-- Suscripciones Web Push persistidas por el notifier. Solo almacena el
-- endpoint, las claves de cifrado y metadatos; no envía push.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.push_subscriptions (
  endpoint text PRIMARY KEY,
  p256dh text NOT NULL,
  auth text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_push_subscriptions_expires_at
  ON shadow.push_subscriptions (expires_at);
