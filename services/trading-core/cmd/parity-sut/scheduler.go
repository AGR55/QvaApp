package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/scheduler"
)

type schedulerRunner struct {
	mu      sync.Mutex
	calls   map[string]int
	started map[string]chan struct{}
	release map[string]chan struct{}
	once    map[string]*sync.Once
}

func newSchedulerRunner() *schedulerRunner {
	return &schedulerRunner{
		calls:   map[string]int{},
		started: map[string]chan struct{}{},
		release: map[string]chan struct{}{},
		once:    map[string]*sync.Once{},
	}
}

func (runner *schedulerRunner) register(plan *scheduler.Scheduler, name, task string, interval int64) error {
	runner.mu.Lock()
	runner.calls[name] = 0
	runner.started[name] = make(chan struct{}, 1)
	runner.release[name] = make(chan struct{})
	runner.once[name] = &sync.Once{}
	started := runner.started[name]
	release := runner.release[name]
	runner.mu.Unlock()

	return plan.Register(name, time.Duration(interval)*time.Millisecond, func() error {
		runner.mu.Lock()
		runner.calls[name]++
		runner.mu.Unlock()
		select {
		case started <- struct{}{}:
		default:
		}
		switch task {
		case "throw":
			return errors.New("tarea fallida")
		case "hold":
			<-release
		}
		return nil
	})
}

func (runner *schedulerRunner) startedSignal(name string) chan struct{} {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.started[name]
}

func (runner *schedulerRunner) releaseTask(name string) {
	runner.mu.Lock()
	once := runner.once[name]
	channel := runner.release[name]
	runner.mu.Unlock()
	if once != nil && channel != nil {
		once.Do(func() { close(channel) })
	}
}

func (runner *schedulerRunner) callCount(name string) int {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.calls[name]
}

func schedulerSequence(fields map[string]any) (any, *opError) {
	steps, ok := fields["steps"].([]any)
	if !ok {
		return nil, validation("El campo steps debe ser un array.")
	}
	plan := scheduler.New(nil)
	runner := newSchedulerRunner()
	pending := map[string]chan schedulerResult{}
	results := make([]any, 0, len(steps))

	for _, item := range steps {
		step, ok := item.(map[string]any)
		if !ok {
			return nil, validation("Cada paso debe ser un objeto.")
		}
		operation, failure := stringField(step, "op")
		if failure != nil {
			return nil, failure
		}
		switch operation {
		case "register":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			task, failure := stringField(step, "task")
			if failure != nil {
				return nil, failure
			}
			interval, failure := integerField(step, "interval")
			if failure != nil {
				return nil, failure
			}
			if err := runner.register(plan, name, task, interval); err != nil {
				return nil, validation(err.Error())
			}
			results = append(results, nil)
		case "start":
			plan.Start()
			results = append(results, nil)
		case "stop":
			plan.Stop()
			results = append(results, nil)
		case "begin":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			channel := make(chan schedulerResult, 1)
			pending[name] = channel
			started := runner.startedSignal(name)
			go func() {
				ran, err := plan.Run(name)
				channel <- schedulerResult{ran: ran, err: err}
			}()
			<-started
			results = append(results, nil)
		case "run":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			ran, err := plan.Run(name)
			if err != nil {
				return nil, validation(err.Error())
			}
			results = append(results, ran)
		case "settle":
			runtime.Gosched()
			results = append(results, nil)
		case "release":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			runner.releaseTask(name)
			results = append(results, nil)
		case "join":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			channel := pending[name]
			if channel == nil {
				results = append(results, nil)
				break
			}
			result := <-channel
			if result.err != nil {
				return nil, validation(result.err.Error())
			}
			results = append(results, result.ran)
		case "calls":
			name, failure := stringField(step, "name")
			if failure != nil {
				return nil, failure
			}
			results = append(results, runner.callCount(name))
		default:
			return nil, validation(fmt.Sprintf("Operación de scheduler desconocida: %s.", operation))
		}
	}
	return map[string]any{"results": results}, nil
}

type schedulerResult struct {
	ran bool
	err error
}
