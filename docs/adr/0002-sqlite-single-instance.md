# ADR-0002: SQLite para la instancia local única

Estado: aceptado  
Fecha: 2026-09-05

## Contexto

La aplicación tendrá una sola instancia y un solo administrador. Requiere transacciones, recuperación tras reinicios, migraciones y backups, pero no escritura distribuida.

## Decisión

Usar SQLite con WAL, claves foráneas, transacciones explícitas y migraciones versionadas. El conocimiento de persistencia se concentra en un módulo profundo.

## Consecuencias

- La operación local no necesita infraestructura adicional.
- No se permiten múltiples procesos escritores.
- Una futura VPS puede seguir usando SQLite con una sola instancia.
- PostgreSQL se reconsiderará cuando existan múltiples procesos, alta disponibilidad o concurrencia que lo justifique.
