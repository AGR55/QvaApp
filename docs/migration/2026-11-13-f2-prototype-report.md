# Informe F2 — prototipo de ruta caliente (2026-11-13)

## Veredicto

**Continuar a F3**, con las limitaciones de abajo. El prototipo Go reproduce
byte a byte las decisiones, llamadas upstream y `stateDigest` del corpus replay,
y cumple el presupuesto local de p99.

Este informe es de un **prototipo local**: no se desplegó nada ni se ejecutaron
mutaciones reales.

## Paridad del corpus

Comando:

```bash
cd services/trading-core && go run ./cmd/replay-session
```

```text
replay-session: 4/4 casos · 14/14 pasos
```

- 4 escenarios: `market-ingest/dedupe`, `money-core/apply`,
  `money-core/reject`, `money-core/uncertain`.
- 14 pasos y 18 líneas de decisión (14 pasos + 4 estados finales).
- Resultado público, `upstream` y `stateDigest` **idénticos** al oráculo.
- Cubiertos: dedupe, feed/observación, riesgo, liquidez, apply, rechazo 409,
  reposición, resultado incierto, conciliación `pending` y `processing`.

## Benchmark local

Mismo corpus y máquina. Go es el prototipo in-memory; TS ejecuta la sesión real
con SQLite temporal, por lo que la comparación incluye persistencia TS.

```text
Go  replay-bench: iterations=1000 p50=0.93-1.23ms p95=1.58-2.18ms
                   p99=1.79-2.95ms steps/s=10633-13474
                   decisions/s=13671-17323 alloc/iter≈381 kB rss=11.8MB

TS  replay-bench-ts: iterations=100 p50=35-39ms p95=52-57ms p99=58-75ms
                      steps/s=354-363 decisions/s=455-467 rss≈99MB
```

- p99 de un replay completo de 4 casos: **1,8–3,0 ms** (< 10 ms objetivo local).
- El prototipo Go es ~**20–32×** más rápido y usa ~**8×** menos RSS en este
  escenario, sin contar la persistencia que TS sí incluye.
- CPU local (shell `time`): Go ~1,20 s de CPU para 1000 iteraciones
  (~1,2 ms/iteración); TS ~1,03 s para 20 (~51 ms/iteración).
- No se midió p99 de recepción→despacho aislado; el replay completo es una cota
  superior local.

## Recuperación tras kill -9

```bash
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=qvaapply_dev_only PGADMIN_DB=qvaapply \
bash services/f2/recovery-kill9.sh
```

```text
f2-recovery: kill -9 recuperado, mensaje publicado una sola vez
```

- Worker A reclama un mensaje y el proceso muere con `kill -9`.
- El estado durable queda `in_flight` con lease.
- Worker B lo reclama al vencer el lease y publica **una sola vez**.
- No hay doble publicación ni pérdida del mensaje.

## Limitaciones y condiciones

1. El prototipo usa estado en memoria y un gateway guionizado; la persistencia
   Postgres real ya está probada por separado (outbox/inbox/idempotencia), pero
   el pipeline replay aún no la usa de extremo a extremo.
2. El benchmark TS incluye SQLite temporal; el Go no. La diferencia de latencia
   no es solo lenguaje: también es la diferencia entre prototipo in-memory y
   sesión persistente.
3. Falta medir en la VPS objetivo y con el fake QvaPay sobre HTTP real.
4. No se pudo ejecutar CI por el bloqueo de billing de GitHub Actions; toda la
   validación se hizo localmente.

## Decisión

**Continuar a F3** con `trading-core` en shadow, manteniendo como condiciones:

- portar la sesión replay sobre Postgres real antes de comparar en shadow;
- repetir el benchmark en la VPS objetivo;
- añadir el fake QvaPay por HTTP y las pruebas de caos completas;
- no habilitar mutaciones reales hasta que F3 cierre el gate de shadow.
