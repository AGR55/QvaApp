# Optimización del hunter — 2026-11-15

## Objetivo

Que una oportunidad llegue al core y se decida en milisegundos, sin que una
persistencia lenta, un apply de QvaPay o una ráfaga de eventos bloquee el resto.

## Tres fuentes activas a la vez

1. **Webhook P2P**: QvaPay → `/webhooks/qvapay/p2p-feed` (HMAC) → edge guarda
   `shadow.qvapay_feed_events` → cola interna → `POST http://hunter:8091/feed`
   con `X-Hunter-Feed-Token`.
2. **SSE**: feed de QvaPay conectado; cada evento se evalúa y se encola.
3. **Polling de respaldo**: `HUNTER_POLL_MS=1000`; si SSE o webhook fallan, en
   ≤1 s se recuperan las ofertas.

Los tres caminos comparten `handleOffer` y el mismo `hunter_events`; el hash
`oferta+decisión+tasa` evita duplicados.

## Hunter sin bloqueo de base

Antes: cada evento SSE abría una transacción, insertaba un `hunter_polls`, un
`hunter_candidates` por cada oferta (incluidas las ignoradas) y el
`hunter_events`; el lector SSE esperaba todo eso.

Ahora:

- `handleOffer` solo evalúa y encola en `streamQueue` (4096).
- `batchLoop` agrupa hasta 256 eventos o 15 ms.
- Un `hunter_polls` por lote, un `pgx.Batch` para candidatos/eventos y
  `NOTIFY hunter_events` en el mismo commit.
- Solo se persisten decisiones no ignoradas.
- Retención de 24 h para candidatos/polls; índices por `observed_at` y
  `polled_at`.

Métricas nuevas:

```text
hunter_stream_queue_depth
hunter_batches_total
```

## Core con despertar inmediato

- `LISTEN hunter_events` en conexión dedicada.
- Claim de hasta 500 eventos; ticker de respaldo de 100 ms.
- Caché de saldo QUSD 500 ms y de uso de riesgo 250 ms, invalidada al crear una
  operación.
- Operación creada directamente en `reserved` (una escritura menos).
- `CompleteWithDecision` con `pgx.Batch` (una ida/vuelta para decisión +
  ejecución + evento).
- **3 workers de apply** (`CORE_APPLY_CONCURRENCY=3`): un apply lento de QvaPay
  ya no bloquea las decisiones siguientes.
- `pool_max_conns=10` en Postgres.
- Índices para `core_decisions.offer_uuid`, `local_operations(state,created_at)`
  y `hunter_events(state,available_at,created_at)`.

## Mediciones

Ráfaga sintética de 200 eventos bloqueados (sin QvaPay):

```text
antes:  avg 1628 ms · p95 3211 ms · max 3242 ms
core:   avg  379 ms · p95  547 ms · max  559 ms
final:  avg  220 ms · p95  378 ms · max  391 ms
```

Camino real de un webhook individual:

```text
edge 202 → feed guardado → hunter /feed → core processed
latencia webhook→core: 36 ms
```

Aplicación real controlada con los workers paralelos:

```text
oferta cbb26757 · 10 QUSD · 10.60 USD
core confirmed · local applied · notifier_sent 2 · errors 0
cancel HTTP 204 · QvaPay volvió a open
```

## Configuración

```text
HUNTER_POLL_MS=1000
CORE_APPLY_CONCURRENCY=3
pool_max_conns=10
HUNTER_FEED_URL=http://hunter:8091/feed
HUNTER_FEED_TOKEN=<secreto 600>
```

## Cómo vigilarlo

```bash
curl -s http://127.0.0.1:8091/metrics | grep -E \
  'hunter_(polls_total|stream_connected|stream_queue_depth|batches_total|events_total)'
curl -s http://127.0.0.1:8090/metrics | grep -E \
  'trading_core_(autotrade_applied_total|runtime_config_version)'
```

Una cola SSE persistentemente alta indica que la base no sigue el ritmo; un
`stream_connected=0` prolongado deja el polling de 1 s como respaldo.
