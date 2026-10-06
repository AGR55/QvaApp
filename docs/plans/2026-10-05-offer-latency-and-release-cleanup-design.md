# Latencia de ofertas y retención de releases

La cola única de transporte añade espera detrás de consultas y chat. En producción se observaron aplicaciones de 8–26 segundos desde recepción, aunque el último evento se entregó en 22 ms. La decisión rápida ya usa precio, saldo fiat comprometido y mediana local; debe mantener esas comprobaciones.

Las aplicaciones tendrán una cola independiente de las lecturas y otros endpoints. Se conservará de forma durable una ventana móvil de dos intentos por 60 segundos (cuota oficial de QvaPay), permitiendo dos aplicaciones seguidas y respetando Retry-After. Cada aplicación automática volverá a comprobar las condiciones locales inmediatamente antes del envío; el intentId propio se excluye del bloqueo de mutaciones pendientes. La intención se persiste antes de enviar y los resultados inciertos no se reintentan.

La preparación remota del escaneo no mantendrá ocupado el turno de decisión; las decisiones financieras siguen serializadas. La recuperación del feed evalúa solo la página recibida usando reglas rápidas y datos locales, sin esperar otros mercados. Los avisos y chat posteriores no ocuparán el turno de aplicación. Se medirán decisión local, espera de cupo y respuesta remota por separado.

Después de un despliegue sano se conservarán únicamente el release actual y el anterior, y se retirarán las imágenes etiquetadas de QvaApply restantes, incluso sin carpeta asociada. No se eliminan volúmenes, datos, backups ni imágenes de otros servicios. La versión nueva del script de despliegue se ejecuta desde el archivo recibido, para aplicar la política en ese mismo despliegue. La caché compartida solo se limpia mediante selectores que identifiquen etapas propias de QvaApply.

Verificación: pruebas de transporte con reloj y red controlados, ráfagas concurrentes, exclusión manual y cambios de precio durante espera, recuperación del feed, métricas, limpieza con Docker simulado y healthcheck/rollback. CI completo antes de integrar y comprobación de HTTPS, contenedor e imágenes tras desplegar.
