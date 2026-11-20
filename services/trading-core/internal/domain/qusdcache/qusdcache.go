// Package qusdcache implementa la caché de saldo QUSD de
// `src/qusd-balance-cache.ts`: deduplicación de lecturas en vuelo, prioridad,
// epoch/revisión, TTL y cierre ordenado.
package qusdcache

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"errors"
	"fmt"
	"sync"

	"github.com/AGR55/QvaApp/services/shared/decimal"
)

// ErrInvalidBalance es el saldo no finito o negativo.
var ErrInvalidBalance = errors.New("Saldo QUSD inválido.")

// ErrClosed indica que la caché se cerró.
var ErrClosed = errors.New("Caché de saldo cerrada.")

// ErrStopped indica que la consulta dejó de ser actual.
var ErrStopped = errors.New("Consulta de saldo detenida.")

// ErrChanged indica que el saldo cambió durante los reintentos.
var ErrChanged = errors.New("El saldo QUSD cambió durante su consulta.")

// ErrTooMany indica que hay demasiadas lecturas en vuelo.
var ErrTooMany = errors.New("Demasiadas consultas de saldo pendientes.")

// Snapshot es un saldo publicado.
type Snapshot struct {
	Value     decimal.Value
	Epoch     string
	UpdatedAt int64
}

// Timing es la observación de telemetría.
type Timing struct {
	Context    string
	Outcome    string
	CacheAgeMs *int64
	TotalMs    int64
}

// Runtime inyecta lectura, epoch y reloj.
type Runtime struct {
	Read         func(priority bool) (decimal.Value, error)
	Epoch        func() string
	Now          func() int64
	MonotonicNow func() int64
	Observe      func(Timing)
}

// Options son las opciones de una consulta.
type Options struct {
	Priority  bool
	Force     bool
	Context   string
	IsCurrent func() bool
	OnWork    func()
}

type remoteSnapshot struct {
	Epoch    string
	Revision int64
	Sequence int64
}

type readResult struct {
	kind     string
	value    decimal.Value
	epoch    string
	revision int64
	sequence int64
	err      error
}

type readWork struct {
	done   chan struct{}
	result readResult
}

// Cache es la caché de saldo.
type Cache struct {
	runtime Runtime
	mu      sync.Mutex

	snapshot          *Snapshot
	revision          int64
	nextSequence      int64
	publishedSequence int64
	remote            *remoteSnapshot
	stopped           bool
	active            map[string]*readWork
}

// New crea la caché.
func New(runtime Runtime) *Cache {
	if runtime.Now == nil {
		runtime.Now = func() int64 { return 0 }
	}
	if runtime.MonotonicNow == nil {
		runtime.MonotonicNow = runtime.Now
	}
	if runtime.Epoch == nil {
		runtime.Epoch = func() string { return "1" }
	}
	return &Cache{runtime: runtime, active: map[string]*readWork{}}
}

// Peek devuelve el saldo vigente sin leer.
func (cache *Cache) Peek() *Snapshot {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return cache.peekLocked()
}

// Replace publica un saldo local.
func (cache *Cache) Replace(value decimal.Value) error {
	if value.Sign() < 0 {
		return ErrInvalidBalance
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.revision++
	cache.remote = nil
	cache.snapshot = &Snapshot{Value: value, Epoch: cache.runtime.Epoch(), UpdatedAt: cache.runtime.Now()}
	return nil
}

// Invalidate invalida el saldo y la revisión.
func (cache *Cache) Invalidate() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.revision++
	cache.snapshot = nil
	cache.remote = nil
}

