# ADR 0009: transporte prioritario y retención acotada

## Contexto

La cola única adoptada en ADR 0007 bloqueaba las aplicaciones detrás de consultas del panel, historiales y chat. Producción registró aplicaciones de 8–26 segundos desde la recepción. La separación fija de 30 segundos impedía usar inmediatamente el segundo intento permitido por QvaPay. El despliegue retenía cinco imágenes y carpetas; las imágenes sin carpeta no se retiraban y el workflow ejecutaba el script del release anterior.

## Decisión

- Sustituir la cola compartida de aplicaciones por una cola independiente; las lecturas críticas de saldo y de ofertas también pueden adelantar tareas normales. Mantener serializadas las decisiones financieras y los intentos por endpoint.
- Persistir los dos últimos intentos de `apply`, conservarlos entre reinicios y permitir dos en una ventana móvil de 60 segundos. Migrar la antigua marca asumiendo conservadoramente que puede existir un intento anterior separado por 30 segundos. Persistir el cooldown indicado por `Retry-After` sin reintentar POST.
- Revalidar las condiciones locales inmediatamente antes de despachar. La intención propia se excluye del bloqueo, pero cualquier otra intención sin resultado sigue bloqueando. Después de una espera superior a cinco segundos comprobar de nuevo apertura e importes remotos. Una prevalidación fallida antes del POST deja la intención rechazada, no incierta.
- Evaluar la página de recuperación híbrida sin consultas de promedios adicionales ni calentamiento de otros mercados. Solo tres UUID distintos de una página fresca pueden renovar la mediana de seguridad; una copia histórica de promedios no se rejuvenece.
- Procesar los estados del feed independientemente de las aplicaciones. Los estados ya procesados también invalidan oportunidades antiguas.
- Exponer evaluación, espera de transporte/cuota y respuesta remota por separado.
- Ejecutar el script del archivo recibido y limpiar después de un healthcheck exitoso. Conservar release e imagen actuales y anteriores; retirar imágenes etiquetadas propias huérfanas y caché de etapas propias no compartida. Preservar contenedores, volúmenes, datos, backups y servicios del sincronizador.

## Consecuencias y evidencia

Se elimina la espera por tareas ajenas a la oportunidad. La cuota remota, el tiempo de entrega del evento, la latencia de red, una consulta crítica necesaria y la conciliación de un resultado incierto siguen siendo límites reales. Esto no permite asegurar una posición frente a otros bots.

Una prueba reproducible con 50 ofertas, SQLite real y una consulta del panel bloqueada midió p50 2,92 ms y p95 7,34 ms desde entrada al motor hasta invocar el POST. Usa transporte y reloj simulados, sin red y con cuota disponible; no mide la latencia real de producción.

Referencias verificadas el 6 de octubre de 2026:

- https://www.qvapay.com/docs/p2p/apply — dos intentos cada 60 segundos.
- https://www.qvapay.com/docs/p2p/list — 25 consultas/minuto en la sección de límites; listado cacheado.
- https://www.qvapay.com/docs/p2p/stream — stream en vivo y webhook con cola/reintentos.
- https://docs.docker.com/reference/cli/docker/buildx/prune/ — selección de registros por descripción, uso y compartición.
- https://docs.docker.com/reference/cli/docker/image/prune/ — eliminación de imágenes dangling filtradas por etiqueta.
