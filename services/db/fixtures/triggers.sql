-- Fixture determinista para los 6 triggers de core.
-- Debe ejecutarse en una base vacía con 0001_core y 0002_triggers aplicadas.

INSERT INTO core.config_integrity_epoch (id, version) VALUES (1, 0);

-- Inserción normal: no incrementa epoch.
INSERT INTO core.config_revisions (id, created_at, source, reason, config_json, previous_hash, hash)
VALUES (5, 1, 'test', 'normal', '{}', '', 'h5');

-- Inserción fuera de orden: incrementa epoch (1).
INSERT INTO core.config_revisions (id, created_at, source, reason, config_json, previous_hash, hash)
VALUES (3, 2, 'test', 'reordered', '{}', '', 'h3');

-- Inserción al final: no incrementa epoch.
INSERT INTO core.config_revisions (id, created_at, source, reason, config_json, previous_hash, hash)
VALUES (10, 3, 'test', 'append', '{}', '', 'h10');

UPDATE core.config_revisions SET reason = 'updated' WHERE id = 3;
DELETE FROM core.config_revisions WHERE id = 10;

DO $$
DECLARE
  current_version bigint;
BEGIN
  SELECT version INTO current_version FROM core.config_integrity_epoch WHERE id = 1;
  IF current_version <> 3 THEN
    RAISE EXCEPTION 'config_integrity_epoch esperado 3, real %', current_version;
  END IF;
END;
$$;

INSERT INTO core.settings (key, value) VALUES ('fiat_balance:CUP', '100');

DO $$
DECLARE
  history_count integer;
  opening core.fiat_balance_history%ROWTYPE;
BEGIN
  SELECT count(*) INTO history_count FROM core.fiat_balance_history WHERE coin = 'CUP';
  IF history_count <> 1 THEN
    RAISE EXCEPTION 'histórico opening esperado 1, real %', history_count;
  END IF;
  SELECT * INTO opening FROM core.fiat_balance_history WHERE coin = 'CUP' ORDER BY id DESC LIMIT 1;
  IF opening.kind <> 'opening' OR opening.balance_before IS NOT NULL
     OR opening.balance_after <> 100 OR opening.amount <> 0 THEN
    RAISE EXCEPTION 'fila opening inesperada: %', opening;
  END IF;
END;
$$;

UPDATE core.settings SET value = '150' WHERE key = 'fiat_balance:CUP';
UPDATE core.settings SET value = '150' WHERE key = 'fiat_balance:CUP';

DO $$
DECLARE
  history_count integer;
  declaration core.fiat_balance_history%ROWTYPE;
BEGIN
  SELECT count(*) INTO history_count FROM core.fiat_balance_history WHERE coin = 'CUP';
  IF history_count <> 2 THEN
    RAISE EXCEPTION 'histórico declaration esperado 2, real %', history_count;
  END IF;
  SELECT * INTO declaration FROM core.fiat_balance_history WHERE coin = 'CUP' AND kind = 'declaration';
  IF declaration.balance_before <> 100 OR declaration.balance_after <> 150
     OR declaration.amount <> 50 THEN
    RAISE EXCEPTION 'fila declaration inesperada: %', declaration;
  END IF;
END;
$$;

INSERT INTO core.mutation_intents (intent_id, state) VALUES ('intent-1', 'submitted');
INSERT INTO core.application_capital_reservations (intent_id, offer_uuid, coin, fiat, qusd, amount)
VALUES ('intent-1', 'offer-1', 'CUP', 100, 100, 1);

UPDATE core.mutation_intents SET state = 'rejected' WHERE intent_id = 'intent-1';

DO $$
DECLARE
  reservations integer;
BEGIN
  SELECT count(*) INTO reservations FROM core.application_capital_reservations WHERE intent_id = 'intent-1';
  IF reservations <> 0 THEN
    RAISE EXCEPTION 'reserva huérfana: %', reservations;
  END IF;
END;
$$;

SELECT 'triggers-ok' AS result;
