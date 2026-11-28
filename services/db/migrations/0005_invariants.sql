-- Resultados del auditor de invariantes SQLite (F3 shadow).
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.invariant_runs (
  run_id text PRIMARY KEY,
  source text NOT NULL,
  violations integer NOT NULL CHECK (violations >= 0),
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_invariant_runs_created_at
  ON shadow.invariant_runs (created_at DESC);
