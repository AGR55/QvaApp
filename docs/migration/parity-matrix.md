# Matriz de paridad de los 718 tests

> **Artefacto generado; no editar a mano.** Se regenera con
> `node --import tsx parity/tools/build-manifest.ts` a partir de la tabla `FILES` del generador.
> El equivalente machine-readable es [parity/manifest.json](../../parity/manifest.json).
>
> - **Esquema:** `qvaapply.parity/v1` (canonicalVersion 1, generator v1)
> - **Oráculo:** TypeScript @ `02bb5afc04b5eb95f5ac3996ef7634dedf073d02`, `srcHash` `sha256:abfc79b1bf8e7f00819f873f86e6b9b0fd45ea8e0eb85ba2ac1f19fc0986207a`
> - **Baseline verificado:** 718 pass / 0 fail / 0 skipped / 0 todo, 95 archivos (`node --import tsx --test test/*.test.ts`, 2026-11-12)
> - **Fuentes normativas:** [04-tests.md](analysis/04-tests.md) §2 y §5.2, [verification.md](verification.md) §L0, [target-architecture.md](target-architecture.md) §3.1

## 0. Resumen ejecutivo

La suite TypeScript de `test/*.test.ts` es el oráculo de la migración a Go. Esta matriz demuestra que **los 718 casos de los 95 archivos están clasificados exactamente una vez** y que cada archivo tiene lote de migración, destino lógico y servicio E1. El gate L0 de [verification.md](verification.md) exige **0 casos sin clasificar**: se cumple.

| Métrica | Valor | Lectura |
| --- | --- | --- |
| Casos del oráculo inventariados | **718 / 718** | suma exacta de los 95 archivos |
| Archivos de test inventariados | **95 / 95** | cada `test/*.test.ts` aparece una vez |
| Casos sin clasificar | **0** | ningún archivo sin categoría, estado, lote o destino |
| Casos con vía de paridad ejecutable | **670 (93,3 %)** | portable 107 + contract 113 + golden 444 + property 6 |
| No aplicables al backend (U + O) | **28 (3,9 %)** | ui 22 + descartado 6 |
| `repository` reemplazado por verificación de datos | **20 (2,8 %)** | estado `descartado`, justificación en §6 |
| Totales por categoría | **107 / 74 / 39 / 470 / 22 / 6** | P 21 · C 11 · H 9 · I 42 · U 9 · O 3 archivos |
| Totales por lote | **L1 107 · L2 113 · L3 298 · L4 172 · L5 28** | L1–L4 = 690 casos; L5 = 28 no migran |

**Lectura:** 670 casos (93,3 %) tienen vía de paridad ejecutable contra Go; 28 (3,9 %) son UI/operaciones no aplicables; 20 (2,8 %) son el caso especial `repository`, cuya garantía pasa a la verificación de migración de datos. La suma 670 + 28 + 20 = 718.

## 1. Cómo se genera y se valida

Este documento y `parity/manifest.json` se regeneran juntos, de forma determinista, con:

```bash
# desde la raíz del repo
node --import tsx parity/tools/build-manifest.ts

# solo verificación (CI): no escribe y sale con 1 si hay deriva
node --import tsx parity/tools/build-manifest.ts --check
```

El generador **no ejecuta la suite** (tarda ~15 s y no aporta al inventario): fija el baseline verificado de 2026-11-12 y comprueba que la tabla de datos cuadre con él. Sale con **exit code 1** si:

| Condición de fallo | Motivo |
| --- | --- |
| Un `test/*.test.ts` existe y no está en `FILES` | archivo de test sin clasificar |
| Una fila de `FILES` no tiene archivo real en `test/` | clasificación obsoleta (archivo borrado o renombrado) |
| Duplicados de archivo en `FILES` | un caso aparecería dos veces |
| La suma de casos no es 718 | pérdida o doble conteo de casos |
| Los totales por categoría no son 107/74/39/470/22/6 (archivos 21/11/9/42/9/3) | desvío del inventario de 04-tests.md |
| Falta categoría, reutilización, lote, destino, estado o contrato | caso sin clasificación completa |
| Un estado `ui`/`descartado` no tiene motivo | exclusión sin justificación escrita |
| Incoherencia categoría ↔ reutilización ↔ lote ↔ destino | clasificación contradictoria |
| `--check` y los artefactos del repo difieren | deriva entre generador y artefactos |

