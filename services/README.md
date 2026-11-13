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
| `domain/liquidity` | ✅ **9/9** | Liberación QUSD, orden por rentabilidad y snapshot |
| `domain/applybudget` | ✅ **9/9** | Ventana de dos apply, legado y `Retry-After` |
| `domain/hunting` | ✅ **6/6** | Elegibilidad, frescura y requisitos faltantes |
| `domain/flexible` | ✅ **21/21** | Dimensionado, orden hija y recuperación inequívoca |
| `domain/ledger` | — | Reservas puras: sin doble gasto ni doble reserva |
| `cmd/parity-sut` | ✅ | Protocolo NDJSON v1 (`stdin`/`stdout`) |

## Comandos

```bash
# Verificación completa (lo usa CI)
bash services/scripts/verify.sh

# Análisis estático + vulnerabilidades (lo usa CI)
bash services/scripts/lint.sh

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

## Calidad

- `go test -race ./...` en ambos módulos.
- Property tests con `testing/quick`:
  - redondeo QUSD idempotente y totales CUP múltiplos de 10,
  - plan presupuestario que nunca supera el disponible,
  - libro de reservas sin doble reserva ni doble gasto.
- `go vet`, `staticcheck` v0.8.2 y `govulncheck` v1.9.0.
- `golangci-lint` queda pendiente: la release v1.64 no soporta el export data
  de Go 1.27.

## Siguiente corte

1. Portar los lotes restantes de L1 (`dashboard`, `monetary-intents`,
   `market-list-budget`, `telegram-*`, `coop-*`) y los bucles stateful.
2. Añadir property tests de redondeo idempotente, reserva única y no doble
   gasto.
3. Incorporar `staticcheck`, `golangci-lint` y `govulncheck` al job de CI.
   `price-simulation` es L4 (integración), no entra en el lote puro de F1.
