# Diseño: avisos de ofertas bloqueadas y normalización de Peer

## Objetivo

Avisar una sola vez por cada oferta bloqueada nueva tanto dentro de QvaApply como mediante una notificación del sistema cuando la pestaña no esté abierta, y permitir revisar la oferta desde el aviso. Corregir además el rechazo de ofertas abiertas cuando QvaPay representa `Peer` con un valor vacío distinto de `null`.

## Experiencia de usuario

- La cabecera mostrará un control compacto para activar, revisar o diagnosticar los avisos.
- La activación solicitará permiso explícito del navegador y registrará una suscripción Web Push.
- Con QvaApply visible, una tarjeta flotante mostrará mercado, lado, importe, tasa, mediana y motivo. Permitirá ir a Auditoría o cerrar el aviso.
- Sin una página visible, el service worker mostrará una notificación del sistema. Al pulsarla abrirá QvaApply en Auditoría.
- El aviso interno reproducirá un tono breve después de que el usuario haya activado la función. La notificación externa solicitará el sonido normal del sistema operativo; su reproducción final depende del navegador y del sistema.
- Una oferta no se volverá a avisar durante cada escaneo. Si cambia su precio o motivo y vuelve a quedar pendiente, se considerará una nueva versión notificable.
- Si Push no está disponible o se deniega el permiso, los avisos internos continuarán funcionando.

## Arquitectura y datos

- Un servicio de notificaciones del servidor administrará las claves VAPID locales, las suscripciones y el envío Web Push.
- Las rutas de alta y baja de suscripciones estarán protegidas por la sesión local y CSRF.
- El evento se originará en el mismo punto donde el motor detecta por primera vez la oferta bloqueada. Telegram y Web Push serán destinos independientes del mismo aviso.
- Cuando la página esté visible, la actualización local periódica detectará nuevas versiones de alertas y mostrará la tarjeta sin consultar innecesariamente QvaPay.
- El service worker decidirá entre comunicar el evento a clientes visibles o mostrar una notificación del sistema.
- Las suscripciones inválidas o expiradas se eliminarán al recibir las respuestas correspondientes del servicio Push.

## Seguridad y privacidad

- El cuerpo de la notificación incluirá únicamente datos ya visibles en la tarjeta de Auditoría y nunca credenciales, detalles bancarios ni tokens.
- Los endpoints Push se tratarán como URLs de capacidad y se conservarán solo en el almacenamiento local.
- La navegación desde la notificación abrirá exclusivamente la aplicación local y seleccionará Auditoría.

## Corrección de Peer

Para una oferta `open`, `Peer` no interviene en la decisión ni identifica al creador. El parser normalizará cualquier representación vacía de `Peer` a `null` solo en ese estado. `User` seguirá siendo validado y, para estados posteriores a `open`, un `Peer` presente deberá contener un `uuid` válido. Una prueba de regresión cubrirá la respuesta observada y otra garantizará que una identidad inválida en una operación activa continúe siendo rechazada.

## Verificación

- Pruebas unitarias del parser de QvaPay y de deduplicación de avisos.
- Pruebas HTTP para registrar y eliminar suscripciones con sesión y CSRF.
- Prueba del service worker: mensaje a una página visible, notificación cuando no hay cliente visible y navegación a Auditoría.
- Smoke visual de la tarjeta, del control de permiso y de la vista móvil.
- Suite completa, compilación, accesibilidad y escaneo de secretos.
