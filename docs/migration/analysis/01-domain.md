# 01 — Dominio y casos de uso del núcleo financiero (`trading-core`)

- **Proyecto:** QvaApply (`/home/agore/Proyectos/QvaApply`)
- **Fecha:** 2026-11-12
- **Autor:** `domain-mapper` (análisis de dominio, no implementación)
- **Estado:** insumo para el plan maestro de migración a microservicios Go/Rust
- **Alcance:** núcleo financiero y de decisión P2P de QvaPay. Los adaptadores de presentación (web, Telegram, Android/operador), notificaciones y analítica se describen solo en su relación con el núcleo.
- **Método:** lectura del código de `src/`, de `test/` y de `docs/`. Cada afirmación relevante cita `archivo:línea`. No se ejecutaron tests ni procesos; no se modificó nada fuera de este archivo.

> **Convención de citas.** `src/x.ts:12` es una línea; `src/x.ts:12-40` es un rango. La suite es `node --import tsx --test test/*.test.ts` (`package.json:21`) y el contexto del proyecto declara 718 tests verdes. En el repositorio hay 661 llamadas `test()` en `test/*.test.ts`, algunas parametrizadas por bucles, de ahí la diferencia.
>
> **Cómo usar este documento.** Las secciones 1–4 describen *qué* debe comportarse igual. La sección 5 separa lo que puede portarse de inmediato de lo que exige rediseño. La sección 6 enumera las decisiones que el plan maestro debe tomar antes de escribir Go/Rust. Las tablas de la sección 3 son el contrato de paridad verificable.

---

## 0. Resumen ejecutivo para el plan maestro

1. El corazón del sistema es una **saga durable y compensable** alrededor de `POST /p2p/:uuid/apply`: reservar capital, cancelar ofertas propias para liberar QUSD, aplicar a la oferta externa y, si la aplicación no ocurrió, reponer las ofertas canceladas (`src/application/opportunity-orchestrator.ts:58-86`, `:213-500`).
2. Toda mutación monetaria pasa por un **protocolo de intención durable**: se persiste `submitted` antes de llamar a QvaPay y se clasifica el resultado como `confirmed`, `rejected` o `uncertain` (`src/application/monetary-intents.ts:43-102`). Un resultado `uncertain` **nunca** se reintenta ni se compensa sin conciliación (ADR-0003, `docs/adr/0003-uncertain-mutations-require-reconciliation.md`).
3. El capital está protegido por **dos ledgers de reserva** en SQLite: `capital_reservations` (QUSD por workflow) y `application_capital_reservations` (fiat/QUSD por intento de `apply`). Ambas tablas se escriben dentro de transacciones que también escriben el workflow o la intención (`src/store.ts:1306-1336`, `:1481-1516`, `:1614-1652`).
4. La **compensación** no reconstruye desde cero: guarda un snapshot inmutable de la oferta propia y usa una clave de idempotencia determinista `sha256("restore:<workflowId>:<offerUuid>")` (`src/store.ts:3522-3526`, `src/application/opportunity-orchestrator.ts:696-716`).
5. El estado compartido crítico **no es un servicio de dominio: es SQLite transaccional**. La atomicidad actual es **por llamada**, no por flujo completo: “comprobar límite + insertar reserva”, “crear intención + reservar capital” y “crear operación + borrar reserva + invalidar caché” son transacciones locales; los flujos con mutación remota encadenan varias transacciones y se sostienen con intenciones durables, restricciones `UNIQUE` y conciliación. Sin una base transaccional o un ledger equivalente, el rediseño puede duplicar exposición.
6. La concurrencia de decisión hoy es **de proceso único**: `OpportunityOrchestrator.inFlight` (`:66`, `:79-86`), `TradingEngine.decisionTail` / `withDecisionTurn` (`src/trading.ts:103`, `:886-891`), `withFiatDecision` (`:866-876`), los `Set` de `offersInFlight`, `reconciliationInFlight` y los caches en memoria (`src/trading.ts:88-112`). Ninguno sobrevive a un reinicio ni coordina dos instancias.
7. Hay **dos caminos de aplicación con enforcement asimétrico**: el escaneo periódico evalúa la política de riesgo completa (`evaluateRisk`), mientras que la vía rápida del feed aplica tras comprobar precio, tasa efectiva, saldo, exclusión y estado remoto, registrando los límites globales solo como *warnings* (`src/trading.ts:1093-1194`). Esta asimetría es deliberada en el código actual y debe decidirse explícitamente en el rediseño (ver §6.4).
8. El dinero es `number` IEEE-754 (float64) en todo el dominio. Hay al menos cinco reglas de redondeo distintas: QUSD a 1e-8 (`src/core/liquidity-plan.ts:285-287`), fiat no-CUP a 1e-8 (`src/market-math.ts:112-114`), CUP a múltiplos de 10 con floor/ceil según lado (`:59-71`), ofertas flexibles a 2 decimales (`src/flexible-order.ts:10`), y presupuesto a 2 decimales (`src/budget.ts:33-34`). Portar a otro lenguaje sin vectores dorados puede cambiar decisiones por un epsilon.
9. El tiempo es **epoch ms de reloj de pared** (`Date.now()`) y el “día” se calcula con la zona horaria local del proceso (`src/application/opportunity-orchestrator.ts:734-738`, `src/trading.ts:3986-3990`). La frescura del feed se ordena por `sent_at` remoto, no por recepción (`docs/adr/0008-feed-terminal-reconciliation.md`).
10. Hay **discrepancias documentales relevantes** entre `docs/ARCHITECTURE.md` y el código: (a) “una mutación sin resolver bloquea cualquier operación nueva” —el código bloquea solo la oferta afectada (`src/application/opportunity-orchestrator.ts:321`, `src/trading.ts:3132-3154`); (b) “al alcanzar el límite de errores consecutivos la automatización se pausa de forma persistente” —el código solo emite un *warning* de riesgo y acumula un contador (`src/core/risk-policy.ts:171-177`, `src/trading.ts:3607-3631`); (c) “los límites globales son bloqueos duros” —la vía rápida del feed solo los registra como advertencias (§6.4); (d) `OperationState` declara `failed` pero ninguna transición lo asigna (`src/types.ts:135-142`).
11. **Portable primero (~1.160 LOC puras):** `risk-policy`, `liquidity-plan`, `apply-budget`, `market-math`, `budget`, `flexible-order`, `hunting-requirements`, `reconciliation-scheduler`, `operation-display-state`. Tienen dependencias mínimas (tipos y `market-math`) y una suite densa por regla; son el mejor candidato para una primera extracción con paridad verificable.
12. **Riesgo externo duro:** QvaPay no ofrece idempotencia para `apply`, `paid`, `received`, `cancel` ni `edit`; solo `createOffer` acepta `idempotency_key` (`src/qvapay.ts:509-552`). La garantía de no duplicar depende del protocolo local + conciliación, no del proveedor. Además, la cuota de `apply` (2 por ventana móvil de 60 s) y la sesión/token son globales de la cuenta (`src/core/apply-budget.ts`, `src/qvapay.ts:114-126`), por lo que deben quedar bajo un único dueño en el rediseño.

---

## 1. Lenguaje de dominio

### 1.1 Contexto delimitado y mapa de módulos

El dominio financiero está delimitado por tres capas con una dirección de dependencia estricta (`docs/ARCHITECTURE.md:5-31`):

```text
adaptadores de entrada
  web React · HTTP Fastify · Telegram/grammy · scheduler · Android/operador
  feed SSE/webhook · polling multi-cuenta · Sync Core (HTTP + NATS)
                │  comandos y consultas
                ▼
fachada de casos de uso
  TradingEngine (src/trading.ts, 3.994 LOC)
  DashboardReadModel (src/dashboard.ts, 1.323 LOC)
                │
      ┌─────────┴──────────┐
      ▼                    ▼
workflows durables      puertos (src/core/ports.ts)
OpportunityOrchestrator  QvaPayGateway · TradingRepository
MonetaryIntents
      │                    │
      └─────────┬──────────┘
                ▼
infraestructura
  SQLite (src/store.ts, 3.643 LOC) · QvaPayClient (src/qvapay.ts, 1.100 LOC)
  Sync Core · notificaciones · caches locales
```

Regla de dependencia que el rediseño debe preservar:
`src/core` no conoce HTTP, Telegram, SQLite ni `fetch` (`docs/ARCHITECTURE.md:23`). Los workflows de `src/application` deciden el orden de reservar, cancelar, aplicar, compensar y conciliar; no hablan con el proveedor salvo por el puerto (`docs/ARCHITECTURE.md:24`).

### 1.2 Conceptos del dominio

| Término | Definición operativa | Evidencia |
|---|---|---|
| **Oferta externa** | Oferta P2P publicada por otro usuario, observada por el sistema y candidata a `apply`. | `CONTEXT.md:3-5`; `src/types.ts:38-73` |
| **Oferta propia** | Oferta creada por el propietario. Puede inmovilizar QUSD y, bajo un workflow compensable, cancelarse y reponerse. | `CONTEXT.md:7-9`; `src/core/liquidity-plan.ts:4-24` |
| **Oportunidad** | Oferta externa + precios, saldos y contexto para evaluar si conviene operar. | `CONTEXT.md:11-13`; `src/trading.ts:73-84` |
| **Decisión** | Resultado explicable de evaluar una oportunidad: `apply`, `manual_review`, `blocked`, `ignored`. | `CONTEXT.md:15-17`; `src/core/risk-policy.ts:1-5`, `:213-240` |
| **Política de riesgo** | Conjunto versionado de límites que puede bloquear una decisión favorable en precio. | `CONTEXT.md:19-21`; `src/core/risk-policy.ts:18-88` |
| **Exposición** | Capital comprometido en operaciones no terminales + reservas QUSD activas. | `CONTEXT.md:23-25`; `src/application/opportunity-orchestrator.ts:313-317` |
| **Reserva de capital** | Asignación local exclusiva que impide que dos workflows usen el mismo QUSD. | `CONTEXT.md:27-29`; `src/store.ts:341-348`, `:1614-1652` |
| **Operación** | Proceso durable que lleva una oportunidad desde la aplicación hasta un estado terminal o una acción humana. | `CONTEXT.md:31-33`; `src/store.ts:133-147` |
| **Workflow compensable** (`TradeWorkflow`) | Saga durable que orquesta reserva, cancelación de ofertas propias, `apply`, reposición y conciliación. Una por oferta objetivo. | `src/store.ts:78-104`; `src/application/opportunity-orchestrator.ts:58-62` |
| **Oferta propia dentro del workflow** (`WorkflowOwnOffer`) | Snapshot + estado de cancelación/reposición de cada oferta propia usada para liberar QUSD. | `src/store.ts:106-121` |
| **Intención monetaria** (`MutationIntent`) | Registro durable creado antes de solicitar a QvaPay una mutación que puede cambiar saldo, oferta o estado. | `CONTEXT.md:35-37`; `src/application/monetary-intents.ts:10-18`; `src/store.ts:254-266` |
| **Resultado incierto** | Mutación enviada cuyo efecto no puede inferirse de la respuesta. Exige conciliación y bloquea reintentos/compensaciones. | `CONTEXT.md:39-41`; `src/application/monetary-intents.ts:92-102` |
| **Conciliación** | Comparación estado local vs remoto para resolver una intención incierta sin duplicar exposición. | `CONTEXT.md:43-45`; `src/application/opportunity-orchestrator.ts:88-211`; `src/trading.ts:457-711` |
| **Compensación** | Restaurar una oferta propia tras confirmar que la aplicación externa no ocurrió. | `CONTEXT.md:47-49`; `src/application/opportunity-orchestrator.ts:536-640` |
| **Pago fiat** | Transferencia externa manual del propietario. El sistema registra referencia; nunca la ejecuta. | `CONTEXT.md:51-53`; `src/trading.ts:2126-2163` |
| **Configuración activa** | Revisión validada de mercados, estrategia y riesgo que gobierna decisiones nuevas. Las operaciones conservan las reglas con las que fueron iniciadas. | `CONTEXT.md:55-57`; `src/market-config.ts:30-49`, `:102-115`; `src/store.ts:123-131` |
| **Decisión versionada** (`DecisionEvent`) | Evidencia durable e idempotente por versión de oferta+tasa+decisión+razones. | `docs/ARCHITECTURE.md:52`; `src/store.ts:165-182`, `:2939-2981` |
| **Alerta de mercado** (`TradingAlert`) | Oferta bloqueada o candidata que requiere revisión; estado `dismissed`/`applied`/`expired`/`resolved`. | `src/store.ts:149-163`, `:2831-2937` |
| **Exclusión por cancelación manual** | UUID excluido de la aplicación automática tras una cancelación manual, persistente a reinicios y reaperturas. | `docs/plans/2026-10-03-manual-cancel-exclusion-design.md`; `src/store.ts:2637-2651` |
| **Hecho de elegibilidad** (`hunting_eligibility`) | Últimos datos verificados de la cuenta (KYC, rating, antigüedad) con frescura de 60 s. | `src/hunting-requirements.ts:1-50` |
| **Mediana de seguridad** | Referencia de precio por mercado y lado; caduca a los 5 min y no se renueva con lecturas de otros mercados. | `src/store.ts:3335-3380`; `src/trading.ts:766-809` |
| **Evento de feed** (`MarketFeedEvent`) | Entrega deduplicada de `p2p.*`; estados `pending`/`processed`/`ignored`/`failed`. | `src/store.ts:66-76`, `:1774-1990` |
| **Presupuesto de aplicación** | Ventana durable de 2 intentos de `apply` por 60 s, conservada entre reinicios. | `src/core/apply-budget.ts:1-30`; ADR-0009 |
| **Aportación cooperativa** | Capacidad fiat compartida con Sync Core; reserva/commit/release remotos y QUSD adeudado a participantes. | `src/hunting-sync.ts:28-66`; `src/cooperative-hunter.ts:7-11` |
| **Reajuste de presupuesto** (`RebalanceJob`) | Plan durable de edición/cancelación proporcional de ofertas propias para ajustar el fiat comprometido. | `src/budget.ts:24-121`; `src/store.ts:225-252`, `:3151-3193` |

