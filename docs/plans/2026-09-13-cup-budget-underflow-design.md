# Diseño: presupuesto CUP por debajo del mínimo transferible

## Problema

El reajuste proporcional puede reducir una oferta de compra CUP a un importe
cuyo total fiat redondeado es cero. La validación de ofertas rechaza ese total,
pero el error actualmente escapa del plan presupuestario y hace fallar la
lectura local completa del dashboard.

## Solución

La validación estricta de `ownOfferFiatTotal` se conserva. `fitAmount`, que
explora importes candidatos para el reajuste, reconocerá que un candidato CUP
no produce una decena positiva y devolverá cero. El plan existente interpreta
el cero como una acción de cancelación, liberando el fiat comprometido sin
crear ni editar una oferta inválida.

## Verificación

Una prueba de regresión construirá una oferta CUP cuyo reparto proporcional
solo permite 10 CUP. El plan deberá completarse sin excepción y proponer la
cancelación de la oferta. También se ejecutarán las pruebas del presupuesto,
la comprobación de tipos y la compilación.
