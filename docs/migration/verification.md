# Verificación y paridad — política de seguridad para la migración

Estado: propuesta para revisión
Fecha: 2026-11-12
Depende de: [target-architecture.md](target-architecture.md), [roadmap.md](roadmap.md)
Anexo de detalle: [analysis/04-tests.md](analysis/04-tests.md) (pendiente de cierre)

## 0. Principio

Un sistema que mueve dinero no se migra "porque los tests nuevos pasan". Se
migra cuando se puede demostrar, con evidencia reproducible, que la
implementación nueva **toma las mismas decisiones, con los mismos números, ante
los mismos hechos**, y que ante fallos se recupera igual o mejor.

La suite actual (718 casos, 95 archivos) es la especificación ejecutable del
comportamiento. La migración no la sustituye por "tests nuevos del lenguaje
nuevo": la **reutiliza como oráculo** y añade las capas que faltan (paridad
cross-language, contratos, propiedades, caos y shadow).

## 1. Capas de verificación

### Estado real de la suite (medido 2026-11-12)

| Métrica | Valor | Nota |
| --- | --- | --- |
| Casos | **718 pass / 0 fail / 0 skipped** | `node --import tsx --test test/*.test.ts` |
| Archivos | 95 | sin helpers compartidos |
| LOC de tests | 15 769 | |
| Duración | ~15,1 s de pared (~10,1 s reportados) | |
| Llamadas `test()` | 643 estáticas, expandidas a 718 por tablas/bucles | |
| Con SQLite real | 43 archivos | la mayoría de integración |
| Con HTTP injection | 13 archivos | superficie Fastify |
| Leen fuente/HTML/CSS | 9 archivos | UI/regresión estructural |

Taxonomía (detalle en [analysis/04-tests.md](analysis/04-tests.md)):

| Categoría | Archivos | Casos | Reutilización |
| --- | ---: | ---: | --- |
| **P** puro/inyectable determinista | 21 | 107 | golden directo |
| **C** contrato de adaptador | 11 | 74 | cassette/replay |
| **H** superficie HTTP | 9 | 39 | HTTP scripted |
| **I** integración durable SQLite+dominio | 42 | 470 | replay/golden extraído |
| **U** UI/React/estructura | 9 | 22 | no aplica al backend |
| **O** despliegue/scripts | 3 | 6 | no aplica al backend |

Nota: `docs/VERIFICATION.md` y el README declaraban 118 pruebas; ya corregidos a
718. La evidencia de release de 2026-11-02 hablaba de 89 archivos; el baseline
real es 95 archivos / 718 casos.

### L0 — Línea base y matriz de paridad

- Congelar el baseline: commit de referencia, 718 tests verdes, tiempos, memoria
  del proceso, versión de Node, snapshot de la base de prueba.
- Inventariar **cada caso** en `docs/migration/parity-matrix.md` con estado:
  - `portable`: se reescribe como test Go del paquete.
  - `golden`: se cubre con fixture dorado ejecutado contra Go.
  - `contract`: se cubre con la suite de contratos (QvaPay/HTTP/webhook).
  - `property`: se cubre con property-based testing.
  - `ui`: se conserva en el frontend o en el smoke visual; no aplica a servicios.
  - `descartado`: solo con justificación escrita y revisión independiente.
- Gate: **0 casos sin clasificar**. La matriz es el documento de trabajo central
  de F0.

### L1 — Vectores dorados del dominio puro

Cubre la lógica determinista que primero se porta (~1.160 LOC):

- `risk-policy` (evaluación de límites y `RiskDecision` completa: `checks`,
  `kind`, `reasons`, `projectedExposureQusd`, `projectedDailyAppliedQusd`).
- `liquidity-plan` (plan todo-o-nada y snapshot restaurable).
- `apply-budget` (ventana de 2/60 s y migración del throttle legado).
- `market-math` + las **cinco reglas de redondeo distintas**: QUSD 1e-8, fiat
  no-CUP 1e-8, CUP a múltiplos de 10 con floor/ceil por lado, flexible a 2
  decimales, presupuesto a 2 decimales.
- `budget`, `flexible-order`, `hunting-requirements`,
  `reconciliation-scheduler`, `operation-display-state`.

Formato del fixture (canónico, versionado):

