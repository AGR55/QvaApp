# QvaApply Android (APK privada)

Aplicación Kotlin con Jetpack Compose Material 3 para consultar operaciones,
avisos y resultados de comprobantes SMS, además de ejecutar acciones permitidas
por el servidor. Requiere Android 8.0 o posterior. Los datos se consultan por
HTTPS; la interfaz conserva una copia cifrada de lectura y la identifica como
desactualizada cuando no puede confirmar una actualización.

Operaciones y avisos se consultan cada 5 segundos mientras la app está en primer
plano. Los resultados de SMS se consultan aproximadamente cada 30 segundos. Los chats disponen de un canal push independiente mediante Firebase; su entrega depende de la conexión y los permisos de Android.

## Interfaz y herramientas

- **Inicio:** saldo QUSD con fecha de origen, pendientes, conexión y accesos.
- **Operaciones:** búsqueda local, filtros de compra/venta y pendientes, detalle,
  copia de ID y acciones protegidas. QUSD e importe fiat se muestran por separado.
- **Avisos:** pagos y conciliaciones primero; resultados SMS con estado legible.
- **Herramientas:** capital fiat, límites y estado de cacerías (lectura), salud,
  diagnóstico de 24 horas, historial paginado, rentabilidad 7/30/90 días y
  simulación local de precios. No se modifican límites ni saldos al consultar.
- **Ajustes:** temas Sistema/Claro/Oscuro, tokens independientes y cola SMS.

La identidad Preciso se conserva en el icono adaptativo y la interfaz. La barra
flotante usa transparencias y bordes suaves, sin desenfoque continuo. Los
importes y las acciones usan superficies legibles. Las herramientas cargan al
abrirse o al solicitar actualizar; no añaden llamadas a QvaPay. La rentabilidad
móvil limita sus entradas a 1.000 ofertas y 1.000 transacciones, señalando una
muestra parcial cuando corresponde. Diagnóstico y simulación conservan el
límite de 5.000 observaciones. La caché de herramientas conserva como máximo 24
entradas y se elimina al cambiar de servidor o de token de operador.

La versión release reduce código y recursos con R8 y usa Security Crypto 1.1.0
estable manteniendo el formato cifrado anterior. Los datos locales quedan
excluidos de copias y transferencias entre dispositivos; las actualizaciones
con la misma firma conservan los datos dentro de la instalación.

Las vistas con datos sintéticos viven exclusivamente en `src/debug` y no
forman parte de la APK release. No muestran ni ejecutan operaciones reales.

## Compilar

Abrir `android/` en Android Studio con Android SDK 35 y JDK 17, o ejecutar
`gradle :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` con Gradle 8.11.1 o posterior.
No se incluye Gradle Wrapper. Los APK se generan en
`app/build/outputs/apk/debug/`. El flujo GitHub Actions «Android SMS APK» genera
el APK de depuración y, en pushes a `main` o ejecuciones manuales, una release
privada firmada con la clave guardada en los secretos del repositorio. Las
solicitudes de cambio solo construyen la versión de depuración.

La versión actual es 0.3.0 (`versionCode` 5). Las actualizaciones conservan las
preferencias cifradas y la cola SQLite al instalarse sobre la misma app con la
misma firma. La copia local de la clave está en `android/.private-signing/`,
excluida de Git; cambiarla puede impedir la actualización y obligar a reinstalar.
Para compilar una release local, define `QVAAPPLY_ANDROID_KEYSTORE_PATH` y
`QVAAPPLY_ANDROID_KEYSTORE_PASSWORD`, y ejecuta `gradle :app:assembleRelease`.

## Vincular y configurar

1. En el portal, crea una credencial de dispositivo para comprobantes SMS y una
   credencial de operador móvil independiente para consultar y ejecutar acciones.
2. En Ajustes/SMS, guarda la URL HTTPS y ambos tokens. No introduzcas la
   contraseña web en la app.
3. Permite `RECEIVE_SMS`. Los emisores aceptados son fijos: `PAGOxMOVIL` para
   bancos y `ETECSA` para telefonía; ya no hay campos para introducir emisores.
4. Las acciones disponibles dependen del estado de la operación que entrega el
   servidor. Cada acción pide confirmar la identidad con las credenciales del
   dispositivo, además de una confirmación explícita; marcar pagado también
   requiere una referencia. Cancelar la autenticación no envía la acción. Una
   respuesta de red incierta bloquea el reenvío desde la app hasta que una
   consulta confirme el cambio.

