# Rediseño de acceso a pantalla completa

## Objetivo

Convertir el acceso administrativo en una entrada visual de producto, usando
el nuevo logotipo, isotipo e imagen financiera entregados en `public/` sin
alterar el flujo de sesión ni los mensajes de error.

## Dirección aprobada

- Composición dividida en dos paneles: formulario claro a la izquierda e
  imagen financiera oscura a la derecha.
- El panel visual ocupa toda la altura disponible, usa la imagen como fondo
  con `object-fit: cover` y una capa azul para conectarla con la identidad.
- El formulario usa el lockup horizontal (`public/logo/logotipo.webp`) y el
  isotipo (`public/logo/isotipo.webp`) como acento decorativo y marca de
  seguridad.
- En pantallas pequeñas la imagen se convierte en una franja superior y el
  formulario permanece cómodo, accesible y sin scroll horizontal.
- El sidebar usa el lockup horizontal; el isotipo se reserva para estados de
  arranque y contextos compactos.

## Componentes y comportamiento

`Login` conserva el POST a `/api/session`, el estado ocupado, el mensaje
accesible con `aria-live` y la callback `onAuthenticated`. Solo cambia su
estructura visual y añade el texto contextual del panel de imagen.

## Validación

Se comprobará typecheck, build de Vite y la comprobación visual existente,
incluyendo escritorio, móvil, carga de recursos y ausencia de overflow.
