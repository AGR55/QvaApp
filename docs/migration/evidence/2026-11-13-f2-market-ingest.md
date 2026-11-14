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

## Actualización

El runner F2 completo reproduce también `stateDigest` (incluido el orden exacto
del snapshot) para los 4 casos y 14 pasos, además de `money-core`. Ver
[2026-11-13-f2-prototype-report.md](../2026-11-13-f2-prototype-report.md).
