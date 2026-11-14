// Package huntingbalance registra los bucles de saldo/liquidez de
// `src/application/hunting-balance-loops.ts` y garantiza un cierre ordenado.
package huntingbalance

import (
	"sync"
	"time"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/scheduler"
)

// Dependencies inyecta los trabajos y el cierre de la caché.
type Dependencies struct {
	RefreshQusd func() error
	Prepare     func() error
	StopReads   func() error
}

// Loops mantiene los bucles registrados.
type Loops struct {
	scheduler *scheduler.Scheduler
	deps      Dependencies

	mu       sync.Mutex
	active   int
	closing  bool
	idle     chan struct{}
	idleOnce sync.Once
	stopOnce sync.Once
}

// Register añade los dos bucles al planificador.
func Register(plan *scheduler.Scheduler, deps Dependencies) (*Loops, error) {
	loops := &Loops{scheduler: plan, deps: deps, idle: make(chan struct{})}
	if err := plan.Register("hunting_balance", time.Second, loops.wrap(deps.RefreshQusd)); err != nil {
		return nil, err
	}
	if err := plan.Register("hunting_liquidity", time.Second, loops.wrap(deps.Prepare)); err != nil {
		return nil, err
	}
	return loops, nil
}

func (loops *Loops) wrap(work func() error) func() error {
	return func() error {
		loops.mu.Lock()
		if loops.closing {
			loops.mu.Unlock()
			return nil
		}
		loops.active++
		loops.mu.Unlock()
		defer func() {
			loops.mu.Lock()
			loops.active--
			if loops.closing && loops.active == 0 {
				loops.closeIdleLocked()
			}
			loops.mu.Unlock()
		}()
		return work()
	}
}

// Stop detiene nuevos trabajos, espera los activos y cierra la caché.
func (loops *Loops) Stop() {
	loops.mu.Lock()
	loops.closing = true
	loops.scheduler.Stop()
	if loops.active == 0 {
		loops.closeIdleLocked()
	}
	idle := loops.idle
	loops.mu.Unlock()
	<-idle
	loops.stopOnce.Do(func() {
		if loops.deps.StopReads != nil {
			_ = loops.deps.StopReads()
		}
	})
}

func (loops *Loops) closeIdleLocked() {
	loops.idleOnce.Do(func() { close(loops.idle) })
}
