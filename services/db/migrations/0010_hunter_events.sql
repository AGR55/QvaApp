-- Cola durable de candidatos hunter -> core. No es dinero: solo eventos.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.hunter_events (
  event_id text PRIMARY KEY,
  offer_uuid text NOT NULL,
  coin text NOT NULL,
  side text NOT NULL,
  decision text NOT NULL,
  rate text NOT NULL,
  payload_json text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at bigint NOT NULL,
  claimed_by text,
  claimed_at bigint,
  processed_at bigint,
  last_error text,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_hunter_events_due
  ON shadow.hunter_events (state, available_at);
CREATE INDEX IF NOT EXISTS idx_shadow_hunter_events_offer
  ON shadow.hunter_events (offer_uuid, created_at DESC);
