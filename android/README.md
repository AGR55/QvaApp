# QvaApply Android (APK privada)

Aplicación Kotlin con Jetpack Compose Material 3 para consultar operaciones,
avisos y resultados de comprobantes SMS, además de ejecutar acciones permitidas
por el servidor. Requiere Android 8.0 o posterior. Los datos se consultan por
HTTPS; la interfaz conserva una copia cifrada de lectura y la identifica como
desactualizada cuando no puede confirmar una actualización.

Operaciones y avisos se consultan cada 5 segundos mientras la app está en primer
plano. Los resultados de SMS se consultan aproximadamente cada 30 segundos. No
hay un canal push de fondo verificado; no se garantiza la entrega de avisos con
la app cerrada.

## Compilar

Abrir `android/` en Android Studio con Android SDK 35 y JDK 17, o ejecutar
`gradle :app:testDebugUnitTest :app:assembleDebug` con Gradle 8.11.1 o posterior.
No se incluye Gradle Wrapper. Los APK se generan en
`app/build/outputs/apk/debug/`. El flujo GitHub Actions «Android SMS APK» genera
el APK de depuración y, en pushes a `main` o ejecuciones manuales, una release
privada firmada con la clave guardada en los secretos del repositorio. Las
solicitudes de cambio solo construyen la versión de depuración.

La versión actual es 0.1.2 (`versionCode` 3). Las actualizaciones conservan las
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
pequeña. La app no se ha instalado ni validado en el Redmi; el flujo completo
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
