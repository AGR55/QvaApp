# QvaApply Android (APK privada)

Aplicación Kotlin con Jetpack Compose Material 3 para consultar operaciones,
avisos y resultados de comprobantes SMS, además de ejecutar acciones permitidas
por el servidor. Requiere Android 8.0 o posterior. Los datos se consultan por
HTTPS; la interfaz conserva una copia cifrada de lectura y la identifica como
desactualizada cuando no puede confirmar una actualización.

Operaciones y avisos se consultan cada 5 segundos mientras la app está en primer
plano (15 segundos al conversar), con espera creciente hasta 80 segundos cuando
falla la actualización y sin peticiones de refresco al no haber red disponible.
Los resultados de SMS se consultan aproximadamente cada 30 segundos. Los chats
disponen de un canal push independiente mediante Firebase; su entrega depende
de la conexión, del interruptor local y de los permisos de Android.

## Interfaz y herramientas

- **Inicio:** saldo QUSD con fecha de origen, pendientes y accesos.
- **Operaciones:** búsqueda local, filtros de compra/venta y pendientes, detalle,
  copia de ID y acciones protegidas. QUSD e importe fiat se muestran por separado.
- **Avisos:** filas compactas, pagos y conciliaciones primero; descarte local
  deslizando con animación, deshacer y alternativa accesible. Ocultar un aviso
  no resuelve la operación ni acusa recepción global en el servidor.
- **Herramientas:** capital fiat, límites y estado de cacerías (lectura), salud,
  diagnóstico de 24 horas, historial paginado, rentabilidad 7/30/90 días y
  simulación local de precios. No se modifican límites ni saldos al consultar.
- **Ajustes:** temas Sistema/Claro/Oscuro, interruptor de notificaciones,
  tokens independientes y cola SMS. Silenciar no afecta QvaPay ni los avisos
  dentro de QvaApply; cancela las notificaciones visibles y solicita la baja
  del registro push cuando vuelve la red. Reactivar respeta el permiso Android.

La identidad Preciso se conserva en el icono adaptativo. La interfaz usa
superficies Material 3 planas, escala 4/8 dp, iconos outline y chevrons locales
(ver `THIRD-PARTY-NOTICES.md`). En modo Sistema, Android 12+ aporta color dinámico.
Los logos originales de mercado y QUSD se empaquetan desde `public/icons`
durante la compilación mediante Python 3, sin descarga en ejecución; un mercado
desconocido usa un pictograma local neutro. Se conservan los PNG originales y
se extrae el raster embebido en los SVG de ETECSA/Zelle, evitando su recorte.
La navegación reúne Inicio, Operaciones, Herramientas y Ajustes; los avisos se
abren desde la campana. La barra superior integra búsqueda local, sin logo,
nombre de sección ni indicador permanente de conexión. Una acción sin red
muestra un snackbar y conserva el estado.
El detalle usa un sheet ajustado al contenido y la conversación se abre dentro
de la operación, manteniendo el regreso al detalle y las notificaciones por orden.
El compositor acepta imágenes comprimidas, muestra progreso hacia el servidor
y conserva el borrador ante fallos. Véanse los límites de descarga y los envíos
inciertos en `../docs/chat-images.md`. Las opciones de vinculación y SMS se
despliegan bajo demanda. Las herramientas cargan al
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

### Laboratorio aislado de pagos asistidos

`gradle :app:testDebugUnitTest :app:testLabUnitTest :app:lintLab :app:assembleLab`
genera `app/build/outputs/apk/lab/app-lab.apk`, con identificador separado
`com.qvaapply.sms.lab`. Se instala junto a la app habitual y abre **QvaApply ·
Laboratorio**. No sustituye su vinculación ni sus datos. La variante lab elimina
los permisos de Internet, estado de red, recepción SMS y notificaciones, además
de la actividad operativa, el receptor SMS y la inicialización Firebase. No usa
la configuración de Google Services de producción.

El laboratorio usa destinos `DEMO-…`, sin números de cuentas o teléfonos reales,
y nunca pide claves. **Aceptar simulación** solo cambia su estado local. Cada
banco se autentica por separado; hay que confirmar la desconexión del anterior
antes de autenticar otro. Puedes dejar esperando la respuesta más de un minuto
para representar congestión y simular incertidumbre: esta bloquea reenvíos hasta
una comprobación explícita ficticia. Ninguna espera genera reintentos automáticos.
La máquina de estados conserva su estado al recrear la actividad.

Los controles de respuesta se habilitan a los cinco segundos. La sesión ETECSA
es independiente de las sesiones bancarias y no se introduce su clave de saldo.
El simulador no comprueba tiempos ni garantías del proveedor real.

Los archivos de laboratorio viven en `src/debug`, se comparten con `lab` y no
se incluyen en release. Sus pruebas puras están en `src/testDebug`. Para revisar
el compositor con datos sintéticos en la instalación aislada:

```bash
adb shell am start -n com.qvaapply.sms.lab/com.qvaapply.sms.PreviewActivity --es screen conversation
```

El laboratorio puede abrir **Probar pago desde una operación**, con datos ficticios.
No ejecuta códigos USSD ni abre Transfermóvil.

### App habitual

El detalle de compras tomadas elegibles incorpora **Realizar pago**. Requiere el
backend con `/api/mobile/operations/:uuid/payment-preview` y un operador con
permiso de acciones. La preparación consulta la oferta actual y muestra tarjeta,
móvil e importe; después de autorizar con Android vuelve a comprobarlos.

En la release 0.6.0 solo está disponible la revisión de datos: el usuario realiza
la transferencia manualmente. `PAYMENT_FORM_ENABLED=false` y el manifest release
elimina el servicio de accesibilidad. No se puede activarlo desde Ajustes.
El rellenado permanece en debug para completar la prueba controlada pendiente.

El asistente experimental **QvaApply · Rellenar Transfermóvil**, en Accesibilidad de debug,
está limitado al paquete y versión 1.260416 de Transfermóvil. Rellena datos y
puede abrir una sola vez la primera revisión bancaria descrita por el operador;
se detiene antes de su confirmación final. ETECSA se detiene antes de ACEPTAR.
El usuario revisa cuenta de origen, moneda e importe y autoriza en Transfermóvil.
No introduce claves ni construye códigos USSD. La autenticación
y desconexión del banco siguen manuales en esta fase. Su recorrido completo real
requiere todavía una prueba de rellenado controlada; no se activó por ADB.
Véase `../docs/plans/2026-11-03-operation-payment-handoff.md`.

Abrir `android/` en Android Studio con Android SDK 35 y JDK 17, o ejecutar
`gradle :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` con Gradle 8.11.1 o posterior.
No se incluye Gradle Wrapper. Los APK se generan en
`app/build/outputs/apk/debug/`. El flujo GitHub Actions «Android SMS APK» genera
el APK de depuración y, en pushes a `main` o ejecuciones manuales, una release
privada firmada con la clave guardada en los secretos del repositorio. Las
solicitudes de cambio solo construyen la versión de depuración.

La versión actual es 0.6.0 (`versionCode` 8). Las actualizaciones conservan las
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
