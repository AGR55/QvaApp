# Evidencia F3 — QvaPay read-only real (2026-11-13)

## Resultado

- Token QvaPay descifrado **en memoria** desde `settings.qvapay_token` con
  `LOCAL_ENCRYPTION_KEY`; nunca se imprimió ni se persistió en claro.
- Llamadas reales:
  - `GET /user` correcto.
  - `GET /p2p` correcto.
  - `GET /p2p/averages` correcto.
- Snapshot VPS `qvapay-live-20261114T042202Z`:

```text
balance = 373.39000000
offers  = 20
averages = 105
```

- Persistido en `shadow.qvapay_snapshots`; no se guarda token ni payload
  sensible.
- `/metrics` expone `trading_core_shadow_last_qvapay_timestamp_seconds`.
- Timer `qvaapply-f3-qvapay.timer` cada hora. Ejecución manual del timer:
  `qvapay-20261114T042712Z`, mismo balance y conteos, `status=0/SUCCESS`.

## Incidencias resueltas

1. El runtime `scratch` no incluía CAs; las lecturas HTTPS fallaban. Se añadió
   el bundle público `ca-certificates.crt`.
2. La respuesta real de `/p2p` devuelve `coin`/`type` como objetos y listas
   agrupadas. El parser ahora acepta `tick`/`code`/`currency` y grupos con
   `offers`, manteniendo la validación de UUID e importes.

## Seguridad

- Solo GET; el cliente no expone login ni mutaciones.
- El token y la clave se pasan al contenedor únicamente mediante
  `docker compose run -e`; no están en el Compose ni en el repositorio.
- El script borra las variables al terminar.
- El contenedor es `scratch`, `read_only`, sin puertos y con `cap_drop: ALL`.

## Verificación

```text
go test -race ./internal/platform/qvapay   OK
go test -race ./internal/platform/vault    OK
golangci/staticcheck/govulncheck           OK
snapshot real QvaPay                       OK
systemd timer                              status=0/SUCCESS
```
