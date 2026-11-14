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

## Limitación actual

El edge ya sirve un shell HTML mínimo que carga `/dashboard/app.js` y assets
reales. El monolito TS sigue generando el HTML/SSR completo y las rutas de API.
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
