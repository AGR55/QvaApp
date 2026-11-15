# Edge Go — MVP (2026-11-14)

## Alcance

Primer microservicio de borde para web/Android:

- Puerto `127.0.0.1:8093`.
- `GET /healthz`, `/readyz`, `/metrics`.
- `GET /api/edge/summary`: contadores de `shadow.hunter_events` y
  `shadow.core_decisions`.
- Sirve assets desde `public/` en `/static` (`/dashboard/app.js`, CSS, iconos).
- Sin auth, sin mutaciones y sin proxy al monolito TS.
- Postgres en modo `default_transaction_read_only=on`.
- Contenedor `scratch`, read-only, sin shell.

## Resultado en VPS

```text
healthz = ok
readyz  = ok
summary = {"hunterEvents":18,"coreAllowed":1,"coreBlocked":0,"corePending":0}
asset /dashboard/app.js = 200, 380147 bytes
/ (shell SPA)           = 200
```

## Sesiones/CSRF

`internal/edge/auth.go` y `session_http.go` implementan:
- sesión HMAC-SHA256 stateless con expiración;
- CSRF ligado a la sesión;
- cookies `HttpOnly`/`SameSite=Lax`;
- `GET/POST/DELETE /api/session`.

Credenciales reales se cargan de `edge.env` (600), generado en el deploy desde
`DASHBOARD_ADMIN_PASSWORD` y `LOCAL_ENCRYPTION_KEY`. Verificado en VPS:

```text
sin sesión = 401
login malo = 401
login OK   = 200
GET auth   = 200
logout     = 204
post-logout= 401
```

No se imprime ni se devuelve la contraseña/token.

## API móvil autenticada

Rutas nuevas, protegidas por la cookie de sesión:

- `GET /api/mobile/overview`
- `GET /api/mobile/markets`
- `GET /api/mobile/alerts?limit=20`
- `GET /api/mobile/operations?limit=20`

Verificado en VPS: sin sesión 401; con login 200 en las cuatro rutas. El store
Postgres es solo lectura y no expone token/CSRF.

## Dashboard/live API

Rutas autenticadas por cookie:

- `GET /api/dashboard`
- `GET /api/live/balance`
- `GET /api/live/own-offers?limit=50`
- `GET /api/live/operations?limit=20`

Verificado en VPS: sin sesión 401; con login 200 en las cuatro rutas. El store
es Postgres read-only y no expone credenciales.

## Observabilidad

Rutas autenticadas:

- `GET /api/operational-health`
- `GET /api/decision-events?limit=20`

Verificado en VPS: 401 sin sesión y 200 con login.

## Live markets/transactions

Rutas autenticadas:

- `GET /api/live/markets/:coin`
- `GET /api/live/transactions?limit=20`

`shadow-qvapay` ahora persiste las últimas 20 transacciones read-only en
`shadow.qvapay_transactions`. Verificado en VPS: 20 filas y ambas rutas 200.

## Configuración, operadores y chats

Rutas autenticadas por cookie:

- `GET /api/config`, `/api/config-revisions`, `/api/market-source`, `/api/audit`
- `GET /api/notifications`, `/api/logs`, `/api/recovery`, `/api/openapi.json`
- `GET /api/push/public-key` (503 si no hay VAPID configurada)
- `GET /api/mobile/operators` (solo campos públicos)
- `GET /api/operations/chats` y `/api/mobile/operations/chats`
- `GET /api/mobile/devices`
- `GET /api/fiat-history?coin=CUP&page=1`
- `GET /api/offers/rebalance/:id`
- `GET /api/market-analytics?coin=CLASICA`
- `GET /api/analytics/fees?page=1`

Credenciales móviles con `Authorization: Bearer`:

- `GET /api/mobile/device-check`
- `GET /api/mobile/operator-check` (60 lecturas/minuto por operador)
- `GET /api/mobile/receipt-outcomes`

Los hashes viven en `/opt/qvaapply-f3-shadow/mobile-auth.json` (600,
propiedad de UID 65532); el edge solo compara `sha256(token)` y nunca los
devuelve ni los registra. El resto de datos sale de snapshots públicos
generados en el deploy (`operators.json`, `chat-threads.json`,
`dashboard-snapshot.json`), sin tokens, teléfonos ni contenido de chat.

Verificado en VPS: rutas de lectura 200 con login, 401 sin sesión; dispositivo
u operador inválido 401; snapshot con 2 dispositivos, 2 operadores y 100
comprobantes, sin `tokenHash` en la respuesta.

La auditoría estática actualiza a **33/109 rutas exactas**; siguen 76
pendientes, en su mayoría mutaciones (`POST/PUT/DELETE`) fuera del alcance
read-only y rutas de chat que dependen del servicio remoto.

## Limitación actual

El edge sirve shell HTML, assets, `/service-worker.js`, `/auth/*`, `/icons/*`,
`/logo/*` y `/market-icons/*` con caché/seguridad, además de las APIs de
sesión, móvil y dashboard/live. El monolito TS sigue generando el HTML/SSR completo y las rutas de API.
**Todavía no sustituye el dashboard completo**. Falta:

- rutas `/api/*` completas con auth/sesión/CSRF/origen;
- contratos móviles y estáticos PWA;
- canary Nginx.

No se modificó Nginx ni el frontend.

## Tests

```text
edge handler health/ready/metrics/summary       OK
static file, index, 404, traversal              OK
go test -race ./internal/edge ./cmd/edge        OK
deploy VPS + health/summary/asset               OK
```
