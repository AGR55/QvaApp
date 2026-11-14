# 04 — Arnés de paridad cross-language para los 718 tests actuales

> **Estado:** diseño, sin implementación.
> **Alcance:** convertir la suite TypeScript de `test/*.test.ts` (718 tests, 95 archivos, 15 769 LOC) en un arnés de paridad reutilizable contra servicios nuevos en Go/Rust, con evidencia medible antes de cualquier despliegue que mueva dinero.
> **Depende de:** `01-domain.md` (casos de uso e invariantes), `02-persistence.md` (§5.1 servicios y §5.4 aritmética decimal), `03-boundaries.md` (§7 contratos K1–K14, §4.3 mapa de rutas, §6.4 servicios). **Encaja en** `../roadmap.md` (fases F0–F6), `../verification.md` (capas L0–L3 y definición de terminado) y `docs/adr/0012-paridad-de-comportamiento.md`.
> **No modifica** `test/`, `src/`, `scripts/` ni `web/`. Los tests actuales se conservan intactos y actúan como oráculo durante la migración.

---

## 0. Resumen ejecutivo

### 0.1 Línea base medida (2026-11-12, este workspace)

| Métrica | Valor verificado | Cómo se midió |
|---|---|---|
| Tests | **718 pass / 0 fail / 0 skipped / 0 todo** | `node --import tsx --test test/*.test.ts` |
| Archivos | **95** (`test/*.test.ts`, ningún helper compartido) | `ls test/*.test.ts \| wc -l` |
| LOC de tests | **15 769** | `wc -l test/*.test.ts` |
| Duración | **15 137 ms** (`duration_ms`), 15,2 s de pared | ejecución completa |
| Llamadas estáticas `test(...)` | 643, expandidas a 718 por tablas/bucles | `grep -c '^test('` |
| Tests con SQLite real (`new Store`) | **43 archivos** | `grep -l 'new Store('` |
| Tests con HTTP injection (Fastify) | **13 archivos** | `grep -l '.inject('` |
| Tests que leen código fuente/HTML/CSS como texto | **9 archivos** | `grep -l 'readFileSync('` |
| Tests con subproceso | 1 (`deployment-cleanup`) | `grep -l 'spawnSync'` |

La evidencia publicada está **desactualizada**: `docs/VERIFICATION.md:10` declara 118 tests y Node 25.9; el release de `docs/2026-11-02-hunting-release-verification.md:12` habla de 89 archivos. El arnés debe fijar el baseline real (718/95) y corregir esos documentos en la fase L0.

### 0.2 Números de esta taxonomía

| Categoría | Archivos | Casos | Reutilización |
|---|---:|---:|---|
| **P** — puro/inyectable, determinista | 21 | **107** | golden directo (A) |
| **C** — contrato de adaptador (fetch/runtime inyectado) | 11 | **74** | cassette/replay (B) |
| **H** — superficie HTTP (Fastify `inject`) | 9 | **39** | scripted HTTP (B) |
| **I** — integración durable con SQLite + dominio | 42 | **470** | replay/HTTP/golden extraído (B, algunas C) |
| **U** — UI/React/estructura de fuente | 9 | **22** | no aplica al backend (D) |
| **O** — despliegue/scripts/reportes | 3 | **6** | no aplica al backend (D) |
| **Total** | **95** | **718** | |

- **Portables tal cual como especificación ejecutable: 107 casos (14,9 %)** — la tabla de §3.2.
- **Portables con adaptación mecánica (contrato/cassette/HTTP): 113 casos (15,7 %)** — §3.3.
- **Reformulables mediante driver de replay/extracción de golden: 470 casos (65,5 %)** — §3.4. Es donde vive el dinero.
- **No aplican al backend: 28 casos (3,9 %)** — §3.5.

### 0.3 Decisión de diseño

1. **El oráculo es la implementación TypeScript actual, congelada por commit y hash.** No se reescribe la suite: se instrumenta para emitir vectores de entrada/salida canónicos.
2. **El arnés es independiente del lenguaje del SUT.** El contrato de entrada es JSON canónico; el SUT se ejerce por **HTTP** (servicios) o por un **CLI de conformidad** (`stdin`/`stdout` NDJSON) para reglas puras. Go, Rust, TypeScript y futuros servicios usan el mismo runner.
3. **Cero red real y cero reloj real.** Fake QvaPay determinista con cassettes, reloj virtual inyectado y sandbox offline obligatorio.
4. **Golden files inmutables y versionados.** Regenerarlos es un acto revisado, no un `npm run update-snapshots` silencioso.
5. **Paridad medible por caso y por invariante.** Un servicio no despliega si `parity < 1.0` en su conjunto obligatorio o si el log de mutaciones upstream difiere del esperado.
6. **El runner se queda en Node** (no se porta a Go/Rust): es un comparador de JSON de ~1 500 LOC. Portarlo no aporta seguridad y añade riesgo. El SUT sí es poliglota.

### 0.4 MVP mínimo viable (lo que hay que construir primero)

| Pieza | Contenido | Criterio de aceptación |
|---|---|---|
| `parity/golden/v1/pure/**` | 107 casos P generados desde TS | auto-paridad TS→TS 100 %, 3 ejecuciones idénticas (hash) |
| `parity/schema/**` | JSON Schema 2020-12 con extensión `x-qva-scale` | golden y real validados contra schema; schema versionado |
| `parity/adapters/ts-cli.ts` | oráculo in-process con `QvaPayRuntime` inyectado | reproduce exactamente los 107 goldens |
| `parity/adapters/cli.ts` | cliente del protocolo CLI v1 | funciona con un binario Go/Rust de ejemplo |
| `parity/adapters/http.ts` | cliente HTTP con cookie/CSRF/Bearer | auto-paridad TS→TS 100 % de la suite H |
| `parity/lib/fake-qvapay` | servidor cassette estricto + log de requests | 6 escenarios base (éxito, 429, timeout, ambiguo, 5xx, 409) reproducibles |
| `parity/runner/run.ts` | comparador canónico, reporte JSON/JUnit | 0 falsos verdes en mutaciones: log upstream exacto |
| `parity/scripts/parity-gate.sh` | gate de CI | bloquea el job de deploy |

**Semana 1:** P (107) + K-contracts base (subset de 11 archivos C) + H (39) = **220 casos en CI**, ~30 % de la suite, con auto-paridad y `golden-guard`.

### 0.5 Encaje con el plan maestro y ADR-0012

- El plan maestro (`docs/migration/roadmap.md` §2, fase **F0 — Congelar**) exige el arnés en `parity/`; este documento es el detalle de F0 y alimenta F1 (dominio puro), F2 (prototipo) y F3 (shadow). Las fases locales L0–L6 de §5.1 se mapean así: L0↔F0, L1↔F1, L2↔F1/F2, L3/L4↔F2/F3, L5↔F3, L6↔F5.
- `docs/migration/verification.md` capa **L0** exige "0 casos sin clasificar" en `docs/migration/parity-matrix.md`. La fuente es §2 de este documento: cada archivo recibe estado `portable | golden | contract | property | ui | descartado` (derivado de P/C/H/I/U/O) y lote L1–L5 (§5.2). La matriz se **genera** desde `parity/manifest.json`; no se mantiene a mano.
- El umbral normativo de shadow es el de **ADR-0012**: ≥ 99,9 % de decisiones idénticas durante 7 días consecutivos y 0 divergencias sin explicar. §4.10 y §5.3 lo detallan; el resto de divergencias (solo campos de timing/telemetría declarados) debe ser ≤ 0,1 % y estar justificado caso a caso.
- El esquema público de fixture `qvaapply.parity/v1` de `verification.md` §L1 es compatible con el JSON canónico v1 de §4.3–§4.4: el manifest declara `"schema": "qvaapply.parity/v1"` y el mapeo de campos es `caseId`↔`case`, `source`↔`source`, `input`↔`input`, `expect`↔`expect`.
- Si el plan maestro cambia nombres de servicio o de fases, se actualizan el manifest y las tablas §2.4/§5.2 **sin tocar goldens** (los goldens no dependen del nombre del servicio).

---

## 1. Línea base y hallazgos que condicionan el diseño

### 1.1 Comandos de medición (reproducibles)

```bash
# suite completa (evitar pnpm: el workspace puede estar read-only)
node --import tsx --test test/*.test.ts

# por archivo y contando casos con el reporter spec
node --import tsx --test test/risk-policy.test.ts | grep 'ℹ tests'

# baseline legible por máquina para CI (TAP no atribuye archivo: se aplana)
node --import tsx --test --test-reporter=junit \
  --test-reporter-destination=/tmp/qvaapply-baseline.xml test/*.test.ts
```

Nota verificada: el reporter `tap` de Node **no incluye el archivo** en cada subtest (se comprobó con dos archivos); para conteo por archivo hay que ejecutar por archivo o usar `junit`, cuyo `classname` sí lo incluye. El script de baseline debe generar `parity/baseline/ts-junit.xml` con 718 casos.

### 1.2 Hallazgos que condicionan el arnés

| # | Hallazgo | Evidencia | Consecuencia |
|---|---|---|---|
| H1 | **Sin helpers compartidos**: 95 archivos y 0 ficheros auxiliares; cada test construye sus fakes y su `Store` temporal. | `find test -maxdepth 1 -type d` vacío; `ls test \| grep -v '.test.ts'` = 0 | Los vectores se extraen por archivo; el generador debe descubrir setups duplicados y convertirlos en fixtures. |
| H2 | 643 `test()` estáticos → 718 casos por bucles. | p. ej. `test/manual-cancel-race.test.ts:38-87` (2×3=6 casos con template literal) | El `caseId` se deriva del título **expandido**; el generador ejecuta el test y registra el título final. |
| H3 | **La base QvaPay está hardcodeada** (`https://api.qvapay.com`). | `src/qvapay.ts:17`; los tests parchean `globalThis.fetch` o inyectan `fetch` (`src/qvapay.ts:71-90`, `test/login.test.ts:11-13`) | El SUT nuevo **debe** aceptar `QVAPAY_BASE_URL` y `CONFORMANCE_MODE`; el adaptador TS reescribe el host o inyecta `fetch`. |
| H4 | Ya existen costuras de inyección excelentes en el monolito: `QvaPayRuntime {fetch, now, sleep, monotonicNow, ...}`, `ports.ts`, `Store` sustituible por shim `{get,set}`, `Scheduler` con callbacks, `WebPushService` con runtime. | `src/qvapay.ts:71-90`, `src/core/ports.ts:5-72`, `test/market-list-budget.test.ts:5-11`, `test/qusd-balance-cache.test.ts:12-24` | El 100 % de P y gran parte de C se portan sin reescribir la intención del test. |
| H5 | La suite **no mide cobertura** (solo `knip`). | `package.json:24` | La paridad debe ser por casos obligatorios mapeados a casos de uso, no por porcentaje de líneas. Ver §5.3. |
| H6 | El OpenAPI se construye a mano y **no está testeado**. | `src/http-dashboard.ts:1164`, `:1365-1438`; sin referencias en `test/http-dashboard.test.ts` | Congelar `openapi.v1.json` + matriz de rutas como artefacto de contrato (§4.7). |
| H7 | Los tests de UI/estructura leen `.tsx`, `.css` y `src/*.ts` como texto y hacen `assert.match`. Pasan aunque el backend diverja. | `test/ui-recovery-regression.test.ts:5-9`, `test/dashboard-local-snapshot-regression.test.ts:5-16` | Nunca cuentan como señal de paridad del backend; se excluyen del score (§3.5). |
| H8 | Los tests de tiempo usan `Date.now()` real en 20+ archivos; algunos esperan con `setTimeout` real. | `test/operation-actions.test.ts:11`; recuento por archivo en §2.6 | Reloj virtual obligatorio en el SUT y casos «clockSensitive» con comparación semántica, no exacta (§4.3, §6.2). |
| H9 | Un test parchea `globalThis.fetch` (solo válido in-process). | `test/login.test.ts:11-13,37-40` | Para el SUT nuevo, el fake se ejerce como servidor HTTP real en loopback; el adaptador TS redirige el host. |

---

## 2. Inventario de los 95 archivos

### 2.0 Cómo leer las tablas

- **Casos:** ejecución real por archivo.
- **Deps:** `SQLite` = `new Store(...)` sobre `node:sqlite`; `HTTP` = `app.inject()`; `fetch` = `QvaPayRuntime.fetch` inyectado; `clock` = `now`/`sleep`/`monotonicNow` inyectados; `source` = lectura de código/HTML/CSS; `fs` = ficheros reales; `proc` = subproceso.
- **Reutilización:** **A** = golden directo; **B** = cassette/replay/HTTP scripted; **C** = solo property/metamorphic (tiempo/concurrencia no determinista); **D** = no portable.
- **Lote:** L1–L5 (§5.2). L1 y L2 primeras; L3 dinero; L4 mercado/lecturas; L5 no migra.

### 2.1 P — Puros portables (21 archivos, 107 casos)

