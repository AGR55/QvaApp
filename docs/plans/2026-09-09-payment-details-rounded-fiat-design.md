# Datos de pago intactos e importes fiat redondeados

## Contexto

El flujo automático puede cancelar ofertas propias de venta para liberar QUSD,
aplicar a una oportunidad externa y recrear el excedente. El listado `GET /p2p`
no entrega `details`; esos datos solo aparecen en `GET /p2p/:uuid` para el
creador o el peer. Por ello, construir el snapshot de compensación directamente
desde el listado puede persistir `details: []` y recrear una oferta sin destino
de pago.

Además, los importes fiat calculados como `amount * rate` pueden quedar en
unidades incómodas o con decimales. Las ofertas propias deben usar totales
terminados en cero sin empeorar la tasa límite configurada.

## Decisiones

### Snapshot seguro antes de cancelar

- El plan preliminar seguirá usando el listado para elegir qué ofertas liberar,
  evitando consultar detalles de todas las ofertas propias.
- Antes de persistir el workflow o cancelar algo, se consultará el detalle
  completo de cada oferta seleccionada mediante `GET /p2p/:uuid`.
- El snapshot persistido se reconstruirá con esa respuesta completa.
- Si el detalle remoto no incluye al menos un nombre y valor de pago válidos, el
  flujo se bloqueará antes de la primera cancelación. No se sustituirán
  silenciosamente los datos originales por la configuración actual del mercado.
- La recreación y su idempotencia conservarán `details`, mensaje, etiquetas,
  restricciones, privacidad y webhook del snapshot confirmado.

### Totales CUP en múltiplos de diez

Se centralizará el cálculo de `receive` para ofertas propias denominadas en CUP:

- Oferta `buy`: el creador paga fiat; se redondea hacia abajo al múltiplo de 10
  para no pagar más que la tasa solicitada.
- Oferta `sell`: el creador recibe fiat; se redondea hacia arriba al múltiplo de
  10 para no cobrar menos que la tasa solicitada.
- Si el producto ya es múltiplo de 10, permanece intacto.
- El resultado respetará el mínimo positivo admitido por QvaPay; una entrada que
  no pueda producir un total válido se rechazará antes de llamar a la API.
- Los mercados en otras monedas, como Clásica/USD, conservarán su precisión
  decimal; redondearlos a decenas alteraría materialmente la tasa.

La misma función se utilizará al crear, editar y recrear ofertas CUP. En una
reposición parcial se conserva la tasa del snapshot, pero el nuevo total vuelve
a redondearse según el lado original. Las demás monedas usarán el mismo punto
central de cálculo con precisión de ocho decimales.

## Seguridad y trazabilidad

- Ninguna oferta se cancela hasta que todos los snapshots seleccionados sean
  completos y estén persistidos.
- Las intenciones de mutación guardarán el `receive` realmente enviado.
- La auditoría describirá la tasa solicitada y el total fiat efectivo.
- Las pruebas cubrirán la ausencia de `details`, su conservación exacta y ambos
  sentidos de redondeo, incluidos creación, edición y reposición parcial.

## Fuente oficial

- `POST /p2p/:uuid/edit` es una actualización parcial y no admite editar
  `details`.
- `GET /p2p/:uuid` devuelve los datos completos y solo muestra `details` al
  creador o peer.
- `POST /p2p/create` exige `details` como arreglo.
