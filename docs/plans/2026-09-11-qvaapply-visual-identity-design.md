# Identidad visual y mercados ilustrados de QvaApply

## Objetivo

Dar a QvaApply una identidad fintech dinámica y profesional, usando los
iconos de mercado existentes y un logo propio reutilizable en el favicon, el
sidebar y futuras superficies de la aplicación.

## Dirección aprobada

- Marca combinada con símbolo abstracto basado en una `Q` abierta y dos trazos
  ascendentes, como metáfora de intercambio, liquidez y movimiento.
- Paleta semántica: azul eléctrico para confianza y tecnología, verde para
  operaciones favorables y liquidez, y ámbar para oportunidades y alertas.
- Formas compactas, bordes suaves, sin sombras fuertes ni degradados
  decorativos que reduzcan el contraste.
- Lockup horizontal para el sidebar, marca cuadrada para favicon y una versión
  monocromática para fondos o contextos restringidos.

## Integración de iconos de mercado

Los recursos de `public/icons/` se usarán como imágenes decorativas con texto
alternativo cuando comuniquen el mercado: `cup.svg`, `tropical.png` y
`clasica.png`. Un componente `MarketIdentity` centralizará la ruta, el nombre,
el color contextual y el tamaño para evitar estilos divergentes entre Capital,
Mercados, Cacería, gráficas y tablas.

## Movimiento y accesibilidad

El dashboard incorporará acentos visuales pequeños —chips de mercado,
indicadores de tendencia y estados de color— con animaciones limitadas a
transformación y opacidad. `prefers-reduced-motion` desactivará el movimiento.
Cada icono tendrá `alt` útil o será marcado como decorativo cuando el texto
adyacente ya comunique lo mismo. El contraste y los estados de foco existentes
se conservan.

## Plan de implementación

1. Crear SVG optimizado del logo en variante horizontal, cuadrada y
   monocromática; añadir favicon y metadatos HTML.
2. Crear `MarketIdentity` y conectarlo a tarjetas y encabezados de las vistas
   de Mercados, Capital, Cacería y Gráficas.
3. Ajustar tokens de color y microinteracciones para que el azul/verde/ámbar
   aporten jerarquía sin convertir cada sección en un tema distinto.
4. Validar escritorio, móvil, modo claro/oscuro, contraste, carga de recursos y
   ausencia de overflow con la comprobación visual existente.

## Criterios de aceptación

- El sidebar muestra el lockup profesional y el navegador muestra el favicon.
- Cada mercado activo se reconoce visualmente sin depender solo del texto.
- Las imágenes no bloquean el render ni provocan saltos de layout.
- Claro y oscuro mantienen contraste AA, foco visible y compatibilidad con
  movimiento reducido.
- `pnpm typecheck`, `pnpm build` y `pnpm check:ui` continúan pasando.
