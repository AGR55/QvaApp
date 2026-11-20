package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/marketlistbudget"
)

type budgetRunner struct {
	mu             sync.Mutex
	values         map[string]string
	sleeps         []int64
	writes         int64
	failFirstWrite bool
	holdNextSleep  bool
	gate           chan struct{}
	started        chan struct{}
	sleepSetsOwner *string
	owner          *string
	now            int64
	budget         *marketlistbudget.Budget
}

func newBudgetRunner(now int64, failFirstWrite bool, sleepSetsOwner *string) *budgetRunner {
	runner := &budgetRunner{
		values:         map[string]string{},
		now:            now,
		failFirstWrite: failFirstWrite,
		sleepSetsOwner: sleepSetsOwner,
	}
	runner.rebuild()
	return runner
}

func (runner *budgetRunner) rebuild() {
	runner.budget = marketlistbudget.New(runner, runner.currentNow, runner.sleep)
}

func (runner *budgetRunner) Get(key string) (string, bool) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	value, ok := runner.values[key]
	return value, ok
}

func (runner *budgetRunner) Set(key, value string) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.failFirstWrite {
		runner.failFirstWrite = false
		return errors.New("disco")
	}
	runner.writes++
	runner.values[key] = value
	return nil
}

func (runner *budgetRunner) currentNow() int64 {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.now
}

func (runner *budgetRunner) sleep(milliseconds int64) {
	runner.mu.Lock()
	runner.sleeps = append(runner.sleeps, milliseconds)
	if runner.holdNextSleep {
		runner.holdNextSleep = false
		runner.gate = make(chan struct{})
		gate := runner.gate
		if runner.started != nil {
			close(runner.started)
			runner.started = nil
		}
		runner.mu.Unlock()
		<-gate
		runner.mu.Lock()
	}
	if runner.sleepSetsOwner != nil {
		owner := *runner.sleepSetsOwner
		runner.owner = &owner
	}
	runner.now += milliseconds
	runner.mu.Unlock()
}

func (runner *budgetRunner) ownerCopy() *string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.owner == nil {
		return nil
	}
	value := *runner.owner
	return &value
}

func (runner *budgetRunner) setOwner(owner *string) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.owner = owner
}

func (runner *budgetRunner) advance(milliseconds int64) {
	runner.mu.Lock()
	runner.now += milliseconds
	runner.mu.Unlock()
}

func (runner *budgetRunner) snapshotNow() int64 {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.now
}

func (runner *budgetRunner) snapshotSleeps() []int64 {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]int64(nil), runner.sleeps...)
}

func (runner *budgetRunner) snapshotWrites() int64 {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.writes
}

func (runner *budgetRunner) holdSleep() chan struct{} {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	started := make(chan struct{})
	runner.started = started
	return started
}

func (runner *budgetRunner) isHoldingSleep() bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.holdNextSleep
}

func (runner *budgetRunner) releaseSleep() {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if runner.gate != nil {
		close(runner.gate)
		runner.gate = nil
	}
}

func (runner *budgetRunner) callWait(provider func() *string) (*string, error) {
	runner.mu.Lock()
	budget := runner.budget
	runner.mu.Unlock()
	return budget.WaitForDispatch(provider)
}

func (runner *budgetRunner) callNote(owner *string, retryAfterMs *int64) error {
	runner.mu.Lock()
	budget := runner.budget
	runner.mu.Unlock()
	return budget.NoteRateLimit(owner, retryAfterMs)
}

func (runner *budgetRunner) recreate() {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.rebuild()
}

func (runner *budgetRunner) stored() any {
	runner.mu.Lock()
	raw, ok := runner.values[marketlistbudget.StateKey]
	runner.mu.Unlock()
	if !ok {
		return nil
	}
	var state struct {
		Universal int64          `json:"universal"`
		LastAny   int64          `json:"lastAny"`
		Owners    map[string]any `json:"owners"`
	}
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return nil
	}
	return map[string]any{
		"universal":  state.Universal,
		"lastAny":    state.LastAny,
		"ownerCount": len(state.Owners),
	}
}

type budgetWaitResult struct {
	owner *string
	err   error
}

