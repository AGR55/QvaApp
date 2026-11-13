-- Assertions para el fixture mínimo importado desde SQLite.
-- La importación ya ocurrió; los triggers se aplicaron después.

DO $$
DECLARE
  import_rows bigint;
  settings_count integer;
  revisions_count integer;
  reservations_count integer;
  history_count integer;
BEGIN
  SELECT rows INTO import_rows FROM core._import_manifest ORDER BY imported_at DESC LIMIT 1;
  SELECT count(*) INTO settings_count FROM core.settings;
  SELECT count(*) INTO revisions_count FROM core.config_revisions;
  SELECT count(*) INTO reservations_count FROM core.application_capital_reservations;
  SELECT count(*) INTO history_count FROM core.fiat_balance_history;
  IF import_rows <> 8 THEN RAISE EXCEPTION 'filas importadas esperadas 8, real %', import_rows; END IF;
  IF settings_count <> 2 OR revisions_count <> 2 OR reservations_count <> 1 OR history_count <> 0 THEN
    RAISE EXCEPTION 'conteos importados inesperados: settings=% revisions=% reservations=% history=%',
      settings_count, revisions_count, reservations_count, history_count;
  END IF;
END;
$$;

-- Identidad: insertar sin id debe funcionar.
INSERT INTO core.fiat_balance_history (coin, balance_after, amount, source, kind, created_at)
VALUES ('TEST', 1, 0, 'fixture', 'test', 1);

-- Integridad de configuración: max inicial 2; id 5 no incrementa, id 3 sí.
INSERT INTO core.config_revisions (id, created_at, source, reason, config_json, previous_hash, hash)
VALUES (5, 3, 'fixture', 'append', '{}', 'h2', 'h5');
INSERT INTO core.config_revisions (id, created_at, source, reason, config_json, previous_hash, hash)
VALUES (3, 4, 'fixture', 'reordered', '{}', 'h2', 'h3');
UPDATE core.config_revisions SET reason = 'updated' WHERE id = 3;
DELETE FROM core.config_revisions WHERE id = 5;

DO $$
DECLARE
  current_version bigint;
BEGIN
  SELECT version INTO current_version FROM core.config_integrity_epoch WHERE id = 1;
  IF current_version <> 3 THEN
    RAISE EXCEPTION 'epoch esperado 3, real %', current_version;
  END IF;
END;
$$;

-- Histórico fiat: clave nueva y actualización.
INSERT INTO core.settings (key, value) VALUES ('fiat_balance:BPA', '200');
UPDATE core.settings SET value = '250' WHERE key = 'fiat_balance:BPA';
DO $$
DECLARE
  history_count integer;
  declaration core.fiat_balance_history%ROWTYPE;
BEGIN
  SELECT count(*) INTO history_count FROM core.fiat_balance_history WHERE coin = 'BPA';
  IF history_count <> 2 THEN RAISE EXCEPTION 'histórico BPA esperado 2, real %', history_count; END IF;
  SELECT * INTO declaration FROM core.fiat_balance_history WHERE coin = 'BPA' AND kind = 'declaration';
  IF declaration.balance_before <> 200 OR declaration.balance_after <> 250 OR declaration.amount <> 50 THEN
    RAISE EXCEPTION 'declaración BPA inesperada: %', declaration;
  END IF;
END;
$$;

-- Resolución de intención: elimina la reserva.
INSERT INTO core.mutation_intents (intent_id, state) VALUES ('intent-2', 'submitted');
INSERT INTO core.application_capital_reservations (intent_id, offer_uuid, coin, fiat, qusd, amount)
VALUES ('intent-2', 'offer-2', 'CUP', 1, 1, 1);
UPDATE core.mutation_intents SET state = 'reconciled' WHERE intent_id = 'intent-2';
DO $$
DECLARE
  reservations integer;
BEGIN
  SELECT count(*) INTO reservations FROM core.application_capital_reservations WHERE intent_id = 'intent-2';
  IF reservations <> 0 THEN RAISE EXCEPTION 'reserva huérfana: %', reservations; END IF;
END;
$$;

SELECT 'import-triggers-ok' AS result;
