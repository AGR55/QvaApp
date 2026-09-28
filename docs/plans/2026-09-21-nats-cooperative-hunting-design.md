# Cacerías cooperativas mediante NATS

## Objetivo

Integrar QvaApply con Sync Core para publicar la capacidad fiat propia y mostrar la capacidad global aportada por los bots sincronizados. NATS será el canal de tiempo real desde la primera versión. HTTP se reservará para autenticación, comandos y reconciliación.

La ejecución distribuida de una oferta queda fuera de esta entrega. El endpoint remoto `POST /hunts/perform` continuará desactivado hasta que Sync Core garantice idempotencia y atomicidad.

## Límites de seguridad

- Las credenciales y la API key nunca llegan al navegador ni a Telegram.
- QvaApply usa una cuenta creada previamente en Sync Core.
- La API key obtenida mediante login se guarda cifrada con el vault local.
- La pérdida de Sync Core o NATS nunca detiene la cacería local ni invalida el último snapshot global conocido.
- Ningún mensaje NATS autoriza por sí solo una mutación financiera en QvaPay.
- La UI distingue datos actuales, datos antiguos y ausencia de sincronización.

## Configuración

La integración se controla mediante variables de entorno:

- `SYNC_ENABLED`: activa la integración cooperativa.
- `SYNC_BASE_URL`: origen HTTP de Sync Core; por defecto no se asume ninguno.
- `SYNC_NATS_URL`: dirección NATS, normalmente `nats://127.0.0.1:4222` en la misma VPS.
- `SYNC_EMAIL`: correo de la cuenta precreada.
- `SYNC_PASSWORD`: contraseña de esa cuenta.

Cuando `SYNC_ENABLED=false`, QvaApply conserva todo su comportamiento actual y no abre conexiones externas.

## Arquitectura

El dominio consume un puerto `HuntingSyncGateway`. Su adaptador HTTP/NATS se ocupa de:

1. iniciar sesión por HTTP y recuperar una API key;
2. usar la API key como token NATS;
3. obtener un snapshot inicial con `GET /hunts/sync`;
4. consumir `cacerias.sync` mediante un consumidor durable;
5. publicar o reemplazar nuestra capacidad con `POST /hunts`;
6. retirar nuestra capacidad con `DELETE /hunts`;
7. reconciliar periódicamente el snapshot por HTTP.

La reconciliación HTTP es necesaria porque Sync Core todavía no publica en NATS al eliminar una cacería. NATS sigue siendo el canal primario de actualización; HTTP corrige huecos y permite recuperar estado después de una retención vencida.

## Persistencia local

SQLite almacena:

- el snapshot global por moneda;
- la aportación propia deseada por mercado;
- la fecha del último mensaje NATS válido;
- la fecha de la última reconciliación HTTP;
- el estado de conexión y el último error sanitizado;
- el token cifrado y su fecha estimada de expiración.

El snapshot se actualiza en una transacción. Los mensajes inválidos se rechazan sin borrar el último estado válido.

## Flujo de arranque

1. El panel arranca inmediatamente desde SQLite.
2. El coordinador valida la configuración de Sync Core.
3. Recupera la API key cifrada o inicia sesión si falta o ha caducado.
4. Solicita el snapshot HTTP inicial.
5. Abre el consumidor NATS durable y procesa snapshots posteriores.
6. Programa reconciliaciones HTTP con intervalo conservador.

Si la autenticación falla, la integración queda degradada y reintenta con backoff sin afectar el motor de trading local.

## Reconexión y errores

- Un `401` HTTP invalida el token una sola vez, vuelve a iniciar sesión y repite la solicitud una vez.
- NATS reconecta con backoff y jitter usando las capacidades del cliente oficial.
- Un payload NATS debe respetar límites de tamaño, monedas válidas y números finitos no negativos.
- Errores y credenciales se sanitizan antes de persistirlos o mostrarlos.
- La aportación propia solo se marca sincronizada después de confirmación HTTP y posterior observación en un snapshot.
- Al cerrar QvaApply se drena la suscripción NATS y se detienen los temporizadores.

## Web y Telegram

La sección **Red cooperativa** muestra:

- conexión HTTP y NATS;
- antigüedad del snapshot;
- fiat global, cantidad de bots, tasa media y mínimo medio por moneda;
- nuestra aportación y si está confirmada;
- acciones para publicar, actualizar o retirar la aportación;
- aviso explícito de que la ejecución conjunta permanece desactivada.

El bot de Telegram expone el mismo resumen local y accesos de publicación/retiro sin conectarse directamente a Sync Core.

## Estrategia de pruebas

- pruebas contractuales del login, reautenticación y comandos HTTP;
- pruebas del decodificador NATS con payloads válidos, incompletos, enormes y no finitos;
- pruebas de persistencia y recuperación del último snapshot;
- pruebas de reconciliación después de perder un mensaje NATS;
- pruebas de backoff, cierre y ausencia de temporizadores solapados;
- pruebas del dashboard y Telegram leyendo exclusivamente el modelo local;
- regresión completa de QvaApply con la integración desactivada por defecto;
- smoke test con Sync Core y NATS en procesos locales antes de habilitar producción.

## Entrega incremental

1. Configuración, tipos, persistencia y cliente HTTP autenticado.
2. Consumidor NATS durable y reconciliación.
3. Proyección local y endpoints autenticados del dashboard.
4. Sección web y resumen Telegram.
5. Verificación integrada contra Sync Core.

La futura ejecución cooperativa será una entrega independiente que exigirá primero garantías remotas de idempotencia, transacciones e historial durable.