```json
{
  "schema": "qvaapply.parity/v1",
  "case": "risk-policy/global-limits/exposure-exceeded",
  "source": "test/risk-policy.test.ts:88",
  "input": { "...": "..." },
  "expect": {
    "kind": "blocked",
    "checks": [ { "id": "exposure", "ok": false } ],
    "reasons": ["..."],
    "projectedExposureQusd": "1234.56000000"
  },
  "meta": { "generatedFrom": "ts@<sha>", "approvedBy": "review:<fecha>" }
}
```

Reglas:

- Importes y tasas como **string decimal**, nunca `number`, para no arrastrar el
  drift de `float64`.
- Sin timestamps absolutos: usar `occurredAt` relativo y reloj inyectable.
- Orden de arrays normalizado (por ID o por clave declarada).
- IDs sustituidos por marcadores deterministas.
- Un fixture solo cambia con revisión explícita y diff revisado; **prohibido**
  regenerar fixtures automáticamente para que un test pase. La regeneración
  actualiza un hash por fixture y deja evidencia en `docs/migration/evidence/`.

### L2 — Contratos de frontera

Los contratos K1–K14 de [analysis/03-boundaries.md](analysis/03-boundaries.md)
se implementan como suite de conformidad contra cualquier implementación
(HTTP/CLI), con un **fake QvaPay determinista**:

- QvaPay REST: éxito, `429` con/sin `Retry-After`, timeout, 5xx, respuesta
  ambigua tras `apply`, `OFFER_CONTENDED`, `OFFER_PAUSED`, requisitos no
  cumplidos, oferta ya tomada, `apply` local agotado.
- Webhook: HMAC-SHA256 válida/ inválida, timestamp ±5 min, cuerpo >10 KB,
  duplicado, 202 solo tras persistir.
- SSE: `init`, `subscription_expired`, 401/402, `retry`, evento >64 KB,
  reconexión sin replay.
- Panel/API: envelopes `{data}`/`{error}`, códigos, cookie/CSRF/Origin, límites
  de cuerpo, rate limits, estáticos y path traversal.
- Chat: `attemptId` (mismo contenido confirmado sin segundo POST, contenido
  distinto 409), imágenes con límites.
- Sync Core/NATS: snapshot, contribuciones, revisión monotónica, dedupe por
  snapshot.
- Notificaciones: mismo evento → mismo `id`, sin duplicados por reintento,
  purga de endpoints 404/410, fallo de un canal no bloquea al otro.

Gate: la suite de contratos se ejecuta contra la implementación TS **y** contra
Go; cualquier divergencia es un fallo, no una "diferencia aceptable".

Estado F0 (2026-11-13): los **74 contratos C** y los **39 casos HTTP H** están
portados y verdes contra el oráculo TS (`--suite contract` y `--suite http`),
con goldens en `parity/golden/v1/{contract,http}/` y guardas de doble ejecución
determinista en `pnpm parity:gate`.

### L3 — Propiedades e invariantes

Property-based testing (Go: `testing/quick`, `rapid` o equivalente) sobre:

- **Reserva única:** nunca dos reservas activas cubren el mismo capital.
- **No doble gasto:** la suma de reservas + aplicado nunca supera el capital
  configurado; el ledger no permite dos asientos con la misma
  `(operation_uuid, direction)`.
- **Intención antes de mutación:** ninguna llamada a QvaPay sale sin intención
  durable persistida.
- **Resultado incierto:** un `uncertain` nunca se reintenta ni se compensa sin
  conciliación.
- **Compensación:** solo tras rechazo confirmado o conciliación que descarte la
  aplicación; reposición con la misma instantánea y clave idempotente.
- **Redondeo idempotente:** aplicar la función dos veces no cambia el valor.
- **Configuración:** la cadena de revisiones verifica; una revisión nueva
  resuelve la anterior sin huecos.

Además, un **auditor de invariantes** independiente que ejecuta SQL/consultas
contra la base (primero la de pruebas, luego la real en shadow):

- reservas activas y reservas de aplicación huérfanas,
- intenciones sin resolver con operación inexistente,
- operaciones no terminales sin reserva o con doble reserva,
- ledger descuadrado contra el saldo materializado,
- cadena de configuración rota o epoch inconsistente,
- ofertas propias canceladas sin reponer ni justificar.

Gate: 0 violaciones en toda la suite de escenarios y 0 en 14 días de shadow.

