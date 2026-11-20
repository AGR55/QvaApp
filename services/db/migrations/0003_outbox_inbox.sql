-- Outbox/inbox transaccional e idempotencia durable (F1).

CREATE TABLE core.outbox (
  id text PRIMARY KEY,
  topic text NOT NULL,
  payload_json text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_flight', 'published', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at bigint NOT NULL,
  locked_by text,
  locked_at bigint,
  last_error text,
  created_at bigint NOT NULL
);

CREATE INDEX idx_outbox_due ON core.outbox (state, available_at);

CREATE TABLE core.inbox (
  consumer text NOT NULL,
  message_id text NOT NULL,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'processed', 'failed')),
  received_at bigint NOT NULL,
  processed_at bigint,
  error text,
  PRIMARY KEY (consumer, message_id)
);

CREATE INDEX idx_inbox_pending ON core.inbox (state, received_at);

CREATE TABLE core.idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'completed', 'failed')),
  response_json text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idx_idempotency_expiry ON core.idempotency_keys (expires_at);
