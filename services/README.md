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
  db/                     # Postgres local, importador SQLite y esquema v1
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
| `domain/dashboard` | ✅ **4/4** | Margen, reparto de presupuesto y compactación |
| `domain/reconciliation` | ✅ **4/4** | Backoff persistido por intención |
| `domain/monetary` | ✅ **5/5** | Intención antes de despachar y clasificación de fallos |
| `domain/marketlistbudget` | ✅ **9/9** | Cuota durable por owner, 429 y poisoned |
| `domain/coop` | ✅ **4/4** | Acciones y sesiones de aporte cooperativo |
| `domain/telegrammenu` | ✅ **6/6** | Comandos, acciones, tasas y sesiones |
| `domain/chatstream` | ✅ **3/3** | Framing SSE acotado y chat no bloqueante |
| `domain/qusdcache` | ✅ **13/13** | Dedupe, prioridad, epoch/revisión, TTL y cierre |
| `domain/telegramruntime` | ✅ **6/6** | Callback seguro, split, render guard y not-modified |
| `domain/scheduler` | ✅ **2/2** | Tareas solapadas, start/stop y timers |
| `domain/mobileoperator` | ✅ **5/5** | Tokens, cupos, acciones y composición móvil |
| `domain/dashboardauth` | ✅ **4/4** | Sesión, CSRF, origen y rate-limit |
| `domain/huntingbalance` | ✅ **1/1** | Cierre ordenado de bucles y caché |
| `domain/dashboardcontrol` | ✅ **3/3** | Pausa, cacería y refresco del panel |
| `domain/markethunting` | ✅ **13/13** | Cola, supersesión, generaciones, pausa y stop |
| `domain/ledger` | — | Reservas puras: sin doble gasto ni doble reserva |
| `platform/outbox` | — | Mensajes, lease, reintento y estados |
| `platform/inbox` | — | Dedupe por consumidor/mensaje |
| `platform/idempotency` | — | Claim, replay, conflicto y expiración |
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

## Persistencia F1

- `services/db/` contiene el compose Postgres 16 aislado, el importador
  SQLite→Postgres, el runner de migraciones y el snapshot `schema/core-v1.sql`.
- La importación se probó sobre una **copia** migrada a v31: **41 tablas,
  16.533 filas, 0 mismatches**, 41 PKs, 40 índices y 6 FKs.
- Los 6 triggers SQLite están traducidos y verificados; el workflow
  `postgres-f1` prueba esquema, triggers e importación desde un fixture mínimo.
- El auditor SQL de invariantes (reservas, ledger, configuración y límites) y
  `verify-money.mjs` (saldos/ledger/operaciones a 8 dp) están en verde.
- `outbox`/`inbox`/idempotencia están definidos en Go y en la migración
  `0003_outbox_inbox.sql`, con constraints probados en Postgres.
- El `sha256` de `data/qvaapply.sqlite` no cambió. Los detalles y garantías
  están en [db/README.md](db/README.md).
- Referencia local: `verify.sh` ~18-23 s; `lint.sh` ~65-130 s según caché;
  tests Postgres ~0,4 s y ~0,6 s. CI imprime los tiempos de cada job.

## Calidad

- `go test -race ./...` en ambos módulos.
- Property tests con `testing/quick`:
  - redondeo QUSD idempotente y totales CUP múltiplos de 10,
  - plan presupuestario que nunca supera el disponible,
  - libro de reservas sin doble reserva ni doble gasto.
- `go vet`, `staticcheck` v0.8.2, `golangci-lint` v2.15 y
  `govulncheck` v1.9.0.

## Siguiente corte

1. Cablear outbox/inbox/idempotencia a los repositorios Postgres de
   `trading-core`.
2. Primera ejecución real de CI y registro de tiempos por job.
3. Preparar el prototipo F2 de la ruta caliente sobre el replay.