### L4 — Integración y caos

Escenarios con el fake y la base real del servicio:

- Kill -9 en los puntos medios de una saga (antes de reservar, tras reservar,
  tras enviar `apply`, tras recibir respuesta ambigua, tras conciliar).
- Corte de red a QvaPay, NATS y Postgres; reconexión.
- Entregas duplicadas y fuera de orden; mismo evento por SSE y webhook.
- Reloj hacia atrás/adelante (cooldowns, frescura, día de negocio).
- Disco lleno, DB bloqueada, reinicio durante migración de datos.
- Caída de `notifier`/`edge` sin afectar al núcleo.
- Recuperación de arranque con intenciones pendientes.

Criterio: tras cada caos, **ningún `apply` duplicado**, ninguna reserva huérfana,
todas las intenciones resueltas o explícitamente en `uncertain` con alerta.

### L5 — Shadow y comparación diferencial

- `trading-core` en producción **sin permiso de mutar**: lecturas reales,
  decisiones escritas en tablas shadow + log de divergencias.
- Comparador por caso: idéntica / diferencia numérica / diferencia de razón /
  decisión distinta / solo en un lado.
- Métrica diaria y alertas. Criterio: **≥ 99,9 % de decisiones idénticas durante
  7 días consecutivos** y 0 divergencias sin explicar.
- Toda divergencia se investiga y se convierte en fixture de regresión.

### L6 — Gates operativos del corte

- Dry-run de migración de datos (mínimo 2) con manifiesto de verificación:
  conteos por tabla, sumas de saldos fiat y QUSD, ofertas abiertas, operaciones
  no terminales, hashes de configuración y epoch, snapshots de lectura.
- Soak 72 h con memoria plana y CPU comparables al baseline.
- Canary con límites reducidos, un solo mercado y aprobación manual de las
  primeras aplicaciones; escalado documentado.
- Rollback ensayado de verdad (no solo escrito): restaurar TS + reconciliar los
  intents creados por Go.
- Observación intensiva 48 h y 14 días de estabilidad antes de retirar TS.

## 2. Estructura propuesta del arnés

```text
parity/
  schema/              # JSON Schema 2020-12 con x-qva-scale (escala decimal por campo)
  golden/v1/
    pure/              # L1: 107 casos de origen (159 goldens) risk, liquidity, math, budget, flexible...
    contract/          # L2: cassettes QvaPay, webhook, SSE, chat, sync
    replay/            # L3/L5: corpus stateful (4 escenarios, 14 pasos) con SQLite real
  manifest.json        # índice: caseId → fuente, servicio destino, reutilización, lote
  baseline/            # ts-junit.xml y hashes del oráculo (718 casos)
  adapters/
    ts-cli.ts          # oráculo in-process (módulos TS actuales)
    ts-http.ts         # oráculo de la superficie Fastify
    cli.ts             # protocolo CLI v1 (stdin/stdout NDJSON) para Go/Rust
    http.ts            # cliente HTTP contra servicios (cookie/CSRF/Bearer)
  lib/fake-qvapay/     # cassette estricto, reloj virtual, log de requests, fake SSE/Telegram/push
  runner/              # comparador canónico, reporte JSON/JUnit, gate
  scripts/             # parity-gate.sh, verify-goldens.ts, shadow-diff.sh
services/
  core/ edge/ notifier/ analytics/
tools/
  export-fixtures/     # TS → golden, con aprobación y hash
  migrate-db/          # SQLite → Postgres con manifiesto de verificación
```

Comandos previstos (se implementan en F0/F1, no ahora; sin `pnpm` para el
backend nuevo):

```bash
make parity              # goldens P + contratos contra TS y contra Go
make contracts           # suite K1-K14 contra TS y Go
make invariants          # auditor de invariantes
make chaos               # escenarios L4
make shadow-report       # resumen diferencial del día
make cutover-manifest    # manifiesto de verificación de datos
```

### Paridad medible por servicio

```text
Required(s) = goldens de casos con targetService = s
            ∪ contratos K de sus adaptadores
            ∪ casos HTTP de las rutas que s posee
            ∪ invariantes INV aplicables a s

Parity(s) = |casos requeridos superados| / |casos requeridos|
```

