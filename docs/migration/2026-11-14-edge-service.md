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
