package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"sync"

	"github.com/AGR55/QvaApp/services/shared/decimal"
	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/qusdcache"
)

type qusdStatusError struct {
	Status  *int
	Message string
}

func (err *qusdStatusError) Error() string { return err.Message }

type qusdReadSpec struct {
	Value        any
	Error        string
	Status       *int
	Hang         bool
	AdvanceEpoch bool
}

type qusdDeferredResult struct {
	value decimal.Value
	err   error
}

type qusdGetResult struct {
	value decimal.Value
	err   error
}

type qusdRunner struct {
	mu            sync.Mutex
	reads         []qusdReadSpec
	now           int64
	epoch         string
	current       bool
	calls         int
	priorities    []bool
	events        []string
	deferred      map[int]chan qusdDeferredResult
	observeThrows bool
	stopResolved  bool
}

func (runner *qusdRunner) read(priority bool) (decimal.Value, error) {
	runner.mu.Lock()
	index := runner.calls
	runner.calls++
	runner.priorities = append(runner.priorities, priority)
	if index >= len(runner.reads) {
		runner.mu.Unlock()
		return decimal.Zero(), fmt.Errorf("lectura de saldo no declarada (%d)", index)
	}
	spec := runner.reads[index]
	if spec.AdvanceEpoch {
		value, _ := strconv.Atoi(runner.epoch)
		runner.epoch = strconv.Itoa(value + 1)
		runner.mu.Unlock()
		if spec.Value != nil {
			return qusdValue(spec.Value)
		}
		return decimal.FromInt(10), nil
	}
	if spec.Hang {
		channel := make(chan qusdDeferredResult, 1)
		runner.deferred[index] = channel
		runner.mu.Unlock()
		result := <-channel
		return result.value, result.err
	}
	status := spec.Status
	message := spec.Error
	value := spec.Value
	runner.mu.Unlock()
	if message != "" {
		return decimal.Zero(), &qusdStatusError{Status: status, Message: message}
	}
	if text, ok := value.(string); ok && text == "NaN" {
		return decimal.Zero(), qusdcache.ErrInvalidBalance
	}
	return qusdValue(value)
}

func qusdValue(value any) (decimal.Value, error) {
	if number, ok := value.(json.Number); ok {
		parsed, err := decimal.Parse(number.String())
		if err != nil {
			return decimal.Zero(), qusdcache.ErrInvalidBalance
		}
		return parsed, nil
	}
	return decimal.Zero(), nil
}

func (runner *qusdRunner) observe(timing qusdcache.Timing) {
	if runner.observeThrows {
		panic("telemetría")
	}
	runner.mu.Lock()
	runner.events = append(runner.events, timing.Outcome)
	runner.mu.Unlock()
}

func (runner *qusdRunner) currentNow() int64 {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.now
}

func (runner *qusdRunner) currentEpoch() string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.epoch
}

func (runner *qusdRunner) isCurrent() bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.current
}

func (runner *qusdRunner) setCurrent(value bool) {
	runner.mu.Lock()
	runner.current = value
	runner.mu.Unlock()
}

func (runner *qusdRunner) setEpoch(value string) {
	runner.mu.Lock()
	runner.epoch = value
	runner.mu.Unlock()
}

func (runner *qusdRunner) advance(milliseconds int64) {
	runner.mu.Lock()
	runner.now += milliseconds
	runner.mu.Unlock()
}

func (runner *qusdRunner) callsValue() int {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.calls
}

func (runner *qusdRunner) prioritiesValue() []bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]bool(nil), runner.priorities...)
}

func (runner *qusdRunner) eventsValue() []string {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]string(nil), runner.events...)
}

func (runner *qusdRunner) lastEvent() any {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.events) == 0 {
		return nil
	}
	return runner.events[len(runner.events)-1]
}

func (runner *qusdRunner) resolveRead(index int, value decimal.Value) {
	runner.mu.Lock()
	channel := runner.deferred[index]
	runner.mu.Unlock()
	if channel != nil {
		channel <- qusdDeferredResult{value: value}
	}
}

func (runner *qusdRunner) rejectRead(index int, message string) {
	runner.mu.Lock()
	channel := runner.deferred[index]
	runner.mu.Unlock()
	if channel != nil {
		channel <- qusdDeferredResult{err: errors.New(message)}
	}
}

func (runner *qusdRunner) stopDone() {
	runner.mu.Lock()
	runner.stopResolved = true
	runner.mu.Unlock()
}

func (runner *qusdRunner) isStopResolved() bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.stopResolved
}

func qusdErrorResult(err error) map[string]any {
	result := map[string]any{"status": "error", "message": err.Error()}
	var status *qusdStatusError
	if errors.As(err, &status) && status.Status != nil {
		result["httpStatus"] = *status.Status
	}
	return result
}

func qusdSuccess(value decimal.Value) map[string]any {
	return map[string]any{"status": "ok", "value": value.Format(8)}
}

func qusdOptions(step map[string]any, runner *qusdRunner, onWork func()) qusdcache.Options {
	options := qusdcache.Options{
		Priority: step["priority"] == true,
		Force:    step["force"] == true,
		Context:  "fast_lane",
		OnWork:   onWork,
	}
	if context, ok := step["context"].(string); ok {
		options.Context = context
	}
	if step["isCurrent"] == true {
		options.IsCurrent = runner.isCurrent
	}
	return options
}

