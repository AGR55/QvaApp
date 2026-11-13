# Evidencia F2 — market.ingest en Go (2026-11-13)

## Resultado

- Corpus congelado cargado y validado: **10 eventos, 4 escenarios, 14 pasos,
  18 decisiones**.
- Escenario `replay/market-ingest/dedupe/0001` reproducido en Go:
  **4/4 resultados idénticos** al oráculo.
- Dedupe, feed, observación y orden canónico por clave implementados en
  `services/trading-core/internal/replay/marketsession`.

## Comando

```bash
cd services/trading-core
go test ./internal/replay/marketsession -run TestMarketIngestResultsParity -v
```

## Limitación actual

El `stateDigest` del oráculo incluye estado interno del `Store` y no coincide
con el hash del resultado público. Se comparará al portar la sesión persistente
completa (Store + orquestador + gateway guionizado).
