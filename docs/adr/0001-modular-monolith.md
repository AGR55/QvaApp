# ADR-0001: monolito modular incremental

Estado: aceptado  
Fecha: 2026-09-05

## Contexto

QvaApply es operado por un único administrador, inicialmente en una sola máquina, y ejecuta decisiones relacionadas con dinero real. La base recuperada ya contiene lógica TypeScript, SQLite, Telegram y React, pero presenta acoplamiento entre transporte, scheduling y dominio.

## Decisión

Evolucionar mediante un monolito modular TypeScript. Las mutaciones monetarias pasan por casos de uso y un orquestador durable; HTTP, Telegram y scheduler son adaptadores de entrada.

## Consecuencias

- Se conserva la lógica recuperada mientras se reemplaza gradualmente.
- Un despliegue sigue siendo suficiente.
- Las interfaces de los módulos se convierten en la superficie principal de pruebas.
- No se adoptan microservicios ni una cola distribuida hasta que exista una necesidad operativa demostrada.