Criterios: `Parity = 1.0` en servicios que tocan dinero (`trading-core` y su
adaptador QvaPay/configuración); `≥ 0,995` sin fallos en el resto; `skipped=0`,
`xfail=0`; log de mutaciones upstream exacto (`mutationParity=1.0`); y ningún
`stateDigest` distinto. Cualquier exclusión va en `parity/exclusions.json` con
motivo y aprobación del dueño, y no reduce `Required` en silencio.

Los nombres de servicio del anexo 04 (`money-core`, `qvapay-adapter`,
`config-registry`, `decisions`, `market-ingest`, `audit`, `gateway`,
`dashboard-bff`, `notifier`, `chat`, `analytics`) son destinos lógicos del
arnés. En el estado E1 se mapean así: `money-core` + `qvapay-adapter` +
`decisions` + `config-registry` + `market-ingest` + `audit` → `trading-core`;
`gateway` + `dashboard-bff` → `edge`; `notifier` + `chat` → `notifier`;
`analytics` → `analytics`.

## 3. CI

| Etapa | Qué ejecuta | Bloquea |
| --- | --- | --- |
| legacy | `pnpm check` (TypeScript actual) | merge |
| go | `go build`, `go test -race`, `staticcheck`, `govulncheck` | merge |
| parity | L1 + L2 contra TS y Go | merge |
| invariants | L3 (escenarios) | merge |
| chaos | L4 (subconjunto rápido, nightly completo) | nightly |
| shadow | L5 (job diario en producción, solo lectura) | escalado de límites |
| security | escaneo de secretos, dependencias, licencias | merge |

## 4. Reglas anti-falso-verde

1. **Prohibido regenerar goldens para que pase un test.** La regeneración es un
   acto revisado, con hash y evidencia.
2. **Revisión independiente** de fixtures y de la matriz de paridad: quien
   implementa no aprueba sus propios goldens.
3. **Reloj, azar y red inyectables** en todo test; sin `sleep` arbitrarios; sin
   red en la suite determinista.
4. **Mutation testing** en los paquetes críticos (risk, liquidity, money,
   rounding, intents): puntuación mínima acordada (p. ej. 80 % en dominio puro).
5. **Cobertura con criterio:** 100 % de ramas en redondeo, riesgo e intents;
   cobertura alta no sustituye a propiedades e invariantes.
6. **Ningún test "de integración" que no ejecute el binario/HTTP real**; nada de
   simular el servicio por dentro.
7. **Cada incidente histórico documentado** en `docs/` y `docs/fixes/` se
   convierte en fixture de regresión.
8. **La ausencia de divergencia se mide**, no se asume: el comparador shadow
   tiene que estar vivo y con datos, no en verde por vacío.

## 5. Definición de terminado

La migración se considera terminada (y solo entonces se retira TypeScript) si:

- [ ] 100 % de los 718 casos actuales están en la matriz de paridad con estado
      final (`portable`/`golden`/`contract`/`property`/`ui`/`descartado` con
      justificación).
- [ ] 100 % de paridad en el corpus dorado del dominio puro, incluidas las cinco
      reglas de redondeo y las decisiones de riesgo completas.
- [ ] 100 % de los contratos K1–K14 en verde contra Go.
- [ ] 0 violaciones de invariantes en la suite, el caos, el shadow y la
      producción observada.
- [ ] ≥ 99,9 % de decisiones idénticas en shadow durante 7 días consecutivos.
- [ ] Manifiesto de migración de datos sin discrepancias sin explicar.
- [ ] 14 días de producción en Go sin doble aplicación ni conciliación abierta
      por causas nuevas.
- [ ] Rollback real ensayado y documentado.
- [ ] Soak 72 h y observación 48 h tras el corte, con métricas y alertas.
- [ ] Runbook, ADRs y documentación actualizados; evidencia archivada en
      `docs/migration/evidence/`.

## 6. Criterios de rollback

Se revierte a TypeScript (la base TS se conserva 14 días) si ocurre cualquiera:

- cualquier `apply` duplicado o mutación sin intención,
- saldo o ledger descuadrado sin explicación,
- intención `uncertain` no resuelta que bloquee una oferta > 15 min,
- divergencia de decisión sistemática (> 0,1 % en una hora),
- pérdida de notificaciones de operación o fallo de la superficie de control,
- imposibilidad de leer o escribir la base de forma consistente.

El rollback no es un fracaso: es la garantía de que el dinero pesa más que la
migración.