### 1.3 Unidades, precisión y comparaciones

| Concepto | Regla verificada | Evidencia |
|---|---|---|
| QUSD | Token 1:1 USD; importes positivos y finitos. No existe tipo decimal en el dominio. | `src/core/risk-policy.ts:367-401` |
| Tasa de una oferta | `rate = receive / amount`; debe ser finita y > 0. | `src/trading.ts:3857`; `src/core/risk-policy.ts:399-400` |
| Redondeo QUSD | `Math.round(value * 1e8) / 1e8` en planes de liquidez y reposiciones. | `src/core/liquidity-plan.ts:285-287`; `src/application/opportunity-orchestrator.ts:726-728` |
| Total fiat de oferta propia | No-CUP: 1e-8. CUP: múltiplo de 10, compras `floor` y ventas `ceil`; error si el total es < 0.1. | `src/market-math.ts:42-72`, `:112-114` |
| Oferta flexible | `amount = floor(min(available, max, capacity, limit) * 100) / 100`; nunca supera capital ni cambia la tasa. | `src/flexible-order.ts:4-13` |
| Presupuesto fiat | `precision(x) = floor((x + EPSILON) * 100) / 100`; mínimo de oferta `MIN_OFFER_QUSD = 0.1`; el remanente CUP < 10 se cancela. | `src/budget.ts:33-34`, `:129-153`; `src/market-math.ts:19` |
| Comparaciones | Epsilon explícito: `1e-7` en liquidez/orquestador, `1e-6` en presupuesto, `1e-8` en tasas flexibles. | `src/core/liquidity-plan.ts:243-245`; `src/application/opportunity-orchestrator.ts:740-742`; `src/budget.ts:150-151`; `src/trading.ts:394-395` |
| Comisión de salida | `outgoingFiatCost(qusd, rate, fixedFee)` expone `nominal`, `fee`, `total` y `effectiveRate = total / qusd`. | `src/market-math.ts:11-35` |
| Tasa efectiva máxima | Una compra se bloquea si `effectiveRate > market.buyMaxRate`; el escaneo la marca `blocked`, la vía rápida `ignored`. | `src/trading.ts:3025-3043`, `:1121-1123` |
| Día de negocio | `new Date(now).setHours(0,0,0,0)` — zona horaria local del proceso. | `src/application/opportunity-orchestrator.ts:734-738`; `src/trading.ts:3986-3990` |
| Frescura de cotización | `maxQuoteAgeSeconds` (45 s por defecto) es bloqueo duro; pasada la edad se bloquea. | `src/core/risk-policy.ts:76-88`, `:150-156` |
| Frescura del feed | Evento con `sent_at` de más de 5 s se descarta antes de aplicar. | `src/trading.ts:954-958` |

### 1.4 Estados y ciclos de vida

#### 1.4.1 Decisión de una oportunidad

`RiskDecisionKind = apply | manual_review | blocked | ignored` (`src/core/risk-policy.ts:1-5`). La precedencia efectiva es (`src/core/risk-policy.ts:212-220`):

```text
priceDecision = ignored          → ignored
priceDecision = manual_review    → manual_review
falla al menos un check duro     → blocked
todo pasa                        → apply
```

`priceDecision` es la puerta de precio/mediana que calcula el llamador; `evaluateRisk` añade los límites globales. No existe una entidad “Opportunity” persistida: la evidencia durable es `DecisionEvent` (`src/store.ts:2939-2981`).

#### 1.4.2 `TradeWorkflow`

Estados declarados en `src/store.ts:78-94` (16). La máquina real que ejecuta el orquestador es:

```text
                        createTradeWorkflow
                                │
                             planned
                                │ reserveQusd falla
                     ┌──────────┴──────────┐
                     ▼                     ▼
                  blocked            capital_reserved
                                           │
                                 cancelling_own_offers
                                           │
                          ┌────────────────┼─────────────────────┐
                          ▼                ▼                     ▼
                  own_offers_cancelled  cancellation_uncertain  apply_rejected
                          │                (conciliación)             │
                   applying_external                               ▼
                          │                              restoring_own_offers
          ┌───────────────┼────────────────┐                     │
          ▼               ▼                ▼                  restored
       applied      apply_uncertain   (rechazo confirmado)
          │           (conciliación)        │
          │                │          restoring_own_offers → restored
          ▼                ▼
   restoring_surplus → applied
          │
          ├─ fallo reposición → surplus_restore_failed (aplicación conservada)
          └─ fallo snapshot/restore → compensation_failed
```

Evidencia por transición:

| Desde | Disparador | Hacia | Efecto lateral durable | Código |
|---|---|---|---|---|
| — | `createTradeWorkflow` | `planned` | Inserta workflow + snapshots de ofertas propias | `src/application/opportunity-orchestrator.ts:350-354`; `src/store.ts:1481-1516` |
| `planned` | `reserveQusd` rechaza (límite de exposición) | `blocked` | No hay reserva; workflow cerrado | `src/application/opportunity-orchestrator.ts:355-378` |
| `planned` | `reserveQusd` acepta | `capital_reserved` | Inserta `capital_reservations(active)` | `:379`; `src/store.ts:1614-1635` |
| `capital_reserved` | inicio de cancelaciones | `cancelling_own_offers` | Marca cada oferta `cancel_requested` | `:502-523` |
| `cancelling_own_offers` | todas canceladas | `own_offers_cancelled` | Marca `cancelled` | `:383-384`, `:514` |
| `cancelling_own_offers` | error incierto de cancelación | `cancellation_uncertain` | Conserva reserva y bloquea | `:472-476` |
| `own_offers_cancelled` | preflight y despacho de `apply` | `applying_external` | Crea intención `apply` + `application_capital_reservations` | `:399-419` |
| `applying_external` | `apply` confirmado | `applied` | Crea `Operation`, libera reserva, repone excedente | `:420-441`; `src/store.ts:2509-2545` |
| `applying_external` | `apply` incierto | `apply_uncertain` | Conserva reserva para conciliación | `:467-481`, `:660-671` |
| `applying_external` | rechazo definitivo | `apply_rejected` → `restored` | Repone ofertas propias canceladas y libera reserva | `:482-491`, `:536-553` |
| cualquiera no terminal | conciliación remota | `reconciling` → `applied`/`restored`/`apply_uncertain` | No repite `apply` | `:95-211` |
| `applied` | fallo al reponer excedente | `surplus_restore_failed` | Conserva la aplicación confirmada y avisa | `:438-451`; test `test/opportunity-orchestrator.test.ts:390` |
| `restoring_own_offers` | fallo de reposición | `compensation_failed` | Conserva evidencia y propaga | `:549-552` |

Estados terminales (no recuperables al arrancar): `applied`, `restored`, `blocked` (`src/store.ts:1536-1547`; `src/application/opportunity-orchestrator.ts:98-104`).

#### 1.4.3 `WorkflowOwnOffer`

```text
planned ──cancel_requested──► cancelled ──restore_requested──► restored
   │              │                │                                  ▲
   │              └──► uncertain ──┘                                  │
   └──────────────────────► consumed (excedente < 0.1 QUSD)
```

- `restore_requested` se escribe antes de crear la oferta repuesta; `restored` guarda `restored_uuid`.
- `uncertain` solo se asigna si la cancelación o reposición fue ambigua.
- La reposición usa el snapshot completo (`details`, flags, mensaje, tags, webhook) y la misma instantánea de tasa (`src/core/liquidity-plan.ts:218-234`; `src/application/opportunity-orchestrator.ts:593-640`).
- Evidencia: `src/store.ts:106-121`, `:1593-1612`; test `test/opportunity-orchestrator.test.ts:191-276`.

#### 1.4.4 `MutationIntent`

```text
                 createMutationIntent (dentro de transacción)
                                │
                            submitted
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
          confirmed          rejected           uncertain
        (respuesta 2xx        (QvaApiError        (QvaMutationUncertainError,
         con evidencia)        status < 500)       5xx, timeout, error desconocido,
              │                 │                  respuesta 2xx sin evidencia)
              │                 │                     │
              └────────────► reconciled ◄─────────────┘
                         (por conciliación remota
                          o declaración manual CAS)
```

Reglas duras:

- La intención se persiste **antes** de llamar al proveedor; si la persistencia falla, no se despacha y el error se propaga (`src/application/monetary-intents.ts:48-64`; test `test/monetary-intents.test.ts:95`).
- Solo `confirmed` se escribe con una respuesta 2xx inequívoca; un fallo de transporte o un 5xx se clasifica `uncertain`; un `QvaApiError` con `status < 500` se clasifica `rejected` (`src/application/monetary-intents.ts:92-102`).
- Un `confirmed` con reserva de aplicación pendiente se degrada a `uncertain` al abrir la base, para que la recuperación no libere ni reenvíe capital (`src/store.ts:365-369`; test `test/application-reservations.test.ts:8`).
- Las intenciones recuperables son `submitted`/`uncertain` y además `confirmed` para `apply`, `paid`, `received` y `cancel` (`src/store.ts:1450-1463`).
- La resolución manual es un CAS con evidencia explícita del operador; no es confirmación remota (`src/store.ts:1404-1434`; `src/self-service-recovery.ts`).
- Tipos de intención observados en el código: `apply`, `create_offer`, `edit_offer`, `cancel_offer`, `restore_own_offer`, `cancel_own_for_liquidity`, `paid`, `received`, `cancel`.

#### 1.4.5 `Operation`

Estados declarados: `applied | acknowledged | paid | revision | cancelled | completed | failed` (`src/types.ts:135-142`). `failed` **no se asigna en ninguna transición actual** (grep de `updateOperation`). Los estados con exposición activa son `applied`, `acknowledged`, `paid`, `revision` (`src/store.ts:2572-2580`).

```text
                   apply confirmado
                          │
                       applied ───────────────► acknowledged   (solo sell: ACK manual o chat propio)
                          │                            │
        (solo sell)       ├── markPaid ──────────────► paid
                          │                            │
        (solo buy)        └── confirmReceived ───────► completed
                          │
                          └── cancel / open remoto ──► cancelled
                          └── revision remoto / cancel ambiguo con orden ──► revision
```

| Transición | Precondición | Evidencia remota exigida | Código |
|---|---|---|---|
| crear `applied` | `apply` confirmado | respuesta de `/apply` o estado remoto `processing/paid/completed/revision` | `src/application/opportunity-orchestrator.ts:420-436`; `src/trading.ts:3504-3517` |
| `applied → acknowledged` | operación `sell`; sin mutación incierta | no consulta remoto | `src/trading.ts:2110-2124` |
| `applied/acknowledged → paid` | operación `sell`; referencia obligatoria | `GET offer` en `processing`; revalidación local | `src/trading.ts:2130-2163` |
| `applied/acknowledged/paid → completed` | operación `buy` | `GET offer` en `processing`/`paid`; revalidación local | `src/trading.ts:2169-2200` |
| `applied/acknowledged → cancelled` | sin mutación incierta; no `completed/cancelled` | `GET offer` en `processing`; `cancel` confirmado | `src/trading.ts:2238-2263` |
| `applied/acknowledged/paid/revision → cancelled/completed` | sincronización periódica o feed | `GET /p2p/:uuid` o evento de feed autenticado | `src/trading.ts:2284-2320`, `:1409-1478` |
| → `revision` | cancelación con orden de compra y respuesta no `cancelled` | estado de la orden hija | `src/trading.ts:2257` |

Mapeo remoto → local: `completed→completed`, `cancelled|canceled|open→cancelled`, `revision→revision`, `paid→paid`, `processing→` conserva `acknowledged/paid/revision` o pasa a `applied` (`src/trading.ts:3869-3891`). Desde feed: `p2p.paid→paid`, `p2p.completed→completed`, `p2p.cancelled→cancelled`, `p2p.applied→applied` salvo estados humanos más precisos (`src/trading.ts:3893-3910`).

#### 1.4.6 Otros ciclos relevantes

- **`MarketFeedEvent`**: `pending → processed | ignored | failed`; `failed` reintenta con backoff y cuenta en salud (`src/store.ts:1774-1990`). Dedupe por `event + uuid + versión temporal` (`src/market-feed.ts:349-395`).
- **`RebalanceJob`**: `pending → applying → completed | partial | reconciliation_required | failed`; una edición/cancelación incierta pasa a `reconciliation_required` y se resuelve comparando intenciones (`src/dashboard.ts:499-599`; `src/store.ts:225-252`).
- **`CooperativeExecution`**: `reserving → reserved → applying → applied → committed → completed → settled`, con `released`, `cancelled`, `uncertain`, `commit_pending`, `release_pending` (`src/cooperative-hunter.ts:7-11`).

### 1.5 Evidencia y trazabilidad

Toda decisión y toda mutación dejan rastro en dos lugares distintos:

- **`audit_log`**: narrativa operativa con `action`, `detail` y `offer_uuid` (`src/store.ts:2619-2625`). Acciones relevantes: `risk_block`, `price_guard_block`, `opportunity_applied`, `workflow_reconciliation_required`, `mutation_uncertain`, `mutation_rejected`, `mutation_manually_reviewed`, `restore_offer_deduplicated`, `surplus_restored`, `surplus_below_minimum`, `standalone_apply_reconciled`, `standalone_offer_mutation_reconciled`, `manual_apply_*`, `auto_apply_buy`, `market_fast_lane_applied`.
- **`decision_events`**: evidencia versionada de decisión, con checks completos y resolución (`src/store.ts:2939-3025`; `docs/ARCHITECTURE.md:50-54`).

En el rediseño, audit + decision events son la base natural de un *event log* de dominio; pero hoy se escriben en la misma base y en el mismo proceso que el estado, sin outbox transaccional explícito para consumidores externos.

---

## 2. Inventario de casos de uso

Los casos de uso se agrupan por la pregunta que responden: **decidir**, **aplicar**, **compensar/conciliar**, **operar** y **mantener**. Cada fila indica precondición, postcondición, puertos/colaboradores, mutaciones externas y regla de compensación o conciliación.

### 2.1 Casos de uso de decisión y aplicación