Regla de oro: **los artefactos no se editan a mano**. Cualquier cambio de clasificación se hace en `FILES` (o en la suite, con revisión del baseline) y se regeneran ambos ficheros en el mismo commit.

## 2. Taxonomía, estados y lotes

Estados de [verification.md](verification.md) §L0 aplicados a la taxonomía de [04-tests.md](analysis/04-tests.md) §0.2 y §3:

| Categoría | Archivos | Casos | Estado asignado | Reutilización | Lote |
| --- | --- | --- | --- | --- | --- |
| P — puro/inyectable determinista | 21 | 107 | `portable` (reutilización A, golden directo) | A | L1 |
| C — contrato de adaptador | 11 | 74 | `contract` (cassette/fixture) | B | L2 |
| H — superficie HTTP | 9 | 39 | `contract` (HTTP scripted, K10) | B | L2 |
| I — integración durable | 42 | 470 | `golden` 38/444 · `property` 3/6 · `descartado` 1/20 | B / C / D | L3–L4 |
| U — UI/React/estructura de fuente | 9 | 22 | `ui` | D | L5 |
| O — despliegue/scripts/reportes | 3 | 6 | `descartado` | D | L5 |
| **Total** | **95** | **718** | 6 estados, 0 sin clasificar | — | L1–L5 |

| Estado | Significado operativo (verification.md §L0) | Archivos | Casos |
| --- | --- | --- | --- |
| `portable` | se reescribe como test Go del paquete; vector input→output directo | 21 | 107 |
| `golden` | se cubre con fixture dorado ejecutado contra Go (replay/golden extraído) | 38 | 444 |
| `contract` | se cubre con la suite de contratos (QvaPay/HTTP/webhook/SSE) | 20 | 113 |
| `property` | se cubre con property-based testing (tiempo/interleaving no determinista) | 3 | 6 |
| `ui` | se conserva en el frontend / smoke visual; fuera del score de backend | 9 | 22 |
| `descartado` | excluido del score con justificación escrita (O + `repository`) | 4 | 26 |

`descartado` agrupa 26 casos = 6 de O (despliegue/scripts) + 20 de `repository` (ver §6). Los 28 casos “no aplicables al backend” de 04-tests.md §0.2 son solo U+O; `repository` es una exclusión adicional de código ejecutable, no una pérdida de cobertura: se sustituye por la verificación de migración de datos.

### Lotes de migración

| Lote | Fase | Archivos | Casos | Contenido |
| --- | --- | --- | --- | --- |
| L1 | F1 — puros | 21 | 107 | riesgo, matemática/redondeo, liquidez, presupuesto, intents, schedulers, auth, telegram |
| L2 | F2 — contratos y HTTP | 20 | 113 | QvaPay (K1–K7), SSE, push/Telegram (K14) y superficie HTTP (K10) |
| L3 | F3 — núcleo monetario | 21 | 298 | reservas, intenciones, mutaciones, compensación, conciliación, ledger |
| L4 | F4 — mercado y lecturas | 21 | 172 | ingesta, dedupe, notificaciones, chat, analítica, insights |
| L5 | F5 — UI y operaciones | 12 | 28 | no migran; quedan como deuda del frontend/scripts |

Cuadre: L1 107 + L2 113 = 220 (220, objetivo de la semana 1 de 04-tests.md §0.4); L3+L4 = 470; total con L5 = 718.

### Destinos lógicos y servicios E1

Un destino lógico puede persistir como servicio propio o resolverse dentro de `trading-core`/`edge`/`notifier` en E1. El manifest guarda `targetService` (lógico) y `e1Service` (estado E1), para que la matriz no dependa de la topología final.

| Servicio E1 | Archivos | Casos | Con vía de paridad | No aplicables/reemplazados |
| --- | --- | --- | --- | --- |
| trading-core | 56 | 549 | 529 | 20 |
| edge | 14 | 60 | 60 | 0 |
| notifier | 11 | 56 | 56 | 0 |
| analytics | 2 | 25 | 25 | 0 |
| no-aplica | 12 | 28 | 0 | 28 |

