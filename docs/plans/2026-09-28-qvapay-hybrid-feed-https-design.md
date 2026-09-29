# Diseño: HTTPS y feed híbrido de QvaPay

## Objetivo

Publicar QvaApply en `https://honux.tech` y reducir al mínimo la latencia entre
la aparición de una oferta P2P y su evaluación. El stream SSE será el camino
rápido y el webhook firmado actuará como respaldo durable ante desconexiones.
El sondeo existente seguirá disponible como modo de contingencia.

## Publicación HTTPS

Nginx terminará TLS para `honux.tech`, redirigirá HTTP a HTTPS y mantendrá la
aplicación enlazada exclusivamente a `127.0.0.1:8782`. Certbot emitirá el
certificado con `gonzalezreyesadriano@gmail.com` y dejará activa la renovación
automática. La configuración conservará `Host`, dirección del cliente y
protocolo original, limitará el cuerpo del webhook y añadirá HSTS una vez que
TLS esté activo.

La activación será reproducible desde GitHub Actions usando las credenciales
SSH del entorno `production`; no se copiarán llaves ni secretos al repositorio.
La comprobación posterior exigirá redirección desde HTTP, certificado válido,
respuesta HTTPS del panel y disponibilidad del endpoint del feed.

## Fuente híbrida

El modo actual `webhook` evolucionará a `hybrid` manteniendo compatibilidad con
la configuración persistida. En este modo:

1. un cliente SSE abre `https://api.qvapay.com/v2/p2p/stream` con `app-id` y
   `app-secret`;
2. los eventos `p2p.created` y `p2p.reopened` entran inmediatamente en la misma
   bandeja durable que usa el webhook;
3. el webhook público acepta esos mismos eventos, valida firma y timestamp, y
   cubre los periodos en los que el stream esté desconectado;
4. la clave `event + data.uuid` hace idempotente la recepción por ambos canales;
5. un único procesador entrega ofertas abiertas al motor de oportunidades y
   conserva todas sus protecciones de riesgo, liquidez e intenciones durables.

Los eventos de stream usarán el mismo payload documentado para el webhook. El
cliente ignorará `init` y keepalives, registrará la expiración de la suscripción
y reconectará con espera acotada y variación aleatoria. Una respuesta HTTP 401
o 402 no provocará un bucle agresivo: dejará un estado operativo visible y
reintentará con una cadencia larga.

## Credenciales y configuración

El `app-id`, el `app-secret` y el secreto de firma del webhook se introducirán
desde el panel autenticado. Los secretos se cifrarán con `LOCAL_ENCRYPTION_KEY`
y nunca volverán al navegador, a logs ni a auditorías. El estado público solo
indicará si están configurados, la conexión del stream, la última recepción y
el último error saneado.

No se activará el modo híbrido hasta que estén guardadas las tres piezas. La
compra de la suscripción y la obtención de credenciales permanecen como una
acción explícita del propietario en QvaPay; QvaApply no efectuará cargos.

## Interfaz y operación

**Estrategia → Fuente de mercado** ofrecerá `Sondeo` y `Tiempo real`. La segunda
opción configurará el modo híbrido, mostrará la URL copiable del webhook y
campos independientes para las credenciales de app y el secreto de firma. La
interfaz explicará que QvaPay debe enviar `p2p.created` y `p2p.reopened`.

El runtime iniciará o detendrá el stream al cambiar el modo sin reiniciar el
proceso. El drenaje periódico de la bandeja seguirá siendo la recuperación ante
reinicios. Volver a sondeo detendrá SSE e ignorará eventos pendientes, pero no
borrará credenciales.

## Verificación

Las pruebas cubrirán parsing SSE fragmentado, keepalives, reconexión, errores de
autenticación/suscripción, no exposición de secretos, eventos reabiertos y
deduplicación entre stream y webhook. Se conservarán las pruebas de firma,
timestamp, persistencia y conmutación existentes. Antes de desplegar se
ejecutarán `pnpm check` y los smoke tests aplicables; después se validarán HTTPS,
certificado, redirección, salud y rechazo de webhooks sin firma.

