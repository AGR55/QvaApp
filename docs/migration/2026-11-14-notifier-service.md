# Notifier Go — send-only (2026-11-14)

## Alcance

Primer microservicio de notificaciones, separado del bot TS:

- Puerto `127.0.0.1:8092`.
- `POST /notify` con `{text, chatId?, dedupeKey?}`.
- `GET /healthz`, `/readyz`, `/metrics`.
- Cliente Telegram `sendMessage` sin long-polling.
- **Dry-run por defecto**: no necesita token y no envía nada.
- Dedupe en memoria con TTL de 10 min.
- Token interno opcional `X-Notifier-Token`.
- Límite de cuerpo 16 KiB y texto 4096 caracteres.
- Contenedor `scratch`, read-only, sin shell, usuario 65532.

## Resultado en VPS

```text
healthz  = ok
readyz   = ok
dry-run  = accepted
segundo  = duplicate
requests = 5
sent     = 1
deduped  = 1
errors   = 0
```

## Comandos puros

`internal/notifier/commands.go` añade parser/dispatcher de `/start`, `/help`,
`/status`, `/pause` y `/resume`, con autorización por chat y textos estables.
Los comandos de mutación no se conectan aún a Telegram; el parser está probado
sin red.

## Qué no incluye todavía

- Comandos, menús, callbacks y sesiones del bot TS.
- Long-polling o webhook de Telegram.
- Push/FCM.
- Envío real: requiere `NOTIFIER_DRY_RUN=false`, `TELEGRAM_BOT_TOKEN` y
  `TELEGRAM_CHAT_ID`, además de `NOTIFIER_INTERNAL_TOKEN` para proteger
  `/notify`.

No se usó el token real de Telegram ni se envió ningún mensaje de producción.
El bot TS sigue siendo el único long-polling activo.

## Integración

```bash
curl -X POST http://127.0.0.1:8092/notify \
  -H 'Content-Type: application/json' \
  -d '{"text":"QvaApply shadow","dedupeKey":"alert-1"}'
```

Cuando se active el envío real, `core`/`hunter` podrán publicar alertas sin
acoplarse a Telegram.

## Tests

```text
notifier sendMessage + API error sin fuga de token   OK
dedupe TTL                                            OK
handler dry-run/dedupe/auth                           OK
go test -race ./cmd/notifier ./internal/notifier      OK
lint/staticcheck/govulncheck                          OK
```
