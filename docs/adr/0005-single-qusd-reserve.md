# ADR 0005: Una sola reserva QUSD global

Estado: aceptado.

## Contexto

La recuperación heredó `qusdReserve` y añadió después `risk.minQusdReserve`. Dos valores podían hacer que la interfaz mostrara capital libre que el orquestador no consideraba utilizable.

## Decisión

`risk.minQusdReserve` es la fuente de verdad. `qusdReserve` permanece solo por compatibilidad de esquema y se sincroniza al cargar/guardar. Una migración registra la corrección si detecta divergencia.

## Consecuencias

Todas las decisiones y visualizaciones usan la misma reserva. Las configuraciones antiguas conservan su valor al importarse y las nuevas parten del límite conservador.
