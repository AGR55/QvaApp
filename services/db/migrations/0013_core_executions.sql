-- Ejecuciones simuladas por core para decisiones allowed. No mutan dinero.
-- Idempotente para aplicarse con psql sin runner.

CREATE TABLE IF NOT EXISTS shadow.core_executions (
  event_id text PRIMARY KEY REFERENCES shadow.core_decisions(event_id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  qusd_amount text NOT NULL,
  reserve_qusd text NOT NULL,
  remaining_qusd text NOT NULL,
  ledger_json text NOT NULL,
  reason text NOT NULL,
  created_at bigint NOT NULL
);
