// Package markethunting contiene el motor de bucles de cacería de
// `src/application/market-hunting-loops.ts`: sondeo, feed, cola acotada,
// supersesión por generación/secuencia y cierre ordenado.
package markethunting

import (
	"fmt"
	"sync"
)

const maxPendingPages = 64

// Update es una página de mercado.
type Update struct {
	Coin             string
	Side             string
	ScannedAt        int64
	DispatchSequence *int64
}

// Timing es la evidencia de evaluación.
type Timing struct {
	Coin         string
	Side         string
	ScannedAt    int64
	QueueMs      int64
	EvaluationMs int64
	Outcome      string
	Reason       string
}

// Source es la fuente de mercado.
type Source interface {
	Mode() string
	ProcessNext() error
	PollNext() (*Update, error)
}

// Trading es el consumidor de páginas.
type Trading interface {
	IsPaused() bool
	Ingest(update Update, realtimeRecovery bool, isCurrent func() bool) error
}

// Options inyecta reloj, generación y telemetría.
type Options struct {
	OnError      func(error)
	Generation   func() string
	MonotonicNow func() int64
	OnTiming     func(Timing)
}

type pendingItem struct {
	Update           Update
	RealtimeRecovery bool
	Generation       string
	Mode             string
	EnqueuedAt       int64
}

// Loops es el motor registrado en el planificador.
type Loops struct {
	source  Source
	trading Trading
	options Options

	mu            sync.Mutex
	pending       map[string]*pendingItem
	order         []string
	consuming     bool
	stopped       bool
	pollsInFlight int
	active        int
	idle          chan struct{}
	idleOnce      sync.Once
	feedRunning   bool
}

// New crea el motor.
func New(source Source, trading Trading, options Options) *Loops {
	if options.MonotonicNow == nil {
		options.MonotonicNow = func() int64 { return 0 }
	}
	if options.OnError == nil {
		options.OnError = func(error) {}
	}
	return &Loops{
		source:  source,
		trading: trading,
		options: options,
		pending: map[string]*pendingItem{},
		idle:    make(chan struct{}),
	}
}

// Scan lanza un sondeo; el canal se cierra cuando la página se encoló (o el
// sondeo terminó). El llamador puede ignorarlo si la lectura remota bloquea.
func (loops *Loops) Scan() <-chan struct{} {
	done := make(chan struct{})
	loops.mu.Lock()
	if loops.stopped || loops.trading.IsPaused() {
		loops.discardLocked(reasonFor(loops.stopped))
		loops.mu.Unlock()
		close(done)
		return done
	}
	if loops.pollsInFlight >= 4 {
		loops.mu.Unlock()
		close(done)
		return done
	}
	mode := loops.source.Mode()
	generation := loops.generationLocked()
	loops.pollsInFlight++
	loops.active++
	loops.mu.Unlock()

	go func() {
		update, err := loops.source.PollNext()

		loops.mu.Lock()
		loops.pollsInFlight--
		loops.active--
		var signal chan struct{}
		if err != nil {
			loops.finishWorkLocked()
			loops.mu.Unlock()
			loops.report(err)
			close(done)
			return
		}
		if update != nil && !loops.stopped && !loops.trading.IsPaused() &&
			mode == loops.source.Mode() && generation == loops.generationLocked() {
			signal = loops.enqueueLocked(*update, mode, generation)
		}
		loops.finishWorkLocked()
		loops.mu.Unlock()
		if signal != nil {
			<-signal
		}
		close(done)
	}()
	return done
}

// Feed ejecuta la fuente de feed si no hay otra en curso.
func (loops *Loops) Feed() bool {
	loops.mu.Lock()
	if loops.feedRunning {
		loops.mu.Unlock()
		return false
	}
	if loops.stopped || loops.trading.IsPaused() || loops.source.Mode() != "hybrid" {
		loops.mu.Unlock()
		return true
	}
	loops.feedRunning = true
	loops.active++
	loops.mu.Unlock()

	err := loops.source.ProcessNext()

	loops.mu.Lock()
	loops.feedRunning = false
	loops.active--
	loops.finishWorkLocked()
	loops.mu.Unlock()
	if err != nil {
		loops.report(err)
	}
	return true
}

// Stopped indica si el motor ya entró en cierre.
func (loops *Loops) Stopped() bool {
	loops.mu.Lock()
	defer loops.mu.Unlock()
	return loops.stopped
}

// Stop detiene nuevos trabajos, descarta la cola y espera los activos.
func (loops *Loops) Stop() {
	loops.mu.Lock()
	loops.stopped = true
	loops.discardLocked("shutdown")
	if loops.active == 0 {
		loops.closeIdleLocked()
	}
	idle := loops.idle
	loops.mu.Unlock()
	<-idle
}