| Archivo | Casos | Módulo bajo test | Deps | Reutilización | Lote |
|---|---:|---|---|:--:|:--:|
| `budget.test.ts` | 6 | `src/budget.ts` (plan proporcional, mínimo CUP) | — | A | L1 |
| `chat-stream.test.ts` | 2 | `src/chat-stream.ts` (parser SSE) | — | A | L1 |
| `cooperative-menu.test.ts` | 3 | `src/cooperative-menu.ts` (teclado/acciones) | — | A | L1 |
| `dashboard-controls.test.ts` | 3 | `src/dashboard.ts` (`DashboardReadModel` con fakes) | — | A | L1 |
| `dashboard-auth.test.ts` | 4 | `src/dashboard-auth.ts` (Origin, sesión, CSRF) | — | A | L1 |
| `dashboard.test.ts` | 3 | `src/dashboard.ts` (`marginCalculation`, `allocateBudget`) | — | A | L1 |
| `hunting-balance-loops.test.ts` | 1 | `src/application/hunting-balance-loops.ts` + `Scheduler` | clock | A | L1 |
| `hunting-requirements.test.ts` | 1 | `src/hunting-requirements.ts` | shim `{get,set}` | A | L1 |
| `liquidity-plan.test.ts` | 9 | `src/core/liquidity-plan.ts` | — | A | L1 |
| `market-hunting-loops.test.ts` | 13 | `src/application/market-hunting-loops.ts` + `Scheduler` | — | A | L1 |
| `market-history-compact.test.ts` | 1 | `src/dashboard.ts` (`compactMarketHistory`) | — | A | L1 |
| `market-list-budget.test.ts` | 9 | `src/market-list-budget.ts` | shim, clock | A | L1 |
| `market-math.test.ts` | 7 | `src/market-math.ts` (`median`, `outgoingFiatCost`, `ownOfferFiatTotal`) | — | A | L1 |
| `mobile-operator.test.ts` | 5 | `src/mobile-operator.ts` (repo + reloj inyectados) | clock | A | L1 |
| `monetary-intents.test.ts` | 5 | `src/application/monetary-intents.ts` (`MemoryIntentRepository`) | — | A | L1 |
| `qusd-balance-cache.test.ts` | 13 | `src/qusd-balance-cache.ts` | clock | A | L1 |
| `rate-rounding.test.ts` | 2 | `src/market-math.ts` (`roundRateForIndex`) | — | A | L1 |
| `risk-policy.test.ts` | 8 | `src/core/risk-policy.ts` (`evaluateRisk`) | — | A | L1 |
| `scheduler.test.ts` | 2 | `src/scheduler.ts` | clock | A | L1 |
| `telegram-menu.test.ts` | 5 | `src/telegram-menu.ts` | — | A | L1 |
| `telegram-runtime.test.ts` | 5 | `src/telegram-runtime.ts` | — | A | L1 |

**Por qué son portables:** todos operan sobre tipos planos y reciben el estado/reloj/IO por parámetro. No hay fuente de verdad externa. Son vectores `input → output` directos.

### 2.2 C — Contratos de adaptador (11 archivos, 74 casos)

| Archivo | Casos | Adaptador/módulo | Deps | Contrato K (03 §7) | Lote |
|---|---:|---|---|---|---|
| `chat-images.test.ts` | 7 | `src/chat-images.ts` + `QvaPayClient.downloadChatImage` | fetch | K7 | L2 |
| `login.test.ts` | 11 | `src/application/qvapay-login.ts` + `QvaPayClient.login` | fetch (global) | K1 | L2 |
| `qusd-read-timing.test.ts` | 2 | `QvaPayClient.qusdBalance` + telemetría | fetch, clock | K2/K12 | L2 |
| `qvapay-feed-stream.test.ts` | 5 | `src/qvapay-feed-stream.ts` (SSE) | fetch, clock | K6 | L2 |
| `qvapay-gateway.test.ts` | 27 | `src/qvapay.ts` (colas, cuotas, errores) | fetch, clock | K2/K3/K4/K7 | L2 |
| `qvapay-list-budget.test.ts` | 6 | `QvaPayClient.profile/listOffersPage` + `ListingReadBudget` | fetch, clock, shim | K2 | L2 |
| `qvapay-list-isolation.test.ts` | 2 | `QvaPayClient` (identidad de listado) | fetch | K2 | L2 |
| `qvapay-list-timing.test.ts` | 3 | `QvaPayClient` (timing de lista) | fetch, clock | K2 | L2 |
| `qvapay-operation-timing.test.ts` | 5 | `src/operation-trace.ts` + `QvaPayClient` | fetch, clock | K3/K4 | L2 |
| `telegram-recovery.test.ts` | 1 | `src/telegram-recovery.ts` (grammy fake API) | — | K14 | L2 |
| `web-push.test.ts` | 5 | `src/web-push.ts` (VAPID runtime inyectado) | — | K14 | L2 |

**Por qué son B:** la intención del test es el contrato de frontera, no la implementación. Se reescriben una vez como cassette/escenario HTTP (QvaPay) o fixture de runtime (push/Telegram) y valen para cualquier lenguaje.

### 2.3 H — Superficie HTTP (9 archivos, 39 casos)

| Archivo | Casos | Rutas/área | Deps | Lote |
|---|---:|---|---|:--:|
| `bulk-dismiss-http.test.ts` | 1 | `POST /api/audit/dismiss-all` | HTTP | L2 |
| `cooperative-hunter-http.test.ts` | 1 | `/api/cooperative-network/executions/check` | HTTP | L2 |
| `http-dashboard.test.ts` | 26 | sesión, CSRF, control, push, recovery, estáticos, webhook | HTTP, SQLite | L2 |
| `mobile-action-http-budget.test.ts` | 1 | acciones móviles (rate limit) | HTTP | L2 |
| `mobile-tools.test.ts` | 3 | `/api/mobile/*` (overview, tools) | HTTP | L2 |
| `operation-chat-http.test.ts` | 3 | `/api/operations/:uuid/chat` | HTTP | L2 |
| `self-service-recovery-http.test.ts` | 2 | `/api/recovery*` | HTTP | L2 |
| `static-assets.test.ts` | 1 | servido comprimido/ETag/HEAD | fs, HTTP | L2 |
| `trading-analytics-http.test.ts` | 1 | `/api/analytics` | HTTP, SQLite | L2 |

**Contrato congelado:** el plan de migración debe preservar los **109 endpoints efectivos** documentados en `03-boundaries.md` §4.3 (102 declaraciones + 7 rutas duplicadas por el bucle de `src/http-dashboard.ts:915-977`). El arnés no reescribe los tests: los convierte en pares `request → response` canónicos contra el adaptador HTTP.

### 2.4 I — Integración durable TS (42 archivos, 470 casos)

| Archivo | Casos | Módulo(s) | Deps | Servicio destino | Reutilización | Lote |
|---|---:|---|---|---|---|:--:|:--:|
| `application-reservations.test.ts` | 2 | reservas de aplicación (`store.ts`) | SQLite | `money-core` | B | L3 |
| `architecture-regression.test.ts` | 4 | `trading.ts`, `dashboard.ts`, `market-config.ts` | SQLite | `money-core`/`dashboard-bff` | B | L3 |
| `assisted-payment.test.ts` | 13 | `assisted-payment.ts` + HTTP | SQLite, HTTP | `money-core`/`gateway` | B | L3 |
| `chat-orders-push.test.ts` | 6 | `chat-push.ts`, `operation-chat.ts` | SQLite | `notifier` | B | L4 |
| `config-integrity-performance.test.ts` | 2 | `market-config.ts`, `store.ts` | SQLite | `config-registry` | B | L3 |
| `cooperative-capital.test.ts` | 16 | `trading.ts`, `store.ts`, `market-config.ts` | SQLite | `money-core` | B | L3 |
| `cooperative-hunter.test.ts` | 6 | `cooperative-hunter.ts` | SQLite | `sync-coop-adapter` | B | L4 |
| `core.test.ts` | 26 | `trading.ts`, `store.ts`, `vault.ts`, `qvapay.ts` | SQLite, fetch | `money-core` | B | L3 |
| `dashboard-market-observation.test.ts` | 3 | `dashboard.ts`, `market-config.ts` | SQLite | `market-ingest` | B | L4 |
| `dashboard-rebalance.test.ts` | 5 | `dashboard.ts`, `market-config.ts`, `qvapay.ts` | SQLite, fetch | `market-ingest`/`money-core` | B | L4 |
| `flexible-fiat.test.ts` | 7 | `trading.ts`, `store.ts` | SQLite | `money-core` | B | L3 |
| `flexible-order.test.ts` | 5 | `flexible-order.ts`, `qvapay.ts`, `store.ts` | SQLite, fetch | `money-core` | B | L3 |
| `hunting-pause.test.ts` | 7 | `market-config.ts`, `store.ts`, `trading.ts` | SQLite | `money-core`/`market-ingest` | B | L3 |
| `hunting-query-performance.test.ts` | 3 | `store.ts` (índices) | SQLite | `money-core`/`audit` | C | L4 |
| `hunting-sync.test.ts` | 17 | `hunting-sync.ts`, `store.ts`, `vault.ts` | SQLite, fetch, fs | `sync-coop-adapter` | B | L4 |
| `manual-cancel-exclusion.test.ts` | 9 | `trading.ts`, `market-config.ts` | SQLite | `money-core` | B | L3 |
| `manual-cancel-race.test.ts` | 31 | `trading.ts`, `qvapay.ts`, `store.ts` | SQLite, fetch, clock | `money-core` | B (algunas C) | L3 |
| `market-accounts.test.ts` | 3 | `market-accounts.ts`, `vault.ts` | SQLite, fs | `market-ingest` | B | L4 |
| `market-feed-shutdown.test.ts` | 1 | `market-feed.ts`, `market-source.ts` | SQLite | `market-ingest` | B | L4 |
| `market-feed.test.ts` | 20 | `market-feed.ts`, `market-source.ts`, HTTP | SQLite, HTTP | `market-ingest` | B | L4 |
| `market-ingest-serialization.test.ts` | 9 | `market-source.ts`, `trading.ts` | SQLite, fetch | `market-ingest` | B | L4 |
| `market-poll-timing.test.ts` | 2 | `market-source.ts`, `market-accounts.ts` | SQLite, clock | `market-ingest` | C | L4 |
| `market-reader-identity.test.ts` | 7 | `market-accounts.ts`, `qvapay.ts` | SQLite, fetcn | `market-ingest` | B | L4 |
| `market-source.test.ts` | 18 | `market-source.ts`, `market-accounts.ts` | SQLite, fetch | `market-ingest` | B | L4 |
| `mobile-operation-status.test.ts` | 8 | `mobile-operator.ts`, `chat-catalog.ts` | SQLite | `gateway`/`chat-service` | B | L4 |
| `notification-dispatcher.test.ts` | 7 | `notification-dispatcher.ts` | SQLite | `notifier` | B | L4 |
| `offer-latency.test.ts` | 1 | `trading.ts`, `qvapay.ts` (latencia recepción→POST) | SQLite, clock | `money-core` | C | L3 |
| `operation-actions.test.ts` | 9 | `trading.ts`, `qvapay.ts`, `store.ts` | SQLite, fetch, clock | `money-core` | B | L4 |
| `operation-chat.test.ts` | 11 | `operation-chat.ts`, `qvapay.ts` | SQLite, fetch | `chat-service` | B | L4 |
| `operational-insights.test.ts` | 8 | `operational-insights.ts`, `notification-dispatcher.ts`, HTTP | SQLite, HTTP | `decisions`/`dashboard-bff` | B | L4 |
| `opportunity-orchestrator.test.ts` | 19 | `application/opportunity-orchestrator.ts` | SQLite, fetch | `money-core` | B | L3 |
| `payment-sms.test.ts` | 24 | `payment-sms.ts`, `qvapay.ts`, `store.ts` | SQLite, fetch, clock | `money-core` | B | L3 |
| `practical-tools.test.ts` | 7 | `trading-analytics.ts`, `price-simulation.ts`, HTTP | SQLite, HTTP | `analytics` | B | L4 |
| `qusd-readiness-integration.test.ts` | 12 | `trading.ts`, `market-config.ts` | SQLite, fetch, clock | `money-core` | B | L3 |
| `reconciliation-feed.test.ts` | 13 | `self-service-recovery.ts`, `qvapay.ts`, `trading.ts` | SQLite, fetch | `money-core` | B | L3 |
| `reconciliation-scheduler.test.ts` | 5 | `reconciliation-scheduler.ts`, `store.ts` | SQLite | `money-core` | B | L3 |
| `repository.test.ts` | 20 | `store.ts` (esquema v31, migraciones, índices) | SQLite | `money-core`/`audit` | D (ver 02) | L3 |
| `self-service-recovery.test.ts` | 13 | `self-service-recovery.ts`, `store.ts` | SQLite | `money-core` | B | L3 |
| `self-service-store.test.ts` | 10 | `store.ts` (dismiss masivo/versionado) | SQLite | `decisions`/`money-core` | B | L3 |
| `telegram-operation.test.ts` | 4 | `telegram-operation.ts`, `store.ts` | SQLite | `notifier` | B | L4 |
| `trading-analytics.test.ts` | 18 | `trading-analytics.ts`, `dashboard.ts` | SQLite | `analytics` | B | L4 |
| `trading-automation.test.ts` | 59 | `trading.ts`, `qvapay.ts`, `market-config.ts` | SQLite, fetch, clock | `money-core` | B | L3 |

**Lectura clave:** 298 de los 470 casos I (L3) contienen las invariantes de dinero. No se pueden «copiar» como tests, pero sí **instrumentar**: el driver arranca el oráculo TS, ejecuta la secuencia del test original con reloj/IDs fijados y captura la traza canónica (decisiones, mutaciones, estado persistido) como caso de replay. El test original sigue verde en TS; el replay es el que se compara contra Go/Rust.