func qusdReads(fields map[string]any) ([]qusdReadSpec, *opError) {
	raw, ok := fields["reads"].([]any)
	if !ok {
		return []qusdReadSpec{}, nil
	}
	reads := make([]qusdReadSpec, 0, len(raw))
	for _, item := range raw {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, validation("Cada lectura debe ser un objeto.")
		}
		spec := qusdReadSpec{
			Hang:         object["hang"] == true,
			AdvanceEpoch: object["advanceEpoch"] == true,
		}
		if object["value"] != nil {
			spec.Value = object["value"]
		}
		if text, ok := object["error"].(string); ok {
			spec.Error = text
		}
		if object["status"] != nil {
			status, failure := integerField(object, "status")
			if failure != nil {
				return nil, failure
			}
			value := int(status)
			spec.Status = &value
		}
		reads = append(reads, spec)
	}
	return reads, nil
}

func qusdSequence(fields map[string]any) (any, *opError) {
	rawSteps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	reads, failure := qusdReads(fields)
	if failure != nil {
		return nil, failure
	}
	now := int64(100_000)
	if fields["now"] != nil {
		value, failure := integerField(fields, "now")
		if failure != nil {
			return nil, failure
		}
		now = value
	}
	epoch := "1"
	if value, ok := fields["epoch"].(string); ok {
		epoch = value
	}
	runner := &qusdRunner{
		reads:         reads,
		now:           now,
		epoch:         epoch,
		current:       true,
		deferred:      map[int]chan qusdDeferredResult{},
		observeThrows: fields["observeThrows"] == true,
	}
	cache := qusdcache.New(qusdcache.Runtime{
		Read:         runner.read,
		Epoch:        runner.currentEpoch,
		Now:          runner.currentNow,
		MonotonicNow: runner.currentNow,
		Observe:      runner.observe,
	})
	pending := map[string]chan qusdGetResult{}
	stops := map[string]chan struct{}{}
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
		case "get":
			value, err := cache.Get(qusdOptions(step, runner, func() {}))
			if err != nil {
				results = append(results, qusdErrorResult(err))
			} else {
				results = append(results, qusdSuccess(value))
			}
		case "beginGet":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			channel := make(chan qusdGetResult, 1)
			pending[label] = channel
			started := make(chan struct{}, 1)
			options := qusdOptions(step, runner, func() {
				select {
				case started <- struct{}{}:
				default:
				}
			})
			go func() {
				value, err := cache.Get(options)
				channel <- qusdGetResult{value: value, err: err}
			}()
			<-started
			results = append(results, nil)
		case "join":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			channel := pending[label]
			if channel == nil {
				results = append(results, nil)
				break
			}
			result := <-channel
			if result.err != nil {
				results = append(results, qusdErrorResult(result.err))
			} else {
				results = append(results, qusdSuccess(result.value))
			}
		case "settle":
			runtime.Gosched()
			results = append(results, nil)
		case "resolveRead":
			index, failure := integerField(step, "index")
			if failure != nil {
				return nil, failure
			}
			if text, ok := step["value"].(string); ok && text == "NaN" {
				runner.resolveRead(int(index), decimal.Zero())
				results = append(results, nil)
				break
			}
			value, _, failure := numberField(step, "value")
			if failure != nil {
				return nil, failure
			}
			runner.resolveRead(int(index), value)
			results = append(results, nil)
		case "rejectRead":
			index, failure := integerField(step, "index")
			if failure != nil {
				return nil, failure
			}
			message, failure := stringField(step, "message")
			if failure != nil {
				return nil, failure
			}
			runner.rejectRead(int(index), message)
			results = append(results, nil)
		case "advance":
			milliseconds, failure := integerField(step, "ms")
			if failure != nil {
				return nil, failure
			}
			runner.advance(milliseconds)
			results = append(results, nil)
		case "setEpoch":
			value, failure := stringField(step, "value")
			if failure != nil {
				return nil, failure
			}
			runner.setEpoch(value)
			results = append(results, nil)
		case "setCurrent":
			runner.setCurrent(step["value"] != false)
			results = append(results, nil)
		case "replace":
			value, _, failure := numberField(step, "value")
			if failure != nil {
				return nil, failure
			}
			if err := cache.Replace(value); err != nil {
				results = append(results, qusdErrorResult(err))
			} else {
				results = append(results, nil)
			}
		case "peek":
			snapshot := cache.Peek()
			if snapshot == nil {
				results = append(results, nil)
			} else {
				results = append(results, snapshot.Value.Format(8))
			}
		case "beginStop":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			done := make(chan struct{})
			stops[label] = done
			onDone := cache.BeginStop()
			go func() {
				<-onDone
				runner.stopDone()
				close(done)
			}()
			results = append(results, nil)
		case "joinStop":
			label, failure := stringField(step, "label")
			if failure != nil {
				return nil, failure
			}
			if done := stops[label]; done != nil {
				<-done
			}
			results = append(results, nil)
		case "stopResolved":
			results = append(results, runner.isStopResolved())
		case "calls":
			results = append(results, runner.callsValue())
		case "priorities":
			results = append(results, runner.prioritiesValue())
		case "events":
			results = append(results, runner.eventsValue())
		case "lastEvent":
			results = append(results, runner.lastEvent())
		default:
			return nil, validation(fmt.Sprintf("Operación de caché QUSD desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}
