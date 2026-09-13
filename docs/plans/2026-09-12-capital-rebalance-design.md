# Sincronización global y reajuste de capital

## Objetivo

Mantener los fondos del header actualizados desde cualquier sección, advertir cuando las compras abiertas comprometen más fiat del declarado y permitir corregir el exceso desde Capital con una confirmación explícita.

## Datos y sincronización

`balance` y `own-offers` son recursos globales porque alimentan el header. Se sincronizan al abrir o refrescar cualquier vista; cada vista añade después únicamente sus recursos propios. La cola continúa siendo secuencial para conexiones lentas y elimina recursos duplicados.

## Alerta

Cada badge fiat compara `committed` con `declared`. Si el comprometido es mayor, adopta estado de peligro y expone en su texto accesible el déficit. El saldo visible sigue siendo el disponible, limitado visualmente a cero.

## Reajuste

Capital muestra una acción de reajuste cuando existe déficit. La previsualización refresca las ofertas propias en el servidor y devuelve una distribución proporcional que conserva la tasa nominal de cada oferta. El modal permite reducir manualmente cada cantidad, pero nunca aumentarla ni cambiar su tasa.

Al confirmar, el servidor vuelve a validar las ofertas, sus tasas y el presupuesto resultante. Las mutaciones se ejecutan secuencialmente. Una propuesta de cero cancela la oferta y se presenta como tal antes de confirmar. Si una mutación falla, se informa qué cambios sí llegaron a aplicarse y se obliga a refrescar antes de reintentar.

## Redondeo por índice

La precisión se deriva del índice del lado configurado en cada mercado: `buyMaxRate` para compra y `sellMinRate` para venta. Una tasa efectiva de compra se redondea hacia arriba y una de venta hacia abajo. Por ejemplo, con índice de dos decimales, `1.051` se evalúa como `1.06` al comprar y `1.1249` como `1.12` al vender. Un índice CUP entero conserva saltos de una unidad.

La tasa nominal de la oferta no se modifica. El redondeo es una representación y validación conservadora de la tasa efectiva resultante del total fiat aceptado por QvaPay.

## Validación

Se cubren con pruebas: recursos globales en todas las vistas, redondeo direccional según el índice, cálculo presupuestario con totales fiat reales y contrato HTTP de previsualización/aplicación. Después se ejecutan pruebas, typecheck, build y Knip.
