# Evidencia F3 — cliente QvaPay read-only (2026-11-13)

## Alcance

`services/trading-core/internal/platform/qvapay` porta únicamente las lecturas
que consume `src/qvapay.ts`:

- `GET /user`
- `GET /p2p`
- `GET /p2p/{uuid}`
- `GET /p2p/averages`
- `GET /transaction` (paginado, `status=paid`)

No incluye login, PIN, apply, cancel, paid, received, chat ni ninguna mutación.

## Garantías

- El único método HTTP interno emite **GET**.
- Allowlist cerrada de rutas; rechaza `/p2p/{uuid}/apply`, `/create`, etc.
- `Authorization: Bearer` sin logging del token.
- Timeout de 5 s y límite de respuesta de 8 MiB.
- Redirecciones solo al mismo host y esquema.
- Errores tipados para HTTP, timeout y red.
- Decimales exactos con `shared/decimal`; no se opera con `float64`.
- Tests con `httptest`: auth, paths, query, parsing, 401/429, JSON inválido,
  respuesta sobredimensionada, timeout, red, paginación y redirecciones.

## Verificación

```text
go test -race ./internal/platform/qvapay   OK
go vet ./internal/platform/qvapay          OK
golangci-lint/staticcheck/govulncheck      OK
```

## Límite

Es una librería de lectura; todavía no está conectada a un sidecar ni a
credenciales de producción. La integración live queda para la siguiente fase.
