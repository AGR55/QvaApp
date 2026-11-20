-- Persistencia del servicio de cacerías: polls y evaluaciones por oferta.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.hunter_polls (
  poll_id bigserial PRIMARY KEY,
  polled_at bigint NOT NULL,
  latency_ms integer NOT NULL,
  offers integer NOT NULL,
  candidates integer NOT NULL,
  error text
);

CREATE INDEX IF NOT EXISTS idx_shadow_hunter_polls_polled_at
  ON shadow.hunter_polls (polled_at DESC);

CREATE TABLE IF NOT EXISTS shadow.hunter_candidates (
  poll_id bigint NOT NULL REFERENCES shadow.hunter_polls(poll_id) ON DELETE CASCADE,
  offer_uuid text NOT NULL,
  coin text NOT NULL,
  side text NOT NULL,
  rate text NOT NULL,
  median text NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  observed_at bigint NOT NULL,
  PRIMARY KEY (poll_id, offer_uuid)
);

CREATE INDEX IF NOT EXISTS idx_shadow_hunter_candidates_decision
  ON shadow.hunter_candidates (decision, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_hunter_candidates_offer
  ON shadow.hunter_candidates (offer_uuid, observed_at DESC);
