// Comando shadow-replay: ejecuta el corpus replay y persiste la comparación F3.
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

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
	"github.com/AGR55/QvaApp/services/trading-core/internal/replay/runner"
)

type output struct {
	RunID      string `json:"runId"`
	Cases      int    `json:"cases"`
	Steps      int    `json:"steps"`
	Matched    int    `json:"matched"`
	Mismatches int    `json:"mismatches"`
	Persisted  int    `json:"persisted"`
}

func main() {
	corpusDir := flag.String("corpus", "parity/fixtures/replay/2026-11-12", "directorio del corpus")
	databaseURL := flag.String("database-url", "", "DSN de PostgreSQL (fallback: DATABASE_URL)")
	runID := flag.String("run-id", "", "identificador del run (default: replay-<timestamp UTC>)")
	source := flag.String("source", "replay", "origen del run")
	failOnMismatch := flag.Bool("fail-on-mismatch", true, "salir con código 1 si hay divergencias")
	flag.Parse()

	dsn := strings.TrimSpace(*databaseURL)
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "shadow-replay: falta -database-url o DATABASE_URL")
		os.Exit(2)
	}

	id := strings.TrimSpace(*runID)
	if id == "" {
		id = "replay-" + time.Now().UTC().Format("20060102T150405Z")
	}

	result, err := run(context.Background(), dsn, id, *source, *corpusDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shadow-replay: %v\n", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintf(os.Stderr, "shadow-replay: %v\n", err)
		os.Exit(1)
	}
	if result.Mismatches > 0 && *failOnMismatch {
		os.Exit(1)
	}
}

func run(ctx context.Context, dsn, runID, source, corpusDir string) (output, error) {
	report, err := runner.RunCorpusDetailed(corpusDir)
	if err != nil {
		return output{}, err
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

	createdAt := time.Now().Unix()
	decisions := make([]shadow.Decision, 0, len(report.Records))
	for _, record := range report.Records {
		decisions = append(decisions, shadow.Decision{
			RunID:          runID,
			CaseID:         record.CaseID,
			Step:           record.Step,
			Source:         record.Source,
			ActualJSON:     record.ActualJSON,
			ActualDigest:   record.ActualDigest,
			ExpectedJSON:   record.ExpectedJSON,
			ExpectedDigest: record.ExpectedDigest,
			Matched:        record.Matched,
			CreatedAt:      createdAt,
		})
	}
	if err := repository.RecordRun(ctx, shadow.Run{
		RunID:     runID,
		Source:    source,
		Cases:     report.Cases,
		Steps:     report.Steps,
		Matched:   report.Matched,
		CreatedAt: createdAt,
	}, decisions); err != nil {
		return output{}, fmt.Errorf("persistir run %s: %w", runID, err)
	}
	persisted := len(decisions)

	return output{
		RunID:      runID,
		Cases:      report.Cases,
		Steps:      report.Steps,
		Matched:    report.Matched,
		Mismatches: report.Steps - report.Matched,
		Persisted:  persisted,
	}, nil
}
