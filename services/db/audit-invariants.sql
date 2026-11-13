-- Auditor de invariantes de core. Devuelve una fila por violación.
-- El wrapper `audit-invariants.sh` falla si hay cualquier fila.

WITH checks AS (
  SELECT 'INV-03'::text AS check_id, 'critical'::text AS severity,
         'reserva de aplicación sin intención'::text AS detail, r.intent_id::text AS subject
  FROM core.application_capital_reservations r
  LEFT JOIN core.mutation_intents i ON i.intent_id = r.intent_id
  WHERE i.intent_id IS NULL

  UNION ALL
  SELECT 'INV-03', 'critical', 'reserva de aplicación con intención terminal', r.intent_id::text
  FROM core.application_capital_reservations r
  JOIN core.mutation_intents i ON i.intent_id = r.intent_id
  WHERE i.state IN ('rejected', 'reconciled')

  UNION ALL
  SELECT 'INV-18', 'critical', 'intención confirmada con reserva pendiente', r.intent_id::text
  FROM core.application_capital_reservations r
  JOIN core.mutation_intents i ON i.intent_id = r.intent_id
  WHERE i.state = 'confirmed'

  UNION ALL
  SELECT 'INV-03', 'critical', 'reserva de aplicación no positiva', r.intent_id::text
  FROM core.application_capital_reservations r
  WHERE coalesce(r.fiat, 0) < 0 OR coalesce(r.qusd, 0) < 0 OR coalesce(r.amount, 0) <= 0

  UNION ALL
  SELECT 'INV-02', 'critical', 'oferta con más de una reserva de aplicación', r.offer_uuid::text
  FROM core.application_capital_reservations r
  WHERE r.offer_uuid IS NOT NULL
  GROUP BY r.offer_uuid
  HAVING count(*) > 1

  UNION ALL
  SELECT 'INV-02', 'critical', 'reserva de capital no positiva', c.workflow_id::text
  FROM core.capital_reservations c
  WHERE coalesce(c.amount, 0) <= 0

  UNION ALL
  SELECT 'INV-04', 'critical', 'reservas QUSD activas por encima del límite',
         x.total::text || ' > ' || y.max_concurrent_qusd_exposure::text
  FROM (SELECT coalesce(sum(amount), 0) AS total FROM core.capital_reservations WHERE state = 'active' AND asset = 'QUSD') x
  CROSS JOIN (SELECT max_concurrent_qusd_exposure FROM core.risk_config WHERE id = 1) y
  WHERE x.total > y.max_concurrent_qusd_exposure

  UNION ALL
  SELECT 'INV-20', 'critical', 'objetivo con más de un workflow', target_offer_uuid::text
  FROM core.trade_workflows
  WHERE target_offer_uuid IS NOT NULL
  GROUP BY target_offer_uuid
  HAVING count(*) > 1

  UNION ALL
  SELECT 'INV-12', 'critical', 'intención con estado desconocido', i.intent_id::text
  FROM core.mutation_intents i
  WHERE i.state NOT IN ('submitted', 'confirmed', 'rejected', 'uncertain', 'reconciled')

  UNION ALL
  SELECT 'INV-01', 'critical', 'operación con estado desconocido', o.uuid::text
  FROM core.operations o
  WHERE o.state NOT IN ('applied', 'acknowledged', 'paid', 'revision', 'cancelled', 'completed')

  UNION ALL
  SELECT 'INV-02', 'critical', 'doble asiento de ledger para operación/dirección',
         l.operation_uuid::text || ':' || l.direction::text
  FROM core.fiat_ledger l
  WHERE l.operation_uuid IS NOT NULL AND l.direction IS NOT NULL
  GROUP BY l.operation_uuid, l.direction
  HAVING count(*) > 1

  UNION ALL
  SELECT 'INV-01', 'critical', 'asiento de ledger no positivo', l.id::text
  FROM core.fiat_ledger l
  WHERE l.amount IS NULL OR l.amount <= 0

  UNION ALL
  SELECT 'INV-01', 'critical', 'saldo fiat negativo en settings', s.key
  FROM core.settings s
  WHERE s.key LIKE 'fiat_balance:%' AND (s.value IS NULL OR s.value = '' OR s.value::double precision < 0)

  UNION ALL
  SELECT 'INV-01', 'critical', 'saldo fiat declarado negativo', fa.market_code
  FROM core.fiat_accounts fa
  WHERE coalesce(fa.declared_balance, 0) < 0

  UNION ALL
  SELECT 'INV-01', 'critical', 'saldo fiat de mercado negativo', mc.code
  FROM core.market_config mc
  WHERE coalesce(mc.fiat_balance, 0) < 0

  UNION ALL
  SELECT 'INV-06', 'critical', 'tasas de mercado cruzan la comisión', mc.code
  FROM core.market_config mc
  WHERE mc.active = 1
    AND coalesce(mc.buy_max_rate, 0) > 0
    AND coalesce(mc.sell_min_rate, 0) > 0
    AND mc.sell_min_rate * (1 - coalesce(mc.sell_fee_percent, 0) / 100) <= mc.buy_max_rate

  UNION ALL
  SELECT 'INV-07', 'critical', 'límites de riesgo incoherentes', r.id::text
  FROM core.risk_config r
  WHERE r.max_qusd_per_operation > r.max_concurrent_qusd_exposure
     OR r.max_qusd_per_operation > r.max_daily_applied_qusd
     OR r.max_concurrent_operations < 1
     OR r.max_slippage_percent > 100

  UNION ALL
  SELECT 'INV-05', 'critical', 'reserva QUSD no harmonizada entre trading y riesgo',
         t.qusd_reserve::text || ' <> ' || r.min_qusd_reserve::text
  FROM core.trading_config t
  CROSS JOIN core.risk_config r
  WHERE t.id = 1 AND r.id = 1 AND abs(t.qusd_reserve - r.min_qusd_reserve) > 0.00000001

  UNION ALL
  SELECT 'INV-34', 'critical', 'cadena de configuración rota', c.id::text
  FROM (
    SELECT id, previous_hash, hash, lag(hash) OVER (ORDER BY id) AS previous
    FROM core.config_revisions
  ) c
  WHERE c.hash IS NULL OR c.hash = ''
     OR (c.previous IS NULL AND coalesce(c.previous_hash, '') <> '')
     OR (c.previous IS NOT NULL AND coalesce(c.previous_hash, '') IS DISTINCT FROM c.previous)

  UNION ALL
  SELECT 'INV-34', 'critical', 'epoch de integridad de configuración inválido', 'config_integrity_epoch'
  FROM (
    SELECT count(*) AS rows, min(id) AS id FROM core.config_integrity_epoch
  ) e
  WHERE e.rows <> 1 OR e.id IS DISTINCT FROM 1
)
SELECT check_id, severity, detail, subject
FROM checks
ORDER BY check_id, subject;