func (loops *Loops) enqueueLocked(update Update, mode, generation string) chan struct{} {
	key := update.Coin + ":" + update.Side
	previous := loops.pending[key]
	now := loops.options.MonotonicNow()
	if previous != nil && previous.Generation == generation && previous.Mode == mode {
		older := false
		if previous.Update.DispatchSequence != nil && update.DispatchSequence != nil {
			older = *previous.Update.DispatchSequence >= *update.DispatchSequence
		} else {
			older = previous.Update.ScannedAt >= update.ScannedAt
		}
		if older {
			loops.timing(pendingItem{Update: update, EnqueuedAt: now}, now, "discarded", "superseded")
			return nil
		}
	}
	if previous != nil {
		loops.timing(*previous, now, "discarded", "superseded")
	}
	if previous == nil && len(loops.order) >= maxPendingPages {
		oldest := loops.order[0]
		loops.timing(*loops.pending[oldest], now, "discarded", "capacity")
		loops.deleteLocked(oldest)
	}
	item := &pendingItem{
		Update:           update,
		RealtimeRecovery: mode == "hybrid",
		Generation:       generation,
		Mode:             mode,
		EnqueuedAt:       now,
	}
	loops.pending[key] = item
	if previous == nil {
		loops.order = append(loops.order, key)
	}
	return loops.startConsumeLocked()
}

func (loops *Loops) startConsumeLocked() chan struct{} {
	if loops.consuming || loops.stopped || loops.trading.IsPaused() || len(loops.order) == 0 {
		return nil
	}
	loops.consuming = true
	loops.active++
	signal := make(chan struct{})
	go loops.consume(signal)
	return signal
}

func (loops *Loops) consume(signal chan struct{}) {
	first := true
	for {
		loops.mu.Lock()
		if loops.stopped || loops.trading.IsPaused() || len(loops.order) == 0 {
			loops.consuming = false
			loops.active--
			loops.closeIdleLocked()
			loops.mu.Unlock()
			if first {
				close(signal)
			}
			return
		}
		key := loops.order[0]
		item := loops.pending[key]
		loops.deleteLocked(key)
		startedAt := loops.options.MonotonicNow()
		loops.mu.Unlock()
		if first {
			close(signal)
			first = false
		}

		rejected := false
		isCurrent := func() bool {
			loops.mu.Lock()
			defer loops.mu.Unlock()
			current := !loops.stopped && !loops.trading.IsPaused() &&
				item.Generation == loops.generationLocked() && item.Mode == loops.source.Mode()
			if !current {
				rejected = true
			}
			return current
		}
		if !isCurrent() {
			loops.timing(*item, startedAt, "discarded", loops.stopReason())
			continue
		}
		err := loops.trading.Ingest(item.Update, item.RealtimeRecovery, isCurrent)
		if err != nil {
			loops.timing(*item, startedAt, "failed", "")
			loops.report(err)
			continue
		}
		if rejected {
			loops.timing(*item, startedAt, "discarded", loops.stopReason())
		} else {
			loops.timing(*item, startedAt, "success", "")
		}
	}
}

func (loops *Loops) discardLocked(reason string) {
	now := loops.options.MonotonicNow()
	for _, key := range loops.order {
		loops.timing(*loops.pending[key], now, "discarded", reason)
	}
	loops.order = nil
	loops.pending = map[string]*pendingItem{}
}

func (loops *Loops) timing(item pendingItem, startedAt int64, outcome, reason string) {
	if loops.options.OnTiming == nil {
		return
	}
	queue := startedAt - item.EnqueuedAt
	if queue < 0 {
		queue = 0
	}
	evaluation := loops.options.MonotonicNow() - startedAt
	if evaluation < 0 {
		evaluation = 0
	}
	defer func() { _ = recover() }()
	loops.options.OnTiming(Timing{
		Coin:         item.Update.Coin,
		Side:         item.Update.Side,
		ScannedAt:    item.Update.ScannedAt,
		QueueMs:      queue,
		EvaluationMs: evaluation,
		Outcome:      outcome,
		Reason:       reason,
	})
}

func (loops *Loops) generationLocked() string {
	if loops.options.Generation != nil {
		return loops.options.Generation()
	}
	return fmt.Sprintf("%t:%s", loops.trading.IsPaused(), loops.source.Mode())
}

func (loops *Loops) deleteLocked(key string) {
	delete(loops.pending, key)
	for index, candidate := range loops.order {
		if candidate == key {
			loops.order = append(loops.order[:index], loops.order[index+1:]...)
			break
		}
	}
}

func (loops *Loops) finishWorkLocked() {
	if loops.active == 0 && loops.stopped {
		loops.closeIdleLocked()
	}
}

func (loops *Loops) closeIdleLocked() {
	loops.idleOnce.Do(func() { close(loops.idle) })
}

func (loops *Loops) report(err error) {
	defer func() { _ = recover() }()
	loops.options.OnError(err)
}

func (loops *Loops) stopReason() string {
	loops.mu.Lock()
	defer loops.mu.Unlock()
	return reasonFor(loops.stopped)
}

func reasonFor(stopped bool) string {
	if stopped {
		return "shutdown"
	}
	return "control"
}
