-- Operaciones shadow durables del core. Persisten el ciclo de vida de una
-- operación sin mover dinero. Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.core_operations (
  operation_id text PRIMARY KEY,
  state text NOT NULL,
  qusd_amount text NOT NULL,
  fiat_amount text NOT NULL,
  updated_at bigint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_core_operations_state_updated
  ON shadow.core_operations (state, updated_at DESC);
