-- Fixture de constraints para outbox/inbox/idempotencia.
INSERT INTO core.idempotency_keys (scope, key, request_hash, state, created_at, updated_at)
VALUES ('apply', 'key-1', 'hash-a', 'reserved', 1, 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO core.idempotency_keys (scope, key, request_hash, state, created_at, updated_at)
    VALUES ('apply', 'key-1', 'hash-a', 'reserved', 1, 1);
    RAISE EXCEPTION 'idempotencia duplicada aceptada';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

INSERT INTO core.outbox (id, topic, payload_json, idempotency_key, state, available_at, created_at)
VALUES ('m1', 'core.events', '{}', 'outbox-key-1', 'pending', 1, 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO core.outbox (id, topic, payload_json, idempotency_key, state, available_at, created_at)
    VALUES ('m2', 'core.events', '{}', 'outbox-key-1', 'pending', 1, 1);
    RAISE EXCEPTION 'idempotency_key de outbox duplicada aceptada';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

INSERT INTO core.inbox (consumer, message_id, state, received_at)
VALUES ('consumer-1', 'message-1', 'received', 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO core.inbox (consumer, message_id, state, received_at)
    VALUES ('consumer-1', 'message-1', 'received', 1);
    RAISE EXCEPTION 'inbox duplicado aceptado';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO core.outbox (id, topic, payload_json, idempotency_key, state, available_at, created_at)
    VALUES ('bad', 'core.events', '{}', 'bad-key', 'unknown', 1, 1);
    RAISE EXCEPTION 'estado inválido de outbox aceptado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;

UPDATE core.outbox
SET state = 'in_flight', attempts = attempts + 1, locked_by = 'worker', locked_at = 2
WHERE id = 'm1';
UPDATE core.outbox
SET state = 'published', locked_by = NULL, locked_at = NULL
WHERE id = 'm1';

DO $$
DECLARE
  outbox_state text;
  inbox_state text;
BEGIN
  SELECT state INTO outbox_state FROM core.outbox WHERE id = 'm1';
  SELECT state INTO inbox_state FROM core.inbox WHERE consumer = 'consumer-1' AND message_id = 'message-1';
  IF outbox_state <> 'published' THEN RAISE EXCEPTION 'outbox state = %', outbox_state; END IF;
  IF inbox_state <> 'received' THEN RAISE EXCEPTION 'inbox state = %', inbox_state; END IF;
END;
$$;

SELECT 'outbox-inbox-ok' AS result;
