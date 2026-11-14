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
- Poll QvaPay cada 3 s (20/min, por debajo del límite de 25/min).
- Promedios `/p2p/averages` cacheados 60 s.
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
- Healthcheck del contenedor sin shell.

## Resultado en VPS

```text
polls       = 551
latencia    = avg 107,5 ms · p95 202 ms · max 518 ms
candidatos  = 148 auto_buy (evaluaciones) · 1 evento durable único pending
mercados    = 5 (BANDECPREPAGO, BANK_CUP, CLASICA, ETECSA, ZELLE)
errores     = 0 en la última ventana
```

El evento durable se deduplica por oferta/decisión/tasa; por eso 148
evaluaciones repetidas producen un único evento para core.

## Tests y verificación

```text
internal/hunter tests       OK (compra/venta, guardián, medianas, config)
go test -race ./...         OK
lint/staticcheck/govuln     OK
E2E local fake QvaPay       OK, evento persistido
deploy VPS                  OK, hunter healthy
```

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
