# SMS de pago y avisos prioritarios en Android

## Objetivo y alcance aprobado

El propietario usa Android y acepta instalar una APK privada. Quiere que QvaApply
extraiga el identificador de los SMS de transferencia de Banco Popular de Ahorro,
Banco Metropolitano y FINCIMEX/Clásica para marcar como pagada una operación
P2P de compra de QUSD. También necesita avisos visibles e inmediatos cuando
alguien toma una oferta propia y cuando el bot toma una oferta ajena. La app
móvil ampliará después las funciones de la web. No se cambian las credenciales
P2P de la cuenta en esta fase.

## Alternativas evaluadas

1. **APK privada que recibe SMS (elegida).** Un receptor Android extrae datos
   concretos, los conserva en una cola local mientras no haya conexión y los
   envía por HTTPS. Se puede convertir después en la app móvil completa.
2. **Compartir manualmente el SMS con la web.** Reduce permisos pero sigue
   exigiendo intervención y no resuelve la demora.
3. **Leer notificaciones de otra app.** Depende de cómo el banco presenta las
   notificaciones y concede acceso a notificaciones ajenas; es menos específico
   que recibir el SMS y complica una futura distribución pública.

## Vinculación y datos

El panel autenticado emite una credencial aleatoria de dispositivo con permiso
exclusivo para entregar comprobantes. El servidor almacena únicamente su hash
y permite revocarla. La APK la recibe durante el emparejamiento; no conoce la
contraseña del panel ni el token de QvaPay.

El teléfono reconoce solo emisores configurados por el propietario y mensajes
que declaren explícitamente que la transferencia se completó. Extrae banco,
moneda, importe, cuenta beneficiaria enmascarada, ID de transacción y hora de
recepción. No sube el SMS íntegro ni el saldo restante. Persiste localmente el
evento antes de transmitirlo y reintenta con conectividad intermitente.

La bandeja SQLite del servidor deduplica por emisor e ID y registra el estado
del procesamiento. El emparejamiento automático exige una única operación
local con pago fiat pendiente, importe y moneda exactos, recepción del SMS
posterior a la operación, y coincidencia del prefijo y sufijo del beneficiario
con la cuenta visible en los `details` de la oferta QvaPay. Se consulta la oferta
remota actual antes de invocar el caso de uso existente `markPaid`, que crea una
intención monetaria durable. Si faltan detalles, hay varios candidatos, la
oferta cambió o QvaPay no confirma el resultado, el comprobante queda para
revisión humana. Nunca se confirma recepción de fiat ni se libera QUSD a partir
de un SMS saliente.

Los ejemplos entregados cubren CUP de Banco Popular de Ahorro y Banco
Metropolitano (`Nro. Transaccion` alfanumérico) y USD de FINCIMEX/Clásica
(`Nro. Transaccion` numérico y comisión separada). El importe a comparar es
`Monto`, sin sumar `Comision`.

## Avisos y experiencia móvil

El feed P2P crea un aviso durable distinto para una oferta propia tomada y otro
para una aplicación hecha por QvaApply. Ambos contienen UUID, mercado e importe,
enlazan directamente a Operaciones y conservan Web Push aunque Telegram falle.
La bandeja de avisos de operación se muestra separada de Logs y requiere
reconocimiento explícito. En la fase de APK, el teléfono recibirá estos avisos
por el canal móvil que se seleccione al integrar notificaciones nativas; Web
Push de la web instalada da una primera vía independiente de Telegram.

## Fases y comprobación

1. Backend: credencial de dispositivo, bandeja de comprobantes, matching
   estricto, endpoint y pruebas de duplicados, importes, monedas, beneficiario,
   carrera de operaciones y fallos remotos.
2. Avisos: detección de aplicaciones a ofertas propias, prioridad visual,
   persistencia y regresiones de Web Push y Telegram.
3. APK Android privada: receptor, parser de los tres SMS, cola local, envío
   autenticado, pantalla de emparejamiento y estado. Probar parser y reintentos;
   construir e instalar en un Android real cuando esté disponible el SDK y el
   dispositivo.
4. Integración: revisar cambios de los subagentes, ejecutar `pnpm check` y
   pruebas Android posibles, probar el flujo con ejemplos sintéticos y después
   con una transferencia pequeña real antes de activar marcado automático.

Las ofertas flexibles, recuperación de entregas, eventos de chat y calificación
se abordarán en fases posteriores. La documentación pública actual de QvaPay
no describe un importe parcial en `POST /p2p/:uuid/apply`; esa capacidad debe
verificarse antes de automatizar ofertas flexibles.

## Referencias

- QvaPay: `GET /p2p/:uuid` muestra `details` a participantes y `POST
  /p2p/:uuid/paid` exige `tx_id`.
- Android: `SMS_RECEIVED_ACTION` para la APK privada; Google Play restringe
  `RECEIVE_SMS` a casos aprobados, por lo que esta fase se distribuye fuera de
  Play.
