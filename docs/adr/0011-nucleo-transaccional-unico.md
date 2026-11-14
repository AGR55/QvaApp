# ADR-0011: núcleo transaccional único para el dinero

Estado: aceptado
Fecha: 2026-11-12
Sustituye (para el estado futuro) a: [ADR-0002](0002-sqlite-single-instance.md) en lo relativo a la base, no en lo relativo al escritor único.

## Contexto

QvaApply mueve dinero real. Sus garantías actuales dependen de que un solo
proceso conozca y escriba, en una única base transaccional, el estado de:

- reservas de capital (`capital_reservations`, `application_capital_reservations`),
- operaciones y workflows (`operations`, `trade_workflows`, `workflow_own_offers`),
- intenciones monetarias y su resolución (`mutation_intents`),
- ledger fiat y su historial (`fiat_ledger`, `fiat_balance_history`),
- configuración versionada y su cadena de integridad (`config_revisions`,
  `config_integrity_epoch`),
- ventana durable de aplicaciones (`qva_apply_last_*`) y presupuesto de listados
  por *owner*.

La migración a microservicios tienta a repartir esas piezas por dominio. El
análisis de persistencia
([../migration/analysis/02-persistence.md](../migration/analysis/02-persistence.md))
demuestra que varias de esas escrituras deben seguir siendo atómicas entre sí: la
atomicidad actual no es "por flujo de negocio" sino por llamada, y los flujos con
mutación remota son secuencias de varias transacciones que se sostienen con
intenciones durables, restricciones `UNIQUE` idempotentes y reconciliación.

## Decisión

1. **Un único servicio (`trading-core`) es propietario y escritor de todo el
   estado financiero**, en una única base ACID. Los demás servicios no escriben
   ni leen directamente esas tablas: usan su API interna o proyecciones por
   eventos.
2. **No se usan transacciones distribuidas ni sagas para el camino crítico.**
   Los pasos que hoy son atómicos (reservar capital + crear operación/workflow +
   registrar intención) siguen siendo una sola transacción local en
   `trading-core`.
3. **La exclusión del capital no se delega a NATS, a un lock en memoria ni a la
   suerte.** `trading-core` corre con una sola instancia activa, protegida por un
   `pg_advisory_lock` al arrancar. Si se necesita alta disponibilidad, se
   implementa liderazgo con *fencing token* y recuperación de intenciones; nunca
   dos escritores sin fencing.
4. **Se mantienen las tablas que hoy dependen entre sí en la misma base**
   (`operations` ↔ `fiat_ledger`, `mutation_intents` ↔
   `application_capital_reservations`, `capital_reservations` ↔
   `trade_workflows`, `config_revisions` ↔ `config_integrity_epoch`).
5. **La partición por servicio se limita a datos derivados y reconstruibles**:
   notificaciones, sesiones de panel, proyecciones analíticas, caché de lectura,
   suscripciones push, documentos de chat push.

## Consecuencias

- `trading-core` es un servicio grande (estimado 12–15k LOC Go). Es un monolito
  modular desplegable como servicio, no un conjunto de nanoservicios. Se acepta
  a cambio de conservar la corrección.
- La API interna de `trading-core` se convierte en el contrato más importante del
  sistema y debe versionarse (OpenAPI/AsyncAPI) y probarse con paridad.
- La latencia del camino caliente no empeora: sigue siendo
  feed → decisión → reserva → `POST`, sin saltos de red nuevos.
- Un fallo de `trading-core` detiene el trading (no la recuperación: las
  intenciones durables permiten reconciliar al arrancar). Los servicios de
  periferia no pueden hacerlo caer.
- El escalado horizontal del núcleo no es un objetivo; el escalado del panel, las
  notificaciones y la analítica sí.
- Migrar el estado a Postgres exige PITR y restauración probada; `pg_dump` solo
  no es suficiente para un sistema monetario.

## Alternativas consideradas

- **Microservicios con una base por agregado y sagas.** Introduce
  transacciones distribuidas, estados intermedios y compensaciones cruzadas en
  un sistema de un solo operador. Riesgo de doble gasto y de reservas huérfanas
  desproporcionado para el beneficio.
- **Mantener SQLite y repartir procesos con acceso al mismo fichero.** Prohibido
  por ADR-0002 y por la propia semántica de SQLite: un solo escritor, sin
  concurrencia entre procesos.
- **Núcleo compartido por varios servicios con una base compartida.** Reintroduce
  el acoplamiento que la migración intenta eliminar y no aporta aislamiento de
  fallos.