func budgetCapture(result budgetWaitResult) any {
	if result.err != nil {
		return map[string]any{"error": result.err.Error()}
	}
	if result.owner == nil {
		return map[string]any{}
	}
	return map[string]any{"owner": *result.owner}
}

func budgetOwner(step map[string]any) (*string, bool, *opError) {
	value, present := step["owner"]
	if !present || value == nil {
		return nil, present, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, true, validation("El campo owner debe ser texto o null.")
	}
	return &text, true, nil
}

func budgetCallback(runner *budgetRunner, step map[string]any) (func() *string, *opError) {
	if dynamic, ok := step["dynamicOwner"].(bool); ok && dynamic {
		return runner.ownerCopy, nil
	}
	owner, present, failure := budgetOwner(step)
	if failure != nil {
		return nil, failure
	}
	if !present {
		owner = runner.ownerCopy()
	}
	return func() *string { return owner }, nil
}

func budgetSequence(fields map[string]any) (any, *opError) {
	rawSteps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	now := int64(10_000)
	if fields["now"] != nil {
		value, failure := integerField(fields, "now")
		if failure != nil {
			return nil, failure
		}
		now = value
	}
	failFirstWrite, _ := fields["failFirstWrite"].(bool)
	var sleepSetsOwner *string
	if value, ok := fields["sleepSetsOwner"].(string); ok {
		sleepSetsOwner = &value
	}
	runner := newBudgetRunner(now, failFirstWrite, sleepSetsOwner)
	pending := map[string]chan budgetWaitResult{}
	results := make([]any, 0, len(rawSteps))

	for _, item := range rawSteps {
		step, ok := item.(map[string]any)
		if !ok {
			return nil, validation("Cada paso debe ser un objeto.")
		}
		operation, failure := stringField(step, "op")
		if failure != nil {
			return nil, failure
		}
		switch operation {
		case "wait":
			provider, failure := budgetCallback(runner, step)
			if failure != nil {
				return nil, failure
			}
			owner, err := runner.callWait(provider)
			results = append(results, budgetCapture(budgetWaitResult{owner: owner, err: err}))
		case "beginWait":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			provider, failure := budgetCallback(runner, step)
			if failure != nil {
				return nil, failure
			}
			channel := make(chan budgetWaitResult, 1)
			pending[label] = channel
			holding := runner.isHoldingSleep()
			var started chan struct{}
			if holding {
				started = runner.holdSleep()
			}
			go func() {
				owner, err := runner.callWait(provider)
				channel <- budgetWaitResult{owner: owner, err: err}
			}()
			if holding {
				<-started
			}
			results = append(results, nil)
		case "joinWait":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			channel := pending[label]
			if channel == nil {
				results = append(results, nil)
				break
			}
			results = append(results, budgetCapture(<-channel))
		case "holdNextSleep":
			runner.mu.Lock()
			runner.holdNextSleep = true
			runner.mu.Unlock()
			results = append(results, nil)
		case "releaseSleep":
			runner.releaseSleep()
			results = append(results, nil)
		case "setOwner":
			owner, _, failure := budgetOwner(step)
			if failure != nil {
				return nil, failure
			}
			runner.setOwner(owner)
			results = append(results, nil)
		case "advance":
			milliseconds, failure := integerField(step, "ms")
			if failure != nil {
				return nil, failure
			}
			runner.advance(milliseconds)
			results = append(results, nil)
		case "note":
			owner, _, failure := budgetOwner(step)
			if failure != nil {
				return nil, failure
			}
			retryAfterMs := marketlistbudget.DefaultRetryAfterMs
			if step["retryAfterMs"] != nil {
				retryAfterMs, failure = integerField(step, "retryAfterMs")
				if failure != nil {
					return nil, failure
				}
			}
			if err := runner.callNote(owner, &retryAfterMs); err != nil {
				results = append(results, map[string]any{"error": err.Error()})
			} else {
				results = append(results, nil)
			}
		case "recreate":
			runner.recreate()
			results = append(results, nil)
		case "now":
			results = append(results, runner.snapshotNow())
		case "sleeps":
			results = append(results, runner.snapshotSleeps())
		case "writes":
			results = append(results, runner.snapshotWrites())
		case "stored":
			results = append(results, runner.stored())
		default:
			return nil, validation(fmt.Sprintf("Operación de presupuesto de listados desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}
