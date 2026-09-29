# Plan de implementación: HTTPS y feed híbrido de QvaPay

1. Generalizar la bandeja durable para que webhook y stream inserten eventos
   con una clave idempotente común y acepten `p2p.created` y `p2p.reopened`.
2. Implementar un cliente SSE con `fetch`, parsing incremental, cancelación,
   reconexión acotada y estados operativos sin añadir una dependencia externa.
3. Extender el coordinador de mercado para gestionar el ciclo de vida del
   stream y guardar cifradas las credenciales de app.
4. Ampliar la API autenticada y la tarjeta Fuente de mercado para configurar el
   modo de tiempo real sin exponer secretos.
5. Añadir pruebas unitarias, HTTP, runtime y regresión de interfaz para stream,
   deduplicación cruzada, reaperturas y saneamiento de errores.
6. Endurecer y automatizar la configuración Nginx/Certbot para `honux.tech`,
   incluyendo una acción manual reproducible de producción.
7. Actualizar la guía operativa con contratación, eventos, secretos y pruebas
   posteriores a la activación.
8. Ejecutar `pnpm check`, desplegar `main`, activar TLS y verificar el servicio
   público antes de habilitar el feed en QvaPay.