| Destino lógico | Servicio E1 | Archivos | Casos |
| --- | --- | --- | --- |
| money-core | trading-core | 33 | 365 |
| qvapay-adapter | trading-core | 10 | 83 |
| config-registry | trading-core | 1 | 2 |
| decisions | trading-core | 1 | 8 |
| market-ingest | trading-core | 9 | 68 |
| gateway | edge | 12 | 56 |
| dashboard-bff | edge | 2 | 4 |
| notifier | notifier | 8 | 36 |
| chat | notifier | 3 | 20 |
| analytics | analytics | 2 | 25 |
| sync-coop-adapter | trading-core | 2 | 23 |
| no-aplica | no-aplica | 12 | 28 |

Solo se listan destinos con al menos un archivo primario. `audit` aparece como destino secundario (p. ej. `repository`, `hunting-query-performance`, `bulk-dismiss-http`) y sus casos se contabilizan en el servicio primario para no duplicar cobertura; `secondaryServices` del manifest conserva el detalle.

## 3. Matriz archivo por archivo

### P — Puros portables — 21 archivos / 107 casos

Lógica determinista sin fuente de verdad externa: vectores `input → output` directos (reutilización A). Estado `portable`: se reescribe como test Go del paquete y se acompaña de golden directo.

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/budget.test.ts` | 6 | src/budget.ts (plan proporcional, mínimo CUP) | money-core | trading-core | A | L1 | `portable` |
| `test/chat-stream.test.ts` | 2 | src/chat-stream.ts (parser SSE) | chat | notifier | A | L1 | `portable` |
| `test/cooperative-menu.test.ts` | 3 | src/cooperative-menu.ts (teclado/acciones) | notifier | notifier | A | L1 | `portable` |
| `test/dashboard-auth.test.ts` | 4 | src/dashboard-auth.ts (Origin, sesión, CSRF) | gateway | edge | A | L1 | `portable` |
| `test/dashboard-controls.test.ts` | 3 | src/dashboard.ts (DashboardReadModel con fakes) | dashboard-bff | edge | A | L1 | `portable` |
| `test/dashboard.test.ts` | 3 | src/dashboard.ts (marginCalculation, allocateBudget) | money-core | trading-core | A | L1 | `portable` |
| `test/hunting-balance-loops.test.ts` | 1 | src/application/hunting-balance-loops.ts + Scheduler | money-core | trading-core | A | L1 | `portable` |
| `test/hunting-requirements.test.ts` | 1 | src/hunting-requirements.ts | money-core | trading-core | A | L1 | `portable` |
| `test/liquidity-plan.test.ts` | 9 | src/core/liquidity-plan.ts | money-core | trading-core | A | L1 | `portable` |
| `test/market-history-compact.test.ts` | 1 | src/dashboard.ts (compactMarketHistory) | dashboard-bff | edge | A | L1 | `portable` |
| `test/market-hunting-loops.test.ts` | 13 | src/application/market-hunting-loops.ts + Scheduler | money-core | trading-core | A | L1 | `portable` |
| `test/market-list-budget.test.ts` | 9 | src/market-list-budget.ts (cuota de listados) | qvapay-adapter | trading-core | A | L1 | `portable` |
| `test/market-math.test.ts` | 7 | src/market-math.ts (median, outgoingFiatCost, ownOfferFiatTotal) | money-core | trading-core | A | L1 | `portable` |
| `test/mobile-operator.test.ts` | 5 | src/mobile-operator.ts (repo + reloj inyectados) | gateway | edge | A | L1 | `portable` |
| `test/monetary-intents.test.ts` | 5 | src/application/monetary-intents.ts (MemoryIntentRepository) | money-core | trading-core | A | L1 | `portable` |
| `test/qusd-balance-cache.test.ts` | 13 | src/qusd-balance-cache.ts | qvapay-adapter | trading-core | A | L1 | `portable` |
| `test/rate-rounding.test.ts` | 2 | src/market-math.ts (roundRateForIndex) | money-core | trading-core | A | L1 | `portable` |
| `test/risk-policy.test.ts` | 8 | src/core/risk-policy.ts (evaluateRisk) | money-core | trading-core | A | L1 | `portable` |
| `test/scheduler.test.ts` | 2 | src/scheduler.ts | money-core | trading-core | A | L1 | `portable` |
| `test/telegram-menu.test.ts` | 5 | src/telegram-menu.ts | notifier | notifier | A | L1 | `portable` |
| `test/telegram-runtime.test.ts` | 5 | src/telegram-runtime.ts | notifier | notifier | A | L1 | `portable` |

### C — Contratos de adaptador — 11 archivos / 74 casos

Fronteras con fetch/runtime inyectado; la intención es el contrato, no la implementación (reutilización B). Estado `contract`: se reescriben una vez como cassette o fixture de runtime.

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/chat-images.test.ts` | 7 | src/chat-images.ts + QvaPayClient.downloadChatImage | chat | notifier | B | L2 | `contract` |
| `test/login.test.ts` | 11 | src/application/qvapay-login.ts + QvaPayClient.login | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qusd-read-timing.test.ts` | 2 | QvaPayClient.qusdBalance + telemetría de lectura | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-feed-stream.test.ts` | 5 | src/qvapay-feed-stream.ts (SSE) | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-gateway.test.ts` | 27 | src/qvapay.ts (colas, cuotas, errores) | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-list-budget.test.ts` | 6 | QvaPayClient.profile/listOffersPage + ListingReadBudget | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-list-isolation.test.ts` | 2 | QvaPayClient (identidad de listado) | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-list-timing.test.ts` | 3 | QvaPayClient (timing de lista) | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/qvapay-operation-timing.test.ts` | 5 | src/operation-trace.ts + QvaPayClient | qvapay-adapter | trading-core | B | L2 | `contract` |
| `test/telegram-recovery.test.ts` | 1 | src/telegram-recovery.ts (grammy fake API) | notifier | notifier | B | L2 | `contract` |
| `test/web-push.test.ts` | 5 | src/web-push.ts (VAPID runtime inyectado) | notifier | notifier | B | L2 | `contract` |

### H — Superficie HTTP — 9 archivos / 39 casos

Handlers Fastify ejercitados con `app.inject()` (reutilización B). Estado `contract`: pares request → response canónicos contra el adaptador HTTP y la matriz de auth de K10.

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/bulk-dismiss-http.test.ts` | 1 | POST /api/audit/dismiss-all | gateway | edge | B | L2 | `contract` |
| `test/cooperative-hunter-http.test.ts` | 1 | /api/cooperative-network/executions/check | gateway | edge | B | L2 | `contract` |
| `test/http-dashboard.test.ts` | 26 | sesión, CSRF, control, push, recovery, estáticos, webhook | gateway | edge | B | L2 | `contract` |
| `test/mobile-action-http-budget.test.ts` | 1 | acciones móviles (rate limit) | gateway | edge | B | L2 | `contract` |
| `test/mobile-tools.test.ts` | 3 | /api/mobile/* (overview, tools) | gateway | edge | B | L2 | `contract` |
| `test/operation-chat-http.test.ts` | 3 | /api/operations/:uuid/chat | gateway | edge | B | L2 | `contract` |
| `test/self-service-recovery-http.test.ts` | 2 | /api/recovery* | gateway | edge | B | L2 | `contract` |
| `test/static-assets.test.ts` | 1 | servido comprimido/ETag/HEAD | gateway | edge | B | L2 | `contract` |
| `test/trading-analytics-http.test.ts` | 1 | /api/analytics | gateway | edge | B | L2 | `contract` |

### I — Integración durable (SQLite + dominio) — 42 archivos / 470 casos

Secuencias con estado persistido; se instrumentan como replay stateful o golden extraído (reutilización B). Estado `golden`; los casos dependientes de interleaving/tiempo pasan a `property`, y `repository` se descarta como código porque su garantía pasa a la verificación de migración de datos.

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/application-reservations.test.ts` | 2 | reservas de aplicación (store.ts) | money-core | trading-core | B | L3 | `golden` |
| `test/architecture-regression.test.ts` | 4 | trading.ts, dashboard.ts, market-config.ts | money-core | trading-core | B | L3 | `golden` |
| `test/assisted-payment.test.ts` | 13 | assisted-payment.ts + HTTP | money-core | trading-core | B | L3 | `golden` |
| `test/chat-orders-push.test.ts` | 6 | chat-push.ts, operation-chat.ts | notifier | notifier | B | L4 | `golden` |
| `test/config-integrity-performance.test.ts` | 2 | market-config.ts, store.ts | config-registry | trading-core | B | L3 | `golden` |
| `test/cooperative-capital.test.ts` | 16 | trading.ts, store.ts, market-config.ts | money-core | trading-core | B | L3 | `golden` |
| `test/cooperative-hunter.test.ts` | 6 | cooperative-hunter.ts | sync-coop-adapter | trading-core | B | L4 | `golden` |
| `test/core.test.ts` | 26 | trading.ts, store.ts, vault.ts, qvapay.ts | money-core | trading-core | B | L3 | `golden` |
| `test/dashboard-market-observation.test.ts` | 3 | dashboard.ts, market-config.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/dashboard-rebalance.test.ts` | 5 | dashboard.ts, market-config.ts, qvapay.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/flexible-fiat.test.ts` | 7 | trading.ts, store.ts | money-core | trading-core | B | L3 | `golden` |
| `test/flexible-order.test.ts` | 5 | flexible-order.ts, qvapay.ts, store.ts | money-core | trading-core | B | L3 | `golden` |
| `test/hunting-pause.test.ts` | 7 | market-config.ts, store.ts, trading.ts | money-core | trading-core | B | L3 | `golden` |
| `test/hunting-query-performance.test.ts` | 3 | store.ts (índices y consultas) | money-core | trading-core | C | L4 | `property` |
| `test/hunting-sync.test.ts` | 17 | hunting-sync.ts, store.ts, vault.ts | sync-coop-adapter | trading-core | B | L4 | `golden` |
| `test/manual-cancel-exclusion.test.ts` | 9 | trading.ts, market-config.ts | money-core | trading-core | B | L3 | `golden` |
| `test/manual-cancel-race.test.ts` | 31 | trading.ts, qvapay.ts, store.ts (carreras de cancelación) | money-core | trading-core | B | L3 | `golden` |
| `test/market-accounts.test.ts` | 3 | market-accounts.ts, vault.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/market-feed-shutdown.test.ts` | 1 | market-feed.ts, market-source.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/market-feed.test.ts` | 20 | market-feed.ts, market-source.ts, HTTP | market-ingest | trading-core | B | L4 | `golden` |
| `test/market-ingest-serialization.test.ts` | 9 | market-source.ts, trading.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/market-poll-timing.test.ts` | 2 | market-source.ts, market-accounts.ts | market-ingest | trading-core | C | L4 | `property` |
| `test/market-reader-identity.test.ts` | 7 | market-accounts.ts, qvapay.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/market-source.test.ts` | 18 | market-source.ts, market-accounts.ts | market-ingest | trading-core | B | L4 | `golden` |
| `test/mobile-operation-status.test.ts` | 8 | mobile-operator.ts, chat-catalog.ts | gateway | edge | B | L4 | `golden` |
| `test/notification-dispatcher.test.ts` | 7 | notification-dispatcher.ts | notifier | notifier | B | L4 | `golden` |
| `test/offer-latency.test.ts` | 1 | trading.ts, qvapay.ts (latencia recepción→POST) | money-core | trading-core | C | L3 | `property` |
| `test/operation-actions.test.ts` | 9 | trading.ts, qvapay.ts, store.ts | money-core | trading-core | B | L4 | `golden` |
| `test/operation-chat.test.ts` | 11 | operation-chat.ts, qvapay.ts | chat | notifier | B | L4 | `golden` |
| `test/operational-insights.test.ts` | 8 | operational-insights.ts, notification-dispatcher.ts, HTTP | decisions | trading-core | B | L4 | `golden` |
| `test/opportunity-orchestrator.test.ts` | 19 | application/opportunity-orchestrator.ts | money-core | trading-core | B | L3 | `golden` |
| `test/payment-sms.test.ts` | 24 | payment-sms.ts, qvapay.ts, store.ts | money-core | trading-core | B | L3 | `golden` |
| `test/practical-tools.test.ts` | 7 | trading-analytics.ts, price-simulation.ts, HTTP | analytics | analytics | B | L4 | `golden` |
| `test/qusd-readiness-integration.test.ts` | 12 | trading.ts, market-config.ts | money-core | trading-core | B | L3 | `golden` |
| `test/reconciliation-feed.test.ts` | 13 | self-service-recovery.ts, qvapay.ts, trading.ts | money-core | trading-core | B | L3 | `golden` |
| `test/reconciliation-scheduler.test.ts` | 5 | reconciliation-scheduler.ts, store.ts | money-core | trading-core | B | L3 | `golden` |
| `test/repository.test.ts` | 20 | store.ts (esquema v31, migraciones, índices) | money-core | trading-core | D | L3 | `descartado` |
| `test/self-service-recovery.test.ts` | 13 | self-service-recovery.ts, store.ts | money-core | trading-core | B | L3 | `golden` |
| `test/self-service-store.test.ts` | 10 | store.ts (dismiss masivo/versionado) | money-core | trading-core | B | L3 | `golden` |
| `test/telegram-operation.test.ts` | 4 | telegram-operation.ts, store.ts | notifier | notifier | B | L4 | `golden` |
| `test/trading-analytics.test.ts` | 18 | trading-analytics.ts, dashboard.ts | analytics | analytics | B | L4 | `golden` |
| `test/trading-automation.test.ts` | 59 | trading.ts, qvapay.ts, market-config.ts | money-core | trading-core | B | L3 | `golden` |

### U — UI / React / estructura de fuente — 9 archivos / 22 casos

Afirman sobre texto de `.tsx`, `.css` o estructura de fuentes del frontend. No son evidencia de paridad del backend. Estado `ui`: se conservan en el frontend y quedan fuera del score.

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/chart-domain.test.ts` | 2 | web/lib (lógica de presentación de gráfica) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/dashboard-bootstrap-regression.test.ts` | 3 | web/main.jsx y hooks (lectura de fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/dashboard-bootstrap.test.ts` | 2 | web/lib (consumo del bootstrap del navegador) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/dashboard-local-snapshot-regression.test.ts` | 1 | src/dashboard.ts (estructura interna, lectura de fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/server-dashboard-cache-regression.test.ts` | 3 | web/hooks y src/index.ts (lectura de fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/telegram-menu-regression.test.ts` | 2 | src/telegram-menu.ts (regex sobre fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/ui-recovery-regression.test.ts` | 4 | .jsx/.css del panel (lectura de fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/web-layout-regression.test.ts` | 4 | .jsx/.css del panel (lectura de fuente) | no-aplica | no-aplica | D | L5 | `ui` |
| `test/web-operation-actions.test.ts` | 1 | web/lib (mapeo de body de acciones del navegador) | no-aplica | no-aplica | D | L5 | `ui` |

### O — Despliegue, scripts y reportes — 3 archivos / 6 casos

Prueban shell scripts, configuración de despliegue o reportes operativos, no el backend Go. Estado `descartado`, con motivo escrito (verification.md §L0).

| Archivo | Casos | Módulo / área | Destino lógico | E1 | Reutil. | Lote | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/deployment-cleanup.test.ts` | 3 | scripts/cleanup-vps.sh con Docker simulado | no-aplica | no-aplica | D | L5 | `descartado` |
| `test/deployment-domain.test.ts` | 1 | nginx/TLS/provision (regex sobre configuración) | no-aplica | no-aplica | D | L5 | `descartado` |
| `test/hunting-latency-report.test.ts` | 2 | scripts/report-hunting-latency.mjs | no-aplica | no-aplica | D | L5 | `descartado` |

## 4. Cuadre de totales

| Comprobación | Fórmula | Resultado |
| --- | --- | --- |
| Suma de casos por archivo | Σ `cases` de las 95 filas | 718 = 718 ✅ |
| Suma de casos por categoría | 107 + 74 + 39 + 470 + 22 + 6 | 718 = 718 ✅ |
| Suma de archivos por categoría | 21 + 11 + 9 + 42 + 9 + 3 | 95 = 95 ✅ |
| Suma por estado | 107 + 444 + 113 + 6 + 22 + 26 | 718 = 718 ✅ |
| Suma por lote | 107 + 113 + 298 + 172 + 28 | 718 = 718 ✅ |
| Suma por servicio E1 | 549 + 60 + 56 + 25 + 28 | 718 = 718 ✅ |
| Casos sin clasificar | 718 casos − 718 casos con estado | 0 ✅ (95 archivos con estado de 95) |

## 5. Casos no aplicables al backend (28)

Los 9 archivos U (22 casos) y 3 archivos O (6 casos) de 04-tests.md §2.5 **no suman al score de paridad**. Regla dura: si un caso afirma sobre texto de `.tsx`, `.css`, sobre la forma de una función fuente o sobre un script de despliegue, no es evidencia de paridad del backend Go. Se conservan mientras exista el frontend/scripts TypeScript; su cobertura futura pasa a `visual-smoke`/E2E y verificación operativa.

| Archivo | Cat. | Casos | Estado | Motivo |
| --- | --- | --- | --- | --- |
| `test/chart-domain.test.ts` | U | 2 | `ui` | Lógica de presentación del navegador; no es comportamiento de un servicio de backend. |
| `test/dashboard-bootstrap-regression.test.ts` | U | 3 | `ui` | Assert.match sobre la estructura de fuentes del frontend; nula señal de paridad del backend. |
| `test/dashboard-bootstrap.test.ts` | U | 2 | `ui` | Consumo del bootstrap del navegador; no se ejecuta en el backend Go. |
| `test/dashboard-local-snapshot-regression.test.ts` | U | 1 | `ui` | Verifica estructura interna del código, no comportamiento financiero observable. |
| `test/server-dashboard-cache-regression.test.ts` | U | 3 | `ui` | Regresión estructural sobre fuentes del panel; sustituible por smoke visual/E2E. |
| `test/telegram-menu-regression.test.ts` | U | 2 | `ui` | Regex sobre el texto de la fuente; el contrato real se cubre con K14/notifier. |
| `test/ui-recovery-regression.test.ts` | U | 4 | `ui` | Regex sobre JSX/CSS; no es evidencia de paridad del backend. |
| `test/web-layout-regression.test.ts` | U | 4 | `ui` | Regex sobre JSX/CSS de layout; se sustituye por visual-smoke. |
| `test/web-operation-actions.test.ts` | U | 1 | `ui` | Mapeo de payload del navegador; no pertenece al backend. |
| `test/deployment-cleanup.test.ts` | O | 3 | `descartado` | Prueba un shell script de operaciones; no es un servicio del backend. Se sustituye por verificación operativa/CI. |
| `test/deployment-domain.test.ts` | O | 1 | `descartado` | Configuración de despliegue (nginx/TLS); no es lógica de negocio. Se sustituye por tests de contrato de infraestructura. |
| `test/hunting-latency-report.test.ts` | O | 2 | `descartado` | Reporte operativo sobre SQLite; se sustituye por métricas y proyecciones de analytics. |

**Sustitución futura:** `scripts/visual-smoke.mjs` (Chromium + axe-core) para el panel; tests de contrato de nginx/deploy y métricas/analytics para los scripts operativos. No se sustituyen por tests Go equivalentes porque no verifican comportamiento de backend.

## 6. Caso especial: `repository` (20 casos)

`test/repository.test.ts` (20 casos, lote L3, destino money-core) prueba el esquema SQLite v31, migraciones e índices. 04-tests.md §2.4 lo marca con reutilización **D** y §6.4 lo excluye de la portabilidad como código: no se reescribe en Go, sino que su garantía se redefine como **verificación de migración de datos** (02-persistence.md §6.5: conteos por tabla, sumas de saldos, hashes de configuración/epoch, snapshots) **+ tests de esquema Postgres**.

Por eso su estado es `descartado` con motivo, pero **no forma parte de los 28 casos “no aplicables al backend”**: es una exclusión adicional que el propio 04-tests.md §6.4 autoriza. En el score de paridad ejecutable se contabiliza como 2,8 % excluido con justificación, no como cobertura perdida.

## 7. Verificación contra la suite real (2026-11-12)

Esta matriz se contrastó con la ejecución real de la suite, no solo con el documento de inventario:

| Comprobación | Método | Resultado |
| --- | --- | --- |
| Casos totales | `node --import tsx --test --test-reporter=junit test/*.test.ts` | 718 `<testcase>`, exit 0 |
| Archivos | atributo `file` de cada `<testcase>` | 95 archivos distintos |
| Conteo por archivo | 95 conteos JUnit vs 04-tests.md §2.1–§2.5 | 95/95 coinciden; 0 discrepancias |
| Llamadas `test()` estáticas | `grep -c '^test(' test/*.test.ts` | 643 (expandidas a 718 por tablas/bucles) |
| LOC de tests | `wc -l test/*.test.ts` | 15.769 |
| Dependencias declaradas en §0.1 | grep -l | `new Store` 43, `.inject` 13, `readFileSync` 9, `spawnSync` 1 |

**Metodología:** el reporter `tap` de Node no atribuye el archivo a cada subtest; por eso el conteo por archivo se obtuvo con el reporter `junit` y su atributo `file`. El baseline de referencia se mantiene en 718/95 (04-tests.md §0.1).

## 8. Discrepancias y observaciones

**Entre 04-tests.md y la suite real: no se detectó ninguna discrepancia de conteo.** Los 95 conteos por archivo coinciden exactamente y las métricas de §0.1 se reprodujeron (718 casos, 95 archivos, 643 llamadas estáticas, 15 769 LOC, 43 archivos con `Store`, 13 con `inject`, 9 con lectura de fuentes y 1 con subproceso).

Observaciones que no alteran el inventario:

- **Errata menor en 04-tests.md §2.4:** la fila `market-reader-identity` declara la dependencia `fetcn` (por `fetch`). Sin efecto en casos ni clasificación.
- **`descartado` vs “no aplicables”:** 04-tests.md §0.2 cuenta 28 no aplicables (U+O) y §6.4 excluye además `repository` (20) como código; este documento mantiene ambos hechos separados y explicados (§5 y §6) para que el cuadre 718 sea transparente.
- **Entorno medido:** Node v25.9.0 en este workspace, aunque `package.json` declara `>=24.22.1 <25`. No afecta al inventario, pero conviene fijar la versión exacta de Node en el job de CI que regenere la matriz.
- **Documentos públicos desactualizados:** `docs/VERIFICATION.md` y el README declaraban 118 tests; la evidencia de release de 2026-11-02 hablaba de 89 archivos. El baseline correcto es 718/95 (04-tests.md §0.1). La corrección de esos documentos es parte de L0 y queda fuera del alcance de esta matriz.

## 9. Cómo cambiar la clasificación (guardrail)

1. Edita la tabla `FILES` de `parity/tools/build-manifest.ts` (o el baseline `EXPECTED` si cambia la suite). No edites este documento ni `parity/manifest.json` a mano.
2. Ejecuta `node --import tsx parity/tools/build-manifest.ts` desde la raíz del repo.
3. Revisa el diff de ambos artefactos y commitea los tres ficheros juntos (generador, manifest, matriz).
4. En CI, `--check` falla si alguien cambia un artefacto sin regenerar. Prohibido mover un archivo de lote o cambiar un estado sin actualizar el manifest y re-ejecutar el gate (04-tests.md §5.2).

---

*Generado por `parity/tools/build-manifest.ts` v1 · esquema `qvaapply.parity/v1` · oráculo TypeScript @ 02bb5afc04b5eb95f5ac3996ef7634dedf073d02 · `sha256:abfc79b1bf8e7f00819f873f86e6b9b0fd45ea8e0eb85ba2ac1f19fc0986207a` · baseline 2026-11-12.*