| ID | Caso de uso | Precondiciones | Postcondiciones | Puertos / colaboradores | Mutaciones externas | Compensación / conciliación |
|---|---|---|---|---|---|---|
| **UC-01** | `EvaluateOpportunityRisk` | Oferta con precio y contexto; límites versionados; snapshot de saldos, exposición, volumen, operaciones y pausa | `RiskDecision` con checks, razones y proyecciones | Puro: `evaluateRisk` (`src/core/risk-policy.ts:94-241`) | Ninguna | No aplica: es puro y determinista |
| **UC-02** | `PlanLiquidity` | Objetivo de compra externa; saldo QUSD libre; reserva; ofertas propias abiertas; economía de mercados | Plan todo-o-nada con ofertas a cancelar y `consumeQusd`/`restoreQusd` | Puro: `planLiquidity` (`src/core/liquidity-plan.ts:89-188`) | Ninguna | Si no alcanza, no propone cancelación parcial (`:153-164`) |
| **UC-03** | `ExecuteCompensableApply` (comprar QUSD de una oferta externa de venta) | Mercado activo; `target.type=buy` y `status=open`; no existe workflow previo para el UUID; política de riesgo `apply` | Aplicación confirmada y `Operation` creada, o bloqueo/restauración/incertidumbre persistidos | `QvaPayGateway`, `TradingRepository`, `MarketConfigService`, `MonetaryIntents`, `planLiquidity`, `evaluateRisk` | `cancel` de ofertas propias; `apply` de la oferta externa; `createOffer` para reponer | Ver §2.3.1. `apply` incierto conserva reserva y bloquea la oferta; rechazo repone ofertas; aplicación confirmada con fallo de excedente se conserva y alerta |
| **UC-04** | `CancelOwnOffersForLiquidity` | Workflow con `capital_reserved` y snapshot hidratado de cada oferta propia | Ofertas `cancelled` o workflow en `cancellation_uncertain` | `QvaPayGateway.cancel`, `MonetaryIntents` | `cancel` por cada oferta propia | Cualquier cancelación incierta impide continuar; la conciliación decide reposición |
| **UC-05** | `DispatchMonetaryMutation` | Intención persistida; caller define `kind`, `request`, `action` e idempotency key opcional | `confirmed`, `rejected` o `uncertain` persistido + auditoría | `MonetaryIntents` (`src/application/monetary-intents.ts:43-89`) | La que ejecute `action` | Es el seam común; no compensa por sí mismo |
| **UC-06** | `RestoreOwnOffer` | Oferta `cancelled`; snapshot con datos de pago completos; workflow existente | Oferta repuesta con `restored_uuid`, o estado `uncertain` | `QvaPayGateway.createOffer`, `MonetaryIntents` | `createOffer` | Idempotencia determinista; un `409` se resuelve leyendo ofertas abiertas y confirmando una duplicada (`src/application/opportunity-orchestrator.ts:593-640`) |
| **UC-07** | `RestoreSurplusOwnOffers` | Aplicación confirmada; ofertas propias con `restoreQusd > 0` | Excedente repuesto; resto marcado `consumed`; o `surplus_restore_failed` | Mismos que UC-06 | `createOffer` | El fallo **no revierte** la aplicación confirmada; conserva evidencia y alerta (`:438-451`, `:555-591`) |
| **UC-08** | `ReconcileTradeWorkflow` | Workflow no terminal; estado remoto consultable | `applied`, `restored` o `apply_uncertain`; reservas e intenciones resueltas coherentemente | `QvaPayGateway.getOffer/listOffers`, `TradingRepository` | Ninguna (solo lectura remota) | Nunca repite `apply`; si no hay evidencia concluyente conserva reserva (`:95-211`, `:660-671`) |
| **UC-09** | `ReconcileStandaloneMutation` | Intención sin workflow en `submitted/uncertain` y backoff vencido | Intención `reconciled` o pendiente con backoff | `QvaPayGateway.getOffer/listOffers`, `ReconciliationScheduler` | Ninguna | Cubre `paid`, `received`, `cancel`, `create_offer`, `edit_offer`, `cancel_offer` y `apply` sin workflow (`src/trading.ts:457-711`) |
| **UC-10** | `ResolveUncertainMutationManually` | Intención `uncertain`; operador autenticado; evidencia declarada | Intención `reconciled` con CAS y auditoría | `TradingRepository.resolveMutationIntentCAS` | Ninguna | Solo declaración del propietario; no sustituye confirmación remota (`src/store.ts:1404-1434`) |
| **UC-11** | `ScanMarkets` (polling) | Motor activo; modo real/simulación; mercados activos; cacerías habilitadas | Página evaluada, decisión versionada y como máximo una aplicación | `QvaPayGateway.listOffersPage/p2pAverages`, `Store` | `apply` si hay candidata | Una aplicación por ronda; si falla, la candidata siguiente puede evaluarse (`src/trading.ts:1529-1584`, `:1586-1907`) |
| **UC-12** | `IngestMarketPage` / `IngestFeedOffer` | Página o evento `p2p.created/reopened/resumed/range_*`; generación de control vigente | Oferta evaluada, decisión persistida y posible `apply` | `TradingEngine.ingestMarketUpdate`, `ingestMarketOffer` | `apply` | Descarte por pausa/cambio de generación/antigüedad; no muta si la página quedó obsoleta (`src/trading.ts:811-963`; `src/application/market-hunting-loops.ts`) |
| **UC-13** | `ApplyFastLane` (feed) | Evento fresco (`sent_at` ≤ 5 s); oferta abierta no propia; sin operación/exclusión/mutación incierta | `apply` confirmado y `Operation`; o decisión `ignored/blocked` | `MonetaryIntents`, `QvaPayClient.apply`, caches de saldo | `apply` | Preflight antes del POST; si la cuota no alcanza, no gasta intento; cualquier otro error incierto bloquea la oferta (`src/trading.ts:1093-1324`) |
| **UC-14** | `TakeFlexibleOffer` | Oferta `offer_kind=flexible`; disponible/mínimo/máximo; capital libre | Orden propia dimensionada y aplicada, o skip motivado | `sizeFlexibleOffer`, orquestador (si hay que liberar QUSD), `QvaPayGateway.apply(amount)` | `apply` con importe; `cancel` de ofertas propias si falta QUSD | La respuesta debe traer `order`, `amount` y `receive`; si no, `QvaMutationUncertainError`. La orden hija, no el padre, gobierna pagos y conciliación (`src/flexible-order.ts:15-35`) |
| **UC-15** | `ApplyManuallyToOffer` | Modo real; oferta abierta; sin operación previa incompatible; sin mutación incierta de esa oferta | Operación `applied` manual | `QvaPayGateway.getOffer/apply`, `MonetaryIntents` | `apply` | La conciliación se hace por la misma intención; la cancelación manual posterior excluye la oferta de la vía automática |
| **UC-16** | `ApplyBlockedOffer` / `PreviewBlockedOffer` / `DismissBlockedOffer` | Alerta `blocked` sin resolver; oferta aún abierta | Aplicación con solo el bloqueo de precio omitido, o alerta resuelta | `TradingRepository` (alertas), `evaluateRisk`, orquestador | `apply` (solo `ApplyBlockedOffer`) | La parada de emergencia y los demás límites siguen siendo duros; `Preview` es read-only (`src/trading.ts:1977-2108`; test `test/trading-automation.test.ts:1289`) |
| **UC-17** | `PrepareHuntingLiquidity` | Cacería de venta activa; motor idle; sin reservas ni decisiones en vuelo; QUSD libre bajo objetivo | Reducción de una oferta propia de venta o ninguna; auditoría | `QvaPayGateway.listOffers/editOffer`, `MonetaryIntents` | `edit_offer` | Nunca deja una oferta bajo `MIN_OFFER_QUSD`; un error incierto bloquea la oferta (`src/trading.ts:1344-1397`) |
| **UC-18** | `ExecuteCooperativeHunt` (adyacente) | Red Sync Core habilitada; snapshot fresco; oferta compatible; motor propio libre | `CooperativeExecution` con reserva/commit/release | `HuntingSyncCoordinator.reserve/settle`, `QvaPayClient.applySecondary` | `POST /p2p/:uuid/apply` secundario en Sync Core; reserva/commit/release | Reserva remota antes del apply; incierto conserva reserva y no reintenta; `reconcile()` repara fases pendientes (`src/cooperative-hunter.ts:117-241`) |

### 2.2 Casos de uso de operación, sincronización y mantenimiento

| ID | Caso de uso | Precondiciones | Postcondiciones | Puertos / colaboradores | Mutaciones externas | Compensación / conciliación |
|---|---|---|---|---|---|---|
| **UC-19** | `AcknowledgeOperation` | Operación `sell` en `applied` | `acknowledged` | `Store` | Ninguna | No aplica |
| **UC-20** | `MarkOperationPaid` | Operación `sell` en `applied/acknowledged`; referencia no vacía; remoto en `processing`; sin mutación incierta | `paid` | `QvaPayGateway.getOffer/markPaid`, `MonetaryIntents` | `paid` | Intención `paid`; si es incierta exige conciliación y bloquea nuevas acciones de la operación (`src/trading.ts:2130-2163`) |
| **UC-21** | `ConfirmOperationReceived` | Operación `buy` en `applied/acknowledged/paid`; remoto `processing/paid` | `completed`; movimiento fiat de crédito si aplica | `QvaPayGateway.getOffer/confirmReceived`, `MonetaryIntents` | `received` | Intención `received`; conciliación por estado remoto `completed` |
| **UC-22** | `CancelOperation` | Operación `applied/acknowledged`; remoto `processing`; sin mutación incierta | `cancelled` o `revision` | `QvaPayGateway.getOffer/cancel`, `MonetaryIntents`, `Store.excludeAutomaticReapplyAfterManualCancel` | `cancel` | Si el remoto es `revision` o la cancelación de una orden no confirma `cancelled`, pasa a `revision` y mantiene exposición (`src/trading.ts:2238-2263`) |
| **UC-23** | `SyncRemoteOperations` | Motor activo; operaciones activas | Estados locales alineados con `GET /p2p/:uuid` | `QvaPayGateway.getOffer`, `operationStateFromRemote` | Ninguna | `open/cancelled` remoto cierra la operación; un 404 la cierra localmente; un error de red no borra estado (`src/trading.ts:2284-2320`, `:3649-3653`) |
| **UC-24** | `SyncChatAcknowledgements` | Operación `sell` pendiente; modo real | `acknowledged` si hay mensaje propio posterior al saludo automático | `QvaPayGateway.profile/listChat` | Solo lectura | Un fallo de chat se audita y se reintenta en el siguiente ciclo; no cancela la operación (`src/trading.ts:2265-2274`, `:3579-3594`) |
| **UC-25** | `RefreshOwnOffers` | Refresco activo; modo real; sin pausa; separación de 20 s | Como máximo una oferta propia editada por ejecución | `QvaPayGateway.listOffers/editOffer` | `edit_offer` | Reintento con backoff por UUID; el fallo no bloquea el motor (`src/trading.ts:2897-2947`, `:3655-3680`) |
| **UC-26** | `CreateOwnOffer` / `EditOwnOffer` / `CancelOwnOffer` | Modo real; mercado configurado; datos de pago; límites de ofertas y saldo | Oferta creada/editada/cancelada con intención durable | `QvaPayGateway.createOffer/editOffer/cancel`, `MonetaryIntents` | `create_offer`, `edit_offer`, `cancel_offer` | `create_offer` usa idempotency key; `edit_offer` reciente idéntico se omite; reconciliación standalone por listado de ofertas propias (`src/trading.ts:2546-2814`; `test/trading-automation.test.ts:994`) |
| **UC-27** | `RebalanceFiatBudget` | Preview de presupuesto; ofertas propias abiertas; objetivo de saldo fiat | `RebalanceJob` con ajustes proporcionales aplicados | `budget.proportionalBudgetPlan`, `MonetaryIntents`, `Store` | `edit_offer`/`cancel_offer` | Cada ajuste es una intención; un incierto pasa a `reconciliation_required` y se compara contra intenciones existentes (`src/dashboard.ts:499-599`; `src/budget.ts:36-121`) |
| **UC-28** | `ConfigureStrategyRiskAndControl` | Panel/Telegram; configuración válida | Configuración persistida con revisión encadenada; pausa/emergencia/modo aplicados | `MarketConfigService.save`, `Store.saveTradingConfig`, `TradingEngine.setPaused/setEmergencyStop/setMode` | Ninguna directa | Cambiar límites no altera decisiones ya persistidas; la pausa y la parada de emergencia invalidan trabajo en vuelo (`src/market-config.ts:169-179`, `:551-597`; `src/trading.ts:330-441`) |
| **UC-29** | `ReconcileAtStartup` | Proceso arranca con SQLite existente | Intenciones standalone y workflows no terminales conciliados o marcados pendientes | `TradingEngine.reconcilePendingStandaloneMutations`, `OpportunityOrchestrator.reconcilePending` | Solo lectura remota | Debe ejecutarse antes de aceptar trabajo nuevo (`src/index.ts:624-657`) |
| **UC-30** | `ProcessPaymentReceipt` / `PrepareAssistedPayment` (adyacente) | SMS/operador autenticado; operación compatible | Recibo `matched/review/failed`; intención de pago preparada y vencible | `Store` receipts, `AssistedPaymentService` | Ninguna transferencia: el sistema no paga fiat | Un recibo ambiguo va a `review`; nunca se inventa una referencia (`src/payment-sms.ts`; `src/assisted-payment.ts`) |
| **UC-31** | `DispatchNotifications` (adyacente) | Evento durable en `notification_events` | Entrega Telegram/Push con dedupe por canal y evento | `NotificationDispatcher`, `WebPushService` | Telegram/Web Push | Reintentos independientes por canal; un fallo no revierte la operación (`src/notification-dispatcher.ts`; `src/web-push.ts`) |
| **UC-32** | `ManageCooperativeCapacity` (adyacente) | Sync Core habilitado; saldo declarado local | Aportación publicada/retirada; capacidad reconciliada | `HuntingSyncCoordinator` | HTTP Sync Core | Una caída no detiene la cacería local; la capacidad remota se confirma solo con delta (`src/hunting-sync.ts`; `docs/plans/2026-10-05-cooperative-capacity-design.md`) |

