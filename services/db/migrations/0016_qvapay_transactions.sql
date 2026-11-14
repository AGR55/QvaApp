-- Historial de transacciones QvaPay leídas en modo read-only (primera página).
-- Solo guarda metadatos públicos de cada transacción; nunca el token.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.qvapay_transactions (
  run_id text NOT NULL REFERENCES shadow.qvapay_snapshots(run_id) ON DELETE CASCADE,
  transaction_uuid text NOT NULL,
  amount text NOT NULL,
  status text NOT NULL,
  description text NOT NULL,
  remote_id text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  captured_at bigint NOT NULL,
  PRIMARY KEY (run_id, transaction_uuid)
);

CREATE INDEX IF NOT EXISTS idx_shadow_qvapay_transactions_captured_at
  ON shadow.qvapay_transactions (captured_at DESC);
