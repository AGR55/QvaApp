# Plan de implementación: coherencia visual y gráficas estables

## 1. Inventario y prueba base

- Enumerar clases y estilos consumidos por cada vista.
- Capturar todas las páginas en escritorio y móvil antes de la corrección.
- Añadir una medición por frames del ancho de documento y del chart al actualizar datos.
- Registrar los selectores que mantienen colores, tipografías, radios o spacing heredados.

## 2. Fundamentos y primitives

- Completar tokens de superficie, texto, borde, estado, radio, sombra y spacing.
- Ampliar `common.jsx` únicamente donde reduzca duplicación real.
- Normalizar botones, campos, tabs, switches, tablas, badges, mensajes y diálogos.
- Añadir `page-stack`, `section-stack`, grids seguros y reglas comunes responsive.

## 3. Páginas operativas

- Migrar Acceso y Cockpit.
- Migrar Mercados y Capital, incluidos editor y cancelación.
- Migrar Cacería y Operaciones, incluidos estados y confirmaciones.
- Migrar Estrategia y Auditoría, incluidos formularios extensos y paneles laterales.

## 4. Gráficas

- Aislar la causa del ensanchamiento con la prueba de medición.
- Estabilizar wrapper, ResponsiveContainer, grid y contenido intrínseco.
- Desactivar animaciones geométricas en actualizaciones de datos.
- Normalizar tabs, tooltip, leyenda y ejes al sistema visual.

## 5. Consolidación CSS

- Absorber reglas correctivas todavía activas en hojas por feature o en el tema.
- Retirar imports y archivos que hayan quedado sin consumidores.
- Buscar colores y fuentes heredados hasta que solo queden los tokens globales o excepciones semánticas justificadas.

## 6. Verificación

- Recorrer todas las vistas a 1440 px y 390 px.
- Verificar ausencia de overflow y WCAG en cada página.
- Validar diálogos de Capital, Cacería, Operaciones, Estrategia y Auditoría.
- Ejecutar estabilidad de Gráficas durante varias actualizaciones.
- Ejecutar `pnpm check`, `pnpm check:ui` y `git diff --check`.