### 2.3 Detalle de los casos críticos

#### 2.3.1 `ExecuteCompensableApply` (UC-03) — orden exacto

Precondiciones verificadas en orden (`src/application/opportunity-orchestrator.ts:213-348`):

1. **Idempotencia por UUID objetivo**: si ya existe workflow para `target.uuid`, se devuelve el existente y se bloquea si la aplicación anterior no se confirmó (`:214-231`).
2. **Ejecutabilidad**: `target.type === "buy"` y `status === "open"`; mercado configurado y activo (`:232-240`).
3. **Saldo real**: `qusdBalance({priority:true})`; se resta deuda cooperativa y `unavailableQusd` (`:242-249`).
4. **Listado de ofertas propias solo si hace falta liberar QUSD**: si el saldo libre cubre el objetivo + reserva, no se consulta (`:247-249`). La prueba lo exige (`test/opportunity-orchestrator.test.ts:159`).
5. **Plan de liquidez** (`:252-275`): si la oferta es flexible y no es viable, se dimensiona y se replanifica. Sin plan viable → decisión `blocked`.
6. **Política de riesgo** (`:276-327`): si la configuración nunca fue revisada desde el panel (`reviewedAt === null`), `eligible` se degrada a `manual_review`; si la liquidez no es viable, la puerta de precio se fuerza a `blocked`. El contexto incluye exposición = operaciones activas + reservas QUSD, volumen diario desde el inicio del día local, errores consecutivos, pausa, emergencia y mutación incierta **de esa oferta**.
7. **Hidratación de snapshots antes de cancelar** (`:331-348`): se consulta cada oferta propia con `priority` y se valida UUID, tipo `sell`, estado `open`, moneda e importes; si QvaPay no devuelve datos de pago completos, **no se cancela ninguna**. Pruebas: `test/opportunity-orchestrator.test.ts:191`, `:246`.
8. **Persistencia del workflow + snapshots** y **reserva atómica** (`:350-379`). Si la reserva no cabe en la exposición, el workflow queda `blocked` y no hay mutación remota.
9. **Cancelación de ofertas propias** (`:383-384`, `:502-523`) con intención por oferta; una cancelación incierta aborta el caso.
10. **Freshness tras liberación flexible** (`:385-398`): si la oferta era flexible y hubo cancelaciones, se vuelve a comprobar saldo QUSD, se relee la oferta y se valida que no cambió ninguno de sus campos observables. Si cambió, se repondrán las ventas propias.
11. **`apply` de la oferta externa** (`:399-419`) con intención durable; la respuesta de una flexible debe traer orden e importes válidos o se lanza `QvaMutationUncertainError`.
12. **Proyección local**: crear `Operation`; liberar la reserva QUSD; reponer el excedente (`:420-441`). La reserva de aplicación se elimina dentro de `createOperation` (`src/store.ts:2542-2543`).
13. **Notificación best-effort**: un fallo de notificación nunca revierte la operación (`:525-534`).
14. **Manejo del error** (`:463-492`):
    - incierto y hubo despacho o cancelación solicitada → workflow `apply_uncertain`/`cancellation_uncertain`, conserva reserva y alerta;
    - rechazo definitivo → `apply_rejected`, repone ofertas propias, `restored`, libera reserva.
15. **Postcondición de salida**: devuelve decisión, workflow persistido y `applicationConfirmed` según exista `Operation` (`:493-499`).

#### 2.3.2 `ReconcileTradeWorkflow` (UC-08)

Pasos (`src/application/opportunity-orchestrator.ts:95-211`):

1. Workflow inexistente → error; terminal `applied/restored/blocked` → no-op.
2. Pasa a `reconciling` y consulta `GET /p2p/:target`.
3. **Flexible**: identifica la orden hija por `orderUuid` persistido o por `matchingRecoveryOrder` (cuenta + importe + ventana temporal); si no hay orden propia inequívoca, conserva reserva (`:111-131`; `src/flexible-order.ts:29-35`).
4. **Aplicación confirmada** (`processing|paid|completed|revision`): crea/asegura `Operation`, libera reserva QUSD, reconcilia intenciones del workflow y repone excedente. Si la reposición falla → `surplus_restore_failed` y resultado `unresolved`; la aplicación se conserva (`:132-163`).
5. **Aplicación ausente** (`open|cancelled`): inspecciona ofertas propias; si alguna sigue `open` no la toca; si está `uncertain/cancel_requested` consulta su estado y exige `cancelled`; luego repone las canceladas, libera reserva, reconcilia intenciones y marca `restored` (`:164-207`).
6. **Estado no concluyente** o error de lectura: `apply_uncertain`, conserva reserva, audita y devuelve `unresolved` (`:208-210`, `:660-671`).
7. **Nunca** vuelve a enviar `apply` ni compensa sin evidencia (ADR-0003; test `test/opportunity-orchestrator.test.ts:478`, `:559`).

#### 2.3.3 `ReconcileStandaloneMutation` (UC-09)

- Selecciona intenciones recuperables sin `workflowId`, respetando el backoff persistido y el flag `force` (`src/trading.ts:467-496`; `src/reconciliation-scheduler.ts`).
- Relee la intención antes de actuar y aborta si cambió (`:498-500`).
- **`paid`/`received`/`cancel`**: exige `Operation` local; consulta la orden u oferta remota; actualiza el estado solo si el mapeo es concluyente (`:504-540`; `reconciledOperationMutationState` en `:3912-3926`).
- **Ofertas propias** (`create/edit/cancel`): lista ofertas abiertas una vez; `cancel_offer` exige ausencia de la oferta y página no llena; `edit_offer` compara importes o `refresh: true`; `create_offer` busca coincidencia por tipo/moneda/importes/creación ≤ 60 s (`:541-556`, `:3790-3842`).
- **`apply` sin workflow**: `GET offer`; si es flexible usa la orden; si no, mapea estado remoto y crea o actualiza la operación. Un 404 solo se resuelve como cancelación si el feed autenticado contiene `p2p.cancelled` posterior al intento y anterior a ahora (ADR-0008; `:557-702`).
- Un 403/404 con evidencia textual de VIP/KYC se reconcilia como rechazo definitivo; un 404 genérico **no** (`:684-701`, `:3734-3740`).
- Todo intento deja `reconciliation_last_check:<intentId>` con error saneado y aplica backoff 1/2/4/8/15 min (`:463-466`, `:650-657`; `src/reconciliation-scheduler.ts:11-38`).

#### 2.3.4 Acciones humanas sobre una `Operation`

Patrón común (`src/trading.ts:2211-2232`):

1. Exclusión por UUID en memoria para evitar dobles clics o dos motores en el mismo proceso.
2. Preflight remoto (`getOffer` u orden) y rechazo si el estado no habilita la acción.
3. Revalidación local: estado y `orderUuid` no cambiaron; sin mutación incierta.
4. Ejecución con `MonetaryIntents` (intención durable).
5. Persistencia local del nuevo estado y auditoría.

Reglas específicas:
- `markPaid` exige `sell`, remoto `processing`, referencia no vacía y revalida antes de despachar (`:2130-2163`).
- `confirmReceived` exige `buy`, remoto `processing/paid` (`:2169-2200`).
- `cancel` exige `applied/acknowledged`, remoto `processing`, registra la exclusión automática **antes** de enviar y puede terminar en `revision` (`:2238-2263`).
- La cancelación automática por falta de ACK está desactivada a propósito (`:2239`).

#### 2.3.5 `RebalanceFiatBudget` (UC-27)

1. Preview puro: `proportionalBudgetPlan` reparte el déficit proporcionalmente, conserva tasa, reserva una comisión fija por oferta, ignora importes inválidos y convierte en cancelación cualquier remanente por debajo de 0.1 QUSD o por debajo de una decena CUP (`src/budget.ts:36-121`).
2. El panel crea `RebalanceJob` durable con ajustes `pending` (`src/dashboard.ts:399-483`; `src/store.ts:3151-3179`).
3. Un ajuste en `applying` al arrancar se degrada a `reconciliation_required`; se intenta conciliar contra intenciones recientes antes de reintentar (`src/dashboard.ts:500-529`).
4. Cada ajuste usa las mismas mutaciones durables que UC-26; un incierto detiene el job y notifica; un rechazo lo marca `partial`/`failed` (`:531-598`).
5. Postcondición: ofertas editadas/canceladas, saldo fiat liberado y evidencia en auditoría; nunca se repone automáticamente un ajuste fallido.

---

## 3. Tabla de invariantes duros

**Leyenda de criticidad:** `P0` = pérdida de dinero o exposición duplicada; `P1` = corrupción de estado o decisión incorrecta; `P2` = degradación operativa o de explicabilidad.

### 3.1 Dinero, capital y reservas

| ID | Invariante | Evidencia | Test / verificación | Riesgo | Crit. |
|---|---|---|---|---|---|
| **INV-01** | Todo importe y límite usado en una decisión debe ser finito y no negativo; un importe QUSD 0 o una tasa 0 es error, no “bloqueo”. | `src/core/risk-policy.ts:367-401` | `test/risk-policy.test.ts:158` | Decisión con `NaN`/`Infinity` que atraviesa comparaciones y aplica capital no acotado. | P0 |
| **INV-02** | La reserva QUSD de un workflow es exclusiva y solo se crea si `Σ reservas activas + amount ≤ maxConcurrentQusdExposure`; se evalúa e inserta atómicamente. | `src/store.ts:1614-1635`; `src/application/opportunity-orchestrator.ts:355-379` | `test/repository.test.ts:541`; `test/application-reservations.test.ts:8` | Dos operaciones comprometen el mismo QUSD. | P0 |
| **INV-03** | Cada intención `apply` crea su reserva de capital (fiat/QUSD/amount) en la **misma transacción** que la intención; la reserva se elimina al proyectar la `Operation` y también cuando la intención pasa a `rejected`/`reconciled` (trigger SQL). | `src/store.ts:1325-1334`, `:918-921`, `:2542-2543`, `:1366-1372` | `test/application-reservations.test.ts:8`, `:19` | Capital gastado sin reserva, o reserva liberada antes de confirmar la operación. | P0 |
| **INV-04** | La exposición activa es `Σ amount de operaciones activas + Σ reservas QUSD activas`; el QUSD adeudado a participantes cooperativos no cuenta como libre. | `src/application/opportunity-orchestrator.ts:313-317`; `src/trading.ts:1399-1402` | `test/opportunity-orchestrator.test.ts:173`; `test/cooperative-capital.test.ts:43` | Exposición subestimada y aplicación por encima del límite. | P0 |
| **INV-05** | `risk.minQusdReserve` es la única reserva QUSD; `qusdReserve` se harmoniza a ese valor al cargar/guardar. | `src/market-config.ts:582-597`; ADR-0005 | `test/repository.test.ts:281` | UI y motor calculan capital libre distinto; se compromete la reserva. | P0 |
| **INV-06** | En cada mercado, `sellMinRate * (1 - sellFeePercent/100) > buyMaxRate`. | `src/market-config.ts:343-348` | `test/repository.test.ts:281` | Comprar y vender al mismo precio destruye capital por comisiones. | P0 |
| **INV-07** | `maxQusdPerOperation ≤ maxConcurrentQusdExposure` y `≤ maxDailyAppliedQusd`; `maxConcurrentOperations ≥ 1`; `maxSlippagePercent ≤ 100`. | `src/market-config.ts:551-580` | `test/repository.test.ts:281` | Límites incoherentes que el motor no puede respetar simultáneamente. | P1 |
| **INV-08** | Un plan de liquidez es **todo-o-nada**: si la suma de ofertas propias seleccionables no alcanza, no se cancela ninguna. | `src/core/liquidity-plan.ts:153-164` | `test/liquidity-plan.test.ts:105` | Cancelar liquidez sin poder aplicar, dejando capital inmovilizado y sin compensación. | P0 |
| **INV-09** | La reposición usa el snapshot original completo y una clave de idempotencia determinista; un `409` se resuelve confirmando la oferta ya creada. | `src/application/opportunity-orchestrator.ts:593-640`, `:696-716`; `src/store.ts:3522-3526` | `test/opportunity-orchestrator.test.ts:191`, `:277`, `:594` | Duplicar ofertas propias y por tanto QUSD inmovilizado. | P0 |
| **INV-10** | Un excedente < 0.1 QUSD no se repone; se marca `consumed` y se audita. | `src/application/opportunity-orchestrator.ts:555-568`; `src/market-math.ts:19` | `test/opportunity-orchestrator.test.ts:316` | Crear una oferta que QvaPay rechazará y dejar el workflow bloqueado. | P1 |
| **INV-11** | Los totales CUP deben ser múltiplos de 10 y nunca cruzar la tasa contra el propietario: compras redondean abajo, ventas arriba. | `src/market-math.ts:42-72`; `src/budget.ts:129-153` | `test/market-math.test.ts:28-46`; `test/rate-rounding.test.ts:5-10`; `test/opportunity-orchestrator.test.ts:357` | Transferencias no realizables o pérdida por redondeo. | P1 |

### 3.2 Mutaciones, incertidumbre y cuotas

