# Producción real, Auditoría recuperable y alertas fiables

## Objetivo

Simplificar la operación de QvaApply a los estados `Activo` e `Inactivo`, evitar
interacciones bloqueantes en Auditoría y garantizar que las aplicaciones
confirmadas sean visibles por más de un canal.

## Estado operativo

La aplicación de producción operará siempre en modo real. El modo de simulación
desaparecerá de la web, Telegram y la API pública. Si las pruebas necesitan
simular operaciones, lo harán mediante adaptadores o dependencias falsas sin
exponer un modo seleccionable ni persistirlo en producción.

En cada arranque, la automatización quedará activa. La única excepción será una
parada de emergencia persistente: mientras esté activa, el proceso arrancará
inactivo y exigirá retirar primero esa parada.

La interfaz web y Telegram mostrarán únicamente `Activo` o `Inactivo`. Se
eliminarán botones, comandos, textos y condiciones dedicadas a cambiar entre
modo real y simulación.

## Auditoría y ofertas VIP

Descartar una oferta será una interacción optimista y recuperable. La tarjeta se
retirará y el diálogo se cerrará sin esperar el refresco global del dashboard.
Si la petición falla, la tarjeta volverá a aparecer y se mostrará un error sin
bloquear el resto de la página.

Las ofertas marcadas `only_vip` se clasificarán como ignoradas antes de crear
eventos de decisión, alertas o notificaciones. Los eventos VIP pendientes que ya
existan se resolverán automáticamente, manteniendo el historial de auditoría.

## Alertas de aplicaciones confirmadas

Una aplicación confirmada creará primero un aviso durable con un identificador
único. La entrega a Telegram y Web Push se procesará por canal, de forma
independiente, con reintentos y espera creciente. Un fallo temporal quedará
auditado y no eliminará el aviso pendiente.

En la web, el aviso será persistente hasta que el usuario lo cierre, reproducirá
un sonido y dirigirá a Operaciones. Cuando la página no esté visible, Web Push
mostrará una notificación del sistema con el icono de QvaApply y solicitará que
permanezca visible cuando la plataforma soporte esa opción.

Los reintentos usarán claves de deduplicación para que un mismo evento no genere
varios mensajes después de una entrega confirmada. El fallo de un canal no
impedirá la entrega por el otro.

## Errores y recuperación

- La parada de emergencia prevalece sobre la activación automática.
- Un fallo al descartar restaura la tarjeta y deja la página utilizable.
- Los errores de Telegram o Push no afectan la operación monetaria confirmada.
- Los avisos pendientes sobreviven a reinicios y se reintentan posteriormente.
- Las suscripciones Push expiradas se eliminan como en el comportamiento actual.

## Verificación

- Producción arranca activa salvo parada de emergencia.
- No quedan controles o textos de simulación en web, Telegram ni API.
- Las ofertas VIP no aparecen en bloqueadas ni generan avisos nuevos.
- Descartar no deja el diálogo o la página en estado ocupado.
- Una aplicación confirmada produce alerta visual persistente, sonido y Push con
  icono.
- Telegram y Push reintentan fallos transitorios sin duplicar entregas exitosas.
- La compilación, el tipado y las pruebas existentes continúan pasando.
