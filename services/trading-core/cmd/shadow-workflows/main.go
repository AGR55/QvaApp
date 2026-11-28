// Comando shadow-workflows: audita el risk_decision_json de trade_workflows.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/domain/decisionaudit"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
)

type workflow struct {
	ID               string `json:"id"`
	State            string `json:"state"`
	RiskDecisionJSON string `json:"risk_decision_json"`
}

type riskDecision struct {
	Kind        string          `json:"kind"`
	Reasons     []string        `json:"reasons"`
	Checks      json.RawMessage `json:"checks"`
	EvaluatedAt int64           `json:"evaluatedAt"`
}

type output struct {
	RunID      string `json:"runId"`
	Workflows  int    `json:"workflows"`
	Comparable int    `json:"comparable"`
	Matched    int    `json:"matched"`
	Mismatches int    `json:"mismatches"`
	Skipped    int    `json:"skipped"`
	Persisted  int    `json:"persisted"`
}

func main() {
	eventsPath := flag.String("events", "", "ruta al array JSON exportado de trade_workflows")
	databaseURL := flag.String("database-url", "", "DSN de PostgreSQL (fallback: DATABASE_URL)")
	runID := flag.String("run-id", "", "identificador del run (default: sqlite-workflows-<timestamp UTC>)")
	source := flag.String("source", "sqlite-workflows", "origen del run")
	failOnMismatch := flag.Bool("fail-on-mismatch", true, "salir con código 1 si hay divergencias")
	flag.Parse()

	path := strings.TrimSpace(*eventsPath)
	if path == "" {
		fmt.Fprintln(os.Stderr, "shadow-workflows: falta -events")
		os.Exit(2)
	}
	dsn := strings.TrimSpace(*databaseURL)
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "shadow-workflows: falta -database-url o DATABASE_URL")
		os.Exit(2)
	}
	id := strings.TrimSpace(*runID)
	if id == "" {
		id = "sqlite-workflows-" + time.Now().UTC().Format("20060102T150405Z")
	}

	result, err := run(context.Background(), dsn, path, id, *source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-workflows: %v\n", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "shadow-workflows: %v\n", err)
		os.Exit(1)
	}
	if result.Mismatches > 0 && *failOnMismatch {
		os.Exit(1)
	}
}

func run(ctx context.Context, dsn, path, runID, source string) (output, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return output{}, fmt.Errorf("leer %s: %w", path, err)
	}
	var workflows []workflow
	if err := json.Unmarshal(payload, &workflows); err != nil {
		return output{}, fmt.Errorf("decodificar %s: %w", path, err)
	}

	createdAt := time.Now().Unix()
	decisions := make([]shadow.Decision, 0, len(workflows))
	cases := make(map[string]struct{})
	matched := 0
	mismatches := 0
	for _, item := range workflows {
		var risk riskDecision
		if err := json.Unmarshal([]byte(item.RiskDecisionJSON), &risk); err != nil {
			return output{}, fmt.Errorf("workflow %s: risk_decision_json inválido: %w", item.ID, err)
		}
		decision := risk.Kind
		if decision == "apply" {
			decision = "applied"
		}
		event := decisionaudit.Event{
			Version:    item.ID,
			Decision:   decision,
			Reason:     strings.Join(risk.Reasons, " · "),
			ChecksJSON: string(risk.Checks),
		}
		result, err := decisionaudit.Audit(event)
		if err != nil {
			return output{}, fmt.Errorf("workflow %s: %w", item.ID, err)
		}
		if !result.Comparable {
			continue
		}
		cases[item.ID] = struct{}{}
		if result.Matched {
			matched++
		} else {
			mismatches++
		}
		decisions = append(decisions, shadow.Decision{
			RunID:          runID,
			CaseID:         item.ID,
			Step:           1,
			Source:         source,
			ActualJSON:     result.ActualJSON,
			ActualDigest:   result.ActualDigest,
			ExpectedJSON:   result.ExpectedJSON,
			ExpectedDigest: result.ExpectedDigest,
			Matched:        result.Matched,
			CreatedAt:      createdAt,
		})
	}

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return output{}, err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return output{}, fmt.Errorf("conectar a PostgreSQL: %w", err)
	}
	repository := postgres.NewShadowRepository(pool)
	if err := repository.RecordRun(ctx, shadow.Run{
		RunID:     runID,
		Source:    source,
		Cases:     len(cases),
		Steps:     len(decisions),
		Matched:   matched,
		CreatedAt: createdAt,
	}, decisions); err != nil {
		return output{}, fmt.Errorf("persistir run %s: %w", runID, err)
	}

	return output{
		RunID:      runID,
		Workflows:  len(workflows),
		Comparable: len(decisions),
		Matched:    matched,
		Mismatches: mismatches,
		Skipped:    len(workflows) - len(decisions),
		Persisted:  len(decisions),
	}, nil
}
