# Conversaciones por orden y notificaciones Android

## Diseño aprobado

El usuario aprobó Firebase y el siguiente alcance el 23 de octubre de 2026: operaciones y conversaciones normales y por rango, tanto propias como tomadas; identidad oferta + orden; notificaciones con remitente, texto y referencia que abren el chat correcto; persistencia y deduplicación; notificaciones web; sincronización separada de las cacerías.

La app 0.2.0 ya se instaló conservando datos en el teléfono Android 16 conectado. Carece de canal de notificaciones y de integración FCM. El chat web actual solo descubre registros de la tabla financiera `operations`, cuya clave es la oferta. Las órdenes de ofertas propias se concilian en el libro de fiat pero no producen esos registros: no deben crearse artificialmente para mostrar chats.

## Arquitectura

- Proyección persistente de conversaciones con clave compuesta oferta/orden. Se alimenta de operaciones existentes y de las ofertas y órdenes verificadas durante la sincronización de cuenta. No cambia el libro de fiat ni ejecuta mutaciones monetarias.
- Caché, lectura, errores y cursores por conversación. Máximo 100 mensajes por chat. Migración compatible del chat anterior. Validación de pertenencia antes de consultar o enviar; nunca aceptar una orden arbitraria del cliente.
- Sincronización acotada y con exclusión propia, sin ocupar la cola de captura. Reutilizar descubrimiento y detalles ya consultados, con lecturas de chats limitadas. Aislar recursos HTTP de chat cuando la implementación de transporte lo permita.
- Entrega persistente por mensaje y dispositivo; deduplicación en servidor y teléfono. Una primera lectura establece una base histórica, sin inundar el móvil con mensajes antiguos. Los mensajes posteriores pendientes sobreviven a reinicios.
- FCM HTTP v1 desde el servidor, credencial protegida fuera del repositorio. Android registra su token mediante autenticación de operador; errores y tokens revocados no detienen ninguna cacería. No se requiere Analytics ni facturación.
- Android solicita permiso de notificaciones cuando corresponde, muestra remitente/texto/referencia y abre la conversación exacta. No usa un servicio permanente ni consulta QvaPay directamente. El usuario puede responder desde la conversación; los envíos inciertos no se repiten automáticamente.
- Web incorpora el catálogo de conversaciones, las órdenes y su lectura, manteniendo las acciones financieras existentes únicamente en sus contextos válidos.

## Seguridad y límites

No incluir claves privadas ni credenciales de QvaPay en APK, Git, registros o notificaciones. La configuración pública Android de Firebase puede distribuirse. Vincular dispositivos a su cuenta de operador; no registrar tokens anónimamente. Recortar cargas y tiempos de espera. Respetar el ajuste de privacidad de la pantalla bloqueada. El cierre forzado y la falta de conectividad pueden impedir la entrega inmediata y deben describirse sin prometer garantías absolutas.

La creación del proyecto Firebase está autorizada. Si la consola exige aceptar términos o generar acceso sensible, se solicita confirmación en ese paso según la política del navegador.

## Plan de implementación

La skill `writing-plans` no está instalada; este plan explícito cubre la transición requerida.

1. Persistir catálogo de conversaciones y reutilizar descubrimiento de órdenes; pruebas de dos órdenes de una misma oferta, roles y operaciones comunes.
2. Adaptar caché, lectura y envío a identidad compuesta; mantener compatibilidad con rutas existentes y no repetir POST inciertos.
3. Añadir rutas autenticadas y presentación web y Android; enlaces exactos y mensajes pendientes.
4. Configurar Firebase, integrar registro de dispositivos y entrega durable acotada; aislar fallos y deduplicar.
5. Añadir permiso, canal y representación de notificaciones Android, registro/rotación del token y apertura del chat.
6. Verificar pruebas relevantes, comprobación del servidor, lint y APK firmado. Instalar actualización conservando datos y verificar en Android 16 con un aviso de prueba propio, sin escribir a contrapartes.
7. Desplegar únicamente los commits de esta funcionalidad sobre producción y comprobar salud, sincronización y cacerías.

## Criterios de aceptación

Cada orden tiene chat independiente, incluida una oferta propia con varias órdenes. Los mensajes entrantes nuevos producen avisos con texto, sin mezclar órdenes ni notificar mensajes propios. Leer en web o Android elimina el contador de esa conversación, no de otras. Reinicios no pierden pendientes ni duplican avisos visibles. FCM indisponible no bloquea operaciones ni cacerías. El APK conserva firma y datos. La entrega con app cerrada se verifica cuando la configuración externa esté disponible.