### 2.5 U/O — No aplican al backend (12 archivos, 28 casos)

| Archivo | Casos | Tipo | Deps | Motivo | Lote |
|---|---:|---|---|---|---|
| `chart-domain.test.ts` | 2 | U (web/lib) | — | Lógica de presentación de gráfica; no es backend | L5 |
| `dashboard-bootstrap.test.ts` | 2 | U (web/lib) | — | Consumo del bootstrap del navegador | L5 |
| `dashboard-bootstrap-regression.test.ts` | 3 | U (source) | source | `assert.match` sobre `web/main.jsx`, hooks | L5 |
| `dashboard-local-snapshot-regression.test.ts` | 1 | U (source) | source | Verifica estructura interna de `src/dashboard.ts` | L5 |
| `server-dashboard-cache-regression.test.ts` | 3 | U (source) | source | `assert.match` sobre `web/hooks`, `src/index.ts` | L5 |
| `telegram-menu-regression.test.ts` | 2 | U (source) | source | Regex sobre `src/telegram-menu.ts` | L5 |
| `ui-recovery-regression.test.ts` | 4 | U (source) | source | Regex sobre `.jsx`/`.css` | L5 |
| `web-layout-regression.test.ts` | 4 | U (source) | source | Regex sobre `.jsx`/`.css` | L5 |
| `web-operation-actions.test.ts` | 1 | U (web/lib) | — | Mapeo de body de acciones del navegador | L5 |
| `deployment-cleanup.test.ts` | 3 | O (bash) | proc, fs | `scripts/cleanup-vps.sh` con Docker simulado | L5 |
| `deployment-domain.test.ts` | 1 | O | fs | Regex sobre nginx/TLS/provision | L5 |
| `hunting-latency-report.test.ts` | 2 | O | SQLite, fs | `scripts/report-hunting-latency.mjs` | L5 |

**Decisión:** estos 28 casos **no entran en el score de paridad del backend**. Se conservan en el monorepo mientras exista el frontend/scripts TS. Sustitución futura: `scripts/visual-smoke.mjs` (Chromium + axe-core, `scripts/visual-smoke.mjs:6,8-9`) y tests de contrato de nginx/deploy si se reescribe el despliegue.

### 2.6 Dependencias agregadas (recuento para dimensionar el arnés)

- **43/95 archivos** usan `Store` real (`node:sqlite`): no hay abstracción de DB en la suite; el puerto `TradingRepository` (`src/core/ports.ts:28-72`) existe en producción pero los tests usan la clase concreta.
- **30/95** hacen aserciones dependientes de reloj real o virtual (`Date.now`, `setTimeout`, `now` inyectado); los más intensivos: `trading-automation` (41), `payment-sms` (40), `manual-cancel-exclusion` (13), `self-service-recovery` (13), `cooperative-capital` (12), `core` (12), `manual-cancel-race` (9), `flexible-fiat` (9), `cooperative-hunter` (9).
- **13/95** usan `app.inject` (Fastify): el contrato HTTP es ejercitable in-process, lo que permite extraer goldens sin levantar red.
- **9/95** leen fuentes; **1** lanza subprocesos.
- Solo **1 archivo** usa `Math.random`/UUID (`http-dashboard.test.ts:2,286`), y es para un nombre de asset estático; el universo de IDs generados es, por tanto, controlable.

---

## 3. Taxonomía y portabilidad

### 3.1 Definiciones operativas

| Término | Definición |
|---|---|
| **Oráculo** | Implementación TypeScript congelada (commit + hash de `src/`) que produce las respuestas esperadas. |
| **SUT** | *System under test*: servicio Go/Rust (o el propio TS en auto-paridad). |
| **Caso** | Unidad de comparación: `input` canónico + `expect` canónico + metadatos de normalización. |
| **Golden** | Serialización inmutable del `expect` del oráculo para un caso. |
| **Cassette** | Secuencia scriptada de respuestas del fake QvaPay para un escenario de contrato. |
| **Replay** | Secuencia de eventos/decisiones grabada del sistema TS, rebasada en el tiempo, que se reejecuta contra el SUT. |
| **Paridad** | Cociente medible entre casos obligatorios superados y casos obligatorios totales (§5.3). |

### 3.2 Portables tal cual — 107 casos (21 archivos)

Núcleo inmediato, sin dependencias externas:

| Grupo funcional | Casos | Archivos | Op CLI propuesta |
|---|---:|---|---|
| Riesgo | 8 | `risk-policy.test.ts` | `risk.evaluate` |
| Redondeo/tasas/matemática de mercado | 19 | `market-math.test.ts` (7), `rate-rounding.test.ts` (2), `dashboard.test.ts` (3), `market-history-compact.test.ts` (1), `budget.test.ts` (6) | `market.math`, `budget.allocate` |
| Liquidez | 9 | `liquidity-plan.test.ts` | `liquidity.plan` |
| Presupuesto de listados | 9 | `market-list-budget.test.ts` | `budget.list` |
| Intenciones monetarias | 5 | `monetary-intents.test.ts` | `intents.execute` |
| Caché de saldo QUSD | 13 | `qusd-balance-cache.test.ts` | `cache.qusd` |
| Orquestación de schedulers | 16 | `hunting-balance-loops.test.ts` (1), `market-hunting-loops.test.ts` (13), `scheduler.test.ts` (2) | `scheduler.run` |
| Requisitos de cacería | 1 | `hunting-requirements.test.ts` | `hunt.requirements` |
| Auth de panel | 4 | `dashboard-auth.test.ts` | `auth.origin` |
| Control de dashboard (con fakes) | 3 | `dashboard-controls.test.ts` | `usecase.dashboard-controls` |
| Operador móvil | 5 | `mobile-operator.test.ts` | `auth.mobile-operator` |
| Telegram (menú/runtime) | 10 | `telegram-menu.test.ts` (5), `telegram-runtime.test.ts` (5) | `telegram.menu`, `telegram.runtime` |
| Menú cooperativo | 3 | `cooperative-menu.test.ts` | `telegram.coop-menu` |
| SSE de chat (parser) | 2 | `chat-stream.test.ts` | `sse.chat` |

**Criterio de "tal cual":** el cuerpo del test actual se puede traducir a `{input, expect}` sin cambiar la intención. Ejemplo de contrato exacto: `evaluateRisk` debe devolver los mismos `checks`, `kind`, `reasons`, `projectedExposureQusd` y `projectedDailyAppliedQusd` (`01-domain.md` §5.2, ítem 1; `src/core/risk-policy.ts:64-90`).

### 3.3 Portables con adaptación — 113 casos (20 archivos)

| Grupo | Casos | Archivos | Adaptación |
|---|---:|---|---|
| Contrato QvaPay | 56 | `qvapay-gateway` (27), `qvapay-list-*` (11), `qusd-read-timing` (2), `qvapay-operation-timing` (5), `login` (11) | cassette + protocolo de ops `qvapay.*` |
| SSE feed | 5 | `qvapay-feed-stream.test.ts` | cassette SSE (fragmentos/retry/429) |
| Imágenes/chat | 7 | `chat-images.test.ts` | cassette de descarga + validadores puros |
| Push/Telegram | 6 | `web-push.test.ts` (5), `telegram-recovery.test.ts` (1) | fixture de runtime + fake Bot API |
| HTTP superficie | 39 | 9 archivos H | adaptador HTTP + contrato OpenAPI congelado |

La adaptación es **mecánica**: cada caso se reescribe una vez como JSON de caso/cassette, no se traduce el código de test.

### 3.4 Reformulables mediante replay/golden extraído — 470 casos (42 archivos)

Se resuelven con tres instrumentos, en este orden de preferencia:

1. **Golden directo ampliado (A/B):** si el test termina en una llamada pura (p. ej. `planLiquidity`, `proportionalBudgetPlan`) o en una respuesta HTTP determinista, se extrae el par exacto.
2. **Driver de replay stateful (B):** si el test ejecuta una secuencia con efectos (reserva → intención → POST → respuesta → conciliación), se graba la secuencia de operaciones y el estado final. El SUT recibe la misma secuencia con reloj y IDs fijados; se comparan decisiones, llamadas upstream y digest de estado (§4.6, §4.12).
3. **Property/metamorphic (C):** si el test depende de interleaving o umbrales temporales (`manual-cancel-race` parcial, `offer-latency`, `hunting-query-performance`, `market-poll-timing`), se convierte en propiedad de orden/estado, no en comparación byte a byte.

Prioridad de extracción (dinero primero):

| Prioridad | Archivos | Casos | Motivo |
|---|---:|---:|---|
| 1 | `trading-automation` (59), `opportunity-orchestrator` (19), `manual-cancel-race` (31), `payment-sms` (24), `core` (26), `flexible-*` (12), `manual-cancel-exclusion` (9), `cooperative-capital` (16), `application-reservations` (2), `reconciliation-*` (18), `self-service-recovery` (13), `qusd-readiness-integration` (12), `repository` (20) | 261 | Reserva, doble gasto, compensación, conciliación |
| 2 | `market-source` (18), `market-feed` (20), `market-ingest-serialization` (9), `market-reader-identity` (7), `market-poll-timing` (2), `market-accounts` (3), `market-feed-shutdown` (1), `dashboard-market-observation` (3), `dashboard-rebalance` (5) | 68 | Ingesta/dedupe/lecturas |
| 3 | `notification-dispatcher` (7), `chat-orders-push` (6), `operation-chat` (11), `mobile-operation-status` (8), `telegram-operation` (4), `operational-insights` (8) | 44 | Avisos/chat (no dinero, pero afectan operación) |
| 4 | `trading-analytics` (18), `practical-tools` (7), `hunting-sync` (17), `cooperative-hunter` (6), `operation-actions` (9), `assisted-payment` (13), `hunting-pause` (7), `config-integrity-performance` (2), `hunting-query-performance` (3), `offer-latency` (1), `architecture-regression` (4), `self-service-store` (10) | 97 | Resto (algunas se solapan por dependencias) |

Las cuatro filas suman 470 casos (261 + 68 + 44 + 97): el total exacto de la categoría I. El lote final por archivo está en §5.2.

### 3.5 No aplican — 28 casos (12 archivos)

Los 9 U + 3 O de §2.5. Regla dura: **si un caso afirma sobre el texto de un `.tsx`, `.css` o sobre la forma de una función fuente, no es evidencia de paridad del backend**. Se mantienen para proteger el frontend actual, pero:

- no suman al `parity score`;
- no se pueden usar para aprobar un servicio Go/Rust;
- se retiran cuando el frontend se reescriba, sin sustituirlos por tests equivalentes (la cobertura pasa a `visual-smoke`/E2E).

### 3.6 Puertos y puntos de inyección existentes (seam de migración)

| Puerto actual | Archivo | Uso en el arnés |
|---|---|---|
| `QvaPayGateway` (15 ops) | `src/core/ports.ts:8-25` | Catálogo de ops `qvapay.*` y cassettes K2/K3/K4/K7. |
| `TradingRepository` (~40 métodos) | `src/core/ports.ts:28-72` | Se parte según `01-domain.md` §5.2 ítem 5; el replay usa la interfaz estrecha de cada op. |
| `QvaPayRuntime {fetch, now, sleep, monotonicNow, throttles}` | `src/qvapay.ts:71-90`, constructor `:151-167` | Reloj virtual, fetch redirigido al fake, telemetría capturada. |
| `Store` con shim `{get,set}` en tests de presupuesto/caché | `test/market-list-budget.test.ts:5-11` | Fixtures de estado persistentes y ops `budget.list`/`cache.qusd`. |
| `Scheduler` con callbacks | `src/scheduler.ts` | Ops `scheduler.run` deterministas. |
| `WebPushService(runtime)` | `src/web-push.ts`; `test/web-push.test.ts:10-24` | Fixture de runtime push (sin red). |
| `buildDashboard(readModel, options)` | `src/http-dashboard.ts`; `test/http-dashboard.test.ts:21-24` | Adaptador HTTP in-process para auto-paridad; SUT HTTP real después. |

**Huecos a resolver en el SUT nuevo (bloqueantes):**

1. `QVAPAY_BASE_URL` configurable (hoy `src/qvapay.ts:17`).
2. `CONFORMANCE_MODE=1` que active reloj inyectable, IDs deterministas y timeouts escalados, **sin cambiar la lógica financiera**.
3. CLI/HTTP de conformidad compilado solo en el build de CI (feature de Rust / build tag de Go), **no incluido en la imagen de producción**.
4. Digest de estado legible (`stateDigest`) para verificar reservas/intenciones sin leer Postgres desde el runner.

### 3.7 Mapa invariante → tests actuales → estrategia cross-language

Invariantes de `docs/ARCHITECTURE.md:75-90` y `01-domain.md` §3. Esta tabla es el contrato de aceptación del arnés.

