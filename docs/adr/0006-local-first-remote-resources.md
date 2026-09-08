# ADR 0006: lecturas remotas independientes con caché SQLite

## Estado

Aceptada.

## Contexto

El panel dependía de una única lectura que esperaba balance, ofertas, transacciones, promedios y todos los mercados. Una conexión lenta impedía usar incluso información y controles locales.

## Decisión

Separar el snapshot local de los recursos QvaPay y persistir la última respuesta válida de cada recurso en SQLite. La interfaz carga por vista y representa explícitamente carga, dato obsoleto y error recuperable.

## Consecuencias

El panel arranca sin red y las consultas remotas dejan de tener un destino de fallo común. A cambio, cada bloque debe manejar frescura propia y ninguna copia almacenada puede presentarse como una cotización actual.
