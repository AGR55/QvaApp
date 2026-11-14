# Plan de migración — de monolito TypeScript a microservicios Go

Estado: aprobado; F0 cerrado el 2026-11-13 (arrancó el 2026-11-12)
Fecha: 2026-11-13
Decisiones confirmadas: Go, Postgres por servicio (VPS 4–8 GB), ventana de
shadow 7 días + 14 días de rollback.
Depende de: [target-architecture.md](target-architecture.md), [verification.md](verification.md)

## 0. Resumen

La migración se ejecuta como **Strangler Fig con paridad verificable**: primero
se congela y automatiza el comportamiento (fixtures + arnés + fake de QvaPay),
después se porta el dominio puro y la ruta caliente a Go, luego se ejecuta en
**shadow** contra el sistema real, y solo al final se corta el dinero con
ventana de congelación, límites reducidos y rollback mantenido.

No hay big-bang. No se migra el frontend. No se parte la base transaccional del
dinero. Duración realista: **16–20 semanas** trabajando una sola persona con
apoyo de agentes; el mínimo irreductible son las 2–4 semanas de soak y shadow
necesarias para confiar en un sistema que mueve dinero. Se puede paralelizar
con agentes, pero **no se puede comprimir el tiempo de observación**.

Entregables de cada fase en la tabla de la sección 9. El criterio global de
"migración terminada" está en [verification.md](verification.md#definición-de-terminado).

## 1. Estrategia en una página

```text
F0 CONGELAR     F1 CIMIENTOS      F2 PROTOTIPO     F3 SHADOW        F4 PERIFERIA    F5 CORTE        F6 DESMONTE
specs+fixtures   Go+Postgres       ruta caliente    core live-read   edge+notifier   datos+dinero    retirar TS
  1-2 sem          2-3 sem           2-3 sem          3-4 sem          2-3 sem         2-3 sem         1-2 sem
   │                 │                 │                │                │               │               │
   ▼                 ▼                 ▼                ▼                ▼               ▼               ▼
718 tests        dominio puro      paridad+p99       ≥99,9% 7 días    UI/push/menú   14 días estable  sin TS
inventariados    100% paridad      sin doble apply   invariantes OK   sin pérdidas    rollback listo   docs+ADR
```

Regla de oro: **una fase no empieza hasta que la anterior tiene su gate en
verde**, y el gate no lo firma el mismo que implementó (revisión independiente,
aunque sea otro agente).

## 2. F0 — Congelar el comportamiento (1–2 semanas)

Objetivo: que el "qué" sea ejecutable y reproducible antes de escribir Go.

Actividades:

1. **Inventario de los 718 tests** con estado de portabilidad y mapeo a módulos
   (salida de [analysis/04-tests.md](analysis/04-tests.md)). Cada archivo de
   test recibe una fila en `docs/migration/parity-matrix.md` con estado:
   `portable`, `golden`, `TS-only`, `UI`, `descartado-con-justificación`.
2. **Arnés de paridad** en `parity/`:
   - esquema JSON canónico de fixtures (normalización de decimales, timestamps,
     orden, IDs),
   - generador que ejecuta la implementación TS y produce fixtures versionados,
   - runner que ejecuta fixtures contra cualquier implementación (CLI/HTTP), no
     solo Go,
   - regeneración controlada: un fixture solo cambia con revisión explícita y
     diff revisado; nunca se regenera "para que pase".
3. **Fake QvaPay** determinista: servidor local que reproduce listados, P2P,
   apply/edit/cancel, chat, perfil y saldos, con inyección de fallos
   (429 con `Retry-After`, timeout, 5xx, respuesta ambigua/post-ack-perdido,
   `OFFER_CONTENDED`, oferta ya tomada). Cassettes grabadas y versionadas.
4. **Corpus de replay**: exportar `market_feed_events`, `market_observations`,
   `decision_events` y auditoría de la base real (sanitizado: sin tokens, sin
   secretos, sin PII) a `fixtures/replay/`. Es el material con el que se probará
   la paridad en F2/F3. Mientras no exista un dump sanitizado, el corpus se
   deriva del oráculo con el mismo esquema y se versiona con hashes y conteos.
5. **Baseline reproducible**: medir y registrar con la implementación TS
   (tiempos de la suite, memoria del proceso, latencias de recepción→despacho
   de los logs existentes) en `docs/migration/baseline.md`.
6. **Contratos**: OpenAPI de las 102 declaraciones de ruta (109 efectivas) actuales y AsyncAPI de eventos
   internos propuestos; congelar payloads de `/api/mobile/*` para Android.

Gate F0 (estado 2026-11-13):

- [x] 718 casos inventariados en 6 categorías (P 21/107, C 11/74, H 9/39,
      I 42/470, U 9/22, O 3/6), 0 sin clasificar.
- [x] El runner de paridad ejecuta la implementación TS y pasa el 100 % de los
      fixtures que cubre (**159/159** en el dominio puro portado).
- [x] Goldens puros completos: **21/21 archivos L1 · 107/107 casos portables**
      (`check-pure-coverage.ts`); 159 goldens ejecutables en `pure/`.
- [x] El fake QvaPay reproduce éxito, 429, timeout, resultado incierto, oferta
      ya tomada, edición/cancelación y webhook firmado (135/135 checks).
- [x] Ensayo SQLite v16→v31 reproducible con manifiesto (33/33 checks, 0 pérdida).
- [x] Corpus de replay stateful reproducible de extremo a extremo sin red:
      **4 escenarios / 14 pasos / 18 líneas de decisión** sobre SQLite real,
      reloj inyectado y gateway guionizado (`generate-replay.ts --check`).
- [x] `golden-guard` + `parity-gate` cableados en CI (`pnpm parity:gate`):
      seis generadores y manifiesto sin deriva, suite pura **159/159**,
      contratos **74/74**, HTTP **39/39** y replay **4/4** TS→TS.
- [x] MVP completo de 220 casos (107 P + 74 C + 39 H) con contratos K y HTTP
      scripted; CI cubre P + contratos + HTTP + replay stateful.

## 3. F1 — Cimientos Go y dominio puro (2–3 semanas)

Objetivo: infraestructura de calidad y los módulos deterministas portados con
paridad total. Es la fase de mayor retorno y menor riesgo.

Actividades:

1. **Workspace Go** en `services/` (un `go.work` con módulos por servicio y
   paquetes compartidos mínimos). Regla: nada de paquete "common" gigante; solo
   tipos de contrato, decimal, IDs, telemetría y errores.
2. **CI** (GitHub Actions) con: `go build ./...`, `go test -race ./...`,
   `staticcheck`, `golangci-lint`, `govulncheck`, cobertura, y el runner de
   paridad. Se mantiene el pipeline actual de TypeScript mientras exista.
3. **Postgres local** (compose) + herramienta de migraciones versionadas
   (`goose` o `atlas`) + esquema consolidado v1 derivado de las 31 migraciones
   SQLite (salida de [analysis/02-persistence.md](analysis/02-persistence.md)).
4. **Primitivas transversales**: `outbox`/`inbox`, `idempotency`, decimal y
   redondeo, reloj inyectable, IDs UUIDv7, cifrado AES-GCM compatible con
   `LOCAL_ENCRYPTION_KEY`, cliente QvaPay tipado, fake de QvaPay, logging con
   `trace_id`, métricas.
5. **Portar dominio puro** (sin I/O), con tests generados desde fixtures +
   property-based testing:
   `risk-policy`, `liquidity-plan`, `apply-budget`/presupuesto, `market-math`
   y redondeo de tasas, `hunting-requirements`, `price-simulation`,
   `operation-display-state`, hash/revisiones de configuración.
6. **Auditor de invariantes** ejecutable contra Postgres (SQL + Go): reserva
   única, intención antes de mutación, sin operación con mutación sin resolver,
   reserva huérfana, saldo negativo, doble aplicación del mismo evento. Se
   ejecuta en CI contra escenarios y luego en producción como watchdog.

Gate F1:

- [x] Paridad 100 % en fixtures del dominio puro (`go test` + runner):
      **159/159** casos de golden, 25 paquetes puros.
- [x] Property tests de invariantes financieros en verde (redondeo
      idempotente, presupuesto que no excede lo disponible y libro de reservas
      sin doble gasto/doble reserva).
- [x] Esquema Postgres reproducible desde cero y migrable desde un dump SQLite
      de prueba con verificación de conteos. Snapshot `core-v1.sql` validado en
      PostgreSQL 16; importación de una copia v31: 41 tablas, 16.533 filas,
      0 mismatches. Triggers traducidos y verificados.
- [x] Auditor de invariantes SQL: reservas huérfanas/terminales, doble asiento,
      saldos negativos, límites y cadena de configuración. Sin violaciones en la
      copia v31; `verify-money.mjs` valida saldos, ledger y operaciones a 8 dp.
- [x] Primitivas transversales iniciales: outbox, inbox e idempotencia durable
      con constraints Postgres (`0003_outbox_inbox.sql`) y repositorios pgx
      con tests de integración.
- [ ] CI completo en verde y con tiempos documentados. Los jobs `verify` y
      `postgres-f1` ya incluyen `go test -race`, staticcheck, golangci-lint,
      govulncheck, esquema, triggers, importación, auditor e importes; falta la
      primera ejecución real del workflow y sus tiempos de runner.

## 4. F2 — Prototipo de la ruta caliente (2–3 semanas)

Objetivo: demostrar (o refutar) con medición que Go reproduce la decisión y no
empeora la latencia. Si este gate falla, **no se sigue**; se corrige el diseño
antes de invertir en el resto. Esta fase responde literalmente a la conclusión
de `docs/2026-11-02-hunting-opportunities-review.md`: comparar contra un
prototipo Go/Rust con replay idéntico y p99 antes de reescribir.

Alcance del prototipo (desechable si hace falta, pero con estructura de
producción):

- Ingesta de replay/fake: SSE y webhook → dedupe → `market_observations`.
- Pipeline: oportunidad → riesgo → liquidez → presupuesto → reserva en Postgres
  → `mutation_intent` → despacho a fake QvaPay (apply/cancel/edit).
- Reconciliación de arranque y de resultado incierto.
- Sin Telegram, sin panel, sin producción, sin mutaciones reales.

Mediciones (mismo corpus, misma máquina, TS vs Go):

- decisiones byte a byte (normalizadas) sobre el 100 % del corpus,
- p50/p95/p99 de recepción→despacho, y recepción→reserva,
- memoria RSS y CPU en reposo y bajo replay,
- recuperación tras kill -9: ningún `apply` duplicado, intents resueltos,
- comportamiento con 429, timeout y respuesta ambigua.

Gate F2:

- [x] 100 % de decisiones idénticas en el corpus: **4/4 casos, 14/14 pasos**;
      resultados, upstream y `stateDigest` idénticos.
- [x] p99 local del replay completo **1,8–3,0 ms** (< 10 ms); benchmark Go vs
      TS documentado (~20–32× y ~8× menos RSS en este escenario).
- [x] Cero doble publicación tras **kill -9** y recuperación por lease; intents
      del corpus resueltos/reconciliados.
- [x] Informe `docs/migration/2026-11-13-f2-prototype-report.md` con números,
      limitaciones y condiciones.
- [x] Decisión explícita: **continuar a F3**, con sesión replay persistente y
      benchmark en VPS como condiciones previas.

## 5. F3 — `trading-core` completo en shadow (3–4 semanas)

Objetivo: implementar el servicio real y ejecutarlo **sin poder mutar** junto a
producción.

Estado (2026-11-13): bootstrap shadow desplegado por SSH en
`/opt/qvaapply-f3-shadow` (health/ready/metrics, Postgres propio, puerto
loopback), sin tocar producción. Comparador persistente, replay del corpus y
auditoría de decisiones reales operativos en la VPS: **4/4 casos · 14/14 pasos
· 14/14 JSON idénticos** y **5/5 decisiones reales comparables**. Soak
continuo iniciado con tail y muestreo de soak cada 5 min, auditoría horaria,
replay, invariantes y workflows diarios. Caos (6 escenarios), benchmark y
runbook completados. También se auditan **17/17 workflows reales** con
`risk_decision_json`, invariantes de continuidad fiat/operaciones/intenciones y
existe un cliente QvaPay **read-only** con tests. Pendiente completar 7 días/72
h, portar el resto de casos de uso y conectar el cliente QvaPay a la ingesta
shadow en vivo.

Actividades:

1. Portar el resto de casos de uso: operaciones/workflows, capital y rebalanceo,
   reclamaciones de conciliación, recuperación self-service, config versionada
   e integridad, auditoría, ledger fiat, recibos de pago y flujo móvil, chat de
   operación, puente cooperativo (HTTP+NATS de Sync Core), pausa de emergencia.
2. **Modo shadow**: `core` se conecta a QvaPay solo para lecturas (listado,
   perfiles, saldos) y escribe decisiones/operaciones simuladas en tablas
   `shadow_*` y en el log de divergencias. Nunca llama a endpoints de mutación.
3. **Comparador diferencial**: proceso que toma la decisión autoritativa de TS
   (vía `decision_events`/auditoría) y la del shadow Go, y clasifica:
   idéntica, diferencia numérica, diferencia de razón, decisión distinta,
   solo-uno. Métrica diaria y alertas.
4. **Auditor de invariantes** contra la base shadow + la real.
5. **Caos**: matar procesos, cortar red a QvaPay/NATS/Postgres, reloj torcido,
   entregas duplicadas y fuera de orden, disco lleno simulado. Todo con fake.
6. **Soak** de 72 h mínimo con replay continuo y memoria plana.

Gate F3:

- [ ] ≥ 99,9 % de decisiones idénticas durante **7 días consecutivos** de shadow
      sobre datos reales; 0 divergencias sin explicar. (En curso con tail cada
      5 min; aún no hay 7 días.)
- [ ] Invariantes limpios todos los días del periodo. (Auditor SQLite y timer
      listos; 1 ejecución limpia registrada.)
- [x] Suite de caos en verde y documentada. (6 escenarios; ver
      `services/f3/chaos.sh`.)
- [ ] RSS/CPU medidos y comparados con el baseline; sin fugas en 72 h.
      (Medidos; falta confirmar 72 h.)
- [x] Runbook de operación actualizado para el nuevo servicio.
      (`docs/migration/f3-shadow-runbook.md`.)

## 6. F4 — `edge` y `notifier` (2–3 semanas)

Objetivo: sacar de producción las superficies no financieras, que son las que
más aíslan fallos y menos riesgo tienen.

`edge`:

- Reproducir las 102 declaraciones de ruta (109 efectivas) actuales (incluidas `/api/mobile/*`, `/api/live/*`,
  `/service-worker.js`, `/api/openapi.json`) con auth/sesión/CSRF/origen
  idénticos.
- Servir `web/dist` sin cambios; verificar con `scripts/visual-smoke.mjs`
  (Chromium, responsive, axe/WCAG).
- Sesiones en Postgres de `edge`; ventana de re-login aceptada y anunciada.
- Canary: levantar `edge` en puerto alterno, validar con el panel real (solo
  lectura + config), después conmutar Nginx. Rollback: devolver Nginx a TS.

`notifier`:

- Portar comandos, menús y textos de Telegram con tests golden de render
  (los actuales `telegram-*-test.ts` son casi snapshots; se convierten en
  goldens).
- Web Push (VAPID) y FCM con dedupe por evento y dispositivo.
- **Cuidado:** el token de Telegram solo admite un long-polling activo. El corte
  se hace en ventana corta con la automatización pausada, no en paralelo.
- Prueba previa con un bot de staging y chat de pruebas.

Gate F4:

- [ ] Smoke visual y WCAG en verde; paridad de rutas ≥ 100 % de las usadas por
      web y Android.
- [ ] Menú y textos de Telegram idénticos en goldens; 0 avisos perdidos en la
      ventana de corte (cola drenada y verificada).
- [ ] Push y FCM entregados en pruebas con dedupe verificado.
- [ ] Fallo de `notifier` no afecta al trading (prueba explícita).

## 7. F5 — Migración de datos y corte del dinero (2–3 semanas)

Objetivo: sustituir el escritor autoritativo sin perder un céntimo.

Preparación (dry-runs, mínimo 2 en staging con snapshot de producción):

1. Congelar escrituras, pausar automatización, drenar colas, reconciliar **todas**
   las mutaciones e intents.
2. Snapshot SQLite + dump transformado a Postgres (`core`, `edge`, `notifier`).
3. Verificación: conteos por tabla, sumas de saldos fiat/QUSD, ofertas abiertas,
   operaciones no terminales, hashes de configuración, cadena de revisiones,
   comparación de snapshots de lectura.
4. Informe de migración firmado con cada discrepancia y su resolución.

Corte:

1. Parada ordenada de TS; congelación de escrituras; backup final.
2. Migración; arranque de `core` en modo **cauteloso**:
   `CONFIRM_REAL_TRADING` equivalente, límites al mínimo, un solo mercado, cupo
   diario bajo, aprobación manual de las primeras N aplicaciones.
3. Observación intensiva 48 h; escalado gradual de límites con el operador
   (documentado por cambio) hasta la configuración normal en 1–2 semanas.
4. **Rollback**: TS congelado pero desplegable; la base TS se mantiene como
   fuente hasta 14 días después del corte. Rollback probado antes del corte
   (ensayo real en staging). Si se revierte: se reconcilian los intents creados
   por Go contra QvaPay y se restauran las escrituras TS.

Gate F5:

- [ ] Informe de migración sin discrepancias sin explicar.
- [ ] 14 días de operación Go sin incidentes de reconciliación ni doble
      aplicación, con todos los invariantes limpios.
- [ ] Rollback ensayado y documentado.
- [ ] Operador confirma que el panel, Telegram, móvil y avisos funcionan.

## 8. F6 — Desmonte y cierre (1–2 semanas)

- Retirar la implementación TypeScript del backend (conservar `web/` y los
  fixtures), archivar la suite TS traducida a `parity/legacy/` como referencia.
- Actualizar `docs/ARCHITECTURE.md`, `OPERATIONS.md`, `VPS.md`, `CONTEXT.md`,
  ADRs (0001 y 0002 pasan a "sustituidos"), README y runbook de incidentes.
- Revisión post-mortem de la migración: qué divergió, qué se subestimó, qué se
  automatizó para la próxima.
- Rotación de secretos usados durante la transición.

## 9. Resumen de entregables y gates

| Fase | Duración | Entregables | Gate |
| --- | --- | --- | --- |
| F0 (en curso) | 1–2 sem | matriz de paridad, fixtures, fake QvaPay, corpus replay, contratos, baseline | 718 inventariados + runner TS verde |
| F1 | 2–3 sem | workspace Go, CI, Postgres, outbox/inbox, dominio puro, auditor | paridad dominio 100 % + invariantes |
| F2 | 2–3 sem | prototipo ruta caliente + informe de medición | decisiones 100 % + p99 + caos |
| F3 | 3–4 sem | `trading-core` shadow + comparador + soak | ≥99,9 % 7 días + invariantes |
| F4 | 2–3 sem | `edge` + `notifier` | UI/menú/push paridad + fallo aislado |
| F5 | 2–3 sem | migración de datos + corte + rollback | 14 días estable |
| F6 | 1–2 sem | desmonte TS + docs + ADRs | migración cerrada |

Total: **16–20 semanas**. Con agentes en paralelo, el trabajo de
implementación se puede solapar entre fases (F1/F2 y F3/F4), pero los gates de
observación (F3 y F5) tienen duración fija.

## 10. Riesgos principales y mitigación

| Riesgo | Prob. | Impacto | Mitigación |
| --- | --- | --- | --- |
| Divergencia de redondeo/decimales entre TS (float64) y Go (decimal) | Alta | Alto | Fixtures de redondeo de primera clase; prohibido `float64` para dinero; comparación por valor redondeado canónico |
| Migración de datos pierde o duplica estado | Media | Crítico | Dry-runs, checksums, sumas de saldos, ventana de congelación, rollback TS 14 días |
| Doble `apply` durante transición | Media | Crítico | Un solo escritor por contrato; intents durables; flags de shadow; auditoría de ofertas |
| Bot de Telegram duplicado (dos long-polling) | Alta | Medio | Corte en ventana con automatización pausada; staging token; verificación de `getUpdates` |
| API móvil/Android se rompe | Media | Alto | Contratos congelados; tests de contrato de `/api/mobile/*`; APK actual como referencia |
| RAM insuficiente en la VPS con Postgres + 3 servicios | Media | Medio | Medir en staging; límites por contenedor; alternativa SQLite-por-servicio documentada |
| Fatiga/errores del operador durante el corte | Media | Alto | Runbook paso a paso, ventana de bajo tráfico, lista de comprobación, segunda persona |
| Scope creep (rediseñar el frontend, añadir features) | Alta | Medio | Fuera de alcance explícito; solo paridad |
| Tests "verdes" que no prueban nada | Media | Alto | Mutation testing en dominio crítico; revisión independiente de goldens; prohibido regenerar a la ligera |
| NATS/outbox con entregas duplicadas o fuera de orden | Media | Medio | Inbox dedupe, versiones monotónicas, reconciliación periódica |
| Pérdida de conocimiento al retirar TS | Media | Medio | Docs por módulo, ADRs, parity matrix y corpus como legado ejecutable |

## 11. Fuera de alcance

- Reescribir `web/` o la app Android.
- Cambiar la lógica de negocio, tasas, comisiones o política de riesgo.
- Ejecución automática de pagos fiat o confirmaciones finales (siguen siendo
  humanas).
- Multi-tenant o multi-operador.
- Kubernetes, service mesh o escalado multi-región.
- Mejoras de rendimiento no demostradas por medición (la migración no es una
  excusa para "optimizar" la lógica).

## 12. Qué se puede adelantar ya sin riesgo

- F0 completo (no toca producción).
- F1 dominio puro + esquema Postgres.
- Los documentos de análisis anexos.
- El `fake-qvapay` y el corpus de replay.

Todo lo anterior puede ejecutarse con agentes en paralelo y revisarse antes de
tocar una línea de producción.