| ID | Invariante | Tests que la cubren hoy | Estrategia |
|---|---|---|---|
| INV-01 | Una sola reserva QUSD (`risk.minQusdReserve`); reserva de aplicación única por intención/operación | `test/application-reservations.test.ts:8-25`, `test/risk-policy.test.ts:42-76`, `test/cooperative-capital.test.ts`, `test/trading-automation.test.ts`, `test/qusd-readiness-integration.test.ts` | Replay stateful + property INV-01 (§4.9) |
| INV-02 | No doble gasto: dos decisiones concurrentes sobre el mismo capital no generan dos `apply` | `test/manual-cancel-race.test.ts:38-87`, `test/cooperative-capital.test.ts:31-42`, `test/trading-automation.test.ts:114`, `test/opportunity-orchestrator.test.ts` | Property state-machine + digests; log upstream exacto |
| INV-03 | Intención durable antes de la mutación externa | `test/monetary-intents.test.ts:71-80`, `test/application-reservations.test.ts:8-18`, `test/payment-sms.test.ts:50-80` | Orden en el log de eventos + request log del fake |
| INV-04 | Compensación solo tras rechazo confirmado o conciliación no aplicada | `test/opportunity-orchestrator.test.ts:94,132,422,515`, `test/flexible-fiat.test.ts`, `test/flexible-order.test.ts` | Property INV-04 + replay de los 19 casos del orquestador |
| INV-05 | Resultado incierto no se reintenta ni compensa hasta conciliar | `test/opportunity-orchestrator.test.ts:422`, `:478`; `test/manual-cancel-race.test.ts:13-36`; `test/qvapay-gateway.test.ts:29-35` | Cassette ambiguo + property de quiescencia |
| INV-06 | Redondeo: CUP compras `floor` múltiplo de 10, ventas `ceil`; no-CUP escala 1e-8; mínimo 0,1 QUSD; presupuesto exacto | `test/market-math.test.ts:28-48`, `test/rate-rounding.test.ts:5-13`, `test/budget.test.ts`, `test/flexible-order.test.ts` | Golden directo + property numérica INV-06 |
| INV-07 | Precedencia de decisión y monotonía: `ignored > manual_review > blocked > apply`; añadir fallos no autoriza | `test/risk-policy.test.ts:78-132`, `src/core/risk-policy.ts:212-220` | Golden + property de monotonía |
| INV-08 | Oferta propia se repone con la misma instantánea y clave idempotente | `test/opportunity-orchestrator.test.ts:594`, `test/manual-cancel-exclusion.test.ts` | Replay + request log (idempotency key) |
| INV-09 | No se inicia operación si hay mutación sin resolver | `test/risk-policy.test.ts:52-76`, `test/manual-cancel-race.test.ts:13-36` | Golden + replay |
| INV-10 | Warnings (slippage/cooldown) no bloquean; límites duros sí | `test/risk-policy.test.ts:104-132` | Golden directo |
| INV-11 | Errores consecutivos pausan persistentemente | `test/hunting-pause.test.ts`, `test/trading-automation.test.ts:1376` | Replay stateful |
| INV-12 | Lectura remota fallida nunca borra ni presenta como actual la última válida | `test/market-feed.test.ts`, `test/market-reader-identity.test.ts`, `test/self-service-recovery.test.ts` | Replay + property de preservación |
| INV-13 | Una ronda no aplica más de una oportunidad; una bloqueada no oculta la siguiente | `test/trading-automation.test.ts:65,407,1159`, `test/market-source.test.ts` | Replay de páginas |
| INV-14 | El refresco no edita más de una oferta propia por ejecución | `test/trading-automation.test.ts`, `test/market-feed.test.ts` | Replay + request log |
| INV-15 | Mínimo de venta neto por mercado > máximo de compra | `test/trading-automation.test.ts:263`, `test/market-math.test.ts` | Golden + property INV-06 |
| INV-16 | Secretos/interruptores de despliegue no son configuración operativa editable | `test/config-integrity-performance.test.ts`, `test/http-dashboard.test.ts` | Contrato HTTP + config-registry parity |

---

## 4. Diseño del arnés de paridad

### 4.1 Principios y vocabulario

1. **La suite TS no se toca.** Es el oráculo y la red de seguridad del monolito hasta el cutover.
2. **Un caso = un JSON.** Nada de código compartido entre SUT y runner; solo contrato de datos.
3. **El SUT es opaco.** El runner solo ve HTTP o el protocolo CLI; no importa paquetes Go/Rust ni lee su código.
4. **Estricto por defecto.** Request inesperado al fake, campo extra en golden, mutación no declarada o estado no verificado = fallo.
5. **Determinista.** Reloj virtual, IDs fijados, orden total explícito, sin red, `TZ=UTC`, `LC_ALL=C`.
6. **Trazable.** Cada caso cita el test fuente (`sourceTest`) y el documento de dominio; cada reporte lleva commit del SUT y hash de goldens.

### 4.2 Arquitectura y topología

```text
                    ┌──────────────────────────────────────────┐
                    │ parity/runner (Node)                │
                    │  carga casos → invoca adaptador →        │
                    │  canoniza → compara → parity-report.json │
                    └───────┬───────────────┬──────────────────┘
                            │               │
              ┌─────────────▼───┐     ┌─────▼─────────────────┐
              │ adapter CLI v1  │     │ adapter HTTP v1       │
              │ stdin/stdout    │     │ cookie/CSRF/Bearer    │
              │ NDJSON          │     │ + OpenAPI congelado   │
              └───┬───────┬─────┘     └─────┬─────────────────┘
                  │       │                 │
        ┌─────────▼──┐  ┌─▼──────────────┐  │
        │ ts-cli     │  │ Go/Rust        │  │
        │ (oráculo)  │  │ conformance    │  │
        └─────────┬──┘  │ binary         │  │
                  │     └───────┬────────┘  │
                  └─────────────┼───────────┘
                                │
                    ┌───────────▼────────────────────────────┐
                    │ fake-qvapay (cassette estricto, reloj  │
                    │ virtual, log de requests) + fake SSE   │
                    │ + fake Telegram/push (fixtures)        │
                    └────────────────────────────────────────┘
```

- **`ts-cli`:** ejecuta los módulos actuales (`risk-policy`, `budget`, `liquidity-plan`, `applications/*`, `qvapay.ts` con `QvaPayRuntime` inyectado) y responde por stdout. Sirve para generar goldens y para auto-paridad.
- **`ts-http`:** arranca `buildDashboard()` in-process y expone el adaptador HTTP; permite validar la suite H antes de que exista el gateway nuevo.
- **`http`:** cliente genérico contra un servicio real en `127.0.0.1:<port>`.
- **`cli`:** lanza `./conformance-sut --protocol=1` (Go/Rust) y habla NDJSON.

### 4.3 JSON canónico v1 (`canonicalVersion: 1`)

Reglas de normalización, aplicadas por el runner **a la salida real** y por el generador **a la salida del oráculo**:

| # | Regla | Detalle |
|---|---|---|
| 1 | Codificación | UTF-8 sin BOM, LF, sin tabulaciones; strings NFC. |
| 2 | Orden de claves | Alfabético por code point en todos los objetos (comparación estructural; el orden en fichero es cosmético). |
| 3 | **Decimales** | Ningún campo monetario/tasa/porcentaje se compara como `float`. Se serializa como **string decimal de escala fija** con patrón `^-?(0\|[1-9][0-9]*)(\.[0-9]{s})?$`, declarado por `x-qva-scale` en el schema. Ej.: QUSD `"20.00000000"` (escala 8), CUP `"9700"` (escala 0), tasa USD `"1.04800000"`, porcentaje `"2.0000"`. |
| 4 | Enteros | Solo para conteos, índices de página, flags numéricos legacy, epoch ms. Nunca para dinero. |
| 5 | Epoch | `created_at`/`updated_at`/`now` son enteros ms. Si el caso fija `clock.now`, los campos derivados deben ser exactamente `clock.now ± delta`; si no, se normalizan a `delta` y se comparan como enteros. |
| 6 | IDs | Los campos `x-qva-id` presentes en la entrada se comparan exactos. Los generados se representan `"$uuid"`, `"$uuid#1"`, `"$token48"` y se comparan por patrón + unicidad; nunca por valor. |
| 7 | Enums | Strings exactos; los estados abiertos (`P2pStatus` es `string`) se conservan tal cual, incluidos valores desconocidos (`src/types.ts:16-23`). |
| 8 | Arrays | `order: "strict"` solo si el orden es semántico; si no, `order: "by:<campo>"` o `order: "set"` (multiconjunto). |
| 9 | `null` vs ausente | Son distintos. El generador normaliza `undefined` a campo **ausente** y `null` a `null`; el schema declara cuáles son obligatorios. |
| 10 | Errores | Se comparan `{"class","status","code","retryable"}`. El texto humano (`message`) se excluye salvo que sea contrato de producto (p. ej. razones de riesgo, que sí se congelan). |
| 11 | Campos extra | Golden: prohibidos. Contrato HTTP: `additionalProperties: "ignore"` solo si el schema lo declara explícitamente. |
| 12 | Rangos no finitos | `NaN`/`Infinity` nunca se serializan; el SUT debe devolver error tipado. El oráculo lanza (`test/risk-policy.test.ts:158-162`); el contrato de la op define `{"error":{"class":"validation"}}`. |

**Extensiones de schema propias (JSON Schema 2020-12):**

```json
{
  "$id": "https://qvaapply.local/parity/v1/risk-decision.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["kind", "requiredQusd", "requiredFiat", "checks", "reasons"],
  "properties": {
    "kind": { "enum": ["apply", "manual_review", "blocked", "ignored"] },
    "requiredQusd": { "type": "string", "x-qva-decimal": 8,
                      "pattern": "^-?(0|[1-9][0-9]*)\\.[0-9]{8}$" },
    "requiredFiat": { "type": "string", "x-qva-decimal": 0,
                      "pattern": "^-?(0|[1-9][0-9]*)$" },
    "checks": { "type": "array", "items": { "$ref": "risk-check.schema.json" } },
    "reasons": { "type": "array", "items": { "type": "string" } }
  }
}
```

El runner valida **golden y real** contra el schema. Un fallo de validación es un fallo del caso (evita que un cambio de tipo pase como «número distinto»).

**Tabla de escalas canónicas (alineada con `02-persistence.md` §5.4 y `01-domain.md` §1.3):**

| Campo | Escala | Evidencia / semántica |
|---|---:|---|
| QUSD (`qusd`, `amount`, `receive` en QUSD, reservas) | 8 | `Math.round(v*1e8)/1e8` (`src/market-math.ts:112-114`, `src/core/liquidity-plan.ts:285-286`) |
| Fiat CUP | 0 | múltiplo de 10 en ofertas propias; enteros en tasas/límites |
| Fiat USD (CLASICA, BANDECPREPAGO) | 2 | precios y comisiones fiat se muestran/persisten con 2 decimales |
| Tasas CUP/QUSD | 0–8 según índice | `roundRateForIndex` usa los decimales del índice configurado (`src/market-math.ts:78-94`) |
| Tasas USD/QUSD | 8 | dominio usa double; se congela cuantizado a 1e-8 |
| Porcentajes (slippage, margen, guard) | 4 (6 en DB) | `NUMERIC(9,6)` propuesto en `02-persistence.md` §5.3; comparación exacta tras cuantizar |
| Epoch ms | entero | comparaciones de ventana 60 s, backoff, cooldown |

**Nota crítica — deuda de `float`:** el dominio actual calcula con `double` y aplica `Math.round`; Go/Rust usarán decimal. La paridad se define **después de cuantizar a la escala del campo**, no en el double intermedio. Los casos con tie ambiguo (`.5` en el dígito de redondeo) se generan explícitamente como vectores de borde (§4.9, INV-06) para forzar la misma regla: `half-away-from-zero` a escala 8 (`02-persistence.md` §5.4). Las tolerancias `1e-7/1e-6/1e-8` del código actual **no se trasladan** al SUT: se convierten en casos de borde que deben producir el mismo resultado cuantizado.

### 4.4 Golden files: formato, manifest, versionado y regeneración

**Layout por suite (NDJSON ordenado por `caseId`):**

```text
parity/golden/v1/
├── manifest.json
├── pure/
│   ├── risk/evaluate-risk.ndjson
│   ├── market/math.ndjson
│   ├── budget/allocate.ndjson
│   ├── budget/list.ndjson
│   ├── liquidity/plan.ndjson
│   ├── intents/execute.ndjson
│   ├── cache/qusd.ndjson
│   ├── scheduler/run.ndjson
│   ├── auth/origin.ndjson
│   ├── telegram/menu.ndjson
│   └── sse/chat.ndjson
├── contract/
│   ├── qvapay/gateway.ndjson
│   ├── qvapay/list.ndjson
│   ├── qvapay/errors.ndjson
│   ├── qvapay/feed-sse.ndjson
│   ├── auth/login.ndjson
│   ├── push/web-push.ndjson
│   └── telegram/recovery.ndjson
├── http/
│   ├── session.ndjson
│   ├── routes-auth-matrix.ndjson
│   ├── dashboard.ndjson
│   ├── mobile.ndjson
│   └── webhook.ndjson
├── replay/
│   ├── market-feed/2026-11-12.ndjson
│   ├── decisions/2026-11-12.ndjson
│   └── money-core/fixtures.ndjson
└── bugs/            # contador ejemplos de property tests, nunca se borran
```

**Registro de caso (una línea NDJSON): `kind: "pure"`**