| ID | Invariante | Evidencia | Test / verificación | Riesgo | Crit. |
|---|---|---|---|---|---|
| **INV-12** | Persistir la intención **antes** de llamar a QvaPay; si falla la persistencia inicial, no se despacha. | `src/application/monetary-intents.ts:48-64` | `test/monetary-intents.test.ts:95`; `test/operation-actions.test.ts:155` | Mutación sin rastro durable: imposible conciliar ni auditar. | P0 |
| **INV-13** | Un resultado incierto no se reintenta ni se compensa hasta conciliar; la oferta queda bloqueada. | ADR-0003; `src/application/opportunity-orchestrator.ts:467-481`; `src/trading.ts:573` | `test/opportunity-orchestrator.test.ts:422`; `test/operation-actions.test.ts:148`; `test/trading-automation.test.ts:573` | Duplicar una aplicación que sí ocurrió. | P0 |
| **INV-14** | Una compensación solo sigue a un rechazo confirmado o a una conciliación que descarte la aplicación. | `docs/ARCHITECTURE.md:79`; `src/application/opportunity-orchestrator.ts:164-207`, `:482-491` | `test/opportunity-orchestrator.test.ts:277`, `:515` | Reponer una oferta propia cuando la aplicación externa sí ocurrió: doble exposición. | P0 |
| **INV-15** | `apply` tiene 2 intentos por ventana móvil de 60 s, persistidos entre reinicios, y respeta `Retry-After`; una prevalidación fallida no consume cuota y deja la intención `rejected`, no `uncertain`. | `src/core/apply-budget.ts:5-30`; `src/qvapay.ts:114-126`; ADR-0009 | `test/qvapay-gateway.test.ts:193`, `:236`, `:256` | Ráfaga tras reinicio o gasto de cuota antes de comprobar condiciones. | P0 |
| **INV-16** | Una mutación sin resolver **de la misma oferta** impide una nueva aplicación; la intención propia en despacho se excluye. Cualquier otra intención no bloquea la cacería (comportamiento real; ver §6.2). | `src/trading.ts:3132-3154`, `:1148-1151`; `src/store.ts:1475-1479` | `test/manual-cancel-race.test.ts:112`, `:130`, `:146`; `test/trading-automation.test.ts:130` | Reaplicar sobre una oferta en estado desconocido. | P0 |
| **INV-17** | La incertidumbre sobrevive a reapertura del repositorio y solo se resuelve con evidencia remota concluyente. | `src/store.ts:365-369`, `:1436-1463` | `test/operation-actions.test.ts:136`; `test/application-reservations.test.ts:8` | Reinicio que libera capital o reintenta una mutación incierta. | P0 |
| **INV-18** | Una intención `confirmed` con reserva de aplicación pendiente se degrada a `uncertain` al abrir la base. | `src/store.ts:365-369` | `test/application-reservations.test.ts:8` | Crash entre confirmación HTTP y proyección local que libera capital o reenvía. | P0 |
| **INV-19** | La conciliación solo lee estado remoto; nunca reemite la mutación original. | `src/application/opportunity-orchestrator.ts:95-211`; `src/trading.ts:457-711` | `test/opportunity-orchestrator.test.ts:478`; `test/reconciliation-feed.test.ts:55` | Reintento implícito durante recuperación. | P0 |

### 3.3 Workflow, compensación y ordenamiento

| ID | Invariante | Evidencia | Test / verificación | Riesgo | Crit. |
|---|---|---|---|---|---|
| **INV-20** | Como máximo hay un workflow por UUID objetivo (`target_offer_uuid UNIQUE`) y, en un proceso, una sola ejecución en vuelo por orquestador. | `src/store.ts:515`; `src/application/opportunity-orchestrator.ts:66`, `:79-86` | `test/opportunity-orchestrator.test.ts:478`; `test/market-ingest-serialization.test.ts:44` | Dos sagas sobre la misma oferta: doble `apply` y doble reserva. | P0 |
| **INV-21** | Los workflows no terminales se recuperan al arrancar; los terminales son `applied`, `restored`, `blocked`. | `src/store.ts:1536-1547`; `src/application/opportunity-orchestrator.ts:98-104` | `test/opportunity-orchestrator.test.ts:478`, `:515` | Capital retenido para siempre o compensación repetida. | P1 |
| **INV-22** | La aplicación confirmada no se revierte si falla la reposición del excedente; el workflow queda `surplus_restore_failed` y se alerta. | `src/application/opportunity-orchestrator.ts:438-451` | `test/opportunity-orchestrator.test.ts:390` | Perder una aplicación real por un fallo de compensación accesoria. | P0 |
| **INV-23** | Antes de reponer una oferta propia cancelada se confirma que el remoto la ve cancelada; una oferta remota `open` no se toca. | `src/application/opportunity-orchestrator.ts:177-195`, `:536-553` | `test/opportunity-orchestrator.test.ts:515`, `:559` | Duplicar una oferta propia que nunca se canceló. | P0 |
| **INV-24** | El pago fiat nunca lo ejecuta el sistema; solo se registra una referencia humana verificada. | `CONTEXT.md:51-53`; `README.md:3`; `src/trading.ts:2126-2163` | `test/operation-actions.test.ts:34-184` | Acusación de pago no realizado o pago duplicado. | P0 |
| **INV-25** | Una orden flexible se identifica por su UUID de orden; el estado del padre nunca sustituye al de la hija. | `src/flexible-order.ts:15-35`; ADR-0009 | `test/flexible-order.test.ts:29`, `:59`; `test/trading-automation.test.ts:1510` | Pagar/conciliar contra la oferta equivocada. | P0 |

### 3.4 Mercado, precio y decisión

| ID | Invariante | Evidencia | Test / verificación | Riesgo | Crit. |
|---|---|---|---|---|---|
| **INV-26** | Una ronda de escaneo aplica como máximo una oportunidad; una candidata bloqueada no impide evaluar la siguiente. | `docs/ARCHITECTURE.md:88`; `src/trading.ts:1677-1772`, `:1888-1906` | `test/trading-automation.test.ts:1159`; `test/market-ingest-serialization.test.ts:44` | Sobreexposición por ronda y competencia entre candidatas. | P1 |
| **INV-27** | El refresco automático edita como máximo una oferta propia por ejecución y respeta 20 s entre ediciones. | `docs/ARCHITECTURE.md:89`; ADR-0007; `src/trading.ts:2897-2947` | `test/trading-automation.test.ts` (refresco/`last_offer_edit_at`); `test/qvapay-gateway.test.ts:150` | Ráfaga de ediciones y bloqueo de cuota. | P1 |
| **INV-28** | La mediana de seguridad usa la mediana oficial si existe; una estimación local exige ≥ 3 UUID distintos, excluye valores sospechosos, caduca a los 5 min y no se rejuvenece con lecturas de otros mercados. | `src/trading.ts:766-809`, `:3044-3067`, `:3156-3167`; `docs/plans/2026-10-03-manual-cancel-exclusion-design.md` | `test/trading-automation.test.ts:242`, `:257`, `:271`, `:285` | Una oferta barata se convierte en su propia referencia y autoriza una compra ruinosa. | P0 |
| **INV-29** | La antigüedad de cotización es bloqueo duro; `slippage` y `cooldowns` son advertencias (no bloquean). | `src/core/risk-policy.ts:150-193`; `docs/ARCHITECTURE.md:84` | `test/risk-policy.test.ts:104`, `:123` | Operar con precio viejo o bloquear de más por advertencias. | P1 |
| **INV-30** | Un evento de feed con `sent_at` > 5 s no se usa para aplicar. | `src/trading.ts:954-958` | `test/trading-automation.test.ts:904` | Aplicar a un precio ya desaparecido. | P1 |
| **INV-31** | La exclusión por cancelación manual es persistente a reinicios y reaperturas, bloquea ambas vías automáticas y no se borra con una aplicación manual explícita. | `src/store.ts:2637-2651`; `src/trading.ts:930-933`, `:1103-1104`, `:2969-2970` | `test/manual-cancel-exclusion.test.ts:42`, `:167`; `test/manual-cancel-race.test.ts:204` | Reaplicar automáticamente a una oferta que el propietario rechazó. | P1 |
| **INV-32** | Una oferta con `only_vip` verdadero o no interpretable se ignora; los hechos de requisitos ausentes o viejos nunca se inventan como cero. | `src/trading.ts:2995-3004`; `src/hunting-requirements.ts:38-50` | `test/trading-automation.test.ts:370`, `:473`; `test/hunting-requirements.test.ts:6` | Aplicar a una oferta que QvaPay rechazará o exponer capital sin elegibilidad. | P1 |
| **INV-33** | Pausa, parada de emergencia y modo simulación son bloqueos duros; la ausencia de la clave `paused` se interpreta como pausado. | `src/application/opportunity-orchestrator.ts:319`; `src/trading.ts:314-317`, `:1148`, `:1242` | `test/trading-automation.test.ts:175`, `:207`; `test/hunting-pause.test.ts` | Arrancar activo por defecto y operar sin supervisión. | P0 |

### 3.5 Configuración, lecturas y arranque

| ID | Invariante | Evidencia | Test / verificación | Riesgo | Crit. |
|---|---|---|---|---|---|
| **INV-34** | La configuración financiera vive en SQLite, se valida, se versiona con hash encadenado y cada revisión es auditable. | `src/market-config.ts:169-179`; `src/store.ts:1122-1304` | `test/repository.test.ts:156`, `:281`, `:319`; `test/config-integrity-performance.test.ts` | Cambios no auditados o cadenas de revisión manipuladas. | P1 |
| **INV-35** | Los límites no revisados (`reviewedAt === null`) fuerzan `manual_review`, pero la vía rápida del feed solo los registra como advertencia (ver §6.4). | `src/application/opportunity-orchestrator.ts:276-279`; `src/trading.ts:1184`, `:3233-3237` | `test/opportunity-orchestrator.test.ts:454`; `test/trading-automation.test.ts:312` | Aplicar automáticamente sin revisión humana de límites. | P0 |
| **INV-36** | Una lectura remota fallida nunca borra ni presenta como actual la última lectura válida. | `docs/ARCHITECTURE.md:87`; `src/qvapay.ts`; `src/dashboard.ts` | `test/dashboard-local-snapshot-regression.test.ts`; `test/server-dashboard-cache-regression.test.ts` | Decisión financiera con dato guardado como si fuera fresco. | P1 |
| **INV-37** | Reanudar desde Telegram o web valida primero una sesión real de QvaPay. | `docs/ARCHITECTURE.md:82`; `src/trading.ts:443-451` | `test/trading-automation.test.ts:207` | Reanudar con token inválido y fallar en bucle. | P1 |
| **INV-38** | Al arrancar se concilian intenciones standalone y workflows no terminales antes de aceptar trabajo nuevo. | `src/index.ts:624-657`; ADR-0003 | `test/opportunity-orchestrator.test.ts:478`; `test/self-service-recovery.test.ts` | Nuevas operaciones sobre estado local desactualizado. | P0 |
| **INV-39** | Si el panel autenticado no puede arrancar, el proceso completo falla antes de iniciar scheduler o bot. | `src/index.ts:205-214` (top-level await antes de `bootstrap` en `:605-657`) | Arranque real/integración de `http-dashboard` | Proceso sin panel de control operando dinero real. | P0 |
| **INV-40** | Secretos, credenciales y el interruptor `CONFIRM_REAL_TRADING` no forman parte de la configuración operativa editable; viven en entorno. | `src/config.ts:1-123`; `src/market-config.ts:30-49`; `src/trading.ts:3600-3605` | `test/repository.test.ts:156`; `test/core.test.ts:16-24` (vault) | Exposición de secretos o habilitación de real sin control de despliegue. | P0 |
| **INV-41** | Las reglas de una operación ya iniciada se conservan: el workflow persiste su `RiskDecision` y la `Operation` su `referenceRate`; **no** se persiste el `configRevisionId` completo (mejora propuesta en §6). | `src/store.ts:513-521`; `src/application/opportunity-orchestrator.ts:350-354`; `src/trading.ts:3504-3517` | `test/opportunity-orchestrator.test.ts:454`; `test/repository.test.ts:541` | Explicar una operación histórica con límites nuevos, o no poder reconstruir por qué se aplicó. | P1 |

### 3.6 Invariantes documentados que **no** coinciden con el código

Estas discrepancias son hallazgos del análisis y deben resolverse antes de fijar el contrato de paridad:

| Invariante documentado | Qué hace el código | Consecuencia para la migración |
|---|---|---|
| “No se inicia una operación si existe una mutación sin resolver” (`docs/ARCHITECTURE.md:81`) | Solo bloquea la oferta afectada: `hasUnresolvedMutationForOffer(uuid)` (`src/application/opportunity-orchestrator.ts:321`; `src/trading.ts:3132-3154`). `hasUnresolvedMutation()` global solo alimenta dashboard y recovery (`src/dashboard.ts:802`; `src/self-service-recovery.ts:108`). | Decidir si el nuevo servicio hereda el bloqueo por oferta (comportamiento real) o el global (documentado). Hay tests que exigen el comportamiento por oferta: `test/manual-cancel-race.test.ts:112`. |
| “Al alcanzar el límite configurado de errores consecutivos, la automatización se pausa de forma persistente” (`docs/ARCHITECTURE.md:85`) | El contador se incrementa en `handleError` y se resetea con cada escaneo exitoso (`src/trading.ts:3607-3631`, `:3689`), pero **no se pausa**. El riesgo solo emite un `warning` (`src/core/risk-policy.ts:171-177`). `initializeProductionState` reconoce un motivo de pausa heredado que el código actual ya no genera (`src/trading.ts:421-428`). | Si el nuevo sistema implementa la pausa, cambia comportamiento. Si no, el documento de arquitectura debe corregirse. |
| “Los rangos, capital, reservas, exposición, concurrencia, volumen y estado remoto continúan siendo bloqueos duros” (`docs/ARCHITECTURE.md:84`) | La vía rápida del feed aplica sin `evaluateRisk`; los límites globales se auditan como `warnings` (`src/trading.ts:1180-1194`, `:1144-1162`). | Asimetría de enforcement; decisión explícita en §6.4. |
| `OperationState` incluye `failed` (`src/types.ts:142`) | Ninguna transición asigna `failed`; solo `applied`, `acknowledged`, `paid`, `revision`, `cancelled`, `completed`. | No portar `failed` salvo que se implemente una transición con semántica definida. |

---

## 4. Pipeline de decisión paso a paso

### 4.1 Vista general

```text
                ┌─────────────────────────────────────────────────────────────┐
                │ FUENTES DE OPORTUNIDAD                                      │
                │ polling (páginas) · feed híbrido (SSE/webhook) · manual     │
                └───────────────┬───────────────────────────┬─────────────────┘
                                │                           │
                    scanOnce / inspectMarketSide      ingestMarketOffer
                                │                           │
                        classifyOffer               ingestPreparedMarketOffer
                     (precio, VIP, mediana)          (VIP, requisitos, frescura)
                                │                           │
                     processSnapshots               vía rápida (fiat o QUSD)
                                │                    o takeFlexibleOffer
                                │                           │
                     evaluateAutomaticBuy          ┌────────┴─────────┐
                     (solo ofertas sell)           │                  │
                                │              fiat-funded       QUSD-funded
                                ▼              applyBuyQusd       intención apply
                        evaluateRisk()          (sin risk policy)   (sin risk policy)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
            (compra QUSD)              (venta QUSD)
            applyBuyQusd            OpportunityOrchestrator
            + intención apply        reserva → liquidez → cancelar
                                     propias → apply → reponer
```

