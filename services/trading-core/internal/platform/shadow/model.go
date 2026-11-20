// Package shadow define los tipos puros de la persistencia shadow (F3).
package shadow

// Run resume una ejecución shadow completa.
type Run struct {
	RunID     string
	Source    string
	Cases     int
	Steps     int
	Matched   int
	CreatedAt int64
}

// Decision es el resultado comparado de un paso de un caso shadow.
type Decision struct {
	RunID          string
	CaseID         string
	Step           int
	Source         string
	ActualJSON     string
	ActualDigest   string
	ExpectedJSON   string
	ExpectedDigest string
	Matched        bool
	CreatedAt      int64
}

// Summary agrega los contadores de una ejecución shadow.
type Summary struct {
	RunID      string
	Cases      int
	Steps      int
	Matched    int
	Mismatches int
}

// Stats agrega el estado global de los runs shadow.
type Stats struct {
	Runs                int64
	Decisions           int64
	Mismatches          int64
	LastRunAt           int64
	InvariantViolations int64
	LastInvariantAt     int64
	LastQvaPayAt        int64
}
