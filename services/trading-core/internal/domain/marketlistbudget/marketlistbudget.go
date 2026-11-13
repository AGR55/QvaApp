// Package marketlistbudget coordina el presupuesto durable de listados por
// owner de `src/market-list-budget.ts`. Serializa las reservas en memoria y
// persiste el estado en un store inyectado.
package marketlistbudget

//lint:file-ignore ST1005 los mensajes son contractuales y deben coincidir con el oráculo

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

const (
	// StateKey es la clave del estado persistido.
	StateKey = "market_list_budget:v1"
	// IntervalMs es el intervalo mínimo entre listados.
	IntervalMs int64 = 2_401
	// DefaultRetryAfterMs es el retry por defecto ante un 429 sin cabecera.
	DefaultRetryAfterMs int64 = 60_000
)

// Store es el almacén clave-valor inyectado.
type Store interface {
	Get(key string) (string, bool)
	Set(key, value string) error
}

// Budget coordina las esperas de todos los clientes de listado.
type Budget struct {
	store    Store
	now      func() int64
	sleep    func(int64)
	mu       sync.Mutex
	poisoned bool
}

// New crea un presupuesto. `sleep` puede ser nil para tests sin espera.
func New(store Store, now func() int64, sleep func(int64)) *Budget {
	if now == nil {
		now = func() int64 { return 0 }
	}
	if sleep == nil {
		sleep = func(int64) {}
	}
	return &Budget{store: store, now: now, sleep: sleep}
}

type budgetState struct {
	Version   int              `json:"version"`
	Universal int64            `json:"universal"`
	LastAny   int64            `json:"lastAny"`
	Owners    map[string]int64 `json:"owners"`
}

// WaitForDispatch reserva el siguiente turno y devuelve el owner normalizado.
func (budget *Budget) WaitForDispatch(provider func() *string) (*string, error) {
	for {
		budget.mu.Lock()
		if budget.poisoned {
			budget.mu.Unlock()
			return nil, fmt.Errorf("No se pudo guardar el límite de consultas; despachos bloqueados.")
		}
		owner := normalize(provider())
		now := budget.now()
		state, err := budget.read(now)
		if err != nil {
			budget.mu.Unlock()
			return nil, err
		}
		ready := state.Universal
		if owner != nil {
			if key := ownerKey(*owner); state.Owners[key] > ready {
				ready = state.Owners[key]
			}
		} else if state.LastAny > ready {
			ready = state.LastAny
		}
		if ready > now {
			budget.mu.Unlock()
			budget.sleep(ready - now)
			continue
		}
		next := now + IntervalMs
		if state.LastAny < next {
			state.LastAny = next
		}
		if owner != nil {
			state.Owners[ownerKey(*owner)] = next
		} else if state.Universal < next {
			state.Universal = next
		}
		if err := budget.write(state); err != nil {
			budget.mu.Unlock()
			return nil, err
		}
		budget.mu.Unlock()
		return owner, nil
	}
}

// NoteRateLimit bloquea el owner (o el cupo universal) tras un 429.
func (budget *Budget) NoteRateLimit(owner *string, retryAfterMs *int64) error {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.poisoned {
		return fmt.Errorf("No se pudo guardar el límite de consultas; despachos bloqueados.")
	}
	normalized := normalize(owner)
	delay := DefaultRetryAfterMs
	if retryAfterMs != nil && *retryAfterMs >= 0 {
		delay = *retryAfterMs
	}
	now := budget.now()
	state, err := budget.read(now)
	if err != nil {
		budget.poisoned = true
		return err
	}
	ready := now + delay
	if state.LastAny < ready {
		state.LastAny = ready
	}
	if normalized != nil {
		key := ownerKey(*normalized)
		if state.Owners[key] < ready {
			state.Owners[key] = ready
		}
	} else if state.Universal < ready {
		state.Universal = ready
	}
	if err := budget.write(state); err != nil {
		budget.poisoned = true
		return err
	}
	return nil
}

func (budget *Budget) read(now int64) (budgetState, error) {
	raw, ok := budget.store.Get(StateKey)
	if !ok {
		return budgetState{Version: 1, Owners: map[string]int64{}}, nil
	}
	var state budgetState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return budgetState{}, fmt.Errorf("Presupuesto de consultas inválido.")
	}
	if state.Version != 1 || state.Universal < 0 || state.LastAny < 0 || state.Owners == nil {
		return budgetState{}, fmt.Errorf("Presupuesto de consultas inválido.")
	}
	owners := make(map[string]int64, len(state.Owners))
	for key, ready := range state.Owners {
		if !isOwnerKey(key) || ready < 0 {
			return budgetState{}, fmt.Errorf("Presupuesto de consultas inválido.")
		}
		if ready > now {
			owners[key] = ready
		}
	}
	state.Owners = owners
	return state, nil
}

func (budget *Budget) write(state budgetState) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return budget.store.Set(StateKey, string(encoded))
}

func normalize(owner *string) *string {
	if owner == nil {
		return nil
	}
	value := strings.ToLower(strings.TrimSpace(*owner))
	if value == "" {
		return nil
	}
	return &value
}

func ownerKey(owner string) string {
	sum := sha256.Sum256([]byte(owner))
	return hex.EncodeToString(sum[:])
}

func isOwnerKey(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}