```json
{"schema":"qvaapply.parity/v1","caseId":"pure/risk/0001","kind":"pure","op":"risk.evaluate","source":"test/risk-policy.test.ts:42","spec":"01-domain.md#44-evaluación-de-riesgo","input":{"now":1788744000000,"opportunity":{"uuid":"offer-1","market":"BANK_CUP","side":"sell_qusd","qusdAmount":"20.00000000","requiredFiat":"20000","quotedRate":"1010","referenceRate":"1005","observedAt":1788743995000,"counterpartyId":"peer-1"},"limits":{"maxQusdPerOperation":"25.00000000","minQusdReserve":"10.00000000"},"priceDecision":"eligible","priceReason":"Supera el mínimo de venta.","expectedMarginPercent":"2.0000","qusdBalance":"100.00000000","fiatAvailable":"100000","concurrentQusdExposure":"5.00000000","dailyAppliedQusd":"20.00000000","activeOperations":1,"consecutiveErrors":0,"paused":false,"emergencyStop":false,"hasUnresolvedMutation":false},"expect":{"result":{"kind":"apply","opportunityUuid":"offer-1","evaluatedAt":1788744000000,"requiredQusd":"20.00000000","requiredFiat":"0","projectedExposureQusd":"25.00000000","projectedDailyAppliedQusd":"40.00000000","checks":[{"code":"price_policy","status":"pass"}],"reasons":[]}},"compare":{"order":{"checks":"by:code"}}}
```

**Registro de caso stateful (replay/CLI): `kind: "stateful"`**

```json
{"schema":"qvaapply.parity/v1","caseId":"replay/money-core/apply/0007","kind":"stateful","source":"test/opportunity-orchestrator.test.ts:422","spec":"01-domain.md#42-estados","service":"money-core","session":{"clock":{"start":1788744000000,"stepMs":1},"ids":{"intentId":"intent-7","orderUuid":"restore-7"},"fixture":"money-core/empty.json"},"steps":[{"op":"trading.decide","input":{"offer":{"uuid":"offer-7","type":"sell","coin":"BANK_CUP","amount":"10.00000000","receive":"9200","status":"open"}},"expect":{"result":{"action":"applied","kind":"apply"},"upstream":[{"method":"POST","path":"/v2/p2p/apply","bodyHash":"sha256:..."}]},"stateDigest":"sha256:..."},{"op":"trading.reconcile","input":{"intentId":"intent-7","observed":"ambiguous"},"expect":{"result":{"intentState":"uncertain","reserveFreed":false},"upstream":[]}}]}
```

**Manifest:**

```json
{
  "schema": "qvaapply.parity/v1",
  "canonicalVersion": 1,
  "goldenVersion": 1,
  "apiVersion": 1,
  "generatedFrom": {"impl": "typescript", "commit": "<sha>", "srcHash": "sha256:<hash de src/ usado>", "generator": "parity/gen@1"},
  "clockMode": "injected",
  "suites": {
    "pure/risk": {"file": "pure/risk/evaluate-risk.ndjson", "cases": 8, "sha256": "<hex>", "sources": ["test/risk-policy.test.ts:42-162"]},
    "contract/qvapay/gateway": {"file": "contract/qvapay/gateway.ndjson", "cases": 27, "sha256": "<hex>", "cassettes": ["cassettes/qvapay/apply-success.json"], "sources": ["test/qvapay-gateway.test.ts:1-456"]}
  },
  "totals": {"cases": 220, "pure": 107, "contract": 74, "http": 39},
  "regeneration": {"issue": "MIG-xx", "approvedBy": "owner", "date": "2026-11-12", "changelog": "golden/CHANGELOG.md"}
}
```

**Versión y regeneración (control de deriva del oráculo):**

1. `goldenVersion` es inmutable. Un cambio de comportamiento del oráculo genera `v2-pending/` con su `CHANGELOG.md`; nunca se sobrescribe `v1`.
2. CI `golden-guard` compara `manifest.json` + `sha256` de cada `.ndjson` contra un archivo de referencia firmado en el repo; si cambian sin el label `golden-change` y una entrada de changelog, **falla**.
3. El generador se ejecuta con `--from ts --commit <sha>` y produce `srcHash`; si `src/` cambió respecto al manifest, el runner en modo `--strict-oracle` falla (oráculo viejo vs código nuevo).
4. Se conserva `v1` durante dos releases para *bisect* de paridad. Los goldens generados desde un bug conocido del oráculo se anotan en `golden/KNOWN_BUGS.md` y **no** se «corrigen» sin decisión de dominio (ver §6.1).
5. Prohibido regenerar desde el SUT nuevo: los goldens son siempre del oráculo TS.

### 4.5 Esquemas y validación

`parity/schema/` contiene JSON Schema 2020-12 por tipo de payload, compartidos por golden, cassette y respuestas reales:

```text
schema/
├── protocol.schema.json          # sobre del protocolo CLI v1
├── risk-context.schema.json
├── risk-decision.schema.json
├── budget-plan.schema.json
├── liquidity-plan.schema.json
├── mutation-intent.schema.json
├── operation.schema.json
├── market-event.schema.json
├── http-request.schema.json
├── http-response.schema.json
├── cassette.schema.json
└── parity-report.schema.json
```

Reglas de uso:

- El runner **rechaza** cualquier salida del SUT que no valide contra el schema del op; no hay comparación «best effort».
- Los schemas se versionan con `$id` que incluye `/v1/`; los cambios incompatibles crean `/v2/`.
- Los schemas son la especificación compartida entre el equipo Go/Rust y el arnés: un campo monetario nuevo exige `x-qva-decimal` y su escala antes de implementarse.

### 4.6 Protocolo CLI v1 y catálogo de ops

Para reglas puras y stateful sin superficie HTTP pública:

```text
# El runner arranca el binario:
$ SUT_CLI --protocol=1
# y escribe una línea por petición; el SUT responde una línea por petición:
{"v":1,"id":"pure/risk/0001","op":"risk.evaluate","input":{...}}
{"v":1,"id":"pure/risk/0001","result":{...}}
{"v":1,"id":"pure/risk/0002","op":"risk.evaluate","input":{...}}
{"v":1,"id":"pure/risk/0002","error":{"class":"validation","code":"non_finite","retryable":false}}
```

Requisitos normativos:

| Requisito | Detalle |
|---|---|
| Frame | Una línea JSON por mensaje; stdout solo protocolo; stderr capturado como log (no parseado). |
| Orden | Las respuestas pueden llegar en cualquier orden, pero cada `id` responde exactamente una vez. |
| Determinismo | Prohibido `Date.now`, `time.Now`, `rand`, red, DNS. El reloj e IDs vienen en `session`/`input`. |
| Estado | `session.open`/`session.close` delimitan un caso stateful; entre sesiones no hay estado. El runner reinicia el proceso cada 500 casos. |
| Seguridad | El binario de conformidad se compila con build tag/feature y **no** se incluye en la imagen de producción; solo escucha stdin/stdout, no abre puertos. |
| Errores de protocolo | Línea inválida o `id` desconocido ⇒ el runner aborta la suite con código 2 (no se degrada a pass). |
| Timeout | 5 s por mensaje (configurable); al vencer, el caso es `timeout` y el proceso se reinicia. |
| `stateDigest` | `sha256` de una serialización canónica acordada del estado que el caso declara (reservas, intenciones, operaciones). Se valida contra `expect.stateDigest`. |

**Catálogo de ops (v1):**

