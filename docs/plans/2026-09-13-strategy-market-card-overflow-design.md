# Corrección del desbordamiento en las tarjetas de Estrategia

## Problema

Las tarjetas de mercados se muestran en dos columnas rígidas. El editor de iconos incluye un `input[type=file]` que intenta ocultarse con una clase inexistente, por lo que el control nativo permanece visible y aporta un ancho mínimo considerable. Las cuadrículas exterior e interior usan columnas `1fr` sin anular explícitamente su tamaño mínimo intrínseco. Juntas, ambas condiciones hacen que los controles de una tarjeta invadan la tarjeta vecina.

## Diseño aprobado

- Conservar dos tarjetas por fila cuando exista espacio suficiente.
- Cambiar automáticamente a una tarjeta por fila antes de que los controles queden comprimidos.
- Usar columnas `minmax(0, 1fr)` para impedir que el contenido intrínseco ensanche las tarjetas.
- Ocultar de forma accesible el selector de archivos nativo usando la utilidad existente `sr-only`.
- Permitir que las acciones del editor de iconos se envuelvan en varias líneas.
- Aplicar `min-width: 0` a los contenedores relevantes para que inputs, etiquetas y unidades permanezcan dentro de la tarjeta.

## Comportamiento responsive

La cuadrícula exterior usará columnas automáticas con un ancho cómodo mínimo. En escritorio cabrán dos tarjetas cuando el panel lo permita; en ventanas más estrechas quedará una sola. La cuadrícula interior seguirá mostrando dos campos por fila mientras la tarjeta tenga espacio y pasará a una columna mediante el punto de ruptura existente.

## Verificación

- Prueba de regresión que compruebe las reglas estructurales críticas del CSS y la clase accesible del selector.
- Compilación y suite completa del proyecto.
- Inspección del layout a ancho de escritorio y a ancho reducido, sin superposición ni desplazamiento horizontal.