Los dos productos del pipeline son:
- **Comprar QUSD** a una oferta externa de tipo `sell` (financia fiat; puede ser vía rápida o riesgo completo).
- **Vender QUSD** a una oferta externa de tipo `buy` (requiere QUSD libre; casi siempre pasa por el workflow compensable porque puede necesitar cancelar ofertas propias).

### 4.2 Entradas del pipeline

| Entrada | Origen | Observaciones |
|---|---|---|
| Oferta normalizada | `parseOffer` en `src/qvapay.ts:934-962`; feed normalizado | Importes como number, flags normalizados, detalles de pago normalizados |
| Página de mercado | `P2pListPage` (`src/types.ts:93-100`) | `total`, `page`, `perPage`, `timing`, `cacheStatus` |
| Configuración activa | `MarketConfigService.current()` (`src/market-config.ts:102-115`) | Copia profunda con saldos fiat superpuestos desde `settings` |
| Saldo QUSD | `qusdBalanceCache.get()` | Cache de 15 s con epoch/version; no confirmación remota obligatoria en cada decisión |
| Saldo fiat | `fiatBalance(coin)` (`src/trading.ts:326-328`) | Derivado de `settings` y del ledger fiat |
| Exposición y volumen | `activeOperations`, `activeReservedQusd`, `dailyAppliedQusd` | Leídos de SQLite en el momento de la decisión |
| Cooldowns | `lastOperationAt(market, counterparty)` (`src/store.ts:1695-1712`) | Ventanas por mercado y contraparte |
| Hechos de elegibilidad | `hunting_eligibility` (`src/hunting-requirements.ts`) | Frescura 60 s; no se inventan ceros |
| Exclusiones | `manual_cancel_exclusions` (`src/store.ts:2637-2651`) | Persistentes |
| Estado del feed por oferta | `latestMarketFeedState(uuid)` | Permite invalidar una oferta con evidencia posterior |

### 4.3 Decisión de precio (clasificación)

`classifyOffer` (`src/trading.ts:2966-3114`) aplica este orden exacto:

1. Oferta pausada → `ignored`.
2. Excluida por cancelación manual → `ignored`.
3. Ya existe `Operation` local → `ignored` (requiere acción manual).
4. No operable (`status ≠ open`, mercado desconocido, importes ≤ 0) → `ignored`.
5. Flexible: dimensionar por capital/rango; si no alcanza → `ignored`.
6. VIP verdadero o no interpretable → `ignored`.
7. Cacería del lado correspondiente detenida → `ignored`.
8. Para oferta `sell` (comprar QUSD):
   - supera `purchaseMaxQusd` → `ignored`;
   - tasa nominal > `buyMaxRate` → `ignored`;
   - tasa efectiva > `buyMaxRate` → `blocked`;
   - precio sospechosamente bajo contra mediana local → `blocked`;
   - sin mediana de venta → `blocked`;
   - `rate < median_sell * (1 - guard/100)` → `blocked`;
   - sin saldo fiat suficiente → `ignored`;
   - todo pasa → `auto_buy`.
9. Para oferta `buy` (vender QUSD):
   - `rate < sellMinRate` → `ignored`;
   - sin mediana de compra → `blocked`;
   - `rate > median_buy * (1 + guard/100)` → `blocked`;
   - todo pasa → `manual_sell` (siempre requiere aplicación manual o workflow automático de venta).

`blocked` genera `DecisionEvent` y `TradingAlert`; `ignored` no genera alerta (`src/trading.ts:1632-1675`, `:1888-1899`).

### 4.4 Evaluación de riesgo (comprar QUSD por escaneo)

`evaluateAutomaticBuy` (`src/trading.ts:3196-3264`) construye el contexto y llama a `evaluateRisk`:

1. Calcula `transfer = outgoingFiatCost(amount, rate, fee)`.
2. Calcula margen esperado: `(sellMinRate * amount * (1 - sellFeePercent/100) - transfer.total) / transfer.total * 100`.
3. Puerta de precio:
   - tasa efectiva > `buyMaxRate` → `blocked`;
   - `reviewedAt === null` → `manual_review`;
   - sin referencia de mercado → `blocked`;
   - en otro caso `eligible`.
4. Pasa saldo fiat declarado, exposición, volumen diario, operaciones activas, errores consecutivos, pausa, emergencia, mutación incierta y cooldowns.
5. `evaluateRisk` evalúa 14 checks + la puerta de precio (`src/core/risk-policy.ts:97-210`):
   - duros: `emergency_stop`, `automation_paused`, `unresolved_mutation`, `operation_amount`, `concurrent_exposure`, `daily_volume`, `concurrent_operations`, `quote_age`, `expected_margin`, `capital` (`fiat_capital` o `qusd_capital`);
   - advisory: `slippage`, `consecutive_errors`, `market_cooldown`, `counterparty_cooldown`.
6. La decisión final es `apply` solo si ningún check duro falla.

### 4.5 Evaluación de riesgo (vender QUSD / workflow)

`OpportunityOrchestrator.executeOnce` (`src/application/opportunity-orchestrator.ts:280-327`) usa el mismo `evaluateRisk` con `side: "sell_qusd"`:

- `requiredQusd = target.amount`; `requiredFiat = 0`.
- `capitalCheck` usa `qusdBalance - minQusdReserve` (`src/core/risk-policy.ts:243-260`).
- El `qusdBalance` inyectado es el saldo libre + lo que el plan de liquidez podría liberar (`src/application/opportunity-orchestrator.ts:307-312`).
- La viabilidad de liquidez se integra como `priceDecision = blocked` cuando el plan no es viable (`:300-305`).
- `observedAt` es `now` de la observación actual, no `created_at` remoto (`:291-294`).
- Antes de reservar se hidratan los snapshots y se valida la oferta propia; después se reserva atómicamente.

### 4.6 Aplicación

| Vía | Función | Reserva previa | Política de riesgo | Mutación | Post-evento |
|---|---|---|---|---|---|
| Escaneo, comprar QUSD | `processSnapshots → evaluateAutomaticBuy → applyBuyQusd` | `application_capital_reservations` (fiat) | Sí (`evaluateRisk`) | `apply` | `Operation(sell)` + decisión aplicada |
| Feed, comprar QUSD | `ingestFastFiatFundedOffer → applyBuyQusd` | Igual | **No** (solo warnings) | `apply` | Ídem; `market_feed_last_decision_ms` |
| Feed, vender QUSD | `ingestFastQusdFundedOffer` | Intención `apply` con reserva QUSD | **No** | `apply` | `Operation(buy)`; cache de saldo ajustado si no cambió el epoch |
| Flexible | `takeFlexibleOffer` | Intención con importe y reserva | Parcial (precio mín/máx) | `apply(amount)` | `Operation` con `orderUuid`; orden hija |
| Manual | `applyManually` | Intención | Comprobaciones locales, no `evaluateRisk` completo | `apply` | `Operation` manual |
| Bloqueada revisada | `applyBlockedOffer` | Según vía | `evaluateAutomaticBuy` (solo se omite el bloqueo de precio) | `apply` | Resuelve alerta y decisión |
| Venta QUSD | `OpportunityOrchestrator.execute` | `capital_reservations` QUSD | Sí | `cancel` propias + `apply` | Workflow + `Operation` + reposición |

### 4.7 Reglas de sizing y redondeo en la aplicación

1. **Oferta fija**: se aplica por el `amount` exacto de la oferta; el fiat a pagar es `receive + outgoingTransferFee` para compras, y el QUSD a comprometer es `amount` para ventas (`src/trading.ts:878-884`).
2. **Oferta flexible**: `amount = floor(min(available, max, capacity, limit) * 100) / 100`; `receive = amount * quote`; nunca supera el capital disponible (`src/flexible-order.ts:4-13`).
3. **Liquidez**: `requiredRelease = max(0, target.amount + reserve - available)`; se seleccionan ofertas propias por peor rentabilidad primero, luego mayor importe, luego más antiguas, luego UUID (`src/core/liquidity-plan.ts:95-151`).
4. **Reposición**: `restoreQusd` calculado por el plan; si es < 0.1 se marca `consumed`; el total fiat se recalcula con la tasa original del snapshot y la regla CUP (`src/application/opportunity-orchestrator.ts:555-568`, `:696-716`; `src/market-math.ts:42-72`).
5. **Reserva mínima**: al calcular capital libre QUSD se resta `minQusdReserve` en la política; el plan de liquidez también la incluye en `requiredRelease` (`src/core/risk-policy.ts:253-259`; `src/core/liquidity-plan.ts:99-102`).

### 4.8 Orden de serialización y control de concurrencia

```text
escaneo manual ──┐
feed opportunity ─┼─► withDecisionTurn / withFiatDecision (proceso)
polling ──────────┘        │
                           ▼
                  ingestMarketUpdate espera al scan manual en vuelo
                           │
                           ▼
                  processSnapshots: una aplicación por ronda
                           │
                           ▼
                  MonetaryIntents: intención durable
                           │
                           ▼
                  QvaPayClient: cola apply independiente + ventana de 2/60 s
```

- `withDecisionTurn` serializa todas las decisiones financieras en una cola de promesas (`src/trading.ts:886-891`).
- `withFiatDecision` permite como máximo 2 decisiones fiat concurrentes y hace esperar al resto (`:866-876`).
- `ingestMarketUpdate` espera explícitamente al escaneo manual en vuelo y luego evalúa la página recibida (`:811-838`).
- `marketEvaluationContext` (AsyncLocalStorage) propaga un guard `isCurrent` para descartar páginas tras pausa/cambio de generación (`:87`, `:319`, `:830-832`).
- El transporte de QvaPay tiene colas separadas por política: aplicaciones, lecturas críticas y tareas normales (`src/qvapay.ts:141-146`, ADR-0009).

---

## 5. Lógica determinista pura vs lógica con I/O

### 5.1 Inventario y portabilidad

| Módulo | LOC | Responsabilidad | Dependencias | Tests que la cubren | Portabilidad | Orden sugerido |
|---|---:|---|---|---|---|---|
| `src/core/risk-policy.ts` | 401 | Evaluación de límites globales y evidencia de decisión | Solo tipos locales | `test/risk-policy.test.ts` (8) | **Alta** | 1 |
| `src/core/liquidity-plan.ts` | 287 | Plan todo-o-nada de liberación de QUSD e hidratación de snapshots | `../market-math.js`, `../types.js` | `test/liquidity-plan.test.ts` (9) | **Alta** | 2 |
| `src/market-math.ts` | 114 | Mediana, costo de salida, redondeo fiat/CUP, redondeo de índice | Ninguna | `test/market-math.test.ts` (7), `test/rate-rounding.test.ts` (2) | **Alta** | 1 (base numérica) |
| `src/core/apply-budget.ts` | 30 | Ventana durable de 2 intentos `apply`/60 s y migración del throttle legado | Interfaz `get` | `test/qvapay-gateway.test.ts:193` | **Alta** | 2 |
| `src/budget.ts` | 154 | Plan proporcional de reducción de ofertas propias | `market-math`, `types` | `test/budget.test.ts` (6) | **Alta** | 3 |
| `src/flexible-order.ts` | 35 | Dimensionado de órdenes flexibles, selección de la orden hija y recuperación | `types` | `test/flexible-order.test.ts` (5) | **Alta** | 2 |
| `src/hunting-requirements.ts` | 50 | Evaluación de requisitos de anunciante con hechos frescos | Interfaz `get`/`set` | `test/hunting-requirements.test.ts` (1) | **Alta** | 3 |
| `src/reconciliation-scheduler.ts` | 79 | Backoff persistido por intención (1/2/4/8/15 min) | Interfaz `get`/`set` | `test/reconciliation-scheduler.test.ts` (5) | **Alta** | 2 |
| `src/operation-display-state.ts` | 11 | Proyección read-only de estado local vs remoto | Ninguna | Integrada | **Alta** | 4 |
| `src/qusd-balance-cache.ts` | 115 | Cache de saldo con epoch, revisión, secuencia y dedupe de lecturas | Callbacks inyectados | `test/qusd-balance-cache.test.ts` (13) | **Media** (concurrencia) | 5 |
| `src/market-list-budget.ts` | 92 | Presupuesto compartido de listados por minuto | Interfaz `Store` | `test/market-list-budget.test.ts` | **Media** | 5 |
| `src/scheduler.ts` | 83 | Scheduler de intervalos con reentrada bloqueada | Timers | `test/scheduler.test.ts` | **Media** | 6 |
| `src/trading-analytics.ts` | 204 | Proyección pura de ofertas/transacciones | `types` | `test/trading-analytics.test.ts` | **Alta** (fuera del core) | 7 |
| `src/price-simulation.ts` | 53 | Simulación de precios | `types`, `market-math` | Integrada | **Alta** (fuera del core) | 7 |
| `src/application/monetary-intents.ts` | 110 | Protocolo durable de mutación (sin I/O propio, colabora con repository y action) | `qvapay` errores, `Store` tipos | `test/monetary-intents.test.ts` (5) | **Media** | 4 |
| `src/application/opportunity-orchestrator.ts` | 767 | Saga compensable | `Store`, `QvaPayGateway`, config, intents | `test/opportunity-orchestrator.test.ts` (18) | **Baja** | 6 |
| `src/application/market-hunting-loops.ts` | 117 | Colas/consumidores de páginas y polling | Scheduler, source, trading | `test/market-hunting-loops.test.ts` (12) | **Baja** | 7 |
| `src/application/hunting-balance-loops.ts` | 25 | Cierre ordenado de lecturas de saldo y liquidez | Scheduler, trading | `test/hunting-balance-loops.test.ts` (1) | **Baja** | 7 |
| `src/trading.ts` | 3.994 | Fachada de casos de uso y vías de aplicación | Todo | `test/trading-automation.test.ts` (55), `test/manual-cancel-*.test.ts`, `test/operation-actions.test.ts`, `test/hunting-pause.test.ts`, `test/market-ingest-serialization.test.ts` | **Baja** | 8 |
| `src/store.ts` | 3.643 | Persistencia, migraciones, transacciones, config, read models | SQLite (`node:sqlite`), cripto | `test/repository.test.ts`, `test/application-reservations.test.ts`, etc. | **Baja** | 9 |
| `src/qvapay.ts` | 1.100 | Transporte, cuotas, clasificación y normalización | `fetch` | `test/qvapay-*.test.ts` | **Baja** | 9 |
| `src/market-feed.ts` | 559 | Stream/webhook, dedupe, cola híbrida | `Store`, NATS/HTTP | `test/market-feed.test.ts` | **Baja** | 8 |
| `src/market-source.ts` | 445 | Polling multi-cuenta y presupuesto de listados | `Store`, gateway | `test/market-source.test.ts` | **Baja** | 8 |
| `src/hunting-sync.ts` | 759 | Cliente Sync Core + NATS | HTTP/NATS, vault | `test/hunting-sync.test.ts`, `test/cooperative-*.test.ts` | **Baja** | 10 |
| `src/cooperative-hunter.ts` | 243 | Cacería cooperativa de segunda prioridad | Sync Core, QvaPay, store | `test/cooperative-hunter.test.ts` | **Baja** | 10 |
| `src/dashboard.ts` | 1.323 | Read model local-first y comandos de panel | Store, trading, QvaPay, chat | `test/dashboard*.test.ts` | **Baja** | 11 |
| `src/http-dashboard.ts` | 1.438 | Adaptador HTTP, auth, CSRF, OpenAPI | Fastify, dashboard | `test/http-dashboard.test.ts` | **Baja** | 12 |
| `src/index.ts` | 1.687 | Bootstrap y wiring de todo | Todo | Integrada | **Baja** | 12 |

