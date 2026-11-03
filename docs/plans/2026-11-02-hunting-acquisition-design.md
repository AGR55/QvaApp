# Cacerías: adquisición independiente y medición

Primera entrega de la revisión del 2 de noviembre, autorizada para implementación por el usuario. Trabajo con tres subagentes GPT-6.1 Terra y revisión integrada del agente principal.

## Alcance implementado

El sondeo conserva su lector, rotación, cuotas, backoff y exclusión de lectura existentes. La evaluación de una página deja de retener el trabajo `scan` del scheduler. Un consumidor serial evalúa inmediatamente y mantiene como máximo 64 claves pendientes de mercado/lado. Para la misma clave conserva la página con mayor `scannedAt`; la página activa no se sustituye. Al superar el límite expulsa la clave pendiente más antigua. La cola es de instantáneas de polling, no de eventos de estado: el feed durable sigue procesando sus invalidaciones.

Cada lectura captura modo y generación antes de comenzar. Las páginas pendientes y las lecturas que terminan después de cambiar modo, pausa o parada se descartan. El contador del motor también detecta pausa y reanudación completas durante una espera. La vigencia acompaña la evaluación mediante un contexto asíncrono independiente y se comprueba después de preparar la instantánea y en el guard de aplicación, incluso si una lectura de saldo cede el hilo. Una aplicación ya enviada conserva su resultado e intención; el cierre no cancela ni reintenta una mutación monetaria.

Una página que encuentra un escaneo manual u otra evaluación en curso espera su terminación y se procesa después: ya no devuelve el resultado ajeno como si hubiese evaluado la página nueva. Al terminar la espera se vuelve a comprobar vigencia. La exclusión de capital y las reservas durables permanecen en sus rutas existentes.

El cierre detiene nuevas lecturas/evaluaciones y espera trabajos iniciados por scheduler y por microtareas de webhook/SSE, incluidos estados independientes, antes de cerrar SQLite. `MarketSourceCoordinator.stop()` es ahora asíncrono y terminal. Los nuevos webhooks recibidos durante el cierre obtienen 503 para permitir reentrega.

## Telemetría

| Evento de auditoría | Qué mide |
| --- | --- |
| `qva_list_timing` | Listados del cliente principal: espera hasta despacho, respuesta, total, número de intentos, resultado, HTTP y X-Cache reconocido |
| `market_poll_timing` | Lectura por mercado/lado/cuenta, intervalo entre respuestas exitosas de ese par, cantidad devuelta/total y metadatos de transporte disponibles, también para lectoras secundarias |
| `market_evaluation_timing` | Espera en la nueva cola, duración de evaluación y resultado de ejecución o descarte |

Las duraciones usan reloj monotónico. `queueMs` del transporte incluye cola y throttle; `responseMs` incluye reintentos de lectura, backoff y decodificación JSON. No son tiempos exclusivos de QvaPay ni separan DNS/TLS/TTFB. `evaluationMs` incluye esperas internas y confirmación remota cuando se aplica; no es CPU pura ni latencia exclusiva de decisión. `success` indica que la evaluación retornó sin excepción ni descarte por guard, no que haya capturado una oferta.

`coverageGapMs` mide separación entre respuestas exitosas locales del mismo mercado/lado, a través de todas las lectoras, desde el arranque. No mide edad del contenido cacheado. `scannedAt` sigue siendo hora local de respuesta. X-Cache solo admite HIT/MISS reconocidos; el resto se omite. No se registran tokens, cuerpos, URLs ni errores remotos en estos eventos. Los observadores fallidos no cambian el resultado de una consulta o evaluación.

## Validación

- Node 24.22.1, versión soportada del runtime local.
- `pnpm check`: tipos, knip, suite completa de 84 archivos, build servidor/web, compresión y revisión de secretos aprobados. Knip conserva una sugerencia informativa sobre `.css` en su configuración.
- Tras los ajustes finales: tipos y pruebas focalizadas de cola, serialización de ingesta, medición de polling/listado y cierre aprobadas; build servidor actualizado.
- Los cuatro casos iniciales de serialización fallaron en una copia temporal con el comportamiento anterior y pasaron con la corrección. La prueba de cierre reproduce el trabajo de webhook iniciado fuera del scheduler.
- Pruebas con SQLite real y gateways controlados: sondeo durante evaluación retenida, reemplazo por frescura, límite de cola, errores, pausa/reanudación, cambios de generación, invalidación durante promedios y preflight, independencia del feed, reservas sin fugas y espera de cierre.

No se realizaron solicitudes a producción ni se desplegó. No hay un porcentaje de mejora de latencia real medido. La mejora demostrada es eliminar la dependencia de evaluación del siguiente sondeo y evitar pérdida de páginas concurrentes.

## Siguiente fase

La instrumentación debe mostrar primero cuánto pesan entrega del feed, espera de motor, lectura de saldo y reserva cooperativa. Quedan fuera de esta entrega los cupos cooperativos preasignados, cambios de ledger/concurrencia QUSD, lecturas simultáneas entre cuentas, cambio de región/transporte y cambio de lenguaje. La preparación de liquidez existente se revisó; no se cambió su política sin evidencia nueva.
