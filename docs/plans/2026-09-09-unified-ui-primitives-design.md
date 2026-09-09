# Sistema unificado de componentes de interfaz

## Objetivo

Migrar la interfaz actual a un conjunto de primitivas React locales inspiradas
en Shadcn, sin introducir Tailwind ni cambiar el contrato del backend. Todas las
features conservarán su lógica y sus rutas; solo cambiará la presentación y la
composición visual.

## Arquitectura

`web/components/ui/` contendrá primitivas sin conocimiento financiero:

- `Button` e `IconButton`, con variantes `primary`, `secondary`, `outline`,
  `ghost` y `destructive`.
- `Input`, `Select`, `Textarea` y `Field`, con labels, descripción, error y
  estados disabled/loading.
- `Card`, `Badge`, `Table`, `Tabs`, `Alert`, `Dialog`, `Skeleton`, `Empty` y
  `ChartFrame`.

`web/components/common.jsx` será la fachada de compatibilidad para las features
existentes durante la transición. Las features usarán las primitivas y dejarán
de repetir clases y markup de estado.

## Dirección visual

- Tokens semánticos existentes para claro/oscuro, un solo acento azul sobrio,
  superficies planas y sombras mínimas.
- Altura de controles de 44px, radios moderados, tipografía tabular para cifras
  financieras y foco visible.
- Variantes declarativas en lugar de colores o estilos inline por feature.
- Estados explícitos para carga, dato obsoleto, vacío, error, hover, pressed y
  disabled.

## Migración por capas

1. Botones, iconos, inputs, selects, textareas y `Field`.
2. `Card/Panel`, `Badge/State`, `Alert`, `Empty` y `Skeleton`.
3. Tablas y tabs de mercados, capital y operaciones.
4. Diálogos de acciones financieras y revisión de auditoría.
5. `ChartFrame` y gráficas.
6. Navegación lateral, login y limpieza de CSS duplicado.

Cada capa se validará con typecheck, pruebas existentes y `check:ui` antes de
pasar a la siguiente. No se modificarán las llamadas a QvaPay ni los límites
financieros.

## Accesibilidad y seguridad UX

Los campos tendrán label asociado y `aria-invalid` cuando corresponda; los
diálogos tendrán título accesible, foco atrapado y cierre por Escape; los
botones de mutación mostrarán estado ocupado y quedarán deshabilitados durante
la petición. Las acciones destructivas conservarán confirmación explícita y
los errores se mostrarán inline.

## Criterios de aceptación

- Ningún feature importante usa botones o campos con estilos ad hoc.
- Claro y oscuro presentan la misma jerarquía y contraste.
- Todas las cargas remotas tienen skeleton, estado cacheado o error recuperable.
- La suite y las comprobaciones visuales existentes continúan pasando.

