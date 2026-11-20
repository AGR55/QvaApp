# ADR-0010: Go como lenguaje de los servicios y microservicios pragmáticos

Estado: aceptado
Fecha: 2026-11-12
Sustituye, para el estado futuro, a [ADR-0001](0001-modular-monolith.md) en lo
relativo a backend distribuido.
Relacionados: [ADR-0011](0011-nucleo-transaccional-unico.md),
[ADR-0012](0012-paridad-de-comportamiento.md),
[../migration/target-architecture.md](../migration/target-architecture.md).

## Contexto

El dueño quiere migrar QvaApply (monolito modular TypeScript, 22,8k LOC, 718
tests verdes, SQLite, operación de una sola persona) a un sistema dividido en
servicios implementado en un lenguaje distinto de JavaScript, priorizando
velocidad, mantenibilidad, escalabilidad y uso de memoria.

La evaluación técnica comparó Rust y Go con pesos explícitos y benchmarks
locales sobre el dominio real del sistema
([../migration/analysis/05-tech-eval.md](../migration/analysis/05-tech-eval.md)):

- Rust fue **2,9–3,9× más rápido** en el pipeline (373 µs vs 1.441 µs por página
  de 100 ofertas) y usó **3–4× menos memoria** (RSS pico 5,3 MB vs 17,2 MB en un
  servicio HTTP mínimo).
- Pero la carga real está acotada por QvaPay (~25 listados/min): el pipeline
  completo cuesta ~36 ms de CPU **por minuto** en Go, con headroom de 4 órdenes
  de magnitud. El CPU no es el cuello de botella; la red y el rate limit sí.
- La recompilación incremental medida fue **59 ms en Go frente a 10,4 s en
  Rust** (~176×), el coste que se paga todos los días con un solo mantenedor.
- Matriz con los pesos declarados: **Go 4.25 / Rust 3.50** (escala 1–5). Con el
  dueño ya experto en Rust, la matriz se invierte (Rust 4.40 / Go 3.65); con VPS
  < ~1 GB, Rust gana por muy poco (4.00 / 3.85).

Además, el diseño actual concentra el estado financiero en una única base
transaccional (ver [ADR-0011](0011-nucleo-transaccional-unico.md)). Repartir ese
estado en microservicios con sagas sería el mayor riesgo del proyecto.

## Decisión

1. **Go 1.27+ como lenguaje principal** de todos los servicios nuevos. No se
   adopta un híbrido Rust+Go en esta etapa.
2. **Frontend y app Android no se reescriben.** `web/` sigue en React/TypeScript
   y se sirve como artefacto estático; la API móvil se conserva por contrato.
3. **Microservicios pragmáticos, no nanoservicios.** El núcleo transaccional
   (`trading-core`) es un único servicio y escritor del dinero. Se extraen solo
   periferias con datos propios y sin escritura del ledger:
   - E1 (corte): `trading-core`, `edge` (panel/API/auth), `notifier`
     (Telegram/push).
   - E2: `analytics` y, si aplica, `coop-bridge`.
   - E3: `market-ingest`/`payments-ingest` solo si una medición reproducible lo
     justifica (añaden un salto en la ruta caliente).
4. **La ruta caliente permanece en un proceso**: feed → decisión → reserva →
   `POST` a QvaPay no cruza servicios ni red interna.
5. **Postgres por servicio y NATS JetStream como bus**, con `outbox`/`inbox` e
   idempotencia durable (ver target-architecture §6).
6. **El login TOTP de QvaPay se mantiene como comando de operación**, no como
   endpoint HTTP.

## Consecuencias

- Se gana velocidad de entrega y mantenibilidad para un solo operador; se pierde
  la seguridad de tipos de Rust. Se compensa con tipos de dominio (`Money`,
  enums), prohibición de `float64` para importes, linters, `-race`, property
  tests e invariantes ejecutables.
- La memoria por servicio (~10–17 MB en Go) es muy inferior al monolito Node
  actual (~134 MiB medidos), aunque varios servicios suman más que un binario
  único. Si la prioridad absoluta fuera la memoria, un monolito modular Go sería
  aún mejor; se elige el reparto por aislamiento de fallos y despliegues
  independientes.
- La migración se valida con paridad, no por confianza en el lenguaje: ver
  [ADR-0012](0012-paridad-de-comportamiento.md).
- Se revisará la decisión si: el dueño domina Rust de verdad, el VPS queda por
  debajo de ~1 GB para todo el stack, la carga deja de estar limitada por
  QvaPay, o aparece un incidente de dinero que Rust habría detectado en
  compilación.

## Alternativas consideradas

- **Rust en todo el stack.** Mejor CPU, memoria y seguridad de tipos; peor
  velocidad de entrega y mantenibilidad para un único operador sin experiencia
  demostrada. Se descarta por ahora, no por dogma: es la opción si el dueño
  confirma dominio de Rust.
- **Híbrido Rust (núcleo) + Go (periferia).** Añade dos toolchains, dos
  runtimes, contratos gRPC/JSON y doble observabilidad a cambio de portar ~515
  LOC puras. No compensa.
- **Monolito modular Go (un solo proceso).** Es la opción de menor coste
  operativo y la recomendación del evaluador si no se necesita aislar fallos.
  Se descarta como estado final porque el dueño pidió explícitamente
  microservicios y el aislamiento de panel/bot sí aporta valor operativo real;
  se usa de hecho como forma de trabajo durante F1–F3.
- **Quedarse en TypeScript.** Es lo más barato a corto plazo y el propio
  análisis de rendimiento lo recomienda hasta que exista una necesidad
  demostrada. Se descarta porque el dueño quiere salir de JS y porque el
  aislamiento del panel/bot y el footprint de memoria son mejorables.
