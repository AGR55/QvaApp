# Diseño: fuente de mercado multicuentas y migración futura a stream

## Objetivo

Reducir el tiempo entre lecturas del mercado P2P mediante un conjunto arbitrario
de cuentas de observación, sin permitir que ninguna cuenta secundaria mueva
fondos ni gestione operaciones. La cuenta principal seguirá siendo la única
identidad operadora. La frontera de captura de mercado quedará preparada para
sustituir el polling por el stream oficial de QvaPay sin reescribir el motor de
decisiones.

## Restricciones confirmadas

- Las cuentas secundarias usarán tokens acotados a `p2p:read`.
- La cuenta principal participará en las lecturas y conservará todas las
  mutaciones.
- Se podrá añadir una cantidad arbitraria de cuentas secundarias.
- Cada cuenta tendrá un intervalo mínimo propio. Dos cuentas saludables a tres
  segundos producirán aproximadamente un turno global cada 1,5 segundos.
- El sistema no intentará eludir los límites individuales: cada cuenta tendrá
  su propio control de frecuencia, cooldown y backoff.
- La fuente inicial será polling multicuentas. El stream será una fuente
  intercambiable que podrá activarse posteriormente.

## Arquitectura

Se introducirá una interfaz `MarketDataSource` que entregue instantáneas de un
mercado y lado, independientemente de cómo se obtuvieron. El motor de trading
consumirá esas instantáneas y no conocerá tokens, cuentas ni transporte.

La primera implementación será `PollingMarketSource`, compuesta por:

- un registro persistente de cuentas de observación;
- un planificador justo que elige la próxima cuenta disponible;
- una cola ponderada de combinaciones mercado/lado;
- una caché de la última instantánea por combinación;
- métricas y estado sanitario por cuenta.

Cada turno ejecutará una única consulta de listado. La cuenta elegida no podrá
volver a usarse antes de su intervalo mínimo. Las cuentas con el mismo intervalo
se desplazarán naturalmente en el tiempo: con dos cuentas a tres segundos habrá
un inicio de consulta aproximadamente cada 1,5 segundos. No habrá consultas
simultáneas con la misma cuenta.

Después de cada lectura correcta, la fuente actualizará únicamente la
instantánea correspondiente. El evaluador combinará las instantáneas recientes,
descartará duplicados por UUID, recalculará referencias y rentabilidad, y podrá
seleccionar como máximo una oportunidad. La compra de QUSD conservará prioridad;
la venta se intercalará con menor frecuencia como en el comportamiento actual.

`PrimaryTradingGateway` será la única dependencia permitida para consultar
saldo privado, ofertas propias y operaciones, y para aplicar, cancelar, crear,
editar, marcar pagado, confirmar recepción o usar chat. Una oferta descubierta
por una secundaria se someterá a todas las comprobaciones actuales y se intentará
exclusivamente con la principal.

## Persistencia y secretos

SQLite almacenará por cuenta secundaria:

- identificador interno y etiqueta;
- UUID de QvaPay cuando el alcance permita consultarlo;
- huella irreversible del token para impedir duplicados exactos;
- token cifrado mediante el vault existente;
- intervalo mínimo, estado habilitado y estado sanitario;
- última lectura correcta, próxima disponibilidad, contador de errores,
  cooldown y último error sanitizado.

El token se recibirá solo al crear o rotar una cuenta. Nunca se devolverá por la
API web, se escribirá en logs ni aparecerá en auditorías. El alta se confirmará
con un listado mínimo real; no exigirá permisos adicionales a `p2p:read`. La
cuenta principal seguirá usando el secreto existente y no se copiará a la nueva
tabla.

Una migración versionada creará las tablas y realizará el respaldo automático
existente. El intervalo actual de escaneo se usará como intervalo inicial de la
cuenta principal, por lo que una instalación sin secundarias seguirá siendo
válida.

## Seguridad operativa

La separación lectura/escritura se expresará en tipos y constructores, no solo
por convención. `PollingMarketSource` recibirá clientes capaces únicamente de
listar. El orquestador de operaciones recibirá únicamente el gateway principal.
No existirá una ruta que seleccione una secundaria para una mutación.

Las instantáneas que superen la antigüedad máxima configurada no participarán en
una decisión. Durante el calentamiento inicial no se aplicará hasta disponer de
referencias suficientes y vigentes. La evaluación y aplicación se serializarán
por UUID para que una oferta repetida por varias cuentas no genere carreras.

## Fallos y recuperación

- `429`: la cuenta afectada respetará `Retry-After` cuando exista o entrará en
  backoff exponencial; las demás continuarán.
- `401` o `403`: la cuenta quedará en estado `requires_attention` y dejará de
  recibir turnos hasta que se rote el token o se reactive después de validar.
- Timeout, red o `5xx`: backoff aislado y creciente para esa cuenta.
- Principal no disponible: las secundarias podrán mantener la observación, pero
  cualquier mutación quedará bloqueada con un estado visible.
- Todas las fuentes de polling indisponibles: se pausará solo la captura de
  mercado. La conciliación y gestión de operaciones existentes continuarán.

El panel mostrará la causa sanitizada, la última lectura correcta y la próxima
reanudación. Una lectura posterior correcta devolverá automáticamente una cuenta
con error temporal al estado saludable.

## Interfaz web

`Estrategia` incorporará una sección `Fuente de mercado` con:

- tarjeta fija de la cuenta principal, marcada `Opera y observa`;
- tarjetas de cuentas secundarias, marcadas `Solo observa`;
- alta, validación, activación, desactivación, rotación y eliminación;
- etiqueta e intervalo configurable por cuenta;
- estado, última lectura, próxima disponibilidad, consultas recientes y último
  error;
- resumen del número de cuentas saludables y cadencia global estimada;
- estimación de consultas por minuto y advertencias de capacidad/cobertura.

Las mutaciones del panel exigirán sesión, CSRF y confirmación explícita para
rotar o eliminar. El mínimo inicial será tres segundos por cuenta, equivalente a
unas veinte consultas por minuto y con margen frente al límite documentado.

## Migración futura al stream

La configuración de la fuente tendrá una discriminante interna (`polling` y,
posteriormente, `stream`). `StreamMarketSource` publicará las mismas
instantáneas/eventos consumidos por el evaluador. Activar el stream detendrá el
polling; volver a multicuentas será inmediato y no alterará estrategia, riesgo,
historial ni cuentas almacenadas.

La primera entrega no incluirá una opción inoperante en la interfaz. Sí dejará
estable la frontera `MarketDataSource`, la caché y el selector de fuente para que
la integración SSE posterior sea aditiva.

## Verificación

Se cubrirán como mínimo:

- secuencias temporales con una, dos y varias cuentas;
- reparto justo y ausencia de solapamiento por cuenta;
- aislamiento de `429`, credenciales inválidas, timeout y recuperación;
- cifrado y no exposición de tokens;
- deduplicación de resultados y exclusión de instantáneas antiguas;
- calentamiento inicial y selección por rentabilidad neta;
- garantía de que solo la principal puede mutar;
- endpoints protegidos por sesión y CSRF;
- alta, rotación, activación, desactivación y eliminación desde la interfaz;
- migración y compatibilidad con instalaciones existentes;
- suite completa, typecheck, análisis estático, builds, secretos y smoke visual.

## Entrega

La implementación se realizará en un worktree aislado de `develop`. Tras pasar
la verificación completa se integrará en `main`. La rama NATS y los cambios
locales preexistentes del directorio principal no formarán parte de la entrega.
