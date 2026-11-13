# Evidencia F0 — arranque del arnés de paridad (2026-11-12)

## Línea base (oráculo TypeScript)

- Comando: `node --import tsx --test test/*.test.ts`
- Resultado: **718 tests, 718 pass, 0 fail, 0 skipped, 0 todo**.
- Archivos: 95. LOC de tests: 15 769. Duración reportada: 10 062 ms
  (15,1 s de pared medidos por el análisis de tests).
- Commit de referencia del oráculo: `02bb5afc04b5eb95f5ac3996ef7634dedf073d02`.
- El README y `docs/VERIFICATION.md` declaraban 118 pruebas: corregidos a 718.

## Arnés de paridad v1

Creado en `parity/`:

| Pieza | Ruta | Estado |
| --- | --- | --- |
| Canonización estricta + hash + diff | `parity/lib/canonical.ts` | ✅ |
| Protocolo CLI v1 (NDJSON) | `parity/adapters/ts-cli.ts` | ✅ |
| Operaciones del oráculo | `parity/adapters/ops/*.ts` | ✅ 22 módulos puros |
| Runner + reporte | `parity/runner/run.ts` | ✅ |
| Lote dorado inicial | `parity/golden/v1/pure/market-math.json` | ✅ 18 casos |
| Schema de casos | `parity/schema/parity-case.schema.json` | ✅ |
| Wrapper | `parity/scripts/parity.sh`, script `pnpm parity:pure` | ✅ |

Ejecución verificada (cierre de L1):

```text
node --import tsx parity/runner/run.ts --sut ts --suite pure
159/159 casos en verde · 0 fallos
```

El primer lote cubrió las cinco reglas de redondeo relevantes de `market-math`
(QUSD 1e-8, fiat 1e-8, CUP a múltiplos de 10 por lado, tasa por índice, mediana)
y un caso negativo (`expectError`), para probar también el canal de errores. El
resto de lotes añadió riesgo, liquidez, presupuesto, pedidos flexibles,
scheduler, panel/auth, menús de Telegram, operador móvil, intenciones
monetarias, cuota de listados, caché QUSD y bucles de cacería.

## Reglas congeladas en el arnés

- Importes/tasas/porcentajes viajan como string decimal de escala fija; una
  diferencia `number` vs `string` es un fallo.
- Objetos canonizados por clave; los arrays conservan el orden del caso.
- Caso = JSON; el runner no conoce el lenguaje del SUT (protocolo CLI/HTTP).
- Regenerar goldens es un acto revisado con hash, nunca un atajo para aprobar.

## Resultados de los frentes F0

| Frente | Entregable | Resultado verificado |
| --- | --- | --- |
| Goldens de dominio puro | `parity/adapters/ops/*`, `parity/golden/v1/pure/*` | **159/159** casos verdes; **21/21 archivos L1 · 107/107 casos portables** |
| Contratos de adaptador (C) | `parity/scenarios/contract/*`, `parity/golden/v1/contract/*` | **74/74** casos verdes, 11 archivos, doble ejecución determinista |
| Superficie HTTP (H) | `parity/scenarios/http/*`, `parity/golden/v1/http/*` | **39/39** casos verdes, 9 archivos, `app.inject()` sin red |
| Fake QvaPay determinista | `parity/lib/fake-qvapay/**`, `parity/fixtures/contracts/**` | **135/135 checks**, 0 requests no declaradas, ~314 ms, 13 cassettes K1–K14 |
| Matriz 718 tests + manifest | `docs/migration/parity-matrix.md`, `parity/manifest.json` | **95 archivos / 718 casos**, 0 sin clasificar, categorías 107/74/39/470/22/6 |
| Ensayo SQLite v16→v31 | `docs/migration/analysis/06-data-rehearsal.md`, `tools/db-rehearsal/` | **33/33 checks**, migración sin errores, `data/` intacto |
| Replay stateful + gate CI | `parity/fixtures/replay/2026-11-12/**`, `parity/golden/v1/replay/**`, `parity/scripts/parity-gate.sh` | **4/4 escenarios** (14 pasos, 18 líneas), `pnpm parity:gate` en CI |

### Cobertura pura (L1)

```text
node --import tsx parity/runner/run.ts --sut ts --suite pure
159/159 casos en verde.

node --import tsx parity/tools/check-pure-coverage.ts
21/21 archivos L1 cubiertos · 107/107 casos de origen · 123 casos de golden que citan fuentes L1.
```

