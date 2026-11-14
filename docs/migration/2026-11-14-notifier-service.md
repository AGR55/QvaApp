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
`internal/notifier/menu.go` añade menús/callbacks seguros
(`status/pause/resume/help`), autorización y límites de 64 bytes de callback.
El webhook `POST /telegram/update` ya procesa mensajes/callbacks con
`ParseUpdate` + `HandleUpdate`, autorización por `TELEGRAM_ADMIN_CHAT_ID` y
respuesta dry-run. No hay long-polling ni token real usado en shadow.

## Webhook de Telegram

`internal/notifier/webhook.go` añade `SetWebhook`, `DeleteWebhook` y
`WebhookInfo` con tests de URL/secret/allowed_updates y sin long-polling.
El router `/admin/telegram/register|status` está integrado y **deshabilitado
por defecto**: devuelve `{"status":"disabled"}` sin red. El registro real exige
`TELEGRAM_WEBHOOK_ENABLED=true`, URL pública y token interno. Todavía no se ha
registrado el webhook de producción porque TS sigue en long-polling.

## Push

`internal/notifier/push.go` valida suscripciones/VAPID y
`push_http.go` expone `POST/DELETE/GET /push/subscriptions`.
`shadow.push_subscriptions` persiste endpoint/claves con TTL 24 h y dedupe.
Verificado en VPS: alta 202, conteo 1, baja 204, conteo 0. Aún no se envían
push reales ni se usa FCM.

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
