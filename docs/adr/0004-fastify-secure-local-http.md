# ADR 0004: Fastify para el adaptador HTTP local

Estado: aceptado.

## Decisión

Usar Fastify 5 como adaptador HTTP, con schemas JSON, límite de cuerpo, timeouts, manejo central de errores y pruebas mediante `inject`. La autenticación de un solo administrador conserva sesiones en memoria y la configuración persistente queda en SQLite.

## Consecuencias

- La API y el panel comparten políticas transversales verificables.
- Un reinicio invalida sesiones del panel, comportamiento deliberado.
- La aplicación sigue enlazada a `127.0.0.1`; una VPS debe aportar proxy TLS.
- OpenAPI se sirve autenticado en `/api/openapi.json`.