Los 159 goldens incluyen los 107 casos portables de L1 y, además,
`flexible-order`, `apply-budget` y `reconciliation-scheduler`. Cada lote se
regenera con su generador y `--check` falla si el oráculo deriva:

- `generate-domain-goldens.ts` → 81 casos (incluye el lote inicial `market-math`).
- `generate-extra-goldens.ts` → 25 casos.
- `generate-pure-goldens.ts` → 53 casos (cierre de L1).

### Contratos de adaptador y HTTP (L2)

```text
node --import tsx parity/tools/generate-contract.ts --check
11 archivos, 74 casos de contrato verificados.

node --import tsx parity/tools/generate-http.ts --check
9 archivos, 39 casos HTTP verificados.

node --import tsx parity/runner/run.ts --sut ts --suite contract
74/74 casos en verde.

node --import tsx parity/runner/run.ts --sut ts --suite http
39/39 casos en verde.
```

Los 74 contratos cubren `web-push`, Telegram, imágenes de chat, login/QvaPay,
presupuesto y tiempos de listado, SSE, timings de operación y las 27 variantes
de `qvapay-gateway`. Los 39 HTTP cubren dashboard, herramientas móviles, chat
con imagen, recuperación self-service, descarte masivo, cazador cooperativo,
presupuesto de acciones, estáticos y analytics. Cada generador ejecuta el
escenario dos veces y falla si el hash canónico difiere.

### Replay stateful (L3) y gate de CI

```text
node --import tsx parity/tools/generate-replay.ts --check
✓ golden/v1/replay/money-core.json
✓ fixtures/replay/2026-11-12/decisions.ndjson
✓ fixtures/replay/2026-11-12/manifest.json
4 escenarios, 14 pasos, 18 líneas de decisión verificados.

node --import tsx parity/runner/run.ts --sut ts --suite replay
✓ replay/market-ingest/dedupe/0001 (stateful, 4 pasos)
✓ replay/money-core/apply/0001 (stateful, 4 pasos)
✓ replay/money-core/reject/0001 (stateful, 2 pasos)
✓ replay/money-core/uncertain/0001 (stateful, 4 pasos)
4/4 casos en verde.

pnpm parity:gate
golden-guard: 6 generadores + cobertura L1 + manifiesto → OK
suite pura: 159/159 · contratos: 74/74 · HTTP: 39/39 · replay: 4/4 → OK
```

El corpus incluye feed con duplicados SSE/webhook, decisión con saldo libre,
rechazo 409 con reposición de la venta propia y apply incierto con conciliación
en dos pasos (sin repetir `apply`). Cada paso compara resultado normalizado,
llamadas upstream y `stateDigest`; no hay red, reloj real ni sleeps.

### Detalles del ensayo de datos

- v16→v31 en una transacción, 72–160 ms; 27→41 tablas, 11→32 índices, 0→6
  triggers, `schema_migrations` 16→31, `integrity_check` ok, 0 violaciones FK.
- Backup automático `qvaapply-before-v31-<ts>.sqlite` byte-idéntico al origen.
- Conteos clave preservados (operations 10, fiat_ledger 71, mutation_intents 21,
  capital_reservations 11, trade_workflows 11, config_revisions 5.416,
  settings 231, market_config 5).
- Cadena de configuración válida (mismo head, epoch 0); sumas de `fiat_ledger`
  idénticas a 8 dp en 7/7 grupos; drift float real pero 0 diferencia
  canonicalizado.
- `config_revisions` sigue al 83,5 % (22,1 MB): retención pendiente de decisión.

## Próximo gate F0

- [x] 718 casos clasificados (matriz + manifest, totales 107/74/39/470/22/6).
- [x] Goldens de los 107 casos puros L1 (21/21 archivos, 159 goldens en total).
- [x] Fake QvaPay con éxito/429/timeout/ambiguo/5xx/409 y smoke < 10 s.
- [x] Ensayo v16→v31 con manifiesto de verificación reproducible.
- [x] Corpus de replay stateful y `parity-gate` cableado en CI sin red ni reloj real.
- [x] MVP de 220 casos (107 P + 74 C + 39 H) en CI; el gate cubre dominio puro,
      contratos de adaptador, superficie HTTP y replay stateful.
