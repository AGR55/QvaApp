# Hunter — microservicio de cacerías (2026-11-14)

## Decisión de arquitectura

El MVP deja de esperar el gate de 7 días para desplegar. Cada incremento se
cierra con tests, benchmark y despliegue shadow; la observación de 7 días/72 h
sigue en paralelo como confianza operativa, no como bloqueo.

Topología MVP:

```text
QvaPay read-only ──► hunter (8091) ──► shadow.hunter_events (cola)
                                      └► shadow.hunter_candidates / polls
core (8090)        ──► único escritor de dinero (siguiente consumidor)
edge               ──► web/Android (pendiente)
notifier           ──► Telegram/push (pendiente)
```

`hunter` es un proceso/contenedor independiente. No escribe dinero, no llama a
mutaciones de QvaPay y puede escalarse o reiniciarse sin tocar `core`.

## Implementación

- Binario `cmd/hunter`, puerto `127.0.0.1:8091`.
- **Feed SSE real** `/v2/p2p/stream` con `app-id`/`app-secret` cifrados; evalúa
  cada `p2p.created/reopened/resumed/range_*` al recibirlo.
- Poll fallback cada 5 s; promedios cacheados 60 s. El feed es la vía rápida y
  el polling solo cubre caídas del stream.
- Credenciales SSE en `hunter.env` (600), nunca en el repo.
- Config de mercados generada desde SQLite de producción en cada deploy.
- Token descifrado en memoria; secretos en `/opt/qvaapply-f3-shadow/hunter.env`
  (600), fuera del repositorio.
- Evaluación pura en `internal/hunter`:
  - compra automática: máximo, límite por operación, mediana de venta y guardián
    de precio;
  - venta: mínimo, mediana de compra y guardián;
  - `ignored`, `blocked`, `auto_buy`, `manual_sell`.
- Persistencia:
  - `shadow.hunter_polls`;
  - `shadow.hunter_candidates`;
  - `shadow.hunter_events` (cola durable candidato → core, idempotente).
- Retención de polls: 24 h.
- `/healthz`, `/readyz`, `/metrics`, `/candidates`.
- Métricas SSE: conexión, eventos crudos/oportunidad, errores, lag y decisión.
- Healthcheck del contenedor sin shell.

## Resultado en VPS

### SSE (camino rápido)

```text
conexión    = 1
eventos SSE = 11 crudos · 7 oportunidades (10 s)
lag         = 39 ms
decisión+persistencia = 12,2 ms
errores SSE = 0
```

El feed entrega `p2p.range_updated` de ofertas vivas cada pocos segundos. La
evaluación local pura medida es **21,7 µs para 20 ofertas**; el resto del
tiempo es red/entrega y persistencia.

### Polling fallback

```text
polls       = 551 históricos
latencia    = avg 107,5 ms · p95 202 ms · max 518 ms
fallback    = 5 s (12/min), 0 errores tras el ajuste
mercados    = 5 (BANDECPREPAGO, BANK_CUP, CLASICA, ETECSA, ZELLE)
```

El evento durable se deduplica por oferta/decisión/tasa; por eso las
evaluaciones repetidas no generan eventos duplicados para core.

## Tests y verificación

```text
internal/hunter tests       OK (compra/venta, guardián, medianas, config)
go test -race ./...         OK
lint/staticcheck/govuln     OK
E2E local fake QvaPay       OK, evento persistido
deploy VPS                  OK, hunter healthy
```

## Por qué antes parecía lento

`hunter_last_latency_ms` medía el **fetch HTTP completo**, no la evaluación. El
round-trip a QvaPay desde la VPS es de 100–180 ms (TLS + Cloudflare + API). La
evaluación Go es de microsegundos. Con SSE el coste dominante baja a la entrega
del feed (~39 ms) y desaparece la espera de hasta 3 s del polling.

## Seguridad

- Solo GET en QvaPay.
- Sin token en logs, repositorio, Compose ni métricas.
- Contenedor `scratch`, usuario 65532, `read_only`, `cap_drop: ALL`.
- Config de mercados pública; secretos en archivo 600.
- Puerto 8091 solo loopback.

## Siguiente

1. Consumidor `core` de `shadow.hunter_events` (idempotente, sin doble apply).
2. `edge` para web/Android y `notifier` para Telegram/push.
3. Benchmark de hunter bajo carga y soak de 72 h en paralelo.
4. Extraer `qvapay`/`vault` a un módulo compartido si más servicios los usan.
