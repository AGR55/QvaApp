package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/AGR55/QvaApp/services/trading-core/internal/platform/shadow"
)

// ShadowRepository persiste ejecuciones y decisiones shadow.
type ShadowRepository struct {
	pool *pgxpool.Pool
}

// NewShadowRepository crea el repositorio.
func NewShadowRepository(pool *pgxpool.Pool) *ShadowRepository {
	return &ShadowRepository{pool: pool}
}

// CreateRun inserta una ejecución; falla si el run_id ya existe.
func (repository *ShadowRepository) CreateRun(ctx context.Context, run shadow.Run) error {
	_, err := repository.pool.Exec(ctx, `
		INSERT INTO shadow.runs (run_id, source, cases, steps, matched, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		run.RunID, run.Source, run.Cases, run.Steps, run.Matched, run.CreatedAt,
	)
	return err
}

// RecordDecision inserta una decisión comparada.
func (repository *ShadowRepository) RecordDecision(ctx context.Context, decision shadow.Decision) error {
	_, err := repository.pool.Exec(ctx, `
		INSERT INTO shadow.decisions
			(run_id, case_id, step, source, actual_json, actual_digest,
			 expected_json, expected_digest, matched, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		decision.RunID, decision.CaseID, decision.Step, decision.Source,
		decision.ActualJSON, decision.ActualDigest, decision.ExpectedJSON,
		decision.ExpectedDigest, decision.Matched, decision.CreatedAt,
	)
	return err
}

// RecordRun persiste una ejecución completa de forma atómica: el run y todas
// sus decisiones se confirman juntos o se revierten juntos.
func (repository *ShadowRepository) RecordRun(
	ctx context.Context,
	run shadow.Run,
	decisions []shadow.Decision,
) error {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // el rollback tras commit es inocuo

	if _, err := tx.Exec(ctx, `
		INSERT INTO shadow.runs (run_id, source, cases, steps, matched, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		run.RunID, run.Source, run.Cases, run.Steps, run.Matched, run.CreatedAt,
	); err != nil {
		return err
	}
	for _, decision := range decisions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO shadow.decisions
				(run_id, case_id, step, source, actual_json, actual_digest,
				 expected_json, expected_digest, matched, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			decision.RunID, decision.CaseID, decision.Step, decision.Source,
			decision.ActualJSON, decision.ActualDigest, decision.ExpectedJSON,
			decision.ExpectedDigest, decision.Matched, decision.CreatedAt,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// FinishRun actualiza los contadores finales de una ejecución.
func (repository *ShadowRepository) FinishRun(ctx context.Context, runID string, cases, steps, matched int) error {
	tag, err := repository.pool.Exec(ctx, `
		UPDATE shadow.runs
		SET cases = $2, steps = $3, matched = $4
		WHERE run_id = $1`,
		runID, cases, steps, matched,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("run shadow %s no existe", runID)
	}
	return nil
}

// Summary devuelve los contadores de la ejecución y sus divergencias.
func (repository *ShadowRepository) Summary(ctx context.Context, runID string) (shadow.Summary, error) {
	var summary shadow.Summary
	err := repository.pool.QueryRow(ctx, `
		SELECT r.run_id, r.cases, r.steps, r.matched,
			(SELECT count(*) FROM shadow.decisions d
			 WHERE d.run_id = r.run_id AND NOT d.matched)
		FROM shadow.runs r
		WHERE r.run_id = $1`,
		runID,
	).Scan(&summary.RunID, &summary.Cases, &summary.Steps, &summary.Matched, &summary.Mismatches)
	if err != nil {
		return shadow.Summary{}, err
	}
	return summary, nil
}
