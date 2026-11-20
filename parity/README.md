# Arnés de paridad QvaApply

Red de seguridad de la migración a Go. Convierte la suite TypeScript actual
(718 tests verdes) en un **oráculo cross-language**: casos dorados que cualquier
implementación debe reproducir exactamente, y contratos de frontera que ninguna
implementación puede cambiar.

Diseño completo: [docs/migration/analysis/04-tests.md](../docs/migration/analysis/04-tests.md) y
[docs/migration/verification.md](../docs/migration/verification.md).

## Estado (F0 cerrado)

| Pieza | Estado |
| --- | --- |
| Runner + adaptador CLI TypeScript (`--sut ts`) | ✅ funcionando |
| Canonización estricta (objetos ordenados, decimales como string) | ✅ |
| Goldens puros: **21/21 archivos L1 · 107/107 casos de origen** | ✅ 159/159 casos verdes |
| Cobertura L1 comprobable (`check-pure-coverage.ts`) | ✅ 21/21 archivos |
| Contratos de adaptador L2: **11 archivos · 74/74 casos** | ✅ `--suite contract` |
| Superficie HTTP L2: **9 archivos · 39/39 casos** | ✅ `--suite http` |
| Fake QvaPay con cassettes (K1–K14) | ✅ 135/135 checks |
| Matriz de paridad de los 718 casos | ✅ 95 archivos / 718 casos |
| Ensayo de datos SQLite v16→v31 | ✅ 33/33 checks |
| Corpus de replay stateful | ✅ 4 escenarios · 14 pasos · 4/4 verdes |
| `parity-gate` + `golden-guard` en CI | ✅ `pnpm parity:gate` |

Los 159 goldens puros incluyen los 107 casos portables de L1 más casos de
`flexible-order`, `apply-budget` y `reconciliation-scheduler`, que se ejecutan
en la misma suite para no perder cobertura al portar el dominio.

Los casos de contrato viven en `parity/scenarios/contract/` y usan los módulos
reales con `fetch`, runtime, reloj y `sleep` inyectados: sin red, sin reloj real
ni esperas arbitrarias. Los 39 casos HTTP arrancan la app Fastify real y la
ejercen con `app.inject()` in-process. Ambos generadores ejecutan cada
escenario dos veces y fallan si el hash canónico difiere.

El corpus de replay vive en `parity/fixtures/replay/2026-11-12/`: feed
sanitizado (`events.ndjson`), escenarios (`scenarios.json`), traza canónica
(`decisions.ndjson`) y manifiesto con conteos y hashes. Los goldens stateful
(`parity/golden/v1/replay/`) se generan con el mismo motor que ejecuta el SUT:
SQLite temporal, reloj inyectado y gateway guionizado, sin red ni sleeps.

## Comandos

```bash
# Ejecuta los goldens puros contra el oráculo TypeScript
node --import tsx parity/runner/run.ts --sut ts --suite pure

# Contratos de adaptador y superficie HTTP (L2)
node --import tsx parity/runner/run.ts --sut ts --suite contract
node --import tsx parity/runner/run.ts --sut ts --suite http

# Filtra por subcadena de caseId
node --import tsx parity/runner/run.ts --sut ts --suite pure --filter round-rate

# Ejecuta contra un binario Go/Rust que hable el protocolo CLI v1
node --import tsx parity/runner/run.ts --sut cli --command "./conformance-sut" --suite pure

# Guarda el reporte (incluye hash canónico) para CI
node --import tsx parity/runner/run.ts --sut ts --suite pure --report /tmp/parity.json

# Regenera o verifica los goldens desde el oráculo TypeScript
node --import tsx parity/tools/generate-domain-goldens.ts
node --import tsx parity/tools/generate-extra-goldens.ts
node --import tsx parity/tools/generate-pure-goldens.ts
node --import tsx parity/tools/generate-contract.ts
node --import tsx parity/tools/generate-http.ts
node --import tsx parity/tools/generate-contract.ts --check
node --import tsx parity/tools/generate-http.ts --check

# Depura un escenario concreto y muestra su hash
node --import tsx parity/tools/run-scenario.ts --suite contract --id web-push/02-subscribe-notify-once
node --import tsx parity/tools/run-scenario.ts --suite http --filter dashboard

# Regenera o verifica el corpus de replay stateful
node --import tsx parity/tools/generate-replay.ts
node --import tsx parity/tools/generate-replay.ts --check

# Ejecuta el replay stateful contra el oráculo
node --import tsx parity/runner/run.ts --sut ts --suite replay

# Comprueba que los 21 archivos L1 siguen cubiertos por algún golden
node --import tsx parity/tools/check-pure-coverage.ts

# Gate completo de F0 (golden-guard + pura + contratos + HTTP + replay); lo usa CI
pnpm parity:gate
```