// Get devuelve el saldo aplicando TTL, dedupe, prioridad y epoch.
func (cache *Cache) Get(options Options) (decimal.Value, error) {
	notified := false
	notify := func() {
		if !notified && options.OnWork != nil {
			notified = true
			options.OnWork()
		}
	}
	for attempt := 0; attempt < 3; attempt++ {
		cache.mu.Lock()
		if cache.stopped {
			cache.mu.Unlock()
			cache.emit(options, "discarded_control", nil)
			return decimal.Zero(), ErrClosed
		}
		if !cache.current(options) {
			cache.mu.Unlock()
			cache.emit(options, "discarded_control", nil)
			return decimal.Zero(), ErrStopped
		}
		item := cache.snapshot
		var age *int64
		if item != nil {
			value := cache.runtime.Now() - item.UpdatedAt
			age = &value
		}
		cached := cache.peekLocked()
		if !options.Force && cached != nil {
			cache.mu.Unlock()
			notify()
			cache.emit(options, "hit", age)
			return cached.Value, nil
		}
		if attempt == 0 && !options.Force {
			outcome := "miss_expired"
			if item == nil {
				outcome = "miss_absent"
			} else if item.Epoch != cache.runtime.Epoch() {
				outcome = "miss_epoch"
			}
			cache.mu.Unlock()
			cache.emit(options, outcome, age)
			cache.mu.Lock()
			// Otra consulta pudo publicar el saldo mientras se emitía la
			// telemetría; en ese caso no se duplica la lectura.
			if cached := cache.peekLocked(); cached != nil {
				cache.mu.Unlock()
				return cached.Value, nil
			}
		}
		epoch := cache.runtime.Epoch()
		revision := cache.revision
		key := fmt.Sprintf("%t|%s|%d", options.Priority, epoch, revision)
		work := cache.active[key]
		if work == nil {
			if len(cache.active) >= 4 {
				cache.mu.Unlock()
				cache.emit(options, "discarded_control", nil)
				return decimal.Zero(), ErrTooMany
			}
			cache.nextSequence++
			work = &readWork{done: make(chan struct{})}
			cache.active[key] = work
			sequence := cache.nextSequence
			cache.mu.Unlock()
			notify()
			go cache.performRead(work, key, epoch, revision, sequence, options.Priority)
		} else {
			cache.mu.Unlock()
			notify()
		}
		<-work.done
		result := work.result

		cache.mu.Lock()
		stopped := cache.stopped
		cache.mu.Unlock()
		if result.kind == "stopped" || stopped {
			cache.emit(options, "discarded_control", nil)
			return decimal.Zero(), ErrClosed
		}
		if !cache.current(options) {
			cache.emit(options, "discarded_control", nil)
			return decimal.Zero(), ErrStopped
		}
		if result.err != nil {
			cache.emit(options, "read_failed", nil)
			return decimal.Zero(), result.err
		}

		cache.mu.Lock()
		currentEpoch := cache.runtime.Epoch()
		currentRevision := cache.revision
		fresh := result.kind == "fresh" && result.epoch == currentEpoch &&
			result.revision == currentRevision && result.sequence == cache.publishedSequence
		remote := cache.remote
		cache.mu.Unlock()
		if fresh {
			cache.emit(options, "read_fresh", nil)
			return result.value, nil
		}
		cache.emit(options, "read_stale", nil)
		if remote != nil && remote.Epoch == result.epoch && remote.Epoch == currentEpoch &&
			remote.Revision == result.revision && remote.Revision == currentRevision &&
			remote.Sequence > result.sequence {
			cache.mu.Lock()
			newer := cache.peekLocked()
			cache.mu.Unlock()
			if newer != nil {
				return newer.Value, nil
			}
		}
	}
	cache.emit(options, "discarded_control", nil)
	return decimal.Zero(), ErrChanged
}

// Stop cierra la caché y espera las lecturas en vuelo.
func (cache *Cache) Stop() {
	<-cache.BeginStop()
}

// BeginStop marca la caché como cerrada de inmediato y devuelve un canal que
// se cierra cuando terminan las lecturas en vuelo.
func (cache *Cache) BeginStop() <-chan struct{} {
	cache.mu.Lock()
	cache.stopped = true
	works := make([]*readWork, 0, len(cache.active))
	for _, work := range cache.active {
		works = append(works, work)
	}
	cache.mu.Unlock()
	done := make(chan struct{})
	go func() {
		for _, work := range works {
			<-work.done
		}
		close(done)
	}()
	return done
}

func (cache *Cache) performRead(work *readWork, key, epoch string, revision, sequence int64, priority bool) {
	result := cache.read(epoch, revision, sequence, priority)
	cache.mu.Lock()
	work.result = result
	if cache.active[key] == work {
		delete(cache.active, key)
	}
	close(work.done)
	cache.mu.Unlock()
}

func (cache *Cache) read(epoch string, revision, sequence int64, priority bool) readResult {
	value, err := cache.runtime.Read(priority)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.stopped {
		return readResult{kind: "stopped"}
	}
	if err != nil {
		return readResult{kind: "error", err: err}
	}
	if epoch != cache.runtime.Epoch() || revision != cache.revision || sequence < cache.publishedSequence {
		return readResult{kind: "stale", epoch: epoch, revision: revision, sequence: sequence}
	}
	if value.Sign() < 0 {
		return readResult{kind: "error", err: ErrInvalidBalance}
	}
	cache.snapshot = &Snapshot{Value: value, Epoch: epoch, UpdatedAt: cache.runtime.Now()}
	cache.publishedSequence = sequence
	cache.remote = &remoteSnapshot{Epoch: epoch, Revision: revision, Sequence: sequence}
	return readResult{kind: "fresh", value: value, epoch: epoch, revision: revision, sequence: sequence}
}

func (cache *Cache) peekLocked() *Snapshot {
	item := cache.snapshot
	if item == nil || item.Epoch != cache.runtime.Epoch() {
		return nil
	}
	age := cache.runtime.Now() - item.UpdatedAt
	if age < 0 || age > 15_000 {
		return nil
	}
	copy := *item
	return &copy
}

func (cache *Cache) current(options Options) bool {
	if options.IsCurrent == nil {
		return true
	}
	result := false
	func() {
		defer func() { _ = recover() }()
		result = options.IsCurrent()
	}()
	return result
}

func (cache *Cache) emit(options Options, outcome string, age *int64) {
	if cache.runtime.Observe == nil {
		return
	}
	defer func() { _ = recover() }()
	cache.runtime.Observe(Timing{
		Context:    options.Context,
		Outcome:    outcome,
		CacheAgeMs: age,
		TotalMs:    0,
	})
}
