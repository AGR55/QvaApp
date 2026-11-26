# Cutover readiness — 2026-11-15

## Decisión

**Cutover ejecutado el 2026-11-15 a las 20:28 UTC.** El edge sirve el dominio,
TS está detenido, el motor Go opera en real y la web funciona. El detalle y la
vigilancia están en `2026-11-15-cutover-watch.md`.

Las secciones siguientes conservan la evidencia de las brechas que se fueron
cerrando antes del corte.

## Evidencia de la brecha

Comparación real de `GET /api/dashboard` entre producción y shadow:

```text
Claves que producción tiene y shadow no:
activity, balance, discoveredMarkets, history, integrity,
recoverableWorkflows, recoveryNoticeCount, unresolvedMutations,
workflowOffers

ownOffers:    producción 4  → shadow 4 (mismo rate/amount)
balance:      producción 495.2 → shadow 495.2
transactions: producción 12 → shadow 20 (ventana de 20)
market:       producción 5  → shadow 12 (incluye monedas fuera de market_config)
operations:   producción 1  → shadow 50 (operaciones locales importadas + P2P)
history:                       500 puntos (3.232 importados + snapshots nuevos)
chat:                          200 con mensajes reales de QvaPay
```

Además:

- `internal/platform/qvapay/mutations.go` ya implementa `Apply`, `Cancel`,
  `CreateOffer`, `EditOffer`, `MarkPaid` y `ConfirmReceived` con tests.
- `MutationsAPI` puede usar esas mutaciones reales con
  `EDGE_MUTATIONS_LIVE=true`; por defecto sigue en shadow.
- El dashboard ya lee balance, ofertas, transacciones, mercado y operaciones
  en vivo, y registra historial.
- El chat ya es real contra QvaPay (lectura y envío de texto).
- `payment-preview` ya existe con validación estricta de rol, contraparte,
  estado, importes y destino; rechaza con 409 si no puede verificar el pago.
- La conciliación ya consulta QvaPay y devuelve estado/importes/aplicado.
- `payment-preview` validado con una operación real: 200 con destino, teléfono
  de confirmación y fingerprint (datos no incluidos en este documento).
- Falta el ensayo de corte con TS congelado, mutación real controlada y
  rollback.
- `payment-preview` devuelve 503 porque necesita perfil/oferta en vivo.
- El chat del edge es local; no habla con el chat remoto de QvaPay.
- El webhook QvaPay del edge está activo con HMAC, pero el webhook de Telegram
  y el long-polling siguen en TS.
- El notifier no tiene FCM y el webhook de Telegram no está registrado.

## Qué sí está listo

- 109/109 rutas declaradas, con auth/CSRF/Origen y tests.
- Configuración, cacerías, polling, cuentas lectoras y feed importados.
- Web Push con VAPID de producción y suscripciones persistidas.
- Logs, notificaciones, recuperación, iconos, analítica y simulación.
- Backup SQLite optimizado: `VACUUM INTO`, 54 s, 10,8 s CPU, `quick_check` OK.

## Ensayos ejecutados

- **Conmutación Nginx → edge → rollback**: el dominio sirvió el edge con login,
  configuración (5 mercados) y dashboard (4 ofertas propias, 50 operaciones,
  balance real). Después se restauró Nginx y TS volvió a running; ambos 200.
- **Mutación real controlada**: con TS congelado y `EDGE_MUTATIONS_LIVE=true`,
  `PUT /api/offers/22549487...` (edición no-op con los mismos importes) devolvió
  204. La oferta siguió en 20/330. Después se restauró `LIVE=false` y TS.
- **Pago asistido real**: 200 con contraparte, destino y fingerprint.
- **Conciliación real**: 200 con estado/importes/aplicado de QvaPay.

## Motor autónomo en dry-run

El core ya ejecuta el ciclo completo en simulación:

```text
hunter_event -> core.Decide -> reserved -> submitted -> dry_run
```

- `CORE_AUTOTRADE=true`
- `CORE_AUTOTRADE_DRY_RUN=true`
- Estado terminal `dry_run`, distinto de `confirmed`.
- `trading_core_autotrade_applied_total` solo cuenta aplicaciones reales; en
  dry-run permanece en 0.
- Evento sintético procesado: decisión `apply`, operación `dry_run`, sin llamada
  a QvaPay.

## Dimensionado de ofertas por rango

El core ya no aplica el importe publicado a ciegas. Para ofertas
`offerKind=flexible` calcula:

```text
capacidad = (fiat disponible - comisión saliente) / tasa
importe   = floor(min(disponible, orderMax, capacidad,
                      máximo del mercado, máximo por operación,
                      exposición restante, volumen diario restante), 2)
```

- Si el resultado queda por debajo de `orderMin` o del `purchaseMinQusd` del
  mercado, no se aplica.
- `purchaseMaxQusd` y `purchaseMinQusd` son por mercado y se editan en el
  panel («Máximo/Mínimo QUSD por oferta (0 = sin límite)»). El mínimo se
  valida en memoria con la configuración cacheada del hunter; no añade
  consultas a la base por cada oferta.
- La exposición simultánea y el volumen diario se leen de
  `shadow.core_operations`, no se asumen cero.

Prueba en shadow con eventos sintéticos:

```text
BANK_CUP  300 disponibles, tope 200, fondos 119.800 CUP, tasa 1100
  -> 108.90 QUSD  (limitado por fondos)
CLASICA   100 disponibles, orderMax 40, tasa 1.06
  -> 40.00 QUSD   (limitado por el máximo de la oferta)
```

