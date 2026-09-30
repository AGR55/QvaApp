# QvaApply SMS Android (APK privada)

Aplicación Kotlin privada para recibir comprobantes bancarios por SMS. Requiere
Android 8.0 o posterior. No incorpora emisores bancarios reales: el propietario
debe introducir manualmente el emisor exacto de cada banco en la pantalla.

## Compilar

Abrir `android/` en Android Studio con Android SDK 35 y JDK 17 o posterior, o
ejecutar `gradle :app:testDebugUnitTest :app:assembleDebug` con Gradle 8.11.1.
No se incluye Gradle Wrapper. Los APK se generan en
`app/build/outputs/apk/debug/`. El flujo GitHub Actions «Android SMS APK»
ejecuta estas tareas y conserva el APK de depuración como artefacto 14 días.
Es una compilación de prueba, firmada con la clave debug; antes de distribuirla
de forma estable se debe firmar una versión release con clave privada propia.

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
