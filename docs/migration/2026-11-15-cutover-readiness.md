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
- Faltan conciliación completa y el ensayo de corte.
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