## Oferta de prueba BANK_MLC

La oferta `c2e0d454-...` es `BANK_MLC`, `sell`, `flexible`, 100 QUSD por 133
MLC (tasa 1.33), rango 5–100. **BANK_MLC no existe en `market_config` ni tiene
saldo fiat declarado**, así que el core la bloquea por mercado inactivo y por
fondos cero. Para probarla con dinero real hace falta:

1. agregar `BANK_MLC` en el panel con sus límites reales;
2. declarar el saldo MLC real de la cuenta;
3. autorizar un importe y una ventana de congelamiento de TS.

## Primer apply real + cancelación (2026-11-15)

Oferta privada `cbb26757-...`, fija, 10 QUSD a 1.06 USD/QUSD (rango de pago 60
minutos, aunque se canceló en segundos). Procedimiento ejecutado con
`scripts/f3-real-apply-cancel.sh`:

```text
backup               1.7 GB, 19:14 UTC
TS                   congelado
CORE_AUTOTRADE_DRY_RUN=false
EDGE_MUTATIONS_LIVE=true
core_operations      confirmed · 10.00000000 QUSD · 10.60000000 USD
QvaPay antes         status=processing · applied=true
cancel               HTTP 204
QvaPay después       status=open · applied=false
core_operations      reconciled
restaurado           DRY_RUN=true · MUTATIONS_LIVE=false · TS running
producción           API 200 · dominio 200
```

No se movió dinero: la orden se aplicó y se canceló antes de pagar. La oferta
vuelve a estar `open` y reutilizable.

Esto valida el camino real de `apply` para ofertas fijas (sin cuerpo, sin
`order`) y la cancelación por UUID de oferta. Las flexibles ya validaron su
respuesta con `order`, pero todavía no se aplicó una flexible real.

## Segunda oferta de prueba (CLASICA)

Oferta `a617538e-...`, del mismo contraparte:

```text
coin CLASICA · sell · flexible
amount 235 · receive 259.44 · tasa 1.104 fiat/QUSD
available 200 · rango 5–200
```

Resultado del motor en dry-run:

```text
importe dimensionado = 40.17 QUSD
fiat                 = 44.35
decisión             = blocked
motivo               = "El margen esperado no alcanza el mínimo configurado."
operaciones creadas  = 0
```

La tasa 1.104 supera el máximo de compra configurado (1.071) y el mínimo de
venta (1.096), por lo que comprarla genera pérdida. El guardián la bloquea
antes de crear cualquier operación. Esto coincide con el oráculo TS
(`sizeFlexibleTake` usa `effectiveRate > buyMaxRate` y `evaluateRisk` exige
margen mínimo).

## Saldos fiat desactualizados

El seed de `shadow.runtime_config` usaba `ON CONFLICT DO NOTHING`: los saldos
fiat quedaban congelados en el primer despliegue. En la prueba, el panel decía
`CLASICA = 166.84` cuando producción tenía `44.44`, lo que habría intentado
aplicar 151 QUSD en vez de 40.17.

Se añadió `scripts/f3-sync-fiat-balances.py`, que actualiza solo `fiatBalance`
desde `settings.fiat_balance:*` de producción, conserva el resto de la
configuración y admite `--dry-run`. Debe ejecutarse antes de cada ensayo y en
la ventana de cutover, mientras TS siga siendo la autoridad del saldo.

## Idempotencia y conciliación

- La respuesta de `apply` se valida: UUID de orden, importe exacto solicitado y
  recepción positiva. Cualquier desviación deja la operación en `uncertain`.
- El UUID de la orden se persiste en `shadow.core_operations.order_uuid` antes
  de confirmar, para poder cancelar y conciliar la operación real.
- El conciliador usa el estado de esa orden concreta si está presente; si la
  orden no aparece en QvaPay, conserva `uncertain` en vez de adivinar.
- Una operación ya `confirmed` no vuelve a llamar a QvaPay.
- Un error ambiguo del apply deja la operación en `uncertain`.
- El conciliador consulta QvaPay cada 30 s:
  - `processing/paid/completed/applied` → `reconciled`;
  - `open/cancelled/rejected` → `rejected`;
  - error de red → conserva `uncertain`.
- Prueba real: operación sintética `uncertain` sobre la oferta 890c... pasó a
  `reconciled` con `remote_status=completed`; después se limpió el registro.

## Bloqueo principal restante: aplicación real controlada

El borde ya sirve web, configuración, lecturas y mutaciones bajo bandera, pero
**el bucle autónomo de caza y aplicación sigue siendo TS**. El hunter Go publica
eventos y el core shadow decide, pero no aplica ofertas ni ejecuta el ciclo
completo de dinero. Apagar TS hoy detendría la operación automática.

## Condición mínima para apagar TS

1. Dashboard completo en Go: `ownOffers`, `operations`, `transactions`,
   `balance`, `market`, `history`, rankings y frescura.
2. Mutaciones reales QvaPay: crear/editar/cancelar oferta, paid, received,
   cancel, apply y conciliación con idempotencia.
3. Chat remoto y `payment-preview` contra QvaPay.
4. Notifier Telegram/FCM y webhook en la ventana de corte.
5. Ensayo de cutover con TS congelado y rollback probado.

Hasta entonces, TS sigue siendo la autoridad de producción y el edge queda como
shadow verificado.
