-- Decisiones shadow del core para eventos de hunter. No ejecuta dinero.
-- Idempotente para aplicarse con psql sin runner.

CREATE TABLE IF NOT EXISTS shadow.core_decisions (
  event_id text PRIMARY KEY REFERENCES shadow.hunter_events(event_id) ON DELETE CASCADE,
  offer_uuid text NOT NULL,
  coin text NOT NULL,
  side text NOT NULL,
  hunter_decision text NOT NULL,
  core_kind text NOT NULL,
  allowed boolean NOT NULL,
  amount text NOT NULL,
  receive text NOT NULL,
  rate text NOT NULL,
  reason text NOT NULL,
  checks_json text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_core_decisions_allowed
  ON shadow.core_decisions (allowed, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_core_decisions_coin
  ON shadow.core_decisions (coin, created_at DESC);
