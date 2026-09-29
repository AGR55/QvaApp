# Diseño: fuente de mercado por webhook de QvaPay

## Objetivo

Permitir alternar desde el panel entre el listado periódico actual (`polling`) y
el feed P2P firmado de QvaPay (`webhook`). El webhook debe reducir la latencia
entre la publicación de una oferta y su evaluación sin relajar las protecciones
de riesgo ni exigir una nueva entrega de código cuando se contrate la
suscripción.

## Fuente y conmutación

La aplicación conservará una única fuente activa. `polling` seguirá siendo el
valor inicial y usará las cuentas lectoras existentes. En `webhook`, el
planificador dejará de listar ofertas y procesará los eventos `p2p.created` que
lleguen al endpoint público. El cambio será persistente e inmediato desde
**Estrategia → Fuente de mercado**.

Volver a polling no eliminará el secreto ni la configuración del feed. Los
eventos recibidos mientras polling esté activo se validarán y reconocerán, pero
no dispararán operaciones.

## Recepción durable y seguridad

El endpoint será:

`POST https://qvapply.honux.tech/webhooks/qvapay/p2p-feed`

La ruta no usará la sesión del panel. Su autenticación será exclusivamente la
firma `x-qvapay-signature`: HMAC-SHA256 calculado sobre el cuerpo JSON crudo con
el secreto propio del feed. También exigirá `x-qvapay-timestamp` dentro de una
ventana de cinco minutos y aplicará comparación constante.

El receptor validará un tamaño pequeño, JSON estricto y los campos mínimos de
la oferta. Persistirá cada evento con la clave `event + uuid` antes de responder
`202`, de modo que las entregas repetidas sean inocuas y un reinicio no pierda
trabajo aceptado. Firmas inválidas, timestamps vencidos y cuerpos inválidos se
rechazarán con `401` o `400` sin registrar secretos.

El secreto se introducirá desde el panel, se cifrará con `LOCAL_ENCRYPTION_KEY`
y nunca regresará al navegador. El estado público solo indicará si está
configurado.

## Procesamiento

Un procesador en memoria se despertará justo después de aceptar el evento y un
trabajo periódico servirá de recuperación. Solo `p2p.created` se convertirá en
una actualización de mercado. La oferta conservará el mismo camino de
clasificación, límites, liquidez, mutaciones durables y notificaciones que usa
polling. Eventos desconocidos o estados que no estén abiertos quedarán
registrados como ignorados.

El feed entrega los datos necesarios para competir sin una lectura previa de
detalle. Las respuestas definitivas de QvaPay al intentar aplicar seguirán
siendo la autoridad final y los rechazos conservarán el tratamiento existente.

## Interfaz y operación

La tarjeta de fuente de mercado mostrará dos opciones, la URL copiable, secreto
configurado, última entrega, último procesamiento, pendientes y último error.
No permitirá activar webhook hasta guardar un secreto. Un cambio de modo y una
rotación de secreto quedarán auditados.

Al contratar el feed, el operador solo tendrá que copiar la URL, seleccionar
`p2p.created` en QvaPay, pegar el secreto mostrado por QvaPay y activar webhook.

## Verificación

Se cubrirán firma válida e inválida, ventana temporal, payload y tamaño,
idempotencia, persistencia, eventos recibidos en modo inactivo, procesamiento
inmediato, recuperación periódica, detención de polling, conmutación HTTP y no
exposición del secreto. Finalmente se ejecutarán `pnpm check` y el smoke visual.