No se usa `pnpm` para el backend nuevo: `node --import tsx` está disponible en el
workspace actual y el runner queda fuera del build de producción.

## Protocolo CLI v1 (NDJSON)

Una petición por línea en `stdin`, una respuesta por línea en `stdout`. En la
suite pura cada línea es independiente; en `replay` el runner abre una sesión
(`replay.start`), envía pasos (`replay.step`) y la cierra (`replay.close`). La
sesión vive solo en el proceso del SUT y siempre usa reloj y IDs inyectados.

```json
{"id":"pure/market-math/round-qusd/0001#17","op":"market.roundQusd","input":{"value":1.234567891}}
{"id":"pure/market-math/round-qusd/0001#17","result":{"value":"1.23456789"}}
```

Un error se devuelve como `{"id":..., "error":{"class":"validation|protocol|error","message":"..."}}`.
Reglas: UTF-8, LF, sin red, reloj inyectable, IDs fijados por el caso.

## Reglas de oro

1. **Nunca dinero como `number`.** Importes, tasas y porcentajes viajan como
   string decimal de escala fija (`"20.00000000"`). Una diferencia
   `number` vs `string` es un fallo, no una tolerancia.
2. **El oráculo es el TS congelado.** Los goldens se generan desde el commit
   declarado en `generatedFrom`; regenerarlos es un acto revisado con hash y
   diff, nunca un atajo para que pase un test.
3. **Caso = JSON.** El runner no importa código Go/Rust: solo ve el protocolo.
   El SUT es opaco.
4. **Determinismo.** Sin reloj real, sin azar, sin red, orden total declarado.
5. **Un fallo de schema es un fallo del caso**, aunque el valor "parezca" igual.

## Estructura

```text
parity/
  schema/            # JSON Schema de los ficheros de casos
  lib/canonical.ts   # canonización, hash y diff estructural
  lib/replay/        # motor stateful: Store real + reloj + gateway guionizado
  adapters/
    ts-cli.ts        # oráculo TypeScript (registro de ops)
    ops/*.ts         # operaciones: una por módulo de dominio
  fixtures/
    contracts/qvapay # cassettes K1–K14 del fake
    replay/<fecha>/  # corpus sanitizado: events, scenarios, decisions, manifest
  golden/v1/
    pure/            # lotes de casos puros
    contract/        # escenarios de contrato L2 (fetch/runtime inyectados)
    http/            # superficie HTTP L2 vía app.inject
    replay/          # casos stateful generados desde el corpus
  scenarios/
    contract/*.ts    # un escenario por test C
    http/*.ts        # un escenario por test H
  runner/run.ts      # ejecuta y compara (pure + contract + http + replay)
  tools/             # generadores de goldens + guardas de cobertura/manifest
  scripts/           # wrappers y parity-gate.sh
```

## Cómo añadir un lote

1. Crea `parity/adapters/ops/<modulo>.ts` exportando `ops: Record<string, (input) => result>`.
   Formatea dinero con escala fija; no devuelvas `number` monetario.
2. Crea `parity/golden/v1/pure/<modulo>.json` con `schema`,
   `generatedFrom` (commit) y `cases[]`; cada caso cita su test de origen.
3. Ejecuta `--filter <modulo>` y verifica que el oráculo pasa.
4. Revisión independiente: quien implementa no aprueba sus propios goldens.
