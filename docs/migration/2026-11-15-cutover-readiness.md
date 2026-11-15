# Cutover readiness — 2026-11-15

## Decisión

**No se ejecutó el cutover.** El edge cubre las 109 rutas HTTP, pero todavía no
es un reemplazo funcional del monolito TS. Apagar TS hoy dejaría la web sin
datos operativos y las mutaciones no llegarían a QvaPay.

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

- Si el resultado queda por debajo de `orderMin`, no se aplica.
- `purchaseMaxQusd` es por mercado y se edita en el panel
  («Máximo QUSD por oferta (0 = sin límite)»).
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

## Idempotencia y conciliación

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
