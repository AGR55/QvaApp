-- Inventario de ofertas QvaPay leídas en modo read-only (F3).
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.qvapay_offers (
  run_id text NOT NULL REFERENCES shadow.qvapay_snapshots(run_id) ON DELETE CASCADE,
  offer_uuid text NOT NULL,
  coin text NOT NULL,
  type text NOT NULL,
  amount text NOT NULL,
  receive text NOT NULL,
  rate text NOT NULL,
  status text NOT NULL,
  captured_at bigint NOT NULL,
  PRIMARY KEY (run_id, offer_uuid)
);

CREATE INDEX IF NOT EXISTS idx_shadow_qvapay_offers_coin
  ON shadow.qvapay_offers (coin, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_qvapay_offers_uuid
  ON shadow.qvapay_offers (offer_uuid, captured_at DESC);
