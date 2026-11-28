-- Resumen de lecturas QvaPay (solo datos no sensibles) para F3.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.qvapay_snapshots (
  run_id text PRIMARY KEY,
  user_uuid text NOT NULL,
  balance text NOT NULL,
  offers integer NOT NULL,
  averages integer NOT NULL,
  captured_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_qvapay_snapshots_captured_at
  ON shadow.qvapay_snapshots (captured_at DESC);
