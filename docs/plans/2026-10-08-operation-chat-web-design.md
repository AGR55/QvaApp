# Chat de operaciones en la web

## Alcance aprobado

Primera fase con la cuenta actual: leer y responder mensajes de texto de operaciones propias desde la web, sin añadir consultas al camino de decisión o de aplicación P2P. Android, imágenes, calificaciones y diagnóstico remoto del feed quedan para fases posteriores. No se integrará una cuenta ajena para ampliar límites sin autorización expresa de QvaPay.

## Decisión

La vista Operaciones abrirá un panel de conversación bajo demanda. El servidor conservará un historial local acotado por operación y actualizará únicamente chats de operaciones activas mediante un trabajo periódico independiente, con concurrencia baja y tiempo de espera limitado. El navegador podrá mostrar la copia local inmediatamente, su antigüedad, los mensajes nuevos y un control de actualización. Ni la carga del panel ni los avisos entrarán en la cola de `apply`; no se enviarán nuevos avisos de chat a Telegram.

Se descartan por ahora los dos extremos: cargar el chat solo al abrirlo impediría descubrir mensajes mientras el panel está cerrado; mantener un stream por cada operación consumiría conexiones y requiere validar un contrato de eventos que la documentación pública no especifica con detalle.

## Contrato y seguridad

- QvaPay documenta `GET /p2p/:uuid/chat` con una lista `chat` y `POST /p2p/:uuid/chat` con el ID en `message`. El adaptador actual acepta otras formas, pero no esas dos respuestas documentadas. Primero se añadirán pruebas de contrato y se corregirá el adaptador sin romper las variantes ya probadas.
- El servidor solo servirá o enviará chat para una operación asociada a esta cuenta. Los endpoints web seguirán las comprobaciones existentes de sesión, CSRF, validación de UUID y límite de tamaño. El texto se recortará y validará hasta el máximo documentado de 599 caracteres; no se interpretará como HTML.
- El historial local distinguirá mensajes propios, de contraparte y de moderación cuando QvaPay proporcione los campos. Se deduplicará por ID remoto, se limitará la retención y se expondrá la fecha de la última sincronización. Un fallo remoto conservará la copia anterior y la marcará como desactualizada.
- Un POST de chat con respuesta incierta no se reintentará automáticamente. Antes de permitir otro envío del mismo texto, la UI consultará el historial para evitar duplicados; si sigue sin haber evidencia, mostrará el resultado como incierto para decisión humana.

## Integración de interfaz

La tabla de operaciones conservará sus acciones de pago, recepción y cancelación. Una acción «Chat» abrirá el panel contextual, sin cargar todos los historiales al abrir Operaciones. El contador de mensajes no leídos será local por operación y se actualizará al abrir la conversación. Los estados de carga, vacío, error y copia desactualizada usarán los componentes existentes de la web. El chat será texto primero; no se expondrá subida de archivos en esta fase.

## Pruebas y aceptación

Pruebas del adaptador con el JSON documentado y variantes heredadas; pruebas HTTP de autenticación, CSRF, operación ajena, texto inválido, timeout y deduplicación; pruebas del trabajo de sincronización para asegurar que no bloquea `apply` y no borra la copia tras errores; regresión de la vista Operaciones. `pnpm check` y CI deben pasar antes de publicar. No se desplegará una mutación incierta ni se reintentará un chat automáticamente.

## Siguientes fases

1. Diagnóstico de entregas y suscripción del feed, más monitor externo de disponibilidad.
2. Calificación manual tras operaciones completadas.
3. Ofertas flexibles solo después de confirmar con QvaPay el contrato de aplicación parcial.

La cuota de `apply` sigue tratándose como dos solicitudes enviadas cada 60 segundos. La documentación pública no garantiza que únicamente cuenten los éxitos y señala expresamente que una aplicación rechazada por VIP puede gastar un intento.
