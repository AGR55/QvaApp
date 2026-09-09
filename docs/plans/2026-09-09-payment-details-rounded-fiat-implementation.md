# Plan de implementación

1. Añadir pruebas puras del cálculo de total fiat: compra CUP hacia abajo, venta
   CUP hacia arriba, múltiplos intactos y monedas no CUP sin salto a decenas.
2. Añadir pruebas de los adaptadores de creación y edición para confirmar que el
   `receive` enviado y usado en la validación de saldo es el total redondeado.
3. Añadir pruebas del orquestador donde el listado propio omite `details`, el
   detalle individual los aporta y la reposición los conserva exactamente.
4. Añadir el caso negativo: si el detalle completo carece de datos de pago, no
   debe ejecutarse ninguna cancelación.
5. Centralizar el cálculo en `market-math.ts` y usarlo desde `trading.ts` y la
   compensación del orquestador.
6. Hidratar y validar todos los snapshots seleccionados antes de crear el
   workflow persistente y antes de la primera mutación remota.
7. Ejecutar pruebas focalizadas y después `pnpm check` completo.