| Op | Semántica | Suite | Servicio |
|---|---|---|---|
| `risk.evaluate` | `evaluateRisk(RiskContext)` | pure/risk | money-core |
| `market.math` | `median`, `outgoingFiatCost`, `ownOfferFiatTotal`, `roundRateForIndex`, `sizeFlexibleOffer` | pure/market | money-core |
| `budget.allocate` | plan proporcional de presupuesto, mínimo CUP, comisión fija | pure/budget | money-core |
| `budget.list` | `ListingReadBudget` con reloj/shim | pure/budget | qvapay-adapter |
| `liquidity.plan` | `planLiquidity` + snapshot restaurable | pure/liquidity | money-core |
| `intents.execute` | `MonetaryIntents.execute` con repo inyectado | pure/intents | money-core |
| `cache.qusd` | `QusdBalanceCache` con reloj/epoch | pure/cache | qvapay-adapter |
| `scheduler.run` | ticks de loops con callbacks controlados | pure/scheduler | runtime |
| `auth.origin` | validación de origen/CSRF/sesión | pure/auth | gateway |
| `auth.mobile-operator` | pairing/check/scopes de operador | pure/auth | gateway |
| `telegram.menu` / `telegram.coop-menu` | máquinas de estado de menús | pure/telegram | notifier |
| `telegram.runtime` | guardas de callback/render | pure/telegram | notifier |
| `sse.chat` | parser de stream de chat | pure/sse | chat-service |
| `qvapay.read` | `profile`, `qusdBalance`, `listOffersPage`, `p2pAverages`, `listTransactions` (fetch al fake) | contract/qvapay | qvapay-adapter |
| `qvapay.mutate` | `apply`, `createOffer`, `editOffer`, `cancel`, `markPaid`, `confirmReceived` | contract/qvapay | qvapay-adapter |
| `qvapay.login` | login TOTP/PIN | contract/auth | qvapay-adapter |
| `qvapay.chat` | `listChat`, `sendChat`, imágenes | contract/qvapay | chat-service |
| `push.deliver` | entrega VAPID/Telegram con runtime fixture | contract/push | notifier |
| `market.ingest` | evento SSE/webhook → dedupe → cola (stateful) | replay/market | market-ingest |
| `trading.decide` | pipeline decisión→riesgo→reserva (stateful) | replay/money-core | money-core |
| `trading.reconcile` | conciliación de intención incierta (stateful) | replay/money-core | money-core |
| `payment.receipt` | comprobante SMS → matching (stateful) | replay/money-core | money-core |
| `http.*` | rutas del gateway (vía adaptador HTTP, no CLI) | http/* | gateway/dashboard-bff |

### 4.7 Adaptador HTTP y contrato congelado

1. **OpenAPI congelado:** generar `parity/schema/openapi.v1.json` desde `buildDashboard()` en modo `ts-http` y compararlo con el documento actual (`src/http-dashboard.ts:1164`). El actual es incompleto (no cubre sesión, móvil, webhook ni imágenes; `03-boundaries.md` §4.6), así que el artefacto de contrato es **la lista de §4.3 de 03** (109 entradas) + un OpenAPI *reconstruido* que el gateway nuevo debe servir. Gate: toda ruta de la lista tiene al menos un caso HTTP y una fila en la matriz de auth.
2. **Matriz de auth por ruta** (`parity/schema/http-routes.json`): para cada método+ruta: `auth ∈ {público, sesión, móvil, dispositivo, HMAC}`, `csrf`, `rateLimit`, `origen`, `consumidor`, `servicio propietario`. Casos obligatorios por ruta: anónimo→401, Origin inválido→403, sin CSRF→403 (si aplica), válido→2xx; body >10 KB→413; métodos no permitidos→405. Esto instancia el contrato K10 de `03-boundaries.md` §7.
3. **Envelopes:** respetar los dos formatos existentes (`{data}` y cuerpo directo en móvil/dispositivo) — `03-boundaries.md` §4.3. El adaptador normaliza el cuerpo a `{"status":<code>,"headers":{...},"body":{...}}` y el comparador trata los headers sensibles (Set-Cookie, Date) como `x-qva-header: "opaque"`/`server`/`etag`.
4. **Autenticación de pruebas:** el runner hace `POST /api/session` con `CONFORMANCE_DASHBOARD_PASSWORD`, guarda cookie, obtiene `csrfToken` y lo reenvía (`test/http-dashboard.test.ts:38-63`). Para móvil, `POST /api/mobile/operators` + Bearer. Las credenciales son solo del entorno de conformidad; nunca las reales.
5. **Mutaciones:** una respuesta 2xx no prueba nada por sí sola. Cada caso HTTP con efecto declara `expect.upstream` (llamadas al fake QvaPay) y `expect.state` (lectura posterior de una ruta segura), y el runner valida ambas.

### 4.8 Fake QvaPay determinista y cassettes

**Componente:** `fake-qvapay` (proceso local, puede ser Node en v0; binario Go/Rust si se prefiere) que escucha en `127.0.0.1:0` y expone:

| Endpoint | Propósito |
|---|---|
| `POST/GET /v2/p2p/**`, `/auth/**`, `/user`, `/p2p/averages`, `/p2p/stream` (SSE) | simulación de la API |
| `POST /webhooks/...` (emisor) | enviar webhook firmado al SUT |
| `GET /__fake/log` | log ordenado de requests con hash de body |
| `POST /__fake/reset` | reinicio de estado entre casos |
| `POST /__fake/advance` | avance de reloj virtual del fake |
| `GET /__fake/health` | readiness del runner |

**Modos:** `replay` (solo cassette), `strict` (request no previsto ⇒ 500 + contador `unexpected` ⇒ fallo), `record` (solo humano y supervisado; graba de sandbox, nunca producción). En CI siempre `strict`.

**Error de transporte:** los cassettes simulan `timeout-after-send`, `connection-reset-before-response`, `5xx`, `429`, `409`, `garbage-after-2xx`, `slow-response`. Para que los timeouts sean rápidos y deterministas, el SUT en modo conformidad escala timeouts (`CONFORMANCE_TIMEOUT_SCALE`, mínimo 10 ms) y el fake avanza su reloj; **la lógica de decisión no cambia**. Los `responseMs` exactos no se comparan (ver §6.2).

**Schema de cassette (resumen):**

```json
{
  "cassetteVersion": 1,
  "id": "apply-timeout-after-send",
  "contract": "K3",
  "sut": "qvapay-adapter",
  "mode": "strict",
  "exchanges": [
    {"request": {"method": "POST", "path": "/v2/p2p/apply",
                 "match": {"bodyUuid": "offer-7"}},
     "response": {"kind": "delay-then-close", "delayMs": 40, "afterRequest": true}}
  ],
  "expect": {"sut": {"error": {"class": "uncertain", "retryable": false}},
             "upstreamRequests": 1, "noRetryWithinMs": 60000}
}
```

**Catálogo obligatorio de cassettes (v1), mapeado a los contratos K1–K14 de `03-boundaries.md` §7:**

| Cassette | Contrato | Qué certifica |
|---|---|---|
| `qvapay/login-otp-pin.json` | K1 | 200/202 `has_otp`, PIN, 401 TOTP, 423, 429, timeout con 3 reintentos |
| `qvapay/list-paged.json` | K2 | envelope `data`/`offers`, take=100, `x-cache`, best rate, 429 + Retry-After |
| `qvapay/apply-success.json` | K3 | 200 vacío, persistencia de `applied` |
| `qvapay/apply-contentions.json` | K3 | 409 `OFFER_CONTENDED`, `OFFER_PAUSED`, `PEER_REQUIREMENTS_NOT_MET`, tercer intento <60 s ⇒ `LOCAL_APPLY_QUOTA` |
| `qvapay/apply-timeout-after-send.json` | K3/K4 | incierta, sin reintento ni compensación |
| `qvapay/mutate-ambiguous.json` | K4 | create/edit/cancel/paid/received con timeout/5xx ⇒ incierta; 4xx definitiva |
| `qvapay/webhook-signed.json` | K5 | HMAC válida/inválida, timestamp, duplicado, 202 tras persistir |
| `qvapay/feed-sse.json` | K6 | fragmentos, `retry:`, keepalive, 401/402, cierre limpio, evento >64 KB |
| `qvapay/chat-legacy-and-current.json` | K7 | envelopes `array`/`data`/`chat`/`messages`; imagen; attemptId |
| `qvapay/sync-core.json` | K8 | `csk_`, snapshot, reserva con suma exacta ±0.011, 401 refresh, cursor no creciente |
| `qvapay/nats.json` | K9 | consumidor durable, payload inválido ⇒ term, >1 MB ⇒ term |
| `market/feed-multi-canal.json` | K13 | mismo evento por SSE y webhook ⇒ una aplicación; `range_*`/`paused` con `sent_at` |
| `push/telegram-webpush.json` | K14 | dedupe por evento, 404/410 purga, fallo de canal no bloquea el otro |

**Regla de determinismo:** el fake **nunca** devuelve respuestas aleatorias ni usa el reloj real; cada cassette es un autómata finito indexado por request. El log de requests se compara por `method`, `path`, `sorted query`, `sha256(body canónico)` e `idempotency key`; un request de más o de menos falla.

### 4.9 Property-based testing

Los property tests son **por implementación** (no se comparan dos implementaciones), pero el modelo sale del dominio compartido. Herramientas: **Rust `proptest` + `proptest-state-machine`**, **Go `pgregory.net/rapid`** (o `testing/quick` si no se admite dependencia externa). La versión TS del arnés puede usar `fast-check` opcionalmente para validar el oráculo.

**Invariantes numéricas y de estado (v1):**

| ID | Propiedad | Generadores | Lenguajes | Casos PR / nightly |
|---|---|---|---:|---:|
| INV-01 | Reserva única por oferta/capital: `Σ reservas activas ≤ capacidad`; ninguna intención activa duplicada | secuencias de `open/confirm/reject/reconcile/ack/restart` | Rust/Go | 500 / 10 000 |
| INV-02 | No doble gasto: para cualquier par de decisiones concurrentes sobre el mismo capital, a lo sumo una mutación externa | ofertas, saldos, configuraciones de límites | Rust/Go | 500 / 10 000 |
| INV-03 | Intención antes de mutación: índice(intent submitted) < índice(mutación) en el log durable | comandos de mutación | Rust/Go | 500 / 10 000 |
| INV-04 | Compensación solo tras rechazo confirmado/conciliación no aplicada; nunca tras `uncertain` | secuencia de estados de intención | Rust/Go | 500 / 10 000 |
| INV-05 | Quiescencia de incertidumbre: tras timeout/ambiguo, 0 mutaciones para esa oferta hasta resolución | cassette ambiguo + comandos | Rust/Go | 300 / 5 000 |
| INV-06 | Redondeo: `buy ≤ nominal ⇒ floor múltiplo 10`; `sell ≥ nominal ⇒ ceil múltiplo 10`; no-CUP cuantiza a 1e-8; `total ≥ MIN_OFFER_QUSD`; `Σ allocations ≤ budget`; idempotencia de cuantización | decimales positivos con escala 0–8, bordes `.5`, `1e-8`, `0.1` | Rust/Go | 1 000 / 50 000 |
| INV-07 | Monotonía de riesgo: si `context` pasa y se empeora un campo, `kind` nunca mejora hacia `apply`; precedencia `ignored > manual_review > blocked > apply` | contextos de riesgo | Rust/Go | 500 / 10 000 |
| INV-08 | Clave idempotente estable: mismo snapshot ⇒ misma key; snapshot distinto ⇒ key distinta | snapshots de oferta | Rust/Go | 300 / 5 000 |
| INV-09 | A lo sumo una edición de oferta propia por refresh | listas de ofertas propias + config | Rust/Go | 300 / 5 000 |
| INV-10 | Preservación de lectura: cualquier fallo remoto deja la última lectura válida y `stale:true`; nunca borra | lecturas remotas + fallos | Rust/Go | 300 / 5 000 |
| INV-11 | Conservación del ledger: `Σ débitos − Σ créditos =Δsaldo`; uuid duplicado se aplica una vez | movimientos fiat | Rust/Go | 500 / 10 000 |

**Ejemplo Rust (proptest-state-machine, bosquejo):**

```rust
proptest! {
    #![proptest_config(ProptestConfig { cases: 500, .. ProptestConfig::default() })]
    #[test]
    fn inv01_no_doble_reserva(seq in prop::collection::vec(command(), 0..200)) {
        let mut model = MoneyModel::new();
        let mut sut = ConformanceSut::new();
        for cmd in seq {
            model.apply(&cmd);            // modelo de referencia del dominio
            sut.exec(cmd);                // SUT por CLI v1
            prop_assert_eq!(sut.state_digest(), model.state_digest());
            prop_assert!(sut.reserved_qusd() <= model.capacity());
        }
    }
}
```

**Ejemplo Go (rapid, bosquejo):**

```go
func TestINV06Redondeo(t *rapid.T) {
    qusd := rapid.StringMatching(`^[0-9]{1,6}(\.[0-9]{1,8})?$`).Draw(t, "qusd")
    rate := rapid.StringMatching(`^[0-9]{1,6}(\.[0-9]{1,8})?$`).Draw(t, "rate")
    c := conformance.NewSUT(t)
    got := c.MustOp("market.math", map[string]any{"fn": "ownOfferFiatTotal", "qusd": qusd, "rate": rate, "type": "buy", "currency": "CUP"})
    // invariantes: múltiplo de 10, <= nominal, >= 0.1
}
```

**Proceso:**

1. Un contador ejemplo (shrink) se serializa como caso golden en `parity/golden/v1/bugs/INV-xx-<hash>.ndjson`; se añade al corpus de regresión y **no se borra**.
2. CI PR: 500 casos/invariante (≈2–3 s por invariante en Rust; Go similar). Nightly: 10 000. Release candidate: 50 000 + semillas guardadas.
3. El corpus de semillas fallidas (`parity/property/seeds/*.json`) se reproduce en ambos lenguajes cuando exista equivalente.
4. Los property tests corren contra el **dominio interno** (crate/paquete, rápido) y una versión reducida (100 casos) contra el SUT por CLI, para detectar divergencias de integración.

### 4.10 Shadow/differential testing

**Objetivo:** comparar decisiones reales (o grabadas) del monolito con las del candidato, sin ejecutar dos veces mutaciones reales.

**Pipeline:**

```text
data/qvaapply.sqlite (copia read-only)
   │  export sanitizado
   ▼
parity/replay/<fecha>/
   ├── events.ndjson        # market_feed_events + market_observations en orden durable
   ├── decisions.ndjson     # decision_events versionados
   ├── config.json          # snapshot de config (hash)
   └── manifest.json        # conteos, hashes, t0, ventana
        │
        ├─► oráculo TS  (replay con reloj rebasado) ──► decisions-ts.ndjson
        └─► SUT candidato (DRY_RUN=1, sin mutaciones) ► decisions-sut.ndjson
                                                         │
                                                   diff clasificado
```

**Reglas:**

1. **Sanitización obligatoria:** exportar solo eventos de mercado y decisiones; excluir tokens, cookies, claves VAPID, `encrypted_token`, datos de pago y PII de usuarios. `03-boundaries.md` §9.1 da el inventario de secretos. Los UUID de oferta pueden conservarse (no son PII), pero los de usuario/peer se pseudoanonimizan con sal del entorno.
2. **Reloj rebasado:** `t' = t − t0`; el SUT recibe `--replay-clock-base`; las ventanas de 60 s, cooldowns y freshness se evalúan contra el reloj virtual. Los sleeps se sustituyen por avance virtual.
3. **Orden durable:** se usa el orden de `market_feed_events`/`decision_events`, no el orden de recepción. Para interleavings SSE/webhook grabados, el export incluye un campo `channel`; el replay puede optar por reproducir el orden durable (determinista) o el orden de llegada (cuando esté grabado).
4. **Clasificación del diff:** `identical` / `benign` (campos declarados de timing/telemetría/IDs) / `semantic` (decisión, checks, importes, acción) / `missing`/`extra`. Solo `semantic` bloquea.
5. **Cero mutaciones reales:** el candidato corre con `DRY_RUN=1`; el fake QvaPay registra los POST que *habría* hecho y se comparan con los del oráculo. Prohibido el dual-write.

**Ventana de promoción (medible):**

| Criterio | Umbral |
|---|---|
| Duración | ≥ 7 días consecutivos en shadow |
| Volumen mínimo | ≥ 200 decisiones de oportunidad y ≥ 20 decisiones «aplicable», o 3× el volumen diario medio observado en `decision_events` (el mayor) |
| Divergencias semánticas | **0** |
| Decisiones idénticas | ≥ 99,9 % (ADR-0012), 7 días consecutivos |
| Divergencias benignas | ≤ 0,1 % del total, todas listadas por campo con justificación (implica el ≥ 99,9 % anterior) |
| Mutaciones que habría ejecutado | 100 % idénticas en método/ruta/idempotency key; 0 duplicadas |
| Invariantes | 100 % de INV-01..11 sin contador ejemplo en la ventana |

**Post-cutover:** el oráculo TS queda como *replay validator* nocturno durante 30 días. Si aparece una divergencia semántica, se congelan nuevas mutaciones (`emergencyStop`/pausa) y se abre incidente; no se «reajusta» el golden.

### 4.11 Auto-paridad (bootstrap)

Antes de que exista Go/Rust:

1. `ts-cli` genera los goldens del oráculo.
2. El runner ejecuta **el mismo oráculo** como SUT a través del adaptador (`--sut ts-cli`).
3. Resultado obligatorio: `718/718` para las suites soportadas, 3 ejecuciones con el mismo `reportSha256`.
4. Esto valida el harness (canonización, comparador, fake, reloj) y detecta no determinismo de la propia suite antes de culpar al SUT.

`ts-http` hace lo mismo para la suite H (39). La auto-paridad corre en cada PR.

### 4.12 Runner, comparador y reporte

**Modos de comparación por caso:** `exact`, `decimal` (con `x-qva-scale`), `set`/`unordered`, `subset` (solo contrato HTTP forward-compatible), `constraint` (`gt/lt/regex/absent/present`, obligatorio para timing/IDs). El comparador opera sobre el JSON canónico, nunca sobre strings crudos.

**Reporte (`parity/reports/parity-report.json`, esquema `parity-report.schema.json`):**

```json
{
  "reportVersion": 1,
  "generatedAt": "2026-11-12T20:00:00Z",
  "sut": {"service": "money-core", "language": "rust", "commit": "<sha>", "binarySha256": "<hex>"},
  "oracle": {"impl": "typescript", "commit": "<sha>", "srcHash": "sha256:<hex>"},
  "goldenVersion": 1,
  "canonicalVersion": 1,
  "suites": {
    "pure/risk": {"required": 8, "passed": 8, "failed": 0, "skipped": 0, "semanticDiffs": 0},
    "contract/qvapay/gateway": {"required": 27, "passed": 27, "failed": 0, "skipped": 0, "upstreamLogMismatches": 0},
    "replay/money-core": {"required": 261, "passed": 261, "failed": 0, "skipped": 0, "stateDigestMismatches": 0}
  },
  "totals": {"requiredCases": 296, "passedCases": 296, "parity": 1.0, "skipped": 0, "xfail": 0},
  "mutationParity": {"cases": 96, "exact": 96, "extraCalls": 0, "missingCalls": 0, "duplicateCalls": 0},
  "invariants": {"INV-01": {"cases": 500, "failures": 0}, "INV-06": {"cases": 1000, "failures": 0}},
  "environment": {"TZ": "UTC", "LC_ALL": "C", "network": "none", "clock": "injected"},
  "artifacts": {"goldenManifestSha256": "<hex>", "reportSha256": "<hex>"}
}
```

Reglas del reporte: `skipped` y `xfail` deben ser **0** en suites obligatorias; si un caso no aplica, se excluye del conjunto requerido con justificación versionada, no se salta. El reporte es un artefacto de CI firmado (`sha256`) que el gate de deploy verifica.

---

## 5. Estrategia de migración de tests y criterios de paridad

### 5.1 Fases con criterios de salida

| Fase | Trabajo | Archivos/casos | Criterio de salida (medible) |
|---|---|---|---|
| **L0 — Baseline y andamiaje** | `parity/` + runner + `ts-cli` + `ts-http` + fake v0 + `golden-guard` + baseline JUnit; corregir `docs/VERIFICATION.md` (718/95) | 0 tests movidos | Suite TS 718/718; auto-paridad TS→TS en P=107 100 %; 3 reportes idénticos; `golden-guard` activo; **CI no bloqueante** aún |
| **L1 — Puros** | 21 archivos → 107 goldens; 4 implementaciones piloto (Rust/Go para risk, market.math, budget, liquidity) | 107 | 107/107 en el SUT piloto; INV-06/INV-07 property en CI; goldens `v1` congelados |
| **L2 — Contratos y HTTP** | 11 C (74) + 9 H (39) → cassettes + matriz de rutas; gateway de conformidad | 113 | 113/113; log upstream exacto; OpenAPI/route-coverage 100 % de las rutas del SUT; cassettes K1–K7, K10, K14 verdes |
| **L3 — Núcleo monetario** | 21 archivos / 298 casos → replay stateful + goldens extraídos; INV-01..05, INV-08/09/11 | 298 | 298/298; `mutationParity = 1.0`; 0 `stateDigestMismatches`; property nightly verde; replay de decisiones 0 divergencias |
| **L4 — Mercado y lecturas** | 21 archivos / 172 casos → replay de feed/observaciones + HTTP del dashboard | 172 | 172/172; dedupe K13; lecturas `stale` preservadas; 0 divergencias semánticas en replay |
| **L5 — UI y operaciones** | 12 archivos / 28 casos: no migran | 28 | Excluidos del score; `visual-smoke` sigue verde; documentado como deuda del frontend |
| **L6 — Shadow y cutover** | pipeline §4.10, canary supervisado | — | §4.10 ventana + checklist humano de `docs/OPERATIONS.md:120-126`; rollback probado |

**Estimación orientativa (1 persona, dedicación parcial):** L0 1–2 semanas; L1 2–3; L2 2–3; L3 4–6; L4 3–4; L6 2+ semanas de calendario (shadow). No se despliega dinero antes de completar L3 y el gate de §5.3.

### 5.2 Asignación archivo por archivo

Ya ubicada en las tablas de §2: **L1 = 21 archivos/107**, **L2 = 20/113**, **L3 = 21/298**, **L4 = 21/172**, **L5 = 12/28**. Reglas de asignación:

- **L1** si el test no toca `Store`, HTTP, fs ni red (aunque inyecte reloj/shim).
- **L2** si el test ejerce una frontera externa o un handler HTTP puro.
- **L3** si toca reservas, intenciones, mutaciones, ledger, conciliación, precio/redondeo o pausas de dinero.
- **L4** si toca ingesta, cachés, notificaciones, chat, analítica o superficie de lectura.
- **L5** si afirma sobre UI/scripts/estructura de fuente.

Cada archivo de L1–L4 recibe en el inventario del runner un `targetService` (tabla §2.4) y un `lote`; un archivo puede dividirse si mezcla categorías (p. ej. `practical-tools` tiene analítica pura y HTTP: sus casos puros van a L1, los HTTP a L2; en la tabla se asigna por mayoría y se anota la excepción). **Prohibido** mover un archivo de lote sin actualizar el manifest y re-ejecutar el gate.

### 5.3 Definición medible de "paridad completa"

Para cada servicio `s`:

```text
Required(s) = goldens de casos cuyo targetService = s
            ∪ contratos K de sus adaptadores
            ∪ casos HTTP de las rutas que s posee
            ∪ invariantes INV-01..11 aplicables a s

Parity(s) = |casos requeridos superados| / |casos requeridos|
```

**Criterios de aceptación (todos obligatorios y medibles):**

1. **Cobertura de casos:** 100 % de `Required(s)` ejecutados; `skipped = 0`, `xfail = 0`, `pending = 0`. Cualquier exclusión debe estar en `parity/schema/exclusions.json` con issue, motivo y aprobación del dueño; no reduce `Required` silenciosamente.
2. **Paridad:** `Parity(s) = 1.0` para servicios **money-critical** (`money-core`, `qvapay-adapter`/`executor`, `config-registry`); `≥ 0.995` y 0 fallos para no monetarios (`market-ingest`, `decisions`, `notifier`, `chat`, `analytics`, `audit`, `gateway`/`dashboard-bff`) con lista de exclusiones aprobada.
3. **Paridad de mutaciones:** `mutationParity.cases = mutationParity.exact`, `extraCalls = 0`, `missingCalls = 0`, `duplicateCalls = 0`, mismas idempotency keys.
4. **Invariantes:** `INV-01..11` con `failures = 0` y sin contador ejemplo pendiente; nightly con ≥ 10 000 casos por invariante; corpus de bugs incluido.
5. **Estado:** `stateDigestMismatches = 0`; reservas/intenciones/operaciones reconciliadas tras cada secuencia.
6. **Dedupe y canales:** K13 en verde con SSE+webhook y `sent_at` distintos; un solo efecto por evento.
7. **Contrato HTTP:** 100 % de rutas propias con matriz de auth; `openapi.v1.json` sin diferencias no aprobadas; envelopes/códigos según `03-boundaries.md` §4.3.
8. **Replay:** ≥ 99,9 % de decisiones idénticas en la ventana de shadow (ADR-0012), 0 divergencias semánticas, `benign ≤ 0,1 %` justificadas y 0 mutaciones extra.
9. **Determinismo del arnés:** 3 ejecuciones del mismo reporte producen el mismo `reportSha256`; sin red externa; `TZ=UTC`, `LC_ALL=C`.
10. **Artefacto firmado:** `parity-report.json` incluye `sutCommit`, `binarySha256`, `goldenManifestSha256` y `reportSha256`; el deploy lo verifica.
11. **Oracle health:** `srcHash` del oráculo coincide con el commit declarado; si no, el gate falla (no se compara contra un oráculo viejo).
12. **Global ("paridad completa" del programa):** todos los servicios money-critical en 1.0, todos los no monetarios ≥ 0.995, L1–L4 completos, L5 documentado, ventana de shadow superada y 30 días de replay post-cutover sin divergencias.

### 5.4 CI gates

Los nombres de gate se proponen para `.github/workflows/ci-deploy.yml`; el job `verify` actual (`ci-deploy.yml:36-37`) se mantiene y el deploy (`ci-deploy.yml:40-41`, hoy `needs: verify`) pasa a depender también de `conformance` (ejecuta el arnés) y `parity-gate` (verifica reportes y umbrales).

| Gate | Comando | Bloquea | Tiempo objetivo | Artefacto |
|---|---|---|---:|---|
| `verify` (existente) | `pnpm check` (`package.json:24`) | Todo | ≤ 20 min (`ci-deploy.yml:17`) | JUnit 718 |
| `conformance-self` | `node --import tsx parity/runner/run.ts --sut ts-cli --suite pure` + `--sut ts-http --suite http` | PR | ≤ 2 min | `reports/self.json` |
| `golden-guard` | `node parity/scripts/verify-goldens.ts` | PR | ≤ 10 s | hashes |
| `conformance-pure` | matriz por servicio: `--sut cli --cmd <binario> --suite pure,contract` | PR (a partir de L1) | ≤ 5 min | reportes por servicio |
| `conformance-http` | `--sut http --base-url <svc> --suite http` | PR (L2+) | ≤ 8 min | `http.json` |
| `conformance-replay` | `--sut http|cli --suite replay` | PR (L3+) | ≤ 10 min | `replay.json` |
| `property-smoke` | `cargo test --features conformance` / `go test -run 'TestINV'` | PR (L1+) | ≤ 5 min | seeds |
| `property-nightly` | 10 000 casos/invariante, ambos lenguajes | Nightly | ≤ 30 min | `property.json` |
| `shadow-nightly` | `./parity/scripts/shadow-diff.sh` con export del día | Nightly (staging) | ≤ 20 min | `diff.json` |
| `parity-gate` | `./parity/scripts/parity-gate.sh --service <s> --min-parity 1.0` | **Deploy** | ≤ 1 min | reporte firmado |
| `deploy` (modificado) | `needs: [verify, parity-gate]` | Producción | — | — |

**Esbozo de cambio en CI (no implementado):**

```yaml
jobs:
  verify:        # se mantiene: pnpm check
  conformance:   # compila SUT + corre runner (matriz de servicios)
  parity-gate:   # verifica reportes firmados y mínimos por servicio
    needs: [verify, conformance]
  deploy:
    needs: [verify, parity-gate]
    # resto igual; el deploy exige el mismo SHA de goldens y reportes
```

**Reglas anti-deriva:** los reportes se suben como artefactos con retención ≥ 90 días; el deploy descarga el artefacto del mismo `workflow_run`, no regenera. Si `goldenVersion` o `srcHash` no coinciden con los reportes, el deploy falla.

### 5.5 Gates de despliegue y cutover (dinero)

1. **Staging primero:** composición completa con Postgres, fake QvaPay en modo `record`/`replay`, y shadow read-only. No hay staging con credenciales reales de producción (`docs/DEVELOPMENT.md:23-25`).
2. **Canary de lectura:** el gateway nuevo sirve primero rutas de lectura; panel/Android siguen contra la API actual. Gate: 100 % de casos HTTP de lectura + 0 errores 5xx en 24 h.
3. **Canary de mutación supervisado:** una sola cuenta, importe mínimo, `CONFIRM_REAL_TRADING=true`, operador humano delante; comparación dual de *intenciones* (no de envíos) y conciliación posterior. Se apoya en la lista humana de `docs/OPERATIONS.md:120-126` y en la regla de que la primera operación tras cambios sea mínima y supervisada (`docs/VERIFICATION.md:51-53`).
4. **Prohibido dual-write real:** jamás dos implementaciones enviando mutaciones a QvaPay. La paridad se demuestra en shadow/DRY_RUN y en canary único. Esto reproduce la advertencia de `03-boundaries.md` §6.4 (un único escritor por cuenta).
5. **Rollback:** release anterior + restauración de backup SQLite/Postgres (`docs/OPERATIONS.md:96-106`); el reporte de paridad y el commit quedan registrados en la auditoría del release.
6. **Post-cutover:** replay validator TS nocturno durante 30 días; cualquier divergencia semántica congela automatización y abre incidente.

---

## 6. Matriz de riesgos

### 6.1 Riesgos de paridad (el oráculo y el contrato)

| Riesgo | Impacto | Detección | Mitigación |
|---|---|---|---|
| **El golden congela un bug del oráculo** | El SUT nuevo reproduce el bug; el arnés da falsa confianza | Revisión de goldens contra `01-domain.md`; property tests independientes; shadow | `golden/REVIEW.md` por lote; bugs conocidos documentados; decisión explícita de dominio para corregir (nunca silenciosa) |
| **Deriva del oráculo** (se toca `src/` después de congelar) | Se compara contra un oráculo viejo | `srcHash` en manifest + `--strict-oracle` | Gate falla; L0-L3 congelan cambios de comportamiento en `src/` salvo seguridad |
| **Doble identidad semántica**: TS devuelve `number`, Go/Rust `string` decimal | Falsos negativos/positivos | Schema `x-qva-decimal` + validador | Salida del SUT validada contra schema antes de comparar |
| **Regla de redondeo distinta** (half-even vs half-away, epsilon) | Diferencias de 1e-8 → discrepancia monetaria | Vectores de borde y property INV-06 | Regla única documentada (`02-persistence.md` §5.4) + vectores `.5`/`1e-8`/`0.1` |
| **Casos de `time` no comparables** | Falsos rojos o verdes | Normalización a delta + `clockSensitive` | Reloj virtual inyectado; sin reloj, caso no se acepta en obligatorios |
| **IDs generados** (uuid, intentId, token) | Ruido en diff | Normalización `$uuid`/`$token48` | IDs deterministas en `CONFORMANCE_MODE`; validación de patrón y unicidad |
| **Fake demasiado permisivo** | El SUT hace requests no previstos y aun así pasa | Modo `strict` + contador `unexpected` | Cualquier request desconocido = fallo; log comparado |
| **Caso que solo verifica "no mutación"** | Falso verde: el SUT no hace nada y pasa | Requerir `expect.state` y `expect.upstream` juntos | Un caso de mutación debe verificar efecto esperado y ausencia de extras |
| **Orden de arrays/key order** | Falsos rojos | `compare.order` y canonización | `set`/`by:key` explícitos; nunca comparar texto crudo |
| **Descuido de ausente vs null** | Comportamiento divergente no detectado | Schema + normalización | Regla 9 de §4.3; casos negativos con campo ausente/null |

### 6.2 Flakiness

| Fuente | Archivos/evidencia | Mitigación en el arnés |
|---|---|---|
| Reloj real (`Date.now`) | `payment-sms` (40), `trading-automation` (40), `manual-cancel-exclusion` (13), `self-service-recovery` (13), `cooperative-capital` (12), `core` (12) | Reloj virtual; prohibido `Date.now` en SUT de conformidad; `clockSensitive` en goldens |
| Esperas reales (`setTimeout`) | `test/operation-actions.test.ts:11` | El replay no espera: avance virtual; los casos con espera se marcan `C` |
| Interleavings de promesas/colas | `test/manual-cancel-race.test.ts:38-87`, `test/market-ingest-serialization.test.ts`, `test/trading-automation.test.ts` (`setImmediate`) | Replay determinista por cola/evento; comparar propiedades de orden, no timing |
| Latencia/percentiles | `test/offer-latency.test.ts:11`, `test/hunting-query-performance.test.ts`, `test/market-poll-timing.test.ts:13` | Excluir de goldens exactos; jobs de performance con umbrales amplios y artefacto separado |
| UUID aleatorio | `test/http-dashboard.test.ts:286` | IDs deterministas por sesión; nombre de asset generado por el runner |
| Zona horaria/locale | Día de negocio local (`01-domain.md` §1.3) | `TZ=UTC`, `LC_ALL=C`; fixture de negocio con zona fija documentada |
| `import` de fuentes .tsx/.css | 9 archivos U | Excluidos del score; corren en el job TS existente |
| Orden de ejecución/estado compartido | Suite actual usa `mkdtemp`; el runner debe aislar por caso | Proceso/sesión limpia por caso stateful; reset del fake; sin estado global |

### 6.3 Falsos verdes (checklist anti-autoengaño)

- [ ] ¿El caso comprueba **efecto** además de ausencia de error? (`expect.state`, `expect.upstream`).
- [ ] ¿El fake está en `strict` y el log de requests se compara? (no solo el status HTTP).
- [ ] ¿El golden se generó desde el oráculo **y** fue revisado contra el documento de dominio?
- [ ] ¿La comparación valida schema (tipos/escala) además de valores?
- [ ] ¿`skipped`/`xfail` son 0 en suites obligatorias?
- [ ] ¿El runner falla si el SUT no responde (`timeout` no es pass)?
- [ ] ¿El caso de mutación verifica idempotency key y número exacto de POST?
- [ ] ¿El reporte está firmado y ligado al `sutCommit`/`srcHash`?
- [ ] ¿Se ejecutó 3 veces con el mismo hash (determinismo del arnés)?
- [ ] ¿Los tests de UI/estructura están fuera del score de backend?

### 6.4 Tests que no se pueden portar (lista cerrada)

1. **UI/React/estructura (22 casos):** `chart-domain`, `dashboard-bootstrap`, `dashboard-bootstrap-regression`, `dashboard-local-snapshot-regression`, `server-dashboard-cache-regression`, `telegram-menu-regression`, `ui-recovery-regression`, `web-layout-regression`, `web-operation-actions`.
2. **Operaciones/repo (6 casos):** `deployment-cleanup`, `deployment-domain`, `hunting-latency-report`.
3. **Partes TS-específicas que se sustituyen por contrato:** `repository` (20) no se porta como código; su garantía se redefine como verificación de migración de datos (`02-persistence.md` §6.5) + tests de esquema Postgres. `login` (11) se conserva como cassette K1, no como test. `static-assets` (1) se sustituye por contrato de gateway (ETag/304/HEAD/compresión).
4. **Nada más.** El resto tiene una vía A/B/C en este documento. Cualquier afirmación de "no portable" nueva debe justificarse contra esta lista.

### 6.5 La paridad no demuestra corrección distribuida

Riesgo específico del salto a microservicios: los 470 casos I certifican el comportamiento **single-node** con estado SQLite transaccional. Al partir el núcleo, la paridad puede pasar y aun así permitirse doble gasto por carreras entre servicios. Contramedidas obligatorias, fuera del alcance de este arnés pero dependientes de él:

- Restricciones únicas/`CHECK` en Postgres para reservas e intenciones (dependencia de `02-persistence.md` §5).
- Un único escritor de mutaciones por cuenta (fencing/lock) en `qvapay-adapter` (`03-boundaries.md` §6.4).
- Tests de doble réplica en CI: dos instancias del servicio + Postgres compartido + carrera de reservas ⇒ exactamente una mutación (property INV-02 en modo distribuido).
- Outbox/inbox idempotente y pruebas de caos entre servicios.
- La ventana de shadow §4.10 no sustituye estas pruebas; las complementa.

---

## 7. Comandos y estructura propuesta

### 7.1 Árbol

```text
parity/                              # nuevo; no toca test/ ni src/
├── README.md
├── manifest.json                        # versión, hashes, conteos, regeneración
├── schema/                              # JSON Schema 2020-12 + extensiones x-qva-*
│   ├── protocol.schema.json
│   ├── risk-context.schema.json
│   ├── risk-decision.schema.json
│   ├── budget-plan.schema.json
│   ├── liquidity-plan.schema.json
│   ├── mutation-intent.schema.json
│   ├── operation.schema.json
│   ├── market-event.schema.json
│   ├── http-request.schema.json
│   ├── http-response.schema.json
│   ├── http-routes.json                 # 109 rutas: auth, csrf, rate, owner service
│   ├── openapi.v1.json                  # contrato congelado (reconstruido, no el actual incompleto)
│   ├── cassette.schema.json
│   ├── parity-report.schema.json
│   └── exclusions.json                  # exclusiones aprobadas (no skips)
├── golden/
│   ├── v1/ ...                          # suites de §4.4 (ndjson)
│   ├── v1/CHANGELOG.md
│   ├── v1/KNOWN_BUGS.md
│   └── v1/REVIEW.md
├── cassettes/
│   ├── qvapay/*.json                    # catálogo §4.8
│   ├── market/*.json
│   ├── telegram/*.json
│   └── push/*.json
├── replay/
│   ├── <fecha>/events.ndjson
│   ├── <fecha>/decisions.ndjson
│   └── <fecha>/manifest.json
├── fixtures/
│   ├── config/market-cup.json
│   ├── config/risk-limits.json
│   ├── state/empty.json
│   └── money-core/*.json
├── adapters/
│   ├── ts-cli.ts                        # oráculo
│   ├── ts-http.ts                       # buildDashboard in-process
│   ├── cli.ts                           # protocolo v1 para Go/Rust
│   └── http.ts                          # SUT HTTP real
├── lib/
│   ├── canonicalize.ts
│   ├── compare.ts
│   ├── clock.ts
│   ├── fake-qvapay/                     # servidor cassette + SSE + webhook
│   ├── fake-telegram/
│   ├── record/                          # grabación supervisada + sanitización
│   └── sanitize.ts
├── runner/
│   ├── run.ts                           # CLI principal
│   ├── suites.ts
│   ├── report.ts
│   └── junit.ts
├── scripts/
│   ├── generate-goldens.ts
│   ├── verify-goldens.ts                # golden-guard
│   ├── self-parity.sh
│   ├── parity-gate.sh
│   ├── shadow-diff.sh
│   └── property-nightly.sh
├── baseline/
│   └── ts-junit.xml                     # 718 casos del oráculo
└── reports/                             # .gitignore: artefactos de CI
    ├── parity-report.json
    └── shadow/<fecha>/diff.json
```

### 7.2 Comandos (todos sin `pnpm`, por el problema de workspace read-only)

```bash
# 1) Auto-paridad del oráculo (sin Go/Rust todavía)
node --import tsx parity/runner/run.ts --sut ts-cli --suite pure \
  --report parity/reports/self-pure.json
node --import tsx parity/runner/run.ts --sut ts-http --suite http \
  --report parity/reports/self-http.json

# 2) Paridad de un servicio Go/Rust por CLI de conformidad
node --import tsx parity/runner/run.ts \
  --sut cli --cmd ./target/debug/trading-conformance \
  --suite pure,contract,replay \
  --report parity/reports/money-core.json

# 3) Paridad HTTP de un servicio
node --import tsx parity/runner/run.ts \
  --sut http --base-url http://127.0.0.1:8081 \
  --suite http --report parity/reports/gateway.json

# 4) Generar/verificar goldens (solo oráculo TS)
node --import tsx parity/scripts/generate-goldens.ts --from ts --commit "$(git rev-parse HEAD)"
node parity/scripts/verify-goldens.ts --manifest parity/manifest.json

# 5) Gate de despliegue
./parity/scripts/parity-gate.sh --service money-core --min-parity 1.0
./parity/scripts/parity-gate.sh --service notifier --min-parity 0.995

# 6) Property tests (por lenguaje)
cargo test --release --features conformance -- --nocapture
go test ./... -run 'TestINV' -rapid.checks=5000

# 7) Shadow
./parity/scripts/shadow-diff.sh --date 2026-11-12 \
  --oracle-ts ./target/debug/ts-replay --candidate http://127.0.0.1:8082
```

### 7.3 Variables de entorno y determinismo

| Variable | Uso |
|---|---|
| `CONFORMANCE_MODE=1` | Activa reloj inyectable, IDs deterministas y timeouts escalados; **nunca** altera la lógica de decisión |
| `CONFORMANCE_TIMEOUT_SCALE=0.01` | Escala timeouts de transporte para cassettes (mín. 10 ms) |
| `CONFORMANCE_CLOCK_MS` | Reloj virtual inicial del caso (el runner lo pasa por sesión) |
| `QVAPAY_BASE_URL=http://127.0.0.1:<port>` | Fake QvaPay; obligatorio en SUT nuevo |
| `CONFORMANCE_DASHBOARD_PASSWORD` | Credencial efímera del entorno de conformidad para la matriz HTTP |
| `TZ=UTC`, `LC_ALL=C` | Elimina variación de zona/locale |
| `NO_PROXY=*`, `HTTP_PROXY=`, `HTTPS_PROXY=` | Garantiza que no hay red externa |
| `RUST_BACKTRACE=0`, `GOMAXPROCS=1` (opcional) | Reproducibilidad de fallos |

### 7.4 Alias opcionales (si se permite tocar `package.json`)

No se modifica en este entregable; recomendación para el plan maestro:

```json
{
  "scripts": {
    "conformance:self": "node --import tsx parity/runner/run.ts --sut ts-cli --suite pure && node --import tsx parity/runner/run.ts --sut ts-http --suite http",
    "conformance:goldens": "node parity/scripts/verify-goldens.ts",
    "conformance:parity": "./parity/scripts/parity-gate.sh"
  }
}
```

---

## 8. Decisiones abiertas (para el plan maestro / dueño)

| # | Decisión | Recomendación | Bloquea |
|---|---|---|---|
| D1 | Lenguaje del runner | Node/TS (comparador JSON). No portarlo. | Nada (MVP) |
| D2 | ¿El gateway nuevo preserva las 109 rutas o rediseña? | Preservar contrato HTTP v1 durante la migración; el rediseño va después | L2, panel/Android |
| D3 | Superficie de conformidad en producción | Compilar CLI solo en CI (feature Rust / build tag Go); no en imagen final | L1 |
| D4 | Autoridad para regenerar goldens | Solo el dueño; label `golden-change` + changelog + revisión | L1+ |
| D5 | Tolerancia para deuda `float` | Cero tolerancias en valores; cuantización a escala declarada; vectores de borde obligatorios | L1, L3 |
| D6 | Tamaño de la ventana shadow | ≥ 7 días y ≥ 200 decisiones / ≥ 20 aplicables, o 3× volumen diario | L6 |
| D7 | ¿Se conserva `decisions`/`analytics` en TS al inicio? | Sí (no mueven dinero); reduce riesgo inicial | Plan global |
| D8 | ¿Qué servicios son money-critical? | `money-core`, `qvapay-adapter`, `config-registry`; confirmar con `01-domain.md` y plan | Gates |
| D9 | ¿Se permite `fast-check`/`proptest`/`rapid` como dependencia? | Sí, dev-only; justificar en el PR | L1 |
| D10 | Fecha de congelación de comportamiento de `src/` | Tras L0; solo fixes de seguridad hasta cutover | L0 |

---

## 9. Referencias cruzadas

- `docs/migration/analysis/01-domain.md` §1.3 (unidades/precisión), §3 (invariantes), §5.2 (contratos a congelar), §5.3 (estrategia de paridad), §7.5 (checklist).
- `docs/migration/analysis/02-persistence.md` §5.1 (servicios), §5.3 (tipos), §5.4 (redondeo), §6.5 (verificación de migración).
- `docs/migration/analysis/03-boundaries.md` §4.3 (109 rutas), §4.6 (deriva OpenAPI), §6.4 (topología y único escritor), §7 (K1–K14), §9.1 (secretos).
- Plan maestro y política: `docs/migration/roadmap.md` §2 (F0–F6), `docs/migration/verification.md` §L0–L3 y definición de terminado, `docs/migration/target-architecture.md`, `docs/adr/0012-paridad-de-comportamiento.md`, `docs/migration/parity-matrix.md` (matriz por archivo, generada desde §2/§5.2).
- Evidencia de la suite: `package.json:21,24,25`; `docs/VERIFICATION.md:10,23-27,49,51-53`; `docs/ARCHITECTURE.md:23-31,60,62,75-90`; `docs/OPERATIONS.md:13,96-106,120-126`.
- Puntos de inyección: `src/core/ports.ts:5-72`, `src/qvapay.ts:17,71-90,151-167`, `src/store.ts:350-377`, `src/market-math.ts:42-94,112-114`, `src/core/apply-budget.ts:8-30`, `src/core/risk-policy.ts:64-90`.

---

**Fin del documento.** Las cifras de la §0 se midieron en este workspace el 2026-11-12 y son reproducibles con los comandos de §1.1. Cualquier desviación de los criterios de §5.3 debe tratarse como deuda de paridad, no como excepción implícita.
