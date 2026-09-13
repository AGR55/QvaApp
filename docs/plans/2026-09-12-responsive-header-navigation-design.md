# Header y navegación responsive de QvaApply

## Objetivo

Simplificar el header del dashboard eliminando el título de la sección actual y convertir sus datos operativos principales en indicadores visuales compactos. En móvil, reemplazar la barra de navegación horizontal por un botón que despliega un panel vertical con todas las secciones.

## Diseño aprobado

- El sidebar permanece fijo en escritorio.
- El header ocupa todo el ancho disponible junto al sidebar y muestra métricas para QUSD libres, CUP disponible, Clásica disponible, Prepago disponible y operaciones.
- Cada métrica usa icono, etiqueta, valor y color de contexto; los datos provienen de `data.availability` y `data.operations`.
- En móvil el sidebar inferior desaparece y el header muestra un botón `Secciones`.
- El botón abre un panel vertical sobre el contenido, con targets táctiles de al menos 44 px, foco visible, cierre con Escape y cierre automático al navegar.
- En Cacería, las columnas de compra/venta se apilan por debajo de 620 px para evitar controles comprimidos y scroll horizontal.

## Verificación

- Build de Vite y typecheck.
- Revisión de reglas responsive para 375 px, 620 px, 900 px y escritorio.
- Confirmar que no quede una barra de navegación horizontal fija en móvil.