Comprueba primero con ejemplos sintéticos y luego con una transferencia real
pequeña. La app se verifica en Android 16 y se actualiza en el Redmi conectado conservando su vinculación. El flujo completo
con una transacción real requiere backend compatible y verificación controlada.

## Comprobantes SMS

`POST /api/mobile/payment-receipts` usa el token de dispositivo en `Authorization:
Bearer <device token>`. Los comprobantes bancarios requieren encabezado conocido
(BPA, Banco Metropolitano, BANDEC o FINCIMEX/Clásica), beneficiario enmascarado,
importe, moneda, hora e ID real de transacción. Un encabezado desconocido se
descarta para revisión manual; la app nunca envía el texto completo del SMS, el
saldo ni la comisión.

Para una transferencia saliente ETECSA, la app envía `bank`, `sender` y `market`
como `ETECSA`, el importe CUP, el teléfono destinatario exacto,
`beneficiaryMasked: ""`, `receiptKind: "outgoing"` y la hora local de recepción.
Omite `transactionId`: el servidor genera una referencia interna estable
`SMS-ETECSA-…`, que no representa un ID emitido por ETECSA. Los avisos entrantes
«Usted ha recibido» no se tratan como pagos salientes.

La cola local persiste antes del envío y conserva los comprobantes pendientes al
actualizar la app. El servidor comprueba las coincidencias; datos ambiguos o
incompletos quedan en revisión y no marcan una operación como pagada.

## Pruebas y límites de verificación

`app/src/test` cubre parser y serialización del contrato para BPA, Metropolitano,
BANDEC, FINCIMEX y ETECSA, incluidos SMS entrantes, saldos y casos incompletos.
Ejecuta `gradle :app:testDebugUnitTest` desde `android/`. El APK instalado, el
tamaño de release, los avisos con la app cerrada y el recorrido end-to-end en un
dispositivo deben verificarse en un entorno con JDK 17 y Android SDK 35.


## Contrato nativo adicional

El token revocable de operador con alcance de lectura autoriza:

- `GET /api/mobile/overview`: proyección local de saldo, fiat y cacerías.
- `GET /api/mobile/insights?kind=health|profitability|history|diagnostics`:
  parámetros validados `coin`, `page` y `days`, según la herramienta.
- `POST /api/mobile/simulate`: entrada `coin`, `hours`, `buyMaxRate`,
  `sellMinRate` y `maxQusd`; es una consulta sin mutación financiera.

Estos permisos no abren rutas de administración web. Las acciones monetarias
conservan el alcance independiente de acciones y la intención durable anterior.
Si además se envía una cookie web en un POST, siguen siendo necesarios Origin y
CSRF. Nunca pruebes acciones reales usando los fixtures de depuración.

## Conversaciones y notificaciones (0.3.0)

El listado **Operaciones** reúne el registro del bot y el catálogo verificado de QvaPay. Identifica cada orden por separado y permite abrir su conversación desde el detalle. Las acciones monetarias se mantienen únicamente en operaciones gestionadas por el bot con coincidencia exacta de oferta y orden; las demás se gestionan en QvaPay.

En **Operaciones → Mensajes** aparecen operaciones normales y cada orden por rango, propias y tomadas. Cada orden mantiene su historial, contador y borrador. El envío no se repite automáticamente si el resultado es incierto: actualiza y comprueba la conversación primero.

Los avisos utilizan Firebase Cloud Messaging, no un servicio permanente del teléfono. Activa el permiso de notificaciones en esa sección. El aviso incluye remitente, texto y referencia, y abre la orden exacta. Se respeta la privacidad que tengas configurada en la pantalla bloqueada. Android puede impedir la entrega tras forzar la detención de una app; vuelve a abrirla para reactivar la recepción.

La configuración pública `app/google-services.json` identifica el proyecto Firebase QvaApply. No contiene la credencial del servidor. La VPS requiere `QVAAPPLY_FCM_CREDENTIALS_FILE` apuntando al JSON protegido de una cuenta dedicada con rol `roles/firebasecloudmessaging.admin`. En el despliegue Docker puede guardarse como `/opt/qvaapply/data/fcm-service-account.json`, propietario 1000, modo 0400, y usar la ruta `/app/data/fcm-service-account.json`. No incorporar ese JSON a ningún artefacto, APK, repositorio o registro.

El servidor conserva pendientes y entregas por dispositivo; revocar un operador elimina su registro push. La sincronización de chats tiene una cola propia, hasta ocho streams activos y consultas de respaldo acotadas. Ni las notificaciones ni la lectura de mensajes ejecutan movimientos de fiat o acciones de cacería.
