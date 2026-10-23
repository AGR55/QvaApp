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

La versión actual es 0.2.0 (`versionCode` 4). Las actualizaciones conservan las
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
pequeña. La app se verifica en emulador Android 16; no se ha instalado ni validado en el Redmi. El flujo completo
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
