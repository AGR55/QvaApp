# Diseño: consola web de logs operativos

## Objetivo

Añadir al panel autenticado una sección **Sistema → Logs** que permita
diagnosticar QvaApply sin entrar por SSH a la VPS. La vista usará el registro de
auditoría persistente como fuente, por lo que conservará contexto después de un
reinicio y seguirá disponible cuando QvaPay no responda.

El visor no expondrá el socket de Docker, archivos del host, variables de entorno
ni la salida cruda del contenedor.

## Fuente y clasificación

Los eventos procederán de `audit_log`. Cada fila se transformará en una entrada
operativa con identificador incremental, fecha, acción, detalle, UUID opcional,
componente y nivel.

La clasificación será determinista en el servidor:

- `error`: fallos de tareas, mutaciones inciertas y errores no controlados;
- `warning`: rechazos, bloqueos, reintentos y conciliaciones pendientes;
- `success`: aplicaciones, conciliaciones y cambios confirmados;
- `info`: actividad normal restante.

Los detalles pasarán por una redacción defensiva antes de salir por HTTP para
ocultar cabeceras Bearer, tokens con formato conocido y valores que parezcan
secretos. Los UUID operativos se conservarán porque son necesarios para rastrear
una operación.

## API y actualización

Se creará `GET /api/logs`, protegido por la sesión existente. Aceptará:

- cursor `after` para solicitar solo filas nuevas;
- `limit` acotado;
- nivel, componente, texto y rango temporal;
- dirección inicial descendente para historial y ascendente al seguir el cursor.

El navegador pedirá cambios cada dos segundos solo mientras la vista esté abierta
y el seguimiento esté activo. Esta estrategia evita conexiones persistentes en
Nginx, se recupera naturalmente tras cortes y ofrece una latencia suficiente para
operación humana. Al volver a conectar usará el último ID recibido y no duplicará
filas.

## Interfaz

La navegación incorporará **Logs** dentro de Sistema. La vista tendrá:

- cabecera con estado del seguimiento y hora de la última actualización;
- contadores compactos por severidad;
- barra de filtros por nivel, componente, texto y período;
- lista densa con hora, distintivo de nivel, componente, acción, detalle y UUID;
- controles para pausar/reanudar, actualizar, activar autoscroll, copiar lo visible
  y descargarlo como texto;
- estados vacío, cargando, desconectado y error con recuperación explícita.

El estilo reutilizará tarjetas, botones, campos, colores semánticos y temas del
panel. La composición recordará una consola operativa sin sacrificar legibilidad:
tipografía monoespaciada solo para metadatos y contenido técnico, no para toda la
pantalla. En móvil los metadatos se apilarán y los filtros podrán desplazarse sin
romper el ancho.

## Control de volumen

El polling multicuentas procesa una instantánea completa tras cada lectura y hoy
escribe miles de `scan_complete` idénticos. Se conservará `last_scan` en settings
en cada ciclo, pero el evento de auditoría se escribirá solo cuando cambie el
resultado o, como latido, una vez por minuto. Así el visor seguirá demostrando que
el escáner vive sin inflar SQLite.

No se borrará historial existente automáticamente en esta entrega. La retención
destructiva requiere una política separada y un backup verificado.

## Errores y seguridad

- La vista nunca dependerá de una llamada remota a QvaPay.
- Un fallo del refresco conservará las filas visibles y mostrará el estado
  desconectado.
- Los parámetros tendrán límites y esquemas estrictos.
- La consulta usará parámetros SQL, paginación por ID e índices existentes.
- Copiar y descargar incluirán exclusivamente las filas ya redactadas devueltas
  al navegador.

## Verificación

Se cubrirán:

- paginación por cursor, filtros y límites;
- clasificación y redacción de secretos;
- autenticación del endpoint;
- deduplicación del ruido de `scan_complete` sin perder `last_scan`;
- seguimiento, pausa, error recuperable y renderizado de niveles;
- navegación, responsive y accesibilidad por teclado;
- `pnpm check` y comprobación visual del panel.
