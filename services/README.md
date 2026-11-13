# Servicios Go — F1

Workspace Go de la migración. `main` sigue ejecutando el monolito TypeScript;
este árbol es el arranque de F1 y no se despliega todavía.

```text
services/
  go.work
  shared/                 # primitivas transversales mínimas (decimal exacto)
  trading-core/           # núcleo transaccional; aquí vive el dominio puro
    cmd/parity-sut/       # CLI de conformidad NDJSON para el runner
    internal/domain/      # reglas puras, sin I/O
  scripts/verify.sh       # gofmt + test -race + vet + paridad
```

## Reglas

- Go 1.27+, módulos por servicio y paquetes compartidos mínimos. Sin paquete
  `common` gigante.
- Dinero, tasas y porcentajes se representan con `shared/decimal.Value`
  (`math/big.Rat` exacto) y se formatean con escala fija. **Nunca `float64`**
  para importes.
- El dominio no hace I/O, no lee reloj ni entorno.
- Cada paquete portado se valida contra los goldens del oráculo TypeScript con
  el mismo runner de F0. Una diferencia es un fallo, no una tolerancia.

## Estado F1

| Paquete | Paridad | Notas |
| --- | --- | --- |
| `shared/decimal` | — | Aritmética exacta, redondeo y formato de escala fija |
| `domain/marketmath` | ✅ **18/18** | `market-math` + `rate-rounding` del lote `market-math` |
| `domain/budget` | ✅ **6/6** | Plan proporcional, recorte/cancelación y mínimos |
| `domain/riskpolicy` | ✅ **8/8** | Límites, slippage, cooldowns, capital y decisión final |
| `cmd/parity-sut` | ✅ | Protocolo NDJSON v1 (`stdin`/`stdout`) |

## Comandos

```bash
# Verificación completa (lo usa CI)
bash services/scripts/verify.sh

# Solo un filtro del runner
bash services/scripts/verify.sh --filter market-math
bash services/scripts/verify.sh --filter pure/budget/

# Tests y vet por módulo
(cd services/shared && go test -race ./...)
(cd services/trading-core && go test -race ./... && go vet ./...)

# Binario + paridad manual
(cd services/trading-core && go build -o bin/parity-sut ./cmd/parity-sut)
node --import tsx parity/runner/run.ts \
  --sut cli \
  --command "services/trading-core/bin/parity-sut" \
  --suite pure --filter market-math
```

## Siguiente corte

1. Portar `liquidity-plan`, `apply-budget` y `hunting-requirements` con sus
   goldens.
2. Añadir property tests de redondeo idempotente, reserva única y no doble
   gasto.
3. Incorporar `staticcheck`, `golangci-lint` y `govulncheck` al job de CI.
