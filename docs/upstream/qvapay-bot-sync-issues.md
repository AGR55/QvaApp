# Hallazgos para Issues de qvapay-bot-sync

Revisión realizada sobre el commit `c4958b3`. `go test ./...` y `go vet ./...`
terminan correctamente, pero actualmente no existen archivos de prueba. Los
siguientes textos están listos para convertirse en Issues independientes.

## P0 · `POST /hunts/perform` descuenta dos veces la misma operación

**Comportamiento observado**

Dos solicitudes idénticas con el mismo `external_id` responden correctamente y
descuentan la capacidad fiat en ambas ocasiones. En el smoke local, una
aportación de 100 quedó en 80 al repetir dos veces una operación de 10.

**Causa visible**

`HuntsService.PerformHunt` usa `external_id` solo en la respuesta y el evento;
no persiste una clave idempotente antes de descontar. Además ejecuta un
`UPDATE` independiente por contribuyente, por lo que un fallo intermedio deja
descuentos parciales confirmados.

**Criterios de aceptación**

- Existe una tabla de ejecuciones con restricción `UNIQUE(external_id)`.
- La reserva de la ejecución y todos los descuentos ocurren en una sola
  transacción de base de datos.
- Repetir el mismo `external_id` devuelve el resultado original sin volver a
  descontar.
- Un fallo en cualquier contribuyente revierte todos los descuentos.
- Hay pruebas concurrentes y de reintento después de timeout.

Referencias: `internal/api/v1/modules/hunts/services.go:109-168` e
`internal/core/database/repositories/hunts_repository.go:203-220`.

## P0 · `PerformHuntSchema.Validate` devuelve el mapa de errores equivocado

**Comportamiento observado**

Campos vacíos o inválidos pueden atravesar la validación de `POST
/hunts/perform`. El método acumula errores en `fe`, pero retorna
`fiatErrors.ToAppError()`. También agrega `amountErrors` cuando falla `fiat`.

**Corrección esperada**

- Cambiar la línea final por `return fe.ToAppError()`.
- Agregar `fiatErrors` a `fe`.
- Rechazar `amount`, `price` y `fiat` cuando sean cero, negativos, `NaN` o
  infinitos.
- Cubrir cada campo con pruebas de tabla.

Referencia: `internal/api/v1/modules/hunts/schemas.go:91-142`.

## P1 · Contraseña incorrecta produce panic y HTTP 500

**Comportamiento observado**

`POST /login` con un usuario existente y contraseña incorrecta provoca panic;
el recovery mantiene vivo el servidor, pero el cliente recibe 500.

**Causa visible**

`AuthService.Login` retorna `(nil, nil)` para una contraseña inválida y el
handler desreferencia inmediatamente `*apiKey`.

**Criterios de aceptación**

- Usuario inexistente y contraseña incorrecta devuelven el mismo 401 genérico.
- Ninguna ruta puede desreferenciar una API key nula.
- La respuesta no revela si el correo existe.
- Hay pruebas HTTP para ambos casos.

Referencias: `internal/api/v1/modules/auth/services.go:55-88` e
`internal/api/v1/modules/auth/handlers.go:43-64`.

## P1 · Eliminar una cacería no publica un snapshot NATS

**Comportamiento observado**

Crear una aportación publica `cacerias.sync`, pero `DELETE /hunts` solo marca la
fila como inactiva. Los consumidores conservan el total anterior hasta su
próxima reconciliación HTTP o hasta que otro bot cree una aportación.

**Criterios de aceptación**

- Toda creación, sustitución, eliminación y descuento confirmado publica un
  snapshot nuevo después del commit.
- El evento nunca se publica si la transacción falla.
- Una prueba JetStream verifica que el total baja al eliminar.

Referencias: `internal/api/v1/modules/hunts/handlers.go` y
`internal/core/events/handlers/hunt_create_handlers/create_hunt_handler.go`.

## P1 · La ejecución cooperativa no notifica realmente a los bots aportantes

**Comportamiento observado**

`NotifyContributorsHandlerC` solo escribe una línea en el log. No existe un
mensaje NATS dirigido al usuario/bot aportante ni una notificación Telegram, por
lo que este no puede conocer de forma fiable cuánto fiat debe ejecutar.

**Criterios de aceptación**

- Cada contribución genera un comando durable dirigido al bot correspondiente,
  con `external_id`, moneda, fiat, QUSD adeudado y versión del contrato.
- El consumidor confirma explícitamente, deduplica por `external_id` y permite
  reentrega segura.
- Existe estado de entrega/aceptación consultable por el propietario.

Referencia:
`internal/core/events/handlers/hunt_perform_handlers/hunt_perform_handler.go`.

## P2 · La migración inicial fue modificada después de publicarse

**Comportamiento observado**

Solo existen `001_initial_up.sql` y `001_initial_down.sql`, pero el historial
muestra cambios posteriores sobre `001_initial_up.sql`. Una base creada con una
versión anterior de la migración 001 no recibirá automáticamente las tablas o
columnas agregadas después.

**Criterios de aceptación**

- Las migraciones aplicadas son inmutables.
- Los cambios posteriores viven en `002_..._up.sql`/`down.sql` y siguientes.
- Una prueba actualiza una base creada desde el primer esquema hasta HEAD.

Referencia: `internal/core/database/migrations/001_initial_up.sql`.

## P2 · El binario auxiliar NATS contiene una credencial literal

**Comportamiento observado**

`cmd/nats/main.go` contiene un token NATS en el código. Aunque sea una utilidad
de desarrollo, acostumbra a copiar credenciales y puede terminar publicado o
reutilizado.

**Criterios de aceptación**

- Leer la credencial desde entorno o entrada segura.
- Rotar cualquier token que haya sido usado fuera de desarrollo.
- Añadir escaneo de secretos al CI.

Referencia: `cmd/nats/main.go`.
