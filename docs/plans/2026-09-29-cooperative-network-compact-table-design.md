# Diseño: tabla operativa compacta para la red cooperativa

## Objetivo

Reemplazar la cuadrícula fija de tarjetas de **Aportación** por una tabla
operativa que permita comparar y editar los aportes de todos los mercados sin
huecos ni repetición visual.

## Estructura

La sección conservará el resumen de liquidez global como tarjetas y mostrará los
aportes en una sola tabla con estas columnas: mercado, estado, fiat disponible,
mínimo, precio y acciones. Cada fila contiene el mismo formulario y las mismas
operaciones existentes: publicar, actualizar y retirar.

Un aporte confirmado se distinguirá con un acento discreto de estado; los que no
estén publicados conservarán una etiqueta neutra. Las acciones se alinearán al
extremo derecho para reducir el ruido y facilitar escanear los valores.

## Adaptación y accesibilidad

En pantallas estrechas, la tabla se convertirá en bloques compactos por mercado.
Las etiquetas de columna se preservarán mediante `data-label`, los campos
mantendrán sus `label`, y los botones conservarán sus estados de carga y
deshabilitado.

## Verificación

Se actualizarán las pruebas de regresión visual para exigir la tabla, sus
cabeceras y la adaptación móvil. Se ejecutarán `pnpm check` y `pnpm check:ui`.
