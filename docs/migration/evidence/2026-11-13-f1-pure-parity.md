# Evidencia F1 — paridad del dominio puro (2026-11-13)

## Resultado

- **159/159 casos de golden L1** ejecutados contra el SUT Go.
- **25 paquetes puros** en `services/trading-core/internal/domain/`.
- `go test -race ./...` en `shared` y `trading-core` en verde.
- `staticcheck v0.8.2` y `govulncheck v1.9.0` sin hallazgos.
- `pnpm parity:gate` (F0) sigue en verde.

Commit de referencia: `0d34310` (rama `feat/f1-go-foundations`).

## Comandos reproducibles

```bash
bash services/scripts/verify.sh
bash services/scripts/lint.sh
pnpm parity:gate
```

Salida resumida:

```text
159/159 casos en verde
services: verificación Go + paridad (...) en verde
services: staticcheck + govulncheck en verde
parity-gate: OK — goldens, manifiesto, pura, contratos, HTTP y replay en verde
```

## Cobertura portada

- Dominio financiero: `marketmath`, `budget`, `riskpolicy`, `liquidity`,
  `applybudget`, `hunting`, `flexible`.
- Estado durable: `marketlistbudget`, `qusdcache`, `reconciliation`,
  `monetary`, `ledger`, `scheduler`, `markethunting`.
- Superficies: `dashboard`, `dashboardcontrol`, `dashboardauth`,
  `mobileoperator`, `coop`, `telegrammenu`, `telegramruntime`, `chatstream`.
- `shared/decimal`: aritmética exacta con `big.Rat`, formato de escala fija y
  redondeo.

## Propiedades financieras

- `marketmath`: redondeo QUSD idempotente y totales CUP múltiplos de 10.
- `budget`: el plan nunca supera el disponible ni propone subir importes.
- `ledger`: reserva única por operación, sin doble gasto y con
  `0 <= reservado <= saldo`.
- `qusdcache` y `markethunting`: tests de concurrencia bajo `-race`.

## Pendiente para cerrar F1

1. `outbox`/`inbox` e idempotencia durable en `trading-core`.
2. Primera ejecución real del workflow de CI y tiempos por job.
3. Preparar el prototipo F2 de la ruta caliente sobre el replay.
