# QvaApply SMS Android (APK privada)

Aplicación Kotlin privada para recibir comprobantes bancarios por SMS. Requiere
Android 8.0 o posterior. No incorpora emisores bancarios reales: el propietario
debe introducir manualmente el emisor exacto de cada banco en la pantalla.
Si varios bancos comparten un emisor (por ejemplo, `PAGOxMOVIL`), la app
identifica el banco por el nombre explícito en el encabezado del SMS. Un emisor
compartido sin encabezado reconocido se descarta para evitar atribuirlo al banco
equivocado; emisores únicos pueden usar la etiqueta que se configuró.

## Compilar

Abrir `android/` en Android Studio con Android SDK 35 y JDK 17 o posterior, o
ejecutar `gradle :app:testDebugUnitTest :app:assembleDebug` con Gradle 8.11.1.
No se incluye Gradle Wrapper. Los APK se generan en
`app/build/outputs/apk/debug/`. El flujo GitHub Actions «Android SMS APK»
ejecuta estas tareas y conserva el APK de depuración como artefacto 14 días.
Los pushes a `main` y las ejecuciones manuales también generan el artefacto
`qvaapply-sms-private-release`, firmado con una clave privada estable guardada
en los secretos del repositorio. Esa es la versión para instalar y actualizar.
Las solicitudes de cambio solo construyen la versión de depuración.

El respaldo local de la clave y su contraseña está en `android/.private-signing/`,
excluido de Git. Debe conservarse en una copia privada segura: cambiar la clave
obliga a reinstalar la app y perdería la cola local. Para compilar una release
local, definir `QVAAPPLY_ANDROID_KEYSTORE_PATH` y
`QVAAPPLY_ANDROID_KEYSTORE_PASSWORD` y ejecutar `gradle :app:assembleRelease`.

## Vincular

1. En el panel, crear una credencial de dispositivo para entrega de comprobantes.
2. En la app, guardar la URL HTTPS del servidor y el token de dispositivo.
3. Escribir los emisores exactos de SMS que el propietario quiere aceptar.
4. Pulsar «Permitir recepción de SMS» y aceptar el permiso.

Comprueba primero el flujo con los tres ejemplos sintéticos y después con una
transferencia real pequeña. Cuando la operación o sus detalles remotos no
coinciden inequívocamente, el comprobante queda en revisión manual; no se
marca como pagado. No se debe compartir el token ni el APK configurado.

El token queda en preferencias cifradas con Android Keystore. La app solicita el
permiso `RECEIVE_SMS` desde el botón contextual, y no procesa mensajes de
emisores que no estén en la lista local.

## Contrato del backend

La app envía `POST /api/mobile/payment-receipts` con `Authorization: Bearer
<device token>` y `Content-Type: application/json`:

```json
{
  "bank": "BPA",
  "sender": "emisor configurado localmente",
  "currency": "CUP",
  "amount": 52500.00,
  "beneficiaryMasked": "9205XXXXXXXX0959",
  "transactionId": "BR601ABVZE997",
  "receivedAt": 1760000000000
}
```

`202` y `200` significan que el servidor aceptó o deduplicó el recibo. Otros
errores transitorios se reintentan. La cola SQLite local se escribe antes de
iniciar la petición. Solo se envían los siete campos anteriores: nunca el texto
del SMS, ordenante, comisión o saldo restante.

## Pruebas

`app/src/test` contiene pruebas JVM para los formatos CUP de BPA y Banco
Metropolitano, USD de FINCIMEX/Clásica, remitentes desconocidos y avisos no
completados. Ejecutar `gradle test` o la tarea equivalente desde Android Studio.
