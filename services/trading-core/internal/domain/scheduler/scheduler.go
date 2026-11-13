// Package scheduler contiene el planificador de tareas de `src/scheduler.ts`.
package scheduler

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Task es una tarea programada.
type Task func() error

type registration struct {
	interval time.Duration
	task     Task
	timer    *time.Timer
	running  bool
}

// Scheduler programa tareas por nombre.
type Scheduler struct {
	mu            sync.Mutex
	registrations map[string]*registration
	started       bool
	stopped       bool
	onError       func(name string, err error)
}

// New crea un planificador.
func New(onError func(name string, err error)) *Scheduler {
	if onError == nil {
		onError = func(string, error) {}
	}
	return &Scheduler{registrations: map[string]*registration{}, onError: onError}
}

// Register añade una tarea.
func (scheduler *Scheduler) Register(name string, interval time.Duration, task Task) error {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if _, exists := scheduler.registrations[name]; exists {
		return fmt.Errorf("la tarea %s ya está registrada", name)
	}
	if interval <= 0 {
		return errors.New("el intervalo debe ser positivo")
	}
	scheduler.registrations[name] = &registration{interval: interval, task: task}
	return nil
}

// Start arranca los timers.
func (scheduler *Scheduler) Start() {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.started || scheduler.stopped {
		return
	}
	scheduler.started = true
	for name := range scheduler.registrations {
		scheduler.scheduleLocked(name)
	}
}

// Stop detiene los timers.
func (scheduler *Scheduler) Stop() {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.stopped {
		return
	}
	scheduler.stopped = true
	for _, registration := range scheduler.registrations {
		if registration.timer != nil {
			registration.timer.Stop()
			registration.timer = nil
		}
	}
}

// Run ejecuta una tarea si no está ya en curso.
func (scheduler *Scheduler) Run(name string) (bool, error) {
	scheduler.mu.Lock()
	registration, ok := scheduler.registrations[name]
	if !ok {
		scheduler.mu.Unlock()
		return false, fmt.Errorf("tarea no registrada: %s", name)
	}
	if scheduler.stopped || registration.running {
		scheduler.mu.Unlock()
		return false, nil
	}
	registration.running = true
	scheduler.mu.Unlock()

	err := registration.task()

	scheduler.mu.Lock()
	registration.running = false
	scheduler.mu.Unlock()
	if err != nil {
		scheduler.onError(name, err)
	}
	return true, nil
}

func (scheduler *Scheduler) scheduleLocked(name string) {
	registration, ok := scheduler.registrations[name]
	if !ok || scheduler.stopped {
		return
	}
	registration.timer = time.AfterFunc(registration.interval, func() {
		_, _ = scheduler.Run(name)
		scheduler.mu.Lock()
		scheduler.scheduleLocked(name)
		scheduler.mu.Unlock()
	})
}
