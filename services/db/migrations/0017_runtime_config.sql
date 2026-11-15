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

CREATE TABLE IF NOT EXISTS shadow.analytics_fee_evidence (
  account_uuid text NOT NULL,
  offer_uuid text NOT NULL,
  gross_qusd double precision NOT NULL,
  fee_qusd double precision NOT NULL,
  evidence text NOT NULL,
  version integer NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_uuid, offer_uuid)
);

CREATE TABLE IF NOT EXISTS shadow.mutation_events (
  id text PRIMARY KEY,
  action text NOT NULL,
  target text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'panel',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.chat_messages (
  id text PRIMARY KEY,
  operation_uuid text NOT NULL,
  order_uuid text,
  message text NOT NULL DEFAULT '',
  attempt_id text,
  direction text NOT NULL DEFAULT 'out',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.qvapay_feed_events (
  event_key text PRIMARY KEY,
  event text NOT NULL,
  payload_json jsonb NOT NULL,
  received_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.live_dashboard_history (
  created_at bigint PRIMARY KEY,
  qusd_balance double precision NOT NULL,
  open_offers integer NOT NULL,
  active_operations integer NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow.local_operations (
  uuid text PRIMARY KEY,
  offer_type text NOT NULL DEFAULT '',
  coin text NOT NULL DEFAULT '',
  amount double precision NOT NULL DEFAULT 0,
  receive double precision NOT NULL DEFAULT 0,
  rate double precision NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT '',
  auto_applied boolean NOT NULL DEFAULT false,
  cancel_at bigint,
  created_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL DEFAULT 0,
  order_uuid text,
  reference_rate double precision,
  counterparty_id text
);

-- La orden flexible que devuelve QvaPay se conserva para cancelar y conciliar
-- una aplicación real. Es idempotente para reaplicar la migración.
ALTER TABLE shadow.core_operations
  ADD COLUMN IF NOT EXISTS order_uuid text NOT NULL DEFAULT '';

-- Movimientos fiat posteriores al corte. La clave es la orden (o la oferta si
-- la orden no existe) para que reintentos y conciliaciones no dupliquen.
CREATE TABLE IF NOT EXISTS shadow.fiat_ledger (
  operation_uuid text PRIMARY KEY,
  coin text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  source text NOT NULL DEFAULT '',
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fiat_ledger_coin_created
  ON shadow.fiat_ledger (coin, created_at DESC);
