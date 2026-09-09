# Diseño: tema claro/oscuro y superficie visual de QvaApply

## Decisiones

- Mantener React/Vite y el CSS existente; no introducir una migración de framework.
- Centralizar colores, superficies, estados y densidad en variables CSS.
- Aplicar el tema con `data-theme` en `<html>` y persistir la selección en `localStorage`.
- En la primera visita, respetar `prefers-color-scheme`; una selección posterior del usuario tiene prioridad.
- Usar una paleta neutra con un único acento azul sobrio, bordes de bajo contraste y sombras mínimas.
- El área de contenido debe crecer con la ventana, sin un `max-width` restrictivo en escritorio.

## Accesibilidad y resiliencia

- El control de tema es un botón accesible con etiqueta y tooltip claros.
- Se conserva el foco visible y el soporte para `prefers-reduced-motion`.
- El cambio de tema no modifica datos, sesiones ni acciones financieras.

## Verificación

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm check:secrets`

