-- Configuración editable desde el panel web y cuentas lectoras rotativas.
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.runtime_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  config_json jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT 'system',
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.runtime_config_revisions (
  version bigint PRIMARY KEY CHECK (version > 0),
  config_json jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT 'system',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.market_readers (
  id text PRIMARY KEY,
  label text NOT NULL,
  encrypted_token text NOT NULL,
  token_fingerprint text NOT NULL UNIQUE,
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 3 AND 3600),
  enabled boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_success_at bigint,
  last_attempt_at bigint,
  next_eligible_at bigint NOT NULL DEFAULT 0,
  consecutive_errors integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX IF NOT EXISTS idx_shadow_market_readers_enabled
  ON shadow.market_readers (enabled, next_eligible_at);

CREATE TABLE IF NOT EXISTS shadow.runtime_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.notification_acks (
  id text PRIMARY KEY,
  acknowledged_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.decision_dismissals (
  id bigint PRIMARY KEY,
  dismissed_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.mobile_devices (
  id text PRIMARY KEY,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at bigint NOT NULL,
  revoked_at bigint,
  last_seen_at bigint
);

CREATE TABLE IF NOT EXISTS shadow.mobile_operators (
  id text PRIMARY KEY,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '["read","actions"]'::jsonb,
  created_at bigint NOT NULL,
  revoked_at bigint,
  read_rate_window_at bigint NOT NULL DEFAULT 0,
  read_rate_count integer NOT NULL DEFAULT 0,
  write_rate_window_at bigint NOT NULL DEFAULT 0,
  write_rate_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shadow.chat_push_devices (
  operator_id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  updated_at bigint NOT NULL
);