**Conclusión de portabilidad.** El núcleo determinista (filas 1–9) suma **~1.161 LOC** y no tiene I/O de red ni acceso directo a SQLite; sus dependencias son `types.ts` y `market-math.ts`. Es la primera extracción natural. `MonetaryIntents` es el siguiente seam porque define el protocolo externo, aunque su implementación actual está acoplada a `Store` y a los errores de `QvaPayClient`.

### 5.2 Contratos que el nuevo servicio debe congelar antes de portar

1. **`RiskLimits` + `RiskContext` + `RiskDecision`**: son el contrato más importante (`src/core/risk-policy.ts:18-74`). Cualquier implementación Go/Rust debe producir exactamente los mismos `checks`, `kind`, `reasons`, `projectedExposureQusd` y `projectedDailyAppliedQusd` para los mismos inputs.
2. **`LiquidityPlanInput` + `LiquidityPlan`**: incluye el snapshot restaurable con datos de pago; es a la vez contrato de dominio y dato sensible (`src/core/liquidity-plan.ts:4-49`).
3. **Protocolo `MonetaryMutation`**: `kind` + `request` + `action` + `idempotencyKey` + clasificación de error (`src/application/monetary-intents.ts:10-18`, `:92-102`).
4. **`QvaPayGateway`**: 15 operaciones (`src/core/ports.ts:8-25`). Es el único puerto externo del núcleo; todo lo demás es persistencia.
5. **`TradingRepository`**: hoy expone ~40 métodos y filtra SQLite (`src/core/ports.ts:28-72`). Para Go/Rust conviene partirlo en al menos: `WorkflowRepository`, `ReservationLedger`, `MutationIntentRepository`, `OperationRepository`, `MarketLedger` (feed/observaciones/exclusiones), `ConfigRepository`.

### 5.3 Estrategia de paridad recomendada

- **Vectores dorados**: exportar los inputs de `evaluateRisk`, `planLiquidity`, `proportionalBudgetPlan`, `ownOfferFiatTotal`, `roundRateForIndex`, `sizeFlexibleOffer`, `applyReadyAt` desde los tests actuales y compararlos contra la implementación nueva. La suite actual ya es casi una especificación ejecutable: `test/risk-policy.test.ts`, `test/liquidity-plan.test.ts`, `test/budget.test.ts`, `test/market-math.test.ts`, `test/rate-rounding.test.ts`, `test/flexible-order.test.ts`.
- **Property tests** sobre las invariantes numéricas: monotonía de exposición, `apply` solo si todos los duros pasan, plan de liquidez todo-o-nada, reposición idempotente.
- **Simulador de proveedor**: los tests existentes inyectan un gateway determinista (`test/opportunity-orchestrator.test.ts`; `test/trading-automation.test.ts`). Ese doble debe convertirse en un *service contract* reutilizable entre TS y Go/Rust.
- **Replay de auditoría**: `audit_log` y `decision_events` contienen secuencias reales; pueden usarse como corpus de regresión, siempre anonimizadas (contienen UUID, importes y datos de pago en algunos `detail`).

---

## 6. Ambigüedades y decisiones abiertas para el rediseño en microservicios

> **Nota de alineación.** Este análisis se escribió junto con `docs/migration/analysis/02-persistence.md`, `03-boundaries.md`, `docs/migration/target-architecture.md` y el `ADR-0011` (núcleo transaccional único). La conclusión de dominio es compatible: **no se parte el estado del dinero**; se extrae la periferia y se mantiene un único dueño ACID del ledger. Las “fronteras” de §6.3 son módulos internos de ese dueño, no servicios con bases separadas.

### 6.1 Dónde vive hoy el estado compartido que depende de SQLite

| Estado | Tabla / clave | Por qué necesita atomicidad | Consumidores |
|---|---|---|---|
| Reservas QUSD | `capital_reservations` (`src/store.ts:533-541`) | Check `Σ + amount ≤ max` e insert deben ser una sola operación | Orquestador, riesgo, dashboard |
| Reserva de aplicación | `application_capital_reservations` (`:913-921`) | Debe crearse con la intención y borrarse con la `Operation` | Intención, operación, riesgo, vía rápida |
| Workflow + ofertas propias | `trade_workflows`, `workflow_own_offers` (`:513-531`) | Snapshot y estado de reposición deben persistirse juntos | Orquestador, conciliación |
| Intenciones | `mutation_intents` (`:465-470`) | Estado y respuesta deben avanzar juntos; CAS manual | Mutaciones, conciliación, recovery |
| Operaciones | `operations` (`:388-392`) | Proyección terminal y liberación de reserva | Todas las capas |
| Ledger fiat | `fiat_ledger` (`:397-401`) | UNIQUE(operation_uuid, direction) evita doble débito/crédito | Operaciones, cooperativa, analítica |
| Configuración y revisiones | `trading_config`, `config_revisions` (`:440-449`, `:495-503`) | Hash encadenado y validación | Riesgo, mercados, panel |
| Feed | `market_feed_events` (`:777-790`) | Dedupe por `event_key`; cola con estado y backoff | Ingesta, conciliación, operaciones |
| Settings operativos | `settings` (`:386`) | Contadores, epoch de saldo, flags de pausa, backoff de refresco | Riesgo, caches, scheduler |
| Decisiones y alertas | `decision_events`, `trading_alerts` (`:647-665`, `:413-418`) | Evidencia versionada + resolución | Auditoría, panel, notificaciones |
| Recibos de pago | `payment_receipts` (`:829-841`) | UNIQUE(bank, sender, transaction_id) evita doble match | Pagos asistidos |
| Exclusión manual | `manual_cancel_exclusions` (`:859-868`) | Persistencia por UUID | Vías automáticas |
| Rebalance | `capital_rebalance_jobs` (`:724-735`) | Progreso por ajuste y reanudación | Panel, intents |

**Implicación:** el futuro `trading-core` no puede ser un servicio sin estado que “solo decide”. La parte que decide puede ser pura, pero la parte que **compromete capital** necesita un ledger transaccional (PostgreSQL, o un ledger append-only con restricciones de unicidad y bloqueo por workflow). SQLite está haciendo hoy tres trabajos: base de datos, mecanismo de lock y bus de eventos interno.

### 6.2 Ambigüedades detectadas (con recomendación)

| # | Ambigüedad | Evidencia | Opciones | Recomendación |
|---|---|---|---|---|
| **A1** | Bloqueo por mutación incierta: ¿global o por oferta? | Docs: global (`docs/ARCHITECTURE.md:81`); código: por oferta (`src/application/opportunity-orchestrator.ts:321`) y hay tests que exigen que otra oferta siga operando (`test/manual-cancel-race.test.ts:112`) | (a) heredar por oferta; (b) global; (c) configurable | Heredar **por oferta** como comportamiento de paridad; el bloqueo global pertenece a una política operativa del panel (hoy es solo informativo). Documentar la diferencia. |
| **A2** | Pausa persistente por errores consecutivos: ¿implementar o corregir doc? | `src/core/risk-policy.ts:171-177` solo advierte; `src/trading.ts:3607-3631` acumula; nada pausa | (a) implementar pausa; (b) mantener warning y corregir docs | Si se implementa, hacerlo como **nueva decisión de producto** con test explícito; no presentarla como paridad. |
| **A3** | Enforcement asimétrico de la vía rápida del feed | `src/trading.ts:1093-1194` vs `:3196-3264` | (a) conservar la vía rápida y sus warnings; (b) unificar con `evaluateRisk` y aceptar latencia/cuota extra; (c) vía rápida con subconjunto duro de límites | (c) es el candidato natural: conservar latencia, pero convertir capital, exposición, volumen, concurrencia y errores en **bloqueos duros**, como ya afirma `docs/ARCHITECTURE.md:84`. Requiere medir el impacto en latencia y cupo. |
| **A4** | `OperationState.failed` sin transición | `src/types.ts:142` | (a) no portarlo; (b) definir semántica y usarlo para fallos definitivos post-aplicación | No portarlo en la primera fase; si se necesita, crear estado explícito para “aplicación confirmada pero reconciliación imposible”. |
| **A5** | Recuperación de una intención `submitted` que nunca se despachó | `src/application/monetary-intents.ts:48-64` persiste y luego despacha, sin marca `dispatched_at` | (a) mantener y conciliar remoto; (b) agregar marca de despacho y tratar ambos casos distinto | (b) en el rediseño: un outbox transaccional con `dispatchedAt` permite distinguir “no enviado” de “respuesta perdida”. Para `apply`, el estado remoto `open` ya se interpreta como no aplicado (`src/trading.ts:588-644`), pero la distinción mejora auditoría y latencia de recuperación. |
| **A6** | `refreshOwnOffers` automático no pasa por `MonetaryIntents` | `src/trading.ts:2936-2938` llama `qva.editOffer` directo; el refresco manual sí usa intención (`:2546-2568`) | (a) conservar (edit idempotente, solo mensaje); (b) unificar intención | (b) para trazabilidad uniforme; si se conserva (a), documentar que el refresco automático no tiene evidencia durable de mutación, solo `last_refresh`/`refresh_retry`. |
| **A7** | Acoplamiento de riesgos a estado de cache | `qusdBalanceCache` es local al proceso y de 15 s (`src/qusd-balance-cache.ts:32-37`); la decisión puede usar saldo cacheado | (a) cache local por instancia; (b) cache compartido con epoch; (c) lectura forzada en decisiones | (b) con epoch/versión ya existe el concepto; llevarlo a Redis/DB y validar `epoch` antes de cada reserva. (c) destruye la latencia actual. |
| **A8** | Límites de QvaPay globales por cuenta y token único | `src/qvapay.ts:114-126`, `:141-146`; `src/core/apply-budget.ts` | (a) un único módulo/proceso dueño de la cuota; (b) cuotas distribuidas | (a) es obligatorio: `apply` no es idempotente y la sesión es única. Debe quedar dentro o bajo el mismo dueño que el estado financiero (ADR-0011), no como servicio independiente con su propia base. |
| **A9** | Día de negocio y zona horaria | `src/application/opportunity-orchestrator.ts:734-738`; `src/trading.ts:3986-3990` | (a) conservar hora local del servidor; (b) UTC; (c) zona configurable | (c) con zona explícita en configuración y tests de borde; migrar el histórico exige fijar la zona actual (America/Havana por el contexto operativo). |
| **A10** | Precisión monetaria | Todo es `number` float64; la suite fija resultados | (a) float64 idéntico; (b) decimal; (c) fixed-point 1e-8 | (c) es el más robusto para un ledger, pero exige convertir los vectores dorados y demostrar equivalencia; (a) es la paridad más barata a corto plazo. Decidirlo antes de portar `market-math`. |
| **A11** | Propiedad y recuperación de caches/loops | `inFlight`, `decisionTail`, `scanInFlight`, `averagesCache`, `marketSnapshotCache`, `readinessInFlight`, `reconciliationInFlight`, `operationActionsInFlight` | (a) locks distribuidos; (b) particionado por UUID; (c) un solo dueño del motor | (c) para el motor de decisión; (b) para acciones por operación; (a) solo para tareas programadas idempotentes. |
| **A12** | Persistencia de datos de pago en snapshots de reparación | `liquidity-plan.snapshot` incluye `details` (`src/core/liquidity-plan.ts:218-234`); se guarda JSON en `workflow_own_offers.snapshot_json` (`src/store.ts:526`, `:1502-1514`) | (a) mantener (necesario para reponer); (b) cifrar campo; (c) referencia a vault | (b) o (c): son datos personales/de pago, no solo operativos. El proyecto ya tiene `vault.ts` para secretos; evaluar si el snapshot debe cifrarse en reposo. |
| **A13** | Ventana de conciliación de `create_offer` | `src/trading.ts:3823-3838` busca coincidencia por importes y `created_at ≥ intent.createdAt - 60 s` | (a) mantener heurística; (b) idempotency key remota + lectura por clave | (b) si QvaPay la expone; si no, mantener y acotar por cuenta/mercado. |
| **A14** | Consistencia de lectura del panel | `DashboardReadModel` compone SQLite + caché remota; `/api/dashboard` no hace red (`docs/ARCHITECTURE.md:48`) | (a) CQRS con proyecciones; (b) consultas directas a DB | (a) para desacoplar; el read model no debe compartir transacciones con el ledger. |
| **A15** | Cooperativa fuera del protocolo de intenciones | `src/cooperative-hunter.ts:117-151` usa `applySecondary` y persiste el job en `remote_resource_cache`, no en `mutation_intents` | (a) integrar al protocolo; (b) tratar Sync Core como saga aparte con su propio ledger | (b) con un `cooperative-ledger` explícito; hoy la durabilidad es más débil que la del flujo principal. |

