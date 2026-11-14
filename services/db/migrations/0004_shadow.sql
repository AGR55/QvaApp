-- Persistencia shadow de decisiones (F3).
--
-- Idempotente: se puede aplicar directamente con psql sin un runner de
-- migraciones. No altera columnas ni nombres existentes.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.runs (
  run_id text PRIMARY KEY,
  source text NOT NULL,
  cases integer NOT NULL,
  steps integer NOT NULL,
  matched integer NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.decisions (
  run_id text NOT NULL REFERENCES shadow.runs(run_id) ON DELETE CASCADE,
  case_id text NOT NULL,
  step integer NOT NULL,
  source text NOT NULL,
  actual_json text NOT NULL,
  actual_digest text NOT NULL,
  expected_json text NOT NULL,
  expected_digest text NOT NULL,
  matched boolean NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (run_id, case_id, step)
);

CREATE INDEX IF NOT EXISTS idx_shadow_decisions_run_id ON shadow.decisions (run_id);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_matched ON shadow.decisions (matched);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_case_id ON shadow.decisions (case_id);
