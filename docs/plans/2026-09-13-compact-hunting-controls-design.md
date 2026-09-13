# Controles compactos de cacería

## Objetivo

Reducir el peso visual de los controles maestros de compra y venta en Cacería sin cambiar su comportamiento: cada lado se puede pausar o reanudar de forma independiente.

## Diseño aprobado

La cabecera operativa será una única barra compacta. A la izquierda conservará el estado del escaneo y su última actualización. A la derecha tendrá un grupo segmentado con dos controles: Compra y Venta.

Cada segmento incluye un punto de estado, un icono y su etiqueta. Cuando esté activo se distinguirá con un borde y punto verdes discretos, no con un relleno llamativo. Cuando esté detenido usará el color atenuado del sistema. El texto accesible y el `title` describirán la acción siguiente: pausar o reanudar el lado correspondiente.

En pantallas estrechas la barra se apilará, mantendrá ambos controles juntos y nunca provocará desbordamiento horizontal.

## Comportamiento y validación

Los controles conservarán las solicitudes existentes a `/api/hunting`, el bloqueo mientras se actualiza y los mensajes de resultado. Se comprobará el tipado, las pruebas y el build web después del cambio.