### 6.3 Fronteras recomendadas: un núcleo transaccional, periferia extraíble

> **Alineación con el resto del plan.** El equipo de migración ya propuso `ADR-0011` (`docs/adr/0011-nucleo-transaccional-unico.md`) y `docs/migration/target-architecture.md`: **un único `trading-core` propietario y escritor de todo el estado financiero en una base ACID**, sin transacciones distribuidas ni sagas para el camino crítico. Este análisis de dominio **confirma esa decisión**: las atomicidades descritas en §6.1 no se pueden repartir sin duplicar exposición. Por tanto, las “fronteras” siguientes son **módulos internos del mismo servicio**, no microservicios con bases separadas; solo la periferia se extrae.

```text
┌──────────────────────────── trading-core (1 proceso, 1 base ACID) ───────────────────────────┐
│                                                                                              │
│  ┌──────────────────────────────┐      ┌──────────────────────────────────────────────────┐  │
│  │ dominio puro                 │      │ estado financiero (misma transacción)            │  │
│  │ risk-policy                  │      │ reservas QUSD + reservas de aplicación           │  │
│  │ liquidity-plan               │─────►│ workflows + ofertas propias                      │  │
│  │ market-math · budget         │      │ operaciones + ledger fiat                        │  │
│  │ flexible-order · sizing      │      │ intenciones + ventana de apply                   │  │
│  └──────────────────────────────┘      │ configuración versionada + cadena de integridad  │  │
│                                        └──────────────────────┬───────────────────────────┘  │
│  ┌──────────────────────────────┐                             │                              │
│  │ mutaciones y conciliación    │◄────────────────────────────┘                              │
│  │ MonetaryIntents · ReconciliationScheduler · feed projector │                              │
│  └──────────────┬───────────────┘                                                            │
│                 │ outbox durable                                                             │
└─────────────────┼────────────────────────────────────────────────────────────────────────────┘
                  │ eventos (no comandos de dinero)
                  ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ periferia extraíble, reconstruible y sin escritura del ledger:                               │
│ panel/API · Telegram · notificaciones · analítica · chat · Sync Core · recibos SMS           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Reglas de oro:

1. **Un solo escritor del dinero**: `trading-core` es el único que escribe reservas, workflows, operaciones, ledger fiat, intenciones y configuración. La exclusión se mantiene en una transacción local (PostgreSQL/`SERIALIZABLE` o `SELECT ... FOR UPDATE`) más un lock de liderazgo con *fencing token* si algún día hay más de una réplica.
2. **Un solo dueño de QvaPay**: la ventana de `apply`, el presupuesto de listados, el token y el estado de sesión viven en el mismo proceso dueño. No se reparten entre servicios.
3. **Sin saltos de red nuevos en la ruta caliente**: feed → decisión → reserva → `POST` a QvaPay permanece en el proceso del núcleo; la periferia consume eventos y expone lecturas.
4. **La periferia no escribe las tablas del núcleo**: usa su API interna o proyecciones. Notificaciones, analítica, sesiones y caches son datos derivados.

Esta recomendación no elimina la discusión sobre si el núcleo debe ser un solo binario o varios módulos en el mismo despliegue; lo que este análisis prohíbe es **separar el estado financiero en bases distintas con sagas**.

### 6.4 Decisiones que bloquean el diseño

1. **Modelo de consistencia del ledger**: PostgreSQL transaccional con `SELECT ... FOR UPDATE`/`SERIALIZABLE` por workflow, o ledger append-only con restricciones de unicidad y proyecciones. Sin esto no se puede prometer INV-02/03/04. La recomendación alineada con ADR-0011 es **una única base ACID**; el ledger append-only queda como alternativa a evaluar, no como partición por servicio.
2. **Propiedad de la cuota y del token de QvaPay**: un solo escritor por cuenta, dentro del núcleo. Si el sistema crece a varias cuentas, la partición debe ser por cuenta y la cuota por cuenta+endpoint.
3. **Vía rápida vs política de riesgo**: definir qué límites son duros en el feed (A3). Es la decisión de producto con mayor impacto en comportamiento observable y en latencia.
4. **Precisión monetaria** (A10): float64 vs fixed-point. Afecta todos los tests de redondeo.
5. **Zona horaria del día de negocio** (A9): afecta `maxDailyAppliedQusd`.
6. **Contrato de recuperación** (A5): outbox con marca de despacho y semántica de `submitted`; define cuánto tarda una oferta en desbloquearse tras un crash.
7. **Persistencia de datos de pago** (A12): cifrado en reposo y retención; el snapshot de reposición contiene datos que permiten cobrar.
8. **Alcance inicial**: qué piezas entran en la primera ola. La recomendación de este análisis coincide con el plan maestro: `market-math` + `risk-policy` + `liquidity-plan` + `budget` como librería pura compartida con paridad dorada; el estado y las mutaciones se quedan en `trading-core`; `market-ingest`, dashboard, Telegram, notificaciones, analítica y cooperativa se extraen **después** y solo si no escriben el ledger.

### 6.5 Riesgos de estado compartido: resumen ejecutivo

| Riesgo | Dónde duele | Mitigación propuesta |
|---|---|---|
| Doble reserva de QUSD | Dos instancias del orquestador | Unicidad por workflow + transacción en la misma base; lock por workflow/liderazgo con fencing |
| Doble `apply` | Reintento tras crash o dos consumidores del feed | Intención + outbox + ventana persistida; un solo dueño del proceso y de QvaPay |
| Compensación duplicada | Dos procesos reconcilian el mismo workflow | Lease de reconciliación por workflow (no solo `Set` en memoria) |
| Saldo QUSD obsoleto | Cache local por instancia | Epoch/versión compartida; lectura forzada antes de reservar |
| Orden de eventos | Feed, polling y sync compiten por la misma oferta | Dedupe por `event_key` en un bus durable; decisión idempotente por UUID |
| Configuración vieja | Servicios con copia en memoria | Config versionada con hash y evento de invalidación; adjuntar `configRevisionId` a cada workflow/decisión |
| Datos de pago filtrados | Snapshots y logs de auditoría | Cifrado en reposo, redacción y retención; no incluir `details` en logs |
| Reloj y expiraciones | Cooldowns, frescura, día de negocio | Reloj inyectable; `occurredAt` remoto preservado; zona configurada |

---

## 7. Apéndices

### 7.1 Puertos actuales (seam de migración)

`src/core/ports.ts` es la frontera más limpia del sistema actual:

- `MarketListingGateway = Pick<QvaPayClient, "listOffersPage">` (`:5`) — capacidad mínima de observación.
- `QvaPayGateway` (`:8-25`) — 15 operaciones: `apply`, `cancel`, `confirmReceived`, `createOffer`, `editOffer`, `getOffer`, `listOffers`, `listOffersPage`, `listTransactions`, `listChat`, `markPaid`, `p2pAverages`, `profile`, `qusdBalance`, `sendChat`.
- `TradingRepository` (`:28-72`) — persistencia usada por `TradingEngine`; incluye reservas, intenciones, operaciones, workflows, decisiones, alertas, feed, chats y settings.

Para Go/Rust, `QvaPayGateway` puede traducirse casi literalmente a una interfaz. `TradingRepository` debe partirse (ver §5.2) porque hoy mezcla al menos seis responsabilidades y filtra tipos de SQLite.

### 7.2 Tabla de mapeo estado ↔ persistencia ↔ código

| Concepto | Tabla SQLite | Modelo TS | Servicio/fachada |
|---|---|---|---|
| Workflow | `trade_workflows` | `TradeWorkflow` (`src/store.ts:96-104`) | `OpportunityOrchestrator` |
| Oferta propia del workflow | `workflow_own_offers` | `WorkflowOwnOffer` (`:106-121`) | `OpportunityOrchestrator` |
| Reserva QUSD | `capital_reservations` | `CapitalReservation` (`:341-348`) | `Store.reserveQusd` |
| Reserva de aplicación | `application_capital_reservations` | tipos inline en `createMutationIntent` (`:1325-1334`) | `Store` + `TradingEngine` |
| Intención | `mutation_intents` | `MutationIntent` (`:254-266`) | `MonetaryIntents` |
| Operación | `operations` | `Operation` (`:133-147`) | `TradingEngine` |
| Ledger fiat | `fiat_ledger` | — | `Store.recordFiatMovement` (`:2215-2266`) |
| Configuración | `trading_config`, `config_revisions`, `settings` | `TradingConfig` (`src/market-config.ts:30-49`) | `MarketConfigService` |
| Decisión | `decision_events` | `DecisionEvent` (`:165-182`) | `TradingEngine` + `DashboardReadModel` |
| Alerta | `trading_alerts` | `TradingAlert` (`:149-163`) | `TradingEngine` |
| Feed | `market_feed_events` | `MarketFeedEvent` (`:66-76`) | `MarketSourceCoordinator` |
| Exclusión manual | `manual_cancel_exclusions` | — | `Store` + `TradingEngine` |
| Rebalance | `capital_rebalance_jobs` | `RebalanceJob` (`:225-252`) | `DashboardReadModel` |
| Recibo de pago | `payment_receipts` | `PaymentReceipt` (`:25-34`) | `PaymentSmsService` |

### 7.3 Cobertura de tests por área

| Área | Archivos principales | Cantidad aproximada |
|---|---|---|
| Riesgo | `test/risk-policy.test.ts` | 8 |
| Liquidez | `test/liquidity-plan.test.ts` | 9 |
| Intenciones | `test/monetary-intents.test.ts` | 5 |
| Orquestador/saga | `test/opportunity-orchestrator.test.ts` | 18 |
| Automatización/feed/vías rápidas | `test/trading-automation.test.ts` | 55 |
| Exclusión por cancelación | `test/manual-cancel-exclusion.test.ts`, `test/manual-cancel-race.test.ts` | 25 |
| Capital cooperativo | `test/cooperative-capital.test.ts`, `test/cooperative-hunter.test.ts` | 14+ |
| Flexible | `test/flexible-order.test.ts`, `test/flexible-fiat.test.ts` | 12 |
| Dinero/redondeo | `test/market-math.test.ts`, `test/rate-rounding.test.ts`, `test/budget.test.ts` | 15 |
| Reservas/acciones | `test/application-reservations.test.ts`, `test/operation-actions.test.ts` | 11 |
| Conciliación | `test/reconciliation-feed.test.ts`, `test/reconciliation-scheduler.test.ts` | 7 |
| Cuotas/transporte | `test/qvapay-gateway.test.ts`, `test/qvapay-list-budget.test.ts` | 20+ |
| Persistencia/migraciones | `test/repository.test.ts` | 20+ |
| Pausa/frescura/estados | `test/hunting-pause.test.ts`, `test/market-ingest-serialization.test.ts` | 20+ |

> El conteo es referencial: varios tests usan bucles que generan casos adicionales. El total del contexto (718) es la suma efectiva de la suite.

### 7.4 Glosario operativo mínimo para implementar en otro lenguaje

- **`apply`**: `POST /p2p/:uuid/apply`. Consume una oferta externa. No idempotente para el proveedor.
- **`paid`**: `POST /p2p/:uuid/paid` con `tx_id`. Solo en operaciones `sell`.
- **`received`**: `POST /p2p/:uuid/received`. Solo en operaciones `buy`.
- **`cancel`**: `POST /p2p/:uuid/cancel`. Compensa una oferta propia o cancela una operación humana.
- **`edit_offer`**: reduce/ajusta una oferta propia fija (usado para liquidez y rebalance).
- **`create_offer`**: repone una oferta propia desde snapshot; acepta `idempotency_key`.
- **`uncertain`**: resultado sin evidencia suficiente; bloquea la oferta y exige reconciliación.
- **`manual_review`**: decisión que no aplica automáticamente y requiere que un humano revise.
- **`blocked`**: decisión que además genera alerta y evidencia versionada.
- **`ignored`**: descarte sin alerta (precio, VIP, cacería detenida, etc.).
- **`turn`**: unidad de serialización de decisiones financieras (`withDecisionTurn`).
- **`epoch` de saldo**: contador que invalida caches de QUSD cuando cambia el saldo o una mutación de oferta (`qusd_balance_epoch`).
- **`sent_at` vs `received_at`**: orden de eventos remotos vs recepción local; la evidencia terminal se decide por `sent_at` (ADR-0008).

### 7.5 Lista de comprobación para el contrato de paridad (entrega al plan maestro)

- [ ] Golden vectors de `evaluateRisk` con todos los checks (incluidos advisory) y sus razones exactas.
- [ ] Golden vectors de `planLiquidity` (selección, orden, `consumeQusd`/`restoreQusd`, caso no viable).
- [ ] Golden vectors de redondeo (`ownOfferFiatTotal` CUP/no-CUP, `roundRateForIndex`, `sizeFlexibleOffer`, `proportionalBudgetPlan`).
- [ ] Secuencias de workflow feliz, rechazo, incierto y reinicio (los 18 casos de `test/opportunity-orchestrator.test.ts`).
- [ ] Secuencia de conciliación con feed terminal (ADR-0008) y con 403/404 VIP/KYC.
- [ ] Semántica exacta de `uncertain` y de la ventana de 2 `apply`/60 s entre reinicios.
- [ ] Contrato de `Operation` (estados, transiciones, `orderUuid` para flexibles).
- [ ] Contrato de reservas: qué se reserva, cuándo se libera, qué es “activo”.
- [ ] Modelo de tiempo: zona, día de negocio, expiraciones de cooldown, frescura.
- [ ] Contrato de exclusión manual y de refresco automático de ofertas propias.
- [ ] Definición de datos sensibles y política de retención/cifrado para snapshots y auditoría.

---

**Fin del documento.** Cualquier afirmación de comportamiento en este archivo se apoya en la cita indicada; las decisiones marcadas como “abiertas” no deben implementarse por inferencia sin aprobación del plan maestro.
