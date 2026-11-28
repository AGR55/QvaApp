// Package applybudget contiene el presupuesto persistido de aplicaciones de
// `src/core/apply-budget.ts`. Trabaja con epoch ms enteros y no hace I/O.
package applybudget

import "sort"

const (
	// WindowMs es la ventana móvil de dos aplicaciones.
	WindowMs int64 = 60_001
	// LegacySpacingMs es la separación del esquema anterior.
	LegacySpacingMs int64 = 30_001
)

// Attempts normaliza la ventana persistida. `attempts == nil` significa que la
// clave no existía; un slice vacío significa que existía y estaba vacía.
func Attempts(attempts []int64, legacyApplyAt *int64) []int64 {
	if attempts != nil && len(attempts) <= 2 {
		valid := true
		for _, at := range attempts {
			if at <= 0 {
				valid = false
				break
			}
		}
		if valid {
			sorted := make([]int64, len(attempts))
			copy(sorted, attempts)
			sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
			return sorted
		}
	}
	if legacyApplyAt != nil && *legacyApplyAt > 0 {
		first := *legacyApplyAt - LegacySpacingMs
		if first < 1 {
			first = 1
		}
		return []int64{first, *legacyApplyAt}
	}
	return []int64{}
}

// ReadyAt devuelve el primer instante en que se puede volver a aplicar.
func ReadyAt(attempts []int64, retryAt *int64, now int64) int64 {
	recent := make([]int64, 0, len(attempts))
	for _, at := range attempts {
		if at+WindowMs > now {
			recent = append(recent, at)
		}
	}
	ready := now
	if len(recent) >= 2 && recent[0]+WindowMs > ready {
		ready = recent[0] + WindowMs
	}
	if retryAt != nil && *retryAt > ready {
		ready = *retryAt
	}
	return ready
}
