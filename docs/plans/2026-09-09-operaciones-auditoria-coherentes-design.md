# Operaciones accionables y auditoría coherente

## Objetivo

Evitar que una cancelación desde el panel sea rechazada por una referencia vacía, retirar de la vista operativa las operaciones ya canceladas y hacer que el contador, la lista y el registro de ofertas bloqueadas representen la misma cola persistente.

## Operaciones

- El cliente enviará `reference` únicamente para la acción `paid`.
- `ack`, `received` y `cancel` enviarán un objeto vacío válido.
- Una cancelación confirmada seguirá actualizando el estado local a `cancelled` y conservará mutación, operación y auditoría en SQLite.
- El snapshot del panel excluirá las operaciones canceladas de la vista operativa sin borrarlas del historial.
- Las operaciones activas, completadas o fallidas conservarán el comportamiento actual.

## Revisión manual

`decision_events` será la única fuente de verdad para la cola versionada. La consulta de pendientes aplicará el mismo filtro de decisión al contador y a la página; una decisión `applied` sin `resolved_at` no podrá incrementar el contador de ofertas bloqueadas.

Todo elemento que el clasificador marque como `blocked` se persistirá en `decision_events`, aunque el UUID ya exista en `seen_offers`. `seen_offers` continuará evitando notificaciones repetidas, pero no impedirá registrar cambios de precio, motivo o comprobaciones.

Descartar resolverá solamente la versión seleccionada. Volver a observar exactamente la misma versión actualizará su fecha sin reabrirla. Un cambio de tasa, decisión o motivo producirá una versión nueva y pendiente.

## Interfaz y degradación

Auditoría consumirá la página de `decision_events`; `trading_alerts` se conservará temporalmente como respaldo cuando falle la petición, no se mezclará con una respuesta válida. El contador mostrado provendrá de la misma consulta paginada.

Después de cancelar o descartar, el panel recargará su snapshot local. Los errores permanecerán en el contexto de la acción y no se perderá trazabilidad.

## Verificación

- Cancelación HTTP con `{}` y sin error de `reference`.
- La acción `paid` continúa exigiendo una referencia no vacía.
- Una operación cancelada permanece en SQLite y Auditoría, pero no en el snapshot operativo.
- El contador de pendientes coincide con una lista filtrada por `blocked`.
- Un UUID visto que pasa a bloqueado se registra en la cola.
- Una versión descartada no reaparece hasta que cambie precio o motivo.
- Typecheck, suite completa, builds y comprobación de secretos.
