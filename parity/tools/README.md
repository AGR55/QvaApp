# `parity/tools` — generadores y guardas de paridad (F0)

Herramientas de las capas **L0/L1/L2** de [docs/migration/verification.md](../../docs/migration/verification.md). Convierten la suite TypeScript en artefactos versionados y reproducibles.

| Artefacto | Contenido |
| --- | --- |
| [`parity/manifest.json`](../manifest.json) | índice machine-readable `qvaapply.parity/v1`: una entrada por `test/*.test.ts` con categoría, casos, destino lógico, servicio E1, reutilización, lote, estado y motivo. |
| [`docs/migration/parity-matrix.md`](../../docs/migration/parity-matrix.md) | la misma matriz en español, con resumen ejecutivo, cuadre de totales, justificación de los 28 casos no aplicables y del caso especial `repository`. |
| `parity/golden/v1/pure/*.json` | goldens puros generados desde el oráculo TS congelado, con `goldenHash` por lote. |
| `parity/golden/v1/contract/*.json` | observaciones normalizadas de los 74 contratos de adaptador (C). |
| `parity/golden/v1/http/*.json` | pasos normalizados de los 39 casos de superficie HTTP (H). |

Los artefactos **se generan juntos**. Nunca se editan a mano.

## Goldens puros

| Generador | Lote | Casos |
| --- | --- | --- |
| [`generate-domain-goldens.ts`](generate-domain-goldens.ts) | lote inicial market-math, riesgo, liquidez, presupuesto, flexible-order | 81 |
| [`generate-extra-goldens.ts`](generate-extra-goldens.ts) | scheduler, dashboard, chat, menús y runtime Telegram | 25 |
| [`generate-pure-goldens.ts`](generate-pure-goldens.ts) | auth/controles del panel, móvil, intents, list-budget, caché QUSD y bucles de cacería | 53 |
| [`generate-replay.ts`](generate-replay.ts) | corpus stateful: feed → dedupe → decisión → mutación → conciliación | 4 escenarios / 14 pasos |
| [`generate-contract.ts`](generate-contract.ts) | contratos de adaptador con `fetch`/runtime/reloj inyectados | 11 archivos / 74 casos |
| [`generate-http.ts`](generate-http.ts) | superficie HTTP con `app.inject()` in-process | 9 archivos / 39 casos |

```bash
# regenerar (acto revisado; el diff y el goldenHash se revisan juntos)
node --import tsx parity/tools/generate-pure-goldens.ts

# CI: no escribe; sale con 1 si el golden no coincide con el oráculo
node --import tsx parity/tools/generate-pure-goldens.ts --check

# cobertura L1: 21/21 archivos y 107/107 casos de origen
node --import tsx parity/tools/check-pure-coverage.ts
```

Regla: regenerar nunca es un atajo para que pase un test. Si el oráculo cambió,
se revisa el diff del golden y se aprueba explícitamente.

## Replay stateful

El corpus vive en `parity/fixtures/replay/2026-11-12/` y se genera con
`generate-replay.ts`:

- `events.ndjson`: feed sanitizado (SSE/webhook, con orden durable y duplicados).
- `scenarios.json`: sesión (reloj, config, settings) y pasos con el gateway
  guionizado; no contiene `expect`.
- `decisions.ndjson`: traza canónica por paso (resultado, upstream y digest).
- `manifest.json`: conteos y `sha256` de cada archivo.

El generador ejecuta el mismo motor que el SUT
(`parity/lib/replay/session.ts`): `Store` real sobre SQLite temporal,
`MarketConfigService` y `OpportunityOrchestrator`, con reloj inyectado y gateway
en proceso. Sin red, sin reloj real y sin sleeps. Los UUID de workflow e
intención se normalizan por orden de aparición para que la traza sea estable.

```bash
node --import tsx parity/tools/generate-replay.ts          # regenera
node --import tsx parity/tools/generate-replay.ts --check  # CI
```

## Contratos de adaptador y HTTP (L2)

Los escenarios viven en `parity/scenarios/contract/` y `parity/scenarios/http/`.
Cada uno cita su `test()` de origen y usa los módulos reales con las fronteras
inyectadas:

- **Contract** (`generate-contract.ts`): `fetch`, runtime de web-push, bot de
  Telegram, reloj, `sleep`, presupuesto de listado y gateway guionizado. Sin red,
  sin reloj real ni esperas arbitrarias.
- **HTTP** (`generate-http.ts`): app Fastify real ejercida con `app.inject()`,
  cookies/CSRF/Bearer/ETag normalizados y campos volátiles redactados.

Ambos generadores ejecutan cada escenario **dos veces** y fallan si el hash
canónico no coincide. Crear o cambiar un golden exige revisar el diff del
escenario y del JSON.

```bash
node --import tsx parity/tools/generate-contract.ts          # regenera
node --import tsx parity/tools/generate-contract.ts --check  # CI
node --import tsx parity/tools/generate-http.ts
node --import tsx parity/tools/generate-http.ts --check

# depurar un escenario concreto
node --import tsx parity/tools/run-scenario.ts --suite contract --id web-push/02-subscribe-notify-once
node --import tsx parity/tools/run-scenario.ts --suite http --filter dashboard
```

## Gate completo

`parity/scripts/parity-gate.sh` encadena `golden-guard` (seis generadores,
cobertura L1 y manifiesto) con las suites `pure`, `contract`, `http` y `replay`
contra el oráculo. CI lo ejecuta como `pnpm parity:gate` después de `pnpm check`.

## Regenerar

