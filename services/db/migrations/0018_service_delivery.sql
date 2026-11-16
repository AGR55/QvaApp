-- Durable delivery and idempotency for the Go notifier and QvaPay feed.
-- Safe to apply more than once.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.telegram_update_inbox (
  update_id bigint PRIMARY KEY CHECK (update_id >= 0),
  payload_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'processed', 'uncertain')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_telegram_inbox_pending
  ON shadow.telegram_update_inbox (update_id)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_shadow_telegram_inbox_retention
  ON shadow.telegram_update_inbox (updated_at)
  WHERE state IN ('processed', 'uncertain');

CREATE TABLE IF NOT EXISTS shadow.notifier_dedupe_keys (
  dedupe_key text PRIMARY KEY CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_notifier_dedupe_created
  ON shadow.notifier_dedupe_keys (created_at);

CREATE TABLE IF NOT EXISTS shadow.qvapay_feed_forward_outbox (
  event_key text PRIMARY KEY REFERENCES shadow.qvapay_feed_events(event_key) ON DELETE CASCADE,
  payload_json jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at bigint NOT NULL,
  claimed_until bigint,
  delivered_at bigint,
  last_error text NOT NULL DEFAULT '',
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_qvapay_forward_pending
  ON shadow.qvapay_feed_forward_outbox (available_at, created_at)
  WHERE delivered_at IS NULL;
