# Integración de cacerías conjuntas en QvaApply

Fecha: 2026-09-27

## Objetivo

Poner en funcionamiento la integración de QvaApply con Sync Core y ofrecer desde el bot administrador y el panel web de QvaApply operaciones de gestión de aportes cooperativos, manteniendo el bot de Sync Core como la interfaz principal especializada.

## Límites del producto

- Sync Core es la única fuente de verdad para aportes, agregados y consumos.
- El bot de Sync Core sigue siendo el bot principal de las cacerías conjuntas.
- El bot administrador de QvaApply ofrece un acceso secundario para consultar la red, crear o actualizar el aporte de QvaApply y retirarlo.
- Telegram no expone ejecución ni liquidación manual.
- La ejecución automática solo ocurre desde el motor de QvaApply después de confirmar una oferta válida y debe ser idempotente y transaccional.
- No se implementa comunicación bot-a-bot ni acceso directo compartido a la base de datos.

## Arquitectura

QvaApply se conecta directamente a Sync Core por HTTP para comandos y reconciliación, y por NATS JetStream para recibir snapshots. El panel web y el bot de QvaApply comparten un único `HuntingSyncCoordinator`, evitando lógica y estados duplicados.

QvaApply utiliza una cuenta técnica dedicada en Sync Core. Sus aportes quedan separados de los usuarios que operan mediante el bot principal. El token de acceso se guarda cifrado en el almacén existente de QvaApply y se renueva al expirar.

La conexión entre contenedores de la VPS utiliza las interfaces internas del host. No se publican al exterior los puertos de Sync Core o NATS.

## Experiencia de Telegram

Se conserva `/network` como resumen rápido y se añade `/coop` como entrada a la gestión. Ambos comandos aparecen en el menú nativo de Telegram y la botonera principal incluye “Cacerías conjuntas”.

La vista permite:

- consultar totales por moneda, precio, mínimo, participantes y salud HTTP/NATS;
- ver los aportes de la cuenta técnica de QvaApply;
- crear o actualizar un aporte mediante un flujo guiado de moneda, precio, mínimo, fiat y confirmación;
- retirar un aporte con confirmación explícita;
- solicitar una reconciliación inmediata.

Las acciones presentan estados pendiente, confirmado, retirado o error y toleran pulsaciones repetidas sin duplicar efectos.

## Panel web

La sección “Cacerías conjuntas” se integra en la navegación y en la botonera operativa del panel. Reutiliza el mismo servicio de aplicación que Telegram y permite consultar, crear o actualizar, retirar y refrescar aportes. No se publica una ruta web de ejecución manual.

## Endurecimiento de Sync Core

Antes de habilitar el consumo automático se incorporan:

- una migración aditiva para registrar ejecuciones con `external_id` único;
- asignación y descuento de todos los aportes dentro de una única transacción;
- respuesta idempotente para reintentos del mismo `external_id`;
- corrección de la validación de `fiat`;
- manejo seguro de credenciales incorrectas y usuarios sin Telegram;
- publicación de un snapshot NATS después de retirar un aporte;
- notificación posterior a la confirmación de la transacción;
- pruebas de concurrencia, duplicados y rollback.

Los cambios de Sync Core se desarrollan exclusivamente en `codex/sync-core-hardening` para revisión del mantenedor. No se integran directamente en `main`.

## Integración de la rama existente

La rama `codex/nats-cooperative-hunting` se integra sobre el estado actual de QvaApply en una rama nueva. Se conservan los cambios recientes de despliegue de la VPS y los archivos locales del usuario. Se corrigen las rutas del cliente a `/auth/login` y `DELETE /hunts/{coin}`, y se adapta la configuración a los puertos internos reales de la VPS.

## Verificación y despliegue

Se ejecutan pruebas unitarias e integrales de Go y TypeScript, validaciones de menús y callbacks de Telegram, pruebas HTTP del panel, compilaciones completas y pruebas de idempotencia/concurrencia. Antes del despliegue se respalda la base SQLite y la configuración de Sync Core.

El despliegue utiliza imágenes versionadas y se valida con health checks, operaciones de gestión no destructivas, conectividad NATS, reinicios y revisión de logs. Se conserva la imagen anterior y el respaldo de datos para reversión.
