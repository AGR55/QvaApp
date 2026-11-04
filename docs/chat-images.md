# Imágenes de chat Android/backend

## Contrato verificado

Documentación oficial consultada el 28 de octubre de 2026:
https://www.qvapay.com/docs/p2p/chat

QvaPay documenta POST multipart al chat, campo `file`, texto `message` opcional
de hasta 599 caracteres, JPG/PNG/GIF y redimensionado máximo 1000×1000.
Las conversaciones por orden usan `?order=...`.
No documenta en esa página límite en bytes, idempotencia upstream, reanudación,
porcentaje remoto ni el formato/origen/autenticación de descarga de `image`.

## API local nueva

Ambos prefijos `/api/mobile/operations/:uuid/chat` y
`/api/operations/:uuid/chat` conservan GET y POST de texto existentes.

- POST `/images?order=...`: multipart con un `file` JPEG/PNG, `message` opcional
  y `attemptId` obligatorio (16–80 caracteres alfanuméricos, guion o guion bajo).
  Límite **local**: 1 MiB por imagen, máximo 1000×1000; cuerpo completo limitado
  a 1 MiB + 16 KiB. GIF no se transmite: Android lo convierte a imagen estática.
- POST de texto acepta `attemptId` opcional para clientes antiguos. Android
  siempre lo envía. El contrato web anterior sigue siendo válido, pero sus
  solicitudes sin identificador no reciben deduplicación durable adicional.
- GET `/sends/:attemptId?order=...`: `data.state` es `not_found`, `uncertain`,
  `rejected` o `confirmed`; puede incluir `data.id` remoto.
- GET `/images/:messageId?order=...`: devuelve binario JPEG/PNG con `no-store`.
  Requiere pertenencia a la conversación y un mensaje de la caché del servidor;
  nunca acepta una URL de descarga en la petición del cliente.

Bearer móvil con permiso de acciones para subir y de lectura para consultar.
Sesión web conserva Origin y CSRF también con multipart y con cookie+Bearer.
No se amplía el límite JSON global ni se añade UI web.

## Seguridad y límites de descarga

Se preserva el campo remoto `image`, incluido junto a un texto. La descarga
admite únicamente HTTPS, sin usuario, puerto alternativo, query ni fragmento,
en `www.qvapay.com` o `api.qvapay.com`, bajo `/storage/` y con extensión JPEG/PNG.
No sigue redirecciones ni adjunta credenciales QvaPay. Lectura acotada a 1 MiB,
12 segundos y validación de firma, tipo y dimensiones. Esta lista es una
restricción defensiva local, **no una afirmación del contrato real de descarga**.
Referencias relativas, privadas, firmadas, GIF o CDN diferentes muestran
placeholder hasta verificar un ejemplo autorizado. No se probaron descargas
reales ni envíos a contrapartes. Validación de cabeceras/dimensiones no equivale
a un escaneo antimalware ni a decodificar completamente el archivo en backend.

## Android y recuperación

`ChatScreen(settings, foreground, target, onTarget)` sigue funcionando.
También admite `initialTarget = ...`; el llamador conserva la navegación y
recibe `onTarget(null)` al volver. Con destino concreto no consulta el catálogo
ni registra push. No muestra banners ni solicita permisos de notificaciones.

La selección no requiere conexión. Original máximo 16 MiB y 80 megapíxeles;
decodificación muestreada, corrección EXIF, lado mayor ≤1000, JPEG sin metadatos
originales, calidad decreciente con objetivo 512 KiB y máximo 1 MiB.
El porcentaje indica exclusivamente Android → servidor; al terminar muestra
espera de confirmación QvaPay, no un porcentaje remoto inventado.

El adjunto pendiente y las imágenes vistas se guardan cifrados AES-GCM con clave
Android Keystore en caché privada, separada por servidor/operador. Máximo 48
archivos / 24 MiB, limpieza por antigüedad a 30 días al escribir. Android puede
eliminar la caché: no se promete conservación indefinida del adjunto. El texto y
el identificador usan las preferencias cifradas existentes. No se guarda el
original. Sin conexión se conserva el borrador y se muestra snackbar.

Antes del despacho se persiste intento en servidor; mismo identificador y
contenido confirmado devuelve confirmación sin otro POST. Contenido diferente
con el mismo identificador da conflicto. Intento concurrente, fallo remoto 5xx,
respuesta inválida, timeout o reinicio durante envío quedan bloqueados. Un 4xx
definitivo (excepto 409) permite reintentar. No se reintenta automáticamente
ningún POST upstream. Los registros de intento se conservan como tombstones:
no se purgan automáticamente para no reabrir envíos antiguos.

Tras incertidumbre, «Comprobar envío» solo consulta estado e historial. `not_found`
no demuestra que una petición anterior no vaya a llegar: tampoco desbloquea.
Sin idempotencia/consulta de resultado upstream documentada, un envío incierto
sin confirmación local requiere conciliación humana; no se promete exactamente
una entrega ni se ofrece reenvío ciego. Una descarga fallida sí se puede repetir.

`MobileApi.action` conserva un único POST, connect timeout 10 s, read timeout
55 s. Solo UnknownHost/ConnectException antes de enviar cuerpo son fallos de
conexión seguros; después del primer intento de escritura son inciertos.
`QvaActionTiming` registra únicamente acción, duración monotónica y resultado;
no contiene UUID, referencia, texto ni tokens.

## Verificación

Pruebas focalizadas de contrato upstream/local, multipart, auth/CSRF, tamaños,
SSRF, pertenencia, identidad por orden, concurrencia, reinicio y deduplicación.
Pruebas JVM adicionales del clasificador antes/después del despacho y del
valor por defecto de `MobileOperation.market`.
La verificación integrada de APK, lint y pruebas está documentada en
`mobile-redesign-report.md`. No hay dispositivo conectado; quedan pendientes
selección/EXIF, lectura cifrada, progreso y pérdida de red en un teléfono real.
Los orígenes de descarga no documentados no se habilitan a ciegas.
Escala visual del chat: espaciado 4/8/12/16, radios 8/12 y padding simétrico
de 12 en mensajes compactos. El backend de imágenes debe desplegarse junto
con esta versión Android; la APK sola no añade rutas a un servidor antiguo.
