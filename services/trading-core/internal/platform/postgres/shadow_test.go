package postgres_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/postgres"
	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
)

func shadowSetup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("TEST_POSTGRES_URL no configurado")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), "TRUNCATE shadow.decisions, shadow.runs"); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestShadowRepository(t *testing.T) {
	pool := shadowSetup(t)
	repository := postgres.NewShadowRepository(pool)
	ctx := context.Background()

	run := shadow.Run{
		RunID:     "run-1",
		Source:    "replay",
		CreatedAt: 100,
	}
	if err := repository.CreateRun(ctx, run); err != nil {
		t.Fatal(err)
	}
	if err := repository.CreateRun(ctx, run); err == nil {
		t.Fatal("CreateRun aceptó un run_id duplicado")
	}

	decisions := []shadow.Decision{
		{
			RunID: "run-1", CaseID: "case-1", Step: 0, Source: "go",
			ActualJSON: `{"ok":true}`, ActualDigest: "digest-a",
			ExpectedJSON: `{"ok":true}`, ExpectedDigest: "digest-a",
			Matched: true, CreatedAt: 110,
		},
		{
			RunID: "run-1", CaseID: "case-1", Step: 1, Source: "go",
			ActualJSON: `{"ok":false}`, ActualDigest: "digest-b",
			ExpectedJSON: `{"ok":true}`, ExpectedDigest: "digest-a",
			Matched: false, CreatedAt: 120,
		},
	}
	for _, decision := range decisions {
		if err := repository.RecordDecision(ctx, decision); err != nil {
			t.Fatal(err)
		}
	}

	if err := repository.FinishRun(ctx, "run-1", 1, 2, 1); err != nil {
		t.Fatal(err)
	}

	summary, err := repository.Summary(ctx, "run-1")
	if err != nil {
		t.Fatal(err)
	}
	want := shadow.Summary{RunID: "run-1", Cases: 1, Steps: 2, Matched: 1, Mismatches: 1}
	if summary != want {
		t.Fatalf("summary = %+v, quiero %+v", summary, want)
	}

	if err := repository.FinishRun(ctx, "no-existe", 0, 0, 0); err == nil {
		t.Fatal("FinishRun aceptó un run inexistente")
	}
}

func TestShadowRecordRunAtomic(t *testing.T) {
	pool := shadowSetup(t)
	repository := postgres.NewShadowRepository(pool)
	ctx := context.Background()

	run := shadow.Run{
		RunID:     "run-atomic",
		Source:    "replay",
		Cases:     1,
		Steps:     1,
		Matched:   1,
		CreatedAt: 200,
	}
	decision := shadow.Decision{
		RunID: "run-atomic", CaseID: "case-1", Step: 1, Source: "moneycore",
		ActualJSON: `{"result":null}`, ActualDigest: "d",
		ExpectedJSON: `{"result":null}`, ExpectedDigest: "d",
		Matched: true, CreatedAt: 200,
	}
	if err := repository.RecordRun(ctx, run, []shadow.Decision{decision}); err != nil {
		t.Fatal(err)
	}

	summary, err := repository.Summary(ctx, "run-atomic")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Steps != 1 || summary.Matched != 1 || summary.Mismatches != 0 {
		t.Fatalf("summary = %+v", summary)
	}

	// La segunda decisión repite la PK; toda la transacción debe revertirse.
	broken := shadow.Decision{
		RunID: "run-failed", CaseID: "case-1", Step: 1, Source: "moneycore",
		ActualJSON: `{}`, ActualDigest: "a", ExpectedJSON: `{}`,
		ExpectedDigest: "a", Matched: true, CreatedAt: 210,
	}
	duplicate := broken
	if err := repository.RecordRun(ctx, shadow.Run{
		RunID: "run-failed", Source: "replay", Cases: 1, Steps: 2,
		Matched: 2, CreatedAt: 210,
	}, []shadow.Decision{broken, duplicate}); err == nil {
		t.Fatal("RecordRun aceptó decisiones duplicadas")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM shadow.runs WHERE run_id = 'run-failed'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("run fallido persistió %d filas", count)
	}
}
