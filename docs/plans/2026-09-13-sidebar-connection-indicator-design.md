# Indicador discreto de conexión en el sidebar

## Objetivo

Mostrar el estado de conexión sin interferir con el contenido de cada vista.

## Diseño aprobado

El estado se ubicará en el pie persistente del sidebar, junto al estado operativo
existente (`Activo · Real`). Se mostrará como una segunda línea compacta con un
punto de color y una etiqueta breve:

- `Conectado` cuando la conexión está disponible.
- `Sin conexión` cuando no lo está.

El punto será verde en línea y rojo fuera de línea. El contenedor conservará
semántica de estado accesible (`role="status"` y `aria-live="polite"`).

## Alcance técnico

- Mover el bloque `connection-state` desde el contenido principal al `.sidebar-foot`.
- Ajustar sus estilos para el formato compacto del pie del sidebar.
- Reutilizar el estado existente `online` y el mensaje `status`, sin cambiar la
  lógica de conexión ni las solicitudes de datos.

## Verificación

- El indicador aparece una sola vez y permanece visible al navegar entre vistas.
- Su color y texto cambian al variar `online`.
- El sidebar y el header conservan su layout en escritorio y móvil.
