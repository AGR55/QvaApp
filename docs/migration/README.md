# Migración de QvaApply a microservicios Go

Estado: **propuesta lista para decisión**
Fecha: 2026-11-12
Alcance: backend (bot, panel/API, núcleo financiero, cacerías, analítica). El
frontend React y la app Android no se reescriben.

Este directorio contiene el plan completo para reemplazar el monolito
TypeScript por servicios en Go sin perder ni un céntimo por el camino. Está
basado en una auditoría del código real, no en una plantilla.

## Decisiones confirmadas (2026-11-12)

- **Lenguaje:** Go 1.27+. Rust queda descartado por ahora (condiciones para
  revisarlo en [ADR-0010](../adr/0010-microservicios-go.md)).
- **Base:** Postgres por servicio. La VPS de producción tiene 4–8 GB, suficiente
  para Postgres + 3 servicios Go con límites por contenedor.
- **Ventana de seguridad:** 7 días de shadow ≥ 99,9 % y 14 días de rollback
  disponible tras el corte. Sin atajos.
- **Arranque:** F0 cerrado (arnés de paridad, fake QvaPay, goldens, matriz de
  718 tests y ensayo de datos v16→v31).

### Estado de F0 (2026-11-13)

- **Arnés de paridad v1 operativo:** `node --import tsx parity/runner/run.ts
  --sut ts --suite pure` → **159/159 casos en verde**; suites `contract`
  **74/74** y `http` **39/39**.
- **Goldens puros completos:** **21/21 archivos L1 · 107/107 casos portables**
  cubiertos (`node --import tsx parity/tools/check-pure-coverage.ts`). Los 159
  goldens incluyen además `flexible-order`, `apply-budget` y
  `reconciliation-scheduler`.
- **Matriz de paridad:** 95 archivos / **718 casos clasificados, 0 sin
  clasificar**; 670 (93,3 %) con vía de paridad ejecutable; categorías
  107/74/39/470/22/6. Manifest regenerable con guardrails.
- **Fake QvaPay determinista:** cassettes K1–K14, smoke **135/135 checks**,
  0 requests no declaradas, ~314 ms.
- **Ensayo SQLite v16→v31:** migración real sobre copia **sin errores**, 33/33
  checks, 27→41 tablas, cadena de configuración válida, sumas fiat idénticas a
  8 dp, backup automático verificado. `data/` intacto (sha256 igual).
- **Corpus de replay stateful:** 4 escenarios / 14 pasos / 18 líneas de
  decisión en `parity/fixtures/replay/2026-11-12/`, reproducibles sin red ni
  reloj real; **4/4** verdes contra el oráculo.
- **Contratos de adaptador (L2):** **74/74** casos en verde con `fetch`,
  runtime, reloj y `sleep` inyectados; 11 archivos de golden en
  `parity/golden/v1/contract/`.
- **Superficie HTTP (L2):** **39/39** casos en verde con `app.inject()`
  in-process; 9 archivos de golden en `parity/golden/v1/http/`.
- **Gate en CI:** `pnpm parity:gate` ejecuta `golden-guard` (seis generadores,
  cobertura L1 y manifiesto) + suite pura **159/159** + contratos **74/74** +
  HTTP **39/39** + replay **4/4**.
- **MVP F0 cerrado:** 220 casos de origen (107 P + 74 C + 39 H) cubiertos por
  el gate, además del replay stateful.
- Evidencia: [evidence/2026-11-12-f0-bootstrap.md](evidence/2026-11-12-f0-bootstrap.md).

## Resumen ejecutivo

1. **Lenguaje recomendado: Go.** La evaluación local
   ([analysis/05-tech-eval.md](analysis/05-tech-eval.md)) da **Go 4,25/5 vs Rust
   3,50/5** con los pesos pedidos. Rust es 2,9–3,9× más rápido y usa 3–4× menos
   memoria, pero el sistema está limitado por QvaPay (~25 listados/min): el
   pipeline completo cuesta ~36 ms de CPU por minuto en Go. Lo que sí pesa todos
   los días es la recompilación incremental (59 ms en Go vs 10,4 s en Rust) y la
   mantenibilidad de un único operador. La recomendación **se invierte si vos ya
   dominás Rust**: la matriz pasa a Rust 4,40 vs Go 3,65.
