-- Triggers de comportamiento equivalentes a los 6 triggers SQLite de v31.
-- Deben aplicarse DESPUÉS de la carga inicial para no duplicar histórico.

CREATE OR REPLACE FUNCTION core.application_reservation_resolved_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IN ('rejected', 'reconciled') THEN
    DELETE FROM core.application_capital_reservations WHERE intent_id = NEW.intent_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS application_reservation_resolved ON core.mutation_intents;
CREATE TRIGGER application_reservation_resolved
AFTER UPDATE OF state ON core.mutation_intents
FOR EACH ROW
WHEN (NEW.state IN ('rejected', 'reconciled'))
EXECUTE FUNCTION core.application_reservation_resolved_fn();

CREATE OR REPLACE FUNCTION core.config_integrity_touch_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.id > 0 AND NEW.id <= COALESCE((SELECT MAX(id) FROM core.config_revisions), 0) THEN
      UPDATE core.config_integrity_epoch SET version = version + 1 WHERE id = 1;
    END IF;
    RETURN NEW;
  END IF;
  UPDATE core.config_integrity_epoch SET version = version + 1 WHERE id = 1;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_integrity_delete ON core.config_revisions;
CREATE TRIGGER config_integrity_delete
AFTER DELETE ON core.config_revisions
FOR EACH ROW
EXECUTE FUNCTION core.config_integrity_touch_fn();

DROP TRIGGER IF EXISTS config_integrity_insert ON core.config_revisions;
CREATE TRIGGER config_integrity_insert
BEFORE INSERT ON core.config_revisions
FOR EACH ROW
EXECUTE FUNCTION core.config_integrity_touch_fn();

DROP TRIGGER IF EXISTS config_integrity_update ON core.config_revisions;
CREATE TRIGGER config_integrity_update
AFTER UPDATE ON core.config_revisions
FOR EACH ROW
EXECUTE FUNCTION core.config_integrity_touch_fn();

CREATE OR REPLACE FUNCTION core.fiat_history_insert_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO core.fiat_balance_history
    (coin, balance_before, balance_after, amount, source, kind, created_at)
  VALUES
    (substr(NEW.key, 14), NULL, NEW.value::double precision, 0,
     'Saldo inicial declarado', 'opening',
     (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiat_history_insert ON core.settings;
CREATE TRIGGER fiat_history_insert
AFTER INSERT ON core.settings
FOR EACH ROW
WHEN (NEW.key LIKE 'fiat_balance:%')
EXECUTE FUNCTION core.fiat_history_insert_fn();

CREATE OR REPLACE FUNCTION core.fiat_history_update_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO core.fiat_balance_history
    (coin, balance_before, balance_after, amount, source, kind, created_at)
  VALUES
    (substr(NEW.key, 14), OLD.value::double precision, NEW.value::double precision,
     NEW.value::double precision - OLD.value::double precision,
     'Saldo declarado o actualizado', 'declaration',
     (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fiat_history_update ON core.settings;
CREATE TRIGGER fiat_history_update
AFTER UPDATE OF value ON core.settings
FOR EACH ROW
WHEN (NEW.key LIKE 'fiat_balance:%'
      AND OLD.value::double precision IS DISTINCT FROM NEW.value::double precision)
EXECUTE FUNCTION core.fiat_history_update_fn();
