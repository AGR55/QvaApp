# Implementación de cacerías cooperativas NATS

## 1. Contratos y persistencia

- Añadir tipos de snapshot, aportación, estado de conexión y errores sanitizados.
- Elevar el esquema SQLite a v15 con una tabla de estado cooperativo y otra de aportaciones propias.
- Añadir operaciones transaccionales para guardar snapshots, estados y confirmaciones.
- Probar migración, datos corruptos y recuperación tras reinicio.

## 2. Autenticación y HTTP

- Incorporar configuración opcional `SYNC_*` con validación condicional.
- Crear `SyncCoreClient` con timeouts, errores tipados y decodificación estricta.
- Implementar login, snapshot, publicar aportación y retirar aportación.
- Reautenticar exactamente una vez ante `401` y persistir el token cifrado.
- Probar respuestas inválidas, timeouts, sanitización y reautenticación.

## 3. NATS y coordinación

- Añadir los módulos oficiales `@nats-io/transport-node` y `@nats-io/jetstream`.
- Crear un consumidor durable individual para el bot sobre `CACERIAS/cacerias.sync`.
- Validar tamaño y estructura antes de guardar y confirmar cada mensaje.
- Exponer estados de conexión y cerrar mediante drain.
- Reconciliar por HTTP al arrancar y periódicamente para cubrir eliminaciones no publicadas.
- Probar el coordinador con puertos falsos sin requerir un broker real.

## 4. Modelo local y API del dashboard

- Añadir la proyección cooperativa al snapshot local del dashboard.
- Exponer endpoints autenticados para consultar, publicar y retirar aportaciones.
- Mantener CSRF, validación de cuerpos y errores seguros en las mutaciones.
- No añadir ninguna ruta para ejecutar `POST /hunts/perform`.

## 5. Interfaz y Telegram

- Añadir **Red cooperativa** a la navegación existente.
- Mostrar conectividad HTTP/NATS, antigüedad, totales por moneda y aportación propia.
- Permitir publicar/actualizar/retirar fiat, mínimo y precio objetivo por mercado.
- Mantener controles independientes por mercado y feedback accesible.
- Añadir `/network` y acceso desde el menú de Telegram con el mismo snapshot local.

## 6. Integración del runtime

- Arrancar el coordinador después de construir almacenamiento y vault.
- Registrar reconciliación sin solapamiento en el scheduler existente.
- Refrescar el dashboard desde SQLite después de cada cambio.
- Drenar NATS antes de cerrar SQLite.
- Documentar variables y despliegue conjunto en VPS.

## 7. Verificación

- Ejecutar typecheck, suite completa, build de servidor y web, secretos y `knip`.
- Ejecutar smoke local contra Sync Core para login, snapshot y recepción NATS.
- Confirmar que `SYNC_ENABLED=false` no abre conexiones ni altera el comportamiento previo.
- Revisar que ninguna credencial aparezca en HTML, bootstrap, auditoría o errores.