2. **Microservicios con el dinero en un solo dueño.** No se parte el estado
   financiero: `trading-core` es propietario y escritor único del ledger, las
   reservas, workflows, intenciones y configuración, en una base ACID. Se extraen
   periferias: `edge` (panel/API/auth), `notifier` (Telegram/push) y, después,
   `analytics`. Partir el dinero en sagas sería el mayor riesgo del proyecto
   ([ADR-0011](../adr/0011-nucleo-transaccional-unico.md),
   [analysis/01-domain.md](analysis/01-domain.md)).
3. **La migración se demuestra, no se confía.** La suite actual (**718 tests
   verdes**) se convierte en oráculo cross-language: fixtures dorados, fake
   QvaPay, contratos K1–K14, property tests, invariantes ejecutables, caos y
   shadow mode. Sin paridad no hay despliegue
   ([ADR-0012](../adr/0012-paridad-de-comportamiento.md),
   [verification.md](verification.md)).
4. **16–20 semanas, sin big-bang.** Fases F0–F6 con gates medibles y rollback
   real a TypeScript durante 14 días tras el corte
   ([roadmap.md](roadmap.md)).
5. **Hallazgos que cambian el plan:** el snapshot local está en schema v16, no
   v31; el dinero se guarda en `REAL` con drift binario ya visible;
   `config_revisions` ocupa el 85–87 % de la base; hay cuatro representaciones
   del saldo fiat; QvaPay no ofrece idempotencia para `apply`/`paid`/`received`/
   `cancel`/`edit`; y la documentación promete tres comportamientos que el código
   no implementa ([analysis/02](analysis/02-persistence.md),
   [analysis/01](analysis/01-domain.md)).

## Decisiones pendientes de detalle (no bloquean F0)

| # | Decisión | Recomendación | Cuándo hace falta |
| --- | --- | --- | --- |
| 1 | Política de retención/compacción de `config_revisions` | Comprimir revisiones antiguas conservando la cadena SHA-256; no borrar evidencia reciente | Antes del primer dry-run de datos (F5) |
| 2 | Migración de tokens de operador Android | Migrar por hash/scope o reemparejar dispositivos con aviso | Antes de F4 |
| 3 | RPO/RTO y ventana de mantenimiento | Definir objetivo (p. ej. RPO ≤ 5 min con WAL, RTO ≤ 1 h) | Antes de F5 |
| 4 | Cifrado de VAPID y secretos de push | Cifrar en el nuevo almacén; rotar al mover notificaciones | F4 |
| 5 | ¿El panel sigue siendo mismo-origen? | Sí en E1 para no rediseñar cookie/CSRF | F4 (solo si cambia) |

El plan asume que el panel sigue siendo mismo-origen, que el frontend React no se
reescribe y que el operador humano sigue aprobando los pagos fiat.

## Documentos

| Documento | Contenido |
| --- | --- |
| [target-architecture.md](target-architecture.md) | Arquitectura objetivo, servicios, datos, comunicación, seguridad, observabilidad, estados E1–E3 |
| [roadmap.md](roadmap.md) | Fases F0–F6, actividades, entregables, gates, riesgos, fuera de alcance |
| [verification.md](verification.md) | Política de verificación money-safe: capas L0–L6, arnés de paridad, CI, definición de terminado, rollback |
| [analysis/01-domain.md](analysis/01-domain.md) | Dominio, 32 casos de uso, 41 invariantes mapeados a tests, pipeline de decisión, 15 ambigüedades |
| [analysis/02-persistence.md](analysis/02-persistence.md) | 41 tablas, transacciones, durabilidad, migración SQLite→Postgres, 20 riesgos, plan de datos |
| [analysis/03-boundaries.md](analysis/03-boundaries.md) | 7 fronteras externas, 109 rutas, 18 endpoints QvaPay, contratos K1–K14, incidentes, seguridad |
| [analysis/04-tests.md](analysis/04-tests.md) | Inventario de los 95 archivos/718 casos, taxonomía P/C/H/I/U/O, JSON canónico, fake QvaPay, gates |
| [analysis/05-tech-eval.md](analysis/05-tech-eval.md) | Matriz Rust vs Go, benchmarks medidos, riesgos por lenguaje, condiciones que invierten la recomendación |
| [ADR-0010](../adr/0010-microservicios-go.md) | Go + microservicios pragmáticos |
| [ADR-0011](../adr/0011-nucleo-transaccional-unico.md) | Núcleo transaccional único para el dinero |
| [ADR-0012](../adr/0012-paridad-de-comportamiento.md) | Paridad como condición de despliegue |

