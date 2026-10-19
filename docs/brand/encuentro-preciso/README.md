# QvaApply · Encuentro Preciso

Dos recorridos opuestos coinciden en una operación: curvas estables, terminales a 45° y un rombo central. Dirección elegida y refinamiento aprobados por el usuario el 19 de octubre de 2026.

## Archivos y usos

Los maestros vectoriales están en `public/logo/encuentro-preciso-*.svg`.

| Uso | Variante | Tamaño en interfaz |
| --- | --- | --- |
| Barra lateral | horizontal | 176 px de ancho |
| Acceso HTML y React | horizontal | 224 px, limitado al contenedor |
| Menú móvil | horizontal | 160 px |
| Carga de sesión y datos | símbolo | 56 × 56 px |
| Primera carga HTML | horizontal | 224 px |
| Pestaña del navegador | favicon simplificado | 16–32 px |
| Acceso directo en iOS | icon-180.png | 180 × 180 px |
| Notificaciones | icon-192.png + badge.png | raster opaco + insignia monocroma |
| Presentaciones y avatares | stacked / app / icon-512 | según soporte |

`horizontal-inverse` y `symbol-inverse` se usan en oscuro. Su símbolo reduce un píxel de grosor sobre una cuadrícula de 256 para compensar el peso aparente del color claro. El tipo se exporta a peso 535 en inverso y 550 en claro. No se aplican filtros CSS para simular colores.

El favicon conserva los recorridos y el centro, con terminales rectos para no perder el detalle en 16 px. El símbolo estándar se recomienda desde 24 px; el horizontal desde 160 px. Para usos menores, preferir el símbolo. El SVG conserva proporciones naturales y nunca se recorta ni estira.

## Color

- Azul principal: `#1D4E86` (RGB 29, 78, 134).
- Marfil inverso: `#F6F2EA` (RGB 246, 242, 234).
- Fondo oscuro aprobado: `#131B22`.
- Monocromo negro: `#000000`; usar las variantes `-black` para una tinta.

Reserva al menos el ancho de un trazo alrededor del símbolo (36 unidades del maestro), además del margen interno incorporado. En el horizontal, mantener al menos medio trazo del símbolo a cada lado; el archivo ya incorpora ese margen. No añadir degradados, sombras, contornos ni combinar las piezas con colores distintos. No modificar la distancia entre símbolo y nombre.

## Tipografía y producción

Estudio tipográfico basado en Adwaita Sans, con espaciado ajustado y letras convertidas a curvas. Licencia SIL Open Font License 1.1, incluida en `FONT-LICENSE.txt`. Los archivos finales no necesitan cargar una fuente ni contienen texto vivo, imágenes incrustadas o filtros. `build-assets.py` documenta la exportación con herramientas locales; no se ejecuta en producción.

Los nombres nuevos evitan las imágenes anteriores en caché. Las dos rutas WebP heredadas también contienen la identidad nueva para pestañas y avisos antiguos. El componente compartido y `brand.css` respetan el tema manual, o la preferencia del sistema cuando no existe tema manual.

SVG auditado; revisión visual en grande y a 16/32 px, fondos claro/oscuro y pantallas de ejemplo. La revisión no sustituye una comprobación registral de marca. No se modifican motor, llamadas a QvaPay ni cálculos financieros.

## Resultado de integración

- `pnpm check`: aprobado (67 archivos de pruebas, tipos, knip, compilaciones y búsqueda de secretos).
- Tras ajustar el primer pintado: compilación y pruebas HTTP repetidas, aprobadas.
- Revisión de navegador con datos de ejemplo: escritorio y vistas móviles, sin desbordamientos ni infracciones graves de accesibilidad en el recorrido de comprobación existente.
- Comprobación específica de logo: proporciones naturales, imágenes cargadas, contención y variante correcta en acceso claro/oscuro, tema guardado opuesto al del sistema, sidebar, menú móvil, primer pintado y acceso React. Capturas adjuntas.
- La transición al acceso React se comprobó simulando la respuesta de cierre de sesión en el navegador de prueba; no se usa una cuenta de producción. El entorno de ejemplo presenta un error previo en `/api/notifications`, ajeno a los recursos de identidad.
- `theme.js` aplica el tema antes de pintar; CSS cubre también la pantalla de carga sin ejecución JavaScript. No se insertan estilos inline para el tema.
