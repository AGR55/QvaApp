# Revisión de latencia de cacerías — 2026-10-09

## Cambios verificados

| Ruta | Espera anterior | Cambio |
| --- | --- | --- |
| Compra QUSD por sondeo / evaluación de riesgo | Consulta remota de saldo QUSD, aunque el capital necesario es fiat | Se elimina la consulta; se conservan todos los controles de riesgo y capital fiat |
| Venta mediante el orquestador con QUSD libre suficiente | Lectura de saldo y listado de ofertas propias, serializados por el cliente HTTP | Solo se consulta saldo; se lista cuando hay que liberar capital, descontando deuda cooperativa y reserva |
| Avisos de cacería propia y cooperativa | Persistencia y entrega de todo el lote de notificaciones antes de continuar | Persistencia antes de retornar; entrega inmediata en segundo plano con los mismos reintentos |
| Sondeo con varios mercados o ambos lados activos | Espera hasta tener una instantánea fresca de todos los mercados y lados | Evalúa desde la primera página fresca y limita la actualización de alertas y recursos a los mercados/lados observados |

Las pruebas de regresión fallaron antes de cada corrección. Comprueban que las consultas sobrantes no ocurren, que una entrega de avisos bloqueada no retiene al publicador y que la reserva y la deuda cooperativa siguen impidiendo utilizar saldo ajeno.

## Ruta crítica que ya existía

- Webhook firmado y stream SSE alimentan una cola persistente y deduplicada. Los eventos despiertan el procesamiento sin esperar el siguiente sondeo.
- Las compras desde el feed deciden con datos locales, sin pedir listado, promedios o saldo QUSD.
- Las ventas desde el feed usan saldo QUSD con caché de 15 segundos o una lectura prioritaria cuando caduca.
- Las aplicaciones tienen una cola separada de las lecturas. El presupuesto durable admite dos intentos en una ventana de 60.001 segundos y conserva los bloqueos de `429` y `Retry-After`.
- Se revalidan las condiciones antes del envío; se descartan observaciones demoradas más de cinco segundos. La serialización evita gastar el mismo capital en dos oportunidades simultáneas.
- La cacería cooperativa necesita reservar capital remoto antes de aplicar y cede prioridad a la propia. Esas esperas no se eliminan.

## Reglas oficiales consultadas

- [Aplicar a una oferta](https://www.qvapay.com/docs/p2p/apply): dos solicitudes cada 60 segundos.
- [Listado P2P](https://www.qvapay.com/docs/p2p/list): el texto de límites indica 25 consultas por minuto por cuenta y advierte de la caché del servidor; su tabla de errores todavía menciona 30. Se mantiene el intervalo existente de 2.401 segundos, compatible con el límite más estricto.
- [Feed del mercado](https://www.qvapay.com/docs/p2p/webhooks): eventos en tiempo real, filtrado de restricciones antes de aplicar, validación de firma e idempotencia.

No se aumenta el número de solicitudes permitido ni se alteran las reservas, las restricciones VIP, la parada de emergencia o el tratamiento de respuestas inciertas.

## Validación y límites de la conclusión

La validación local usa `node --import tsx --test --test-isolation=none test/*.test.ts`. Se utiliza este modo porque el ejecutor aislado de Node 25 en este entorno termina sin exponer el diagnóstico de los archivos. Las pruebas enfocadas también se ejecutaron directamente. CI ejecuta además `pnpm check` en Node 24 antes del despliegue.

Las mejoras eliminan dependencias de red concretas; no constituyen una medición de latencia en producción. Las pruebas no envían aplicaciones reales. No es posible prometer respuesta imperceptible ni ganar siempre: quedan la entrega del feed, la conexión HTTP, el procesamiento remoto, el presupuesto de aplicaciones y, cuando corresponde, la liberación o reserva de capital.

Para comparar en producción, usar las métricas existentes de demora del feed, decisión, cola de aplicación, espera de cupo y respuesta HTTP, junto con la auditoría `offer_apply_timing`. La vía de menor latencia requiere el modo Tiempo real y una suscripción de feed activa; no se modificaron credenciales ni suscripciones.
