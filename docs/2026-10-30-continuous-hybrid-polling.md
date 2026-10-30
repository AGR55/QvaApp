# Polling continuo en modo Tiempo real — 30 de octubre de 2026

## Diagnóstico

El modo híbrido devolvía sin consultar polling si el SSE estaba conectado y no había una solicitud de recuperación. Cuando sí sondeaba, imponía un intervalo global de tres segundos además del intervalo de cada cuenta. Esto impedía aprovechar el escalonamiento de varias cuentas lectoras.

La tarea scan también esperaba processNext del feed y retornaba si había procesado eventos. Una aplicación o conciliación lenta del feed podía retrasar el siguiente sondeo.

El indicador de último escaneo tenía un segundo problema: ingestRealtimeRecovery no escribía last_scan. La inspección de producción encontró ese resumen fechado mucho antes, aunque la lectora sí tenía consultas recientes. Por ello las 585 horas no representaban necesariamente ausencia total de solicitudes.

Se confirmó una cuenta lectora adicional a la cuenta principal: dos fuentes para sondear. Solo se leyeron metadatos de salud, intervalos y fechas; no se mostraron tokens.

## Corrección

- Tiempo real mantiene polling, SSE y webhook activos conjuntamente.
- Se elimina el intervalo global redundante del coordinador. PollingMarketSource conserva la rotación, intervalos por cuenta, una lectura en vuelo y tratamiento de 401/403/429 y errores.
- Feed y sondeo tienen tareas independientes del Scheduler. Una no conserva el temporizador de la otra mientras espera HTTP. La evaluación del capital y la deduplicación siguen en el motor compartido.
- Cada página híbrida evaluada correctamente actualiza last_scan, incluyendo páginas vacías y resultados con aplicación anticipada. No se registra éxito si la evaluación lanza un error.
- La siembra del calendario respeta el mayor entre el turno escalonado y nextEligibleAt persistido, para no perder Retry-After al reiniciar.

No se aumentan cuotas, no se habilitan mutaciones desde las cuentas lectoras y no se repiten aplicaciones inciertas. Las dos cuentas pueden aportar consultas escalonadas según sus intervalos; el tiempo HTTP y de evaluación se añade a la cadencia efectiva. No se garantiza un intervalo exacto global ni que el polling gane todas las carreras.

## Verificación

Se reprodujeron primero dos fallos: sondeo ausente con SSE conectado y resumen last_scan ausente en recuperación. Tras corregirlos, se verificaron:

- SSE conectado con polling continuo y delegación de intervalos por cuenta.
- Feed bloqueado con polling progresando; polling lento con feed progresando.
- Pausa del usuario detiene ambos trabajos y cada worker conserva su exclusión de reentrada.
- La misma oferta vista simultáneamente por feed y polling produce un único POST y una única reserva, tanto con respuesta confirmada como incierta.
- Actualización del último escaneo con página vacía y con aplicación.
- Alternancia de cuentas, exclusión de lecturas simultáneas y conservación de Retry-After tras reinicio.

Árbol aislado basado en producción, Node 24.22.1: tipos, knip, suite completa, build servidor/web, compresión y comprobación de secretos aprobados. No se enviaron operaciones monetarias de prueba. Los cambios pendientes de Android y acciones manuales quedan fuera de esta entrega.

Referencia oficial: https://www.qvapay.com/docs/p2p/list . El listado documenta caché y 25 consultas/minuto por cuenta en su explicación; se mantienen los límites existentes y la respuesta 429 como autoridad. Las credenciales de app comparten el cupo de su propietario.
