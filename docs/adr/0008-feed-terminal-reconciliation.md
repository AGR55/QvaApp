# ADR 0008: evidencia terminal del feed para aplicaciones inaccesibles

Estado: aceptado, 2026-10-03.

## Contexto

Una aplicación incierta puede bloquear nuevas aplicaciones indefinidamente si
QvaPay deja de permitir consultar su UUID. Un HTTP 403/404 con «No tienes
permisos» no distingue VIP, oferta tomada, eliminación ni aplicación fallida.
No autoriza a repetir una mutación ni a descartar obligaciones financieras.

El feed autenticado conserva eventos de ciclo de vida incluso cuando el detalle
ya no es accesible. En producción se comprobó una cancelación posterior a un
intento incierto que llevaba varios días bloqueando el motor.

## Decisión

Solo para conciliación de `apply`, un GET 404 puede corroborarse con el último
evento persistido del UUID si es `p2p.cancelled`, su estado es `cancelled`, se
emitió después del intento y no está fechado en el futuro. La recepción también
debe ser posterior al intento. Se concilia como oferta cancelada, **no** como
aplicación rechazada ni VIP. No se inventa una operación ni un movimiento fiat.
Si la operación existente está pagada o en revisión, esta evidencia no basta
para liquidarla: conserva estado, exposición e incertidumbre.

El orden se determina por `sent_at`, no por recepción: una reapertura o aplicación
posterior invalida la evidencia terminal. Empates son ambiguos y no desbloquean.
Los eventos entran únicamente por las rutas autenticadas de webhook/stream.
Un índice por UUID evita recorrer todo el historial en cada conciliación.

Los intentos sin evidencia concluyente siguen pendientes con backoff persistido
por intención: 1, 2, 4, 8 y 15 minutos, con tope de 15 minutos. Un reinicio no
restablece el ciclo de consultas. No hay reintentos automáticos de la mutación.

## Consecuencias y límites

Se conserva el bloqueo financiero cuando falta evidencia; no se deduce el
resultado por permisos genéricos. Esta vía no confirma pagos, recepción,
participantes ni liquidación de ofertas completadas. Tampoco atribuye una oferta
perdida a la velocidad de un competidor: no disponemos de esa telemetría.

Las medianas mostradas en Telegram son las de las ofertas abiertas observadas
por mercado/lado, con muestra y antigüedad. No son medias oficiales de operaciones
completadas ni necesariamente una muestra exhaustiva de todo el mercado.
