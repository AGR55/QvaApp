# ADR-0003: las mutaciones inciertas exigen conciliación

Estado: aceptado  
Fecha: 2026-09-05

## Contexto

Una pérdida de respuesta no demuestra que QvaPay rechazó una mutación. Reintentar o compensar inmediatamente puede duplicar exposición.

## Decisión

Persistir una intención antes de cada mutación monetaria. Si no existe confirmación inequívoca, marcarla como incierta, pausar acciones relacionadas y conciliar el estado remoto antes de reintentar o compensar.

## Consecuencias

- Algunos fallos requieren espera o intervención en vez de recuperación inmediata.
- La seguridad financiera tiene prioridad sobre la disponibilidad.
- Las pruebas deben cubrir pérdida de respuesta después de que QvaPay haya aplicado el cambio.
