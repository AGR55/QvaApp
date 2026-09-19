# Caché autónoma del servidor y controles de Cacería

## Problema

El navegador carga primero el snapshot local, pero después dispara varias rutas
`/api/live/*`. Cada ruta obliga a la VPS a consultar QvaPay y el hook del cliente
las espera de forma secuencial, con reintentos y timeouts. Una conexión lenta entre
el navegador y la VPS prolonga todo el flujo y la información solo se refresca
mientras existe un cliente abierto.

Las mutaciones de Cacería reutilizan ese refresco completo antes de liberar su
estado `busy`. Además, todos los controles usan `Boolean(busy)`, por lo que una
única acción deshabilita la vista completa hasta que terminan las lecturas remotas.

## Diseño aprobado

La VPS será responsable de mantener el snapshot operativo actualizado. Una tarea
serializada del scheduler refrescará saldo, ofertas propias, transacciones y todos
los mercados activos cada 30 segundos y persistirá cada resultado válido en
SQLite. También se ejecutará una vez al arrancar. El fallo de un recurso no borrará
los demás datos guardados y quedará auditado por el manejador del scheduler.

El cliente dejará de llamar a `/api/live/*` durante la navegación normal. Solo
leerá `/api/dashboard`, que no consulta QvaPay, al iniciar sesión, cambiar de vista,
volver a primer plano y cada 10 segundos mientras la pestaña sea visible. El
snapshot conserva las marcas de frescura para que la interfaz indique la edad de
los datos.

En Cacería, cada mutación terminará después de guardar la configuración y releer
el snapshot local. El estado ocupado seguirá identificado por la clave de la
acción, pero solo se deshabilitará el control que está ejecutándose. Los demás
mercados, lados y controles permanecerán interactivos. La cancelación confirmada
seguirá bloqueando exclusivamente su propio diálogo para evitar duplicados.

## Seguridad y consistencia

- Las mutaciones continúan autenticadas y protegidas por CSRF.
- La tarea de caché no ejecuta operaciones financieras; solo realiza lecturas.
- El scheduler impide solapar dos ejecuciones de la misma tarea.
- SQLite sigue siendo la fuente del snapshot entregado al navegador.
- Los errores de QvaPay conservan el último dato válido.

## Verificación

- Prueba de que el refresco de caché intenta todos los recursos aunque uno falle.
- Prueba de registro y ejecución inmediata de la tarea de caché del servidor.
- Regresión estática que impida reintroducir rutas `/api/live/*` en el hook normal.
- Regresión de Cacería que compruebe que no se usa un bloqueo global por `busy`.
- Suite completa, build de producción y smoke test HTTP antes del despliegue.