Desde la raíz del repo (no se usa `pnpm`; el workspace puede estar read-only):

```bash
# regenera manifest.json + parity-matrix.md
node --import tsx parity/tools/build-manifest.ts

# modo CI: no escribe; sale con 1 si los artefactos del repo están desactualizados
node --import tsx parity/tools/build-manifest.ts --check
```

El script no recibe argumentos posicionales y funciona desde cualquier directorio (resuelve la raíz del repo a partir de su propia ruta). No ejecuta la suite de tests: fija el baseline verificado del oráculo (2026-11-12: **718 casos / 95 archivos**, 04-tests.md §0.1) y valida el inventario contra él.

Salida esperada:

```text
build-manifest: OK — 95 archivos / 718 casos (P 107, C 74, H 39, I 470, U 22, O 6).
  - parity/manifest.json
  - docs/migration/parity-matrix.md
```

## Qué valida (exit code 1)

| Condición | Motivo |
| --- | --- |
| Un `test/*.test.ts` existe y no está en `FILES` | archivo de test sin clasificar |
| Una fila de `FILES` no tiene archivo real en `test/` | clasificación obsoleta (archivo borrado o renombrado) |
| Duplicados de archivo en `FILES` | un caso aparecería dos veces |
| La suma de casos no es 718 | pérdida o doble conteo de casos |
| Totales por categoría ≠ 107/74/39/470/22/6 (archivos 21/11/9/42/9/3) | desvío del inventario de 04-tests.md §2 |
| Falta categoría, reutilización, lote, destino, estado o contrato K | caso sin clasificación completa |
| Incoherencia categoría ↔ reutilización ↔ lote ↔ destino | clasificación contradictoria |
| Un estado `ui`/`descartado` no tiene `motivo` | exclusión sin justificación escrita |
| `--check` y los artefactos del repo difieren | deriva generador ↔ artefactos |

El script acumula **todos** los errores y sale con 1 sin escribir nada.

## Clasificación: de la taxonomía al estado L0

Fuente de verdad: [docs/migration/analysis/04-tests.md](../../docs/migration/analysis/04-tests.md) §2 y §5.2.

| Categoría | Archivos | Casos | Estado | Reutilización | Lote |
| --- | ---: | ---: | --- | --- | --- |
| **P** puro/inyectable determinista | 21 | 107 | `portable` | A | L1 |
| **C** contrato de adaptador | 11 | 74 | `contract` | B | L2 |
| **H** superficie HTTP (`app.inject`) | 9 | 39 | `contract` | B | L2 |
| **I** integración durable (SQLite + dominio) | 42 | 470 | `golden` / `property` / `descartado` (`repository`) | B / C / D | L3–L4 |
| **U** UI/React/estructura de fuente | 9 | 22 | `ui` | D | L5 |
| **O** despliegue/scripts/reportes | 3 | 6 | `descartado` | D | L5 |

Reglas implícitas que el generador verifica:

- P ⇒ reutilización A y lote L1; C/H ⇒ B y L2; U/O ⇒ D y L5.
- I ⇒ B (golden), C (property) o D (`repository`, descartado como código).
- L5 ⇒ `targetService: "no-aplica"`; L1–L4 ⇒ destino lógico de la lista de servicios.
- Estado `descartado`: `repository` (20 casos, garantía sustituida por la verificación de migración de datos de 02-persistence.md §6.5) + los 3 archivos O.
- Estado `ui`: los 9 archivos U; se conservan en el frontend/smoke visual y no suman al score de backend.

Totales de estado resultantes: `portable` 107 · `contract` 113 · `golden` 444 · `property` 6 · `ui` 22 · `descartado` 26 = **718**.

## Destinos lógicos y servicios E1

Cada fila guarda el destino lógico (`targetService`) y su resolución al estado E1 (`e1Service`), según [verification.md](../../docs/migration/verification.md) §2 y [target-architecture.md](../../docs/migration/target-architecture.md) §3.1:

| Destino lógico | Servicio E1 |
| --- | --- |
| `money-core`, `qvapay-adapter`, `config-registry`, `decisions`, `market-ingest`, `audit`, `sync-coop-adapter` | `trading-core` |
| `gateway`, `dashboard-bff` | `edge` |
| `notifier`, `chat` | `notifier` |
| `analytics` | `analytics` |
| `no-aplica` | `no-aplica` (L5, fuera del score) |

`qvapay-adapter` incluye el rol de *executor* de mutaciones: en E1 vive dentro de `trading-core` y comparte su presupuesto de aplicación (un único escritor QvaPay).

## Cómo cambiar la clasificación

1. Edita la tabla `FILES` de [`build-manifest.ts`](build-manifest.ts) (o `EXPECTED`/`BASELINE` si cambia la suite, decisión revisada).
2. Ejecuta `node --import tsx parity/tools/build-manifest.ts`.
3. Revisa el diff de `parity/manifest.json` y `docs/migration/parity-matrix.md` y commitea los tres archivos juntos.
4. En CI, `--check` bloquea si alguien cambia un artefacto sin regenerar.

> Prohibido regenerar para que pase un test. Mover un archivo de lote o cambiar un estado exige actualizar el manifest y re-ejecutar el gate (04-tests.md §5.2).

## Requisitos

- Node ≥ 24 (probado con Node 25.9.0) y `tsx` disponibles en el workspace.
- Ejecutar sin `pnpm`.
- Git opcional: si no hay repo, `oracle.commit` se escribe como `unknown`; `oracle.srcHash` siempre se calcula desde `src/`.
