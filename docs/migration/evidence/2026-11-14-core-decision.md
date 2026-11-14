# Core shadow — decisión financiera (2026-11-14)

## Resultado

- `trading-core` consume `shadow.hunter_events` con claim idempotente.
- Carga un snapshot generado en el deploy desde la SQLite real:
  - `risk_config` completo;
  - mercados, tasas, comisiones y flags de cacería;
  - saldos fiat declarados.
- Evalúa el evento con `riskpolicy.Evaluate` y persiste en
  `shadow.core_decisions`.
- **No muta dinero**; sigue siendo shadow.

## Evidencia

Evento real `hunter-3f6cfa932221deb1ce7f1f8427348eb8`:

```text
core_kind = apply
allowed   = true
coin      = BANK_CUP
side      = buy
reason    = La oportunidad cumple la política de precio y todos los límites.
```

Un evento sintético de control con margen insuficiente produjo `blocked` y se
eliminó después para no contaminar estadísticas. La cola quedó:

```text
processed = 18
pending   = 0
failed    = 0
```

## Métricas

- `trading_core_hunter_events_processed_total`
- `trading_core_hunter_events_failed_total`
- `trading_core_hunter_events_pending`
- `trading_core_core_decisions_allowed_total`
- `trading_core_core_decisions_blocked_total`

## Límites

- El snapshot de configuración/balances se regenera en cada deploy; no es un
  lector vivo de la SQLite de producción.
- No hay ejecución de apply, ledger ni escritura de dinero.
- La cobertura de configuraciones/decisiones reales debe compararse con TS
  antes del corte.

## Tests

```text
core config/decide tests      OK
hunter consumer validation    OK
Postgres claim/complete       OK
go test -race ./...           OK
lint/staticcheck/govuln      OK
```