## Hallazgos que condicionan todo

1. **718 tests, 0 fallos, ~15 s.** Baseline verificado el 2026-11-12. La
   documentación decía 118: corregido. Es la red de seguridad y el oráculo.
2. **El snapshot local está en schema v16, no v31.** El camino v16→v31 nunca se
   ha ejecutado sobre datos reales: hay que ensayarlo antes de cualquier dump.
3. **El dinero está en `REAL` (float64)** en 40+ columnas y dentro de JSON, con
   drift ya visible (`1244.1000000000001`). El destino exige `NUMERIC(24,8)` y
   cinco reglas de redondeo replicadas al bit.
4. **`config_revisions` es el 85–87 % de la base** (5.416 revisiones en 11 días,
   sin retención). Decidir compactación antes de migrar o el dump se vuelve el
   evento principal.
5. **El saldo fiat tiene cuatro representaciones.** Debe quedar un libro + un
   saldo materializado; el resto, proyecciones reconstruibles.
6. **Un solo escritor de QvaPay.** La ventana de 2 aplicaciones/60 s, la cuota
   de listados y el estado de intención incierta no se pueden repartir entre
   réplicas sin doble aplicación.
7. **QvaPay no es idempotente** para las mutaciones que importan; la garantía es
   local (intención durable + conciliación), y eso no se puede perder.
8. **El 65,5 % de los tests (470 casos) son integración con SQLite.** No se
   "portan": se reformulan con replay stateful y goldens extraídos. Ahí vive el
   dinero y ahí está el trabajo real de verificación.
9. **La ruta caliente no admite saltos nuevos.** Recepción → despacho tiene
   objetivo p95 < 10 ms; por eso feed, decisión y `POST` se quedan juntos.
10. **La documentación y el código no coinciden en tres puntos** (bloqueo
    global vs por oferta; pausa persistente por errores; `OperationState.failed`
    muerto). La migración congela el comportamiento **del código**, y esos
    puntos se deciden explícitamente.

## Próximos pasos (F0, sin tocar producción)

Se puede empezar ya, en este orden:

1. `parity/` esqueleto: schema canónico v1, manifest, runner y adaptador
   `ts-cli` que reproduce los 107 casos puros.
2. Generar los goldens de dominio puro (riesgo, liquidez, redondeo, presupuesto)
   y el `golden-guard` con hashes.
3. Fake QvaPay con las cassettes base (éxito, 429, timeout, ambiguo, 5xx, 409).
4. `parity-matrix.md` generado desde el manifest (718 casos clasificados).
5. Escenario de migración SQLite v16→v31 y ensayo de dump→Postgres en un
   directorio temporal.

Nada de esto toca `src/`, `test/`, producción ni credenciales.

## Qué NO se hace

- Reescribir el frontend o Android.
- Cambiar reglas de negocio, tasas, comisiones o política de riesgo.
- Automatizar pagos fiat o confirmaciones finales (siguen siendo humanos).
- Big-bang, doble escritura real contra QvaPay o varios escritores por cuenta.
- Kubernetes, service mesh o multi-región.
- Optimizaciones no demostradas por medición.

## Riesgo principal, dicho sin rodeos

La migración de un sistema monetario frágil a microservicios es, en sí misma,
la operación de mayor riesgo que puede hacer el proyecto. El plan la reduce con
tres reglas: **el dinero no se reparte**, **el comportamiento se demuestra con
paridad** y **siempre hay rollback**. Si en algún momento hay que elegir entre
terminar la migración y no perder dinero, se elige no perder dinero.
