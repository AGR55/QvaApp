# Arquitectura objetivo — QvaApply en microservicios Go

Estado: propuesta para revisión
Fecha: 2026-11-12
ADRs relacionados: [0010](../adr/0010-microservicios-go.md), [0011](../adr/0011-nucleo-transaccional-unico.md), [0012](../adr/0012-paridad-de-comportamiento.md)

> Este documento sustituye, para el estado futuro, a
> [ADR-0001](../adr/0001-modular-monolith.md) y
> [ADR-0002](../adr/0002-sqlite-single-instance.md), que siguen siendo válidos
> mientras corra la implementación TypeScript actual.

## 1. Contexto y restricciones

Hechos verificados en el repositorio:

- Monolito modular TypeScript: 22.832 LOC en `src/` (los cinco archivos más
  grandes son `trading.ts` 3.994, `store.ts` 3.643, `index.ts` 1.687,
  `http-dashboard.ts` 1.438 y `dashboard.ts` 1.323).
- 95 archivos de test, 15.769 LOC, **718 casos verdes** en ~10 s
  (`node --import tsx --test test/*.test.ts`).
- Persistencia SQLite con 31 migraciones y ~40 tablas; una sola instancia
  escritora (ADR-0002).
- Producción: una VPS Hostinger, Docker Compose, Nginx con TLS, despliegue
  automático desde `main` (`.github/workflows/ci-deploy.yml`), proceso Node de
  ~134 MiB según la revisión de rendimiento de 2026-10-29.
- Integraciones: QvaPay P2P (REST + SSE + webhook firmado), Telegram, Web Push
  (VAPID), Firebase Cloud Messaging, Sync Core (HTTP + NATS JetStream), SMTP de
  SMS bancarios vía Android.
- Restricciones externas duras: 25 listados/min por cuenta, 2 aplicaciones por
  ventana de 60 s, 20 s entre `edit`/`cancel`, caché de listado de varios
  segundos. La ventaja competitiva es latente: recepción → despacho con p95
  objetivo < 10 ms (`docs/2026-11-02-hunting-opportunities-review.md`.
- Móvil: app Android que consume la misma API HTTP del panel. El frontend React
  (`web/`) no forma parte de esta migración: se sirve como artefacto estático y
  no se reescribe.

Restricciones de negocio:

- Un único operador humano; las acciones que mueven dinero fiat y las
  confirmaciones finales siempre requieren intervención humana.
- El sistema es frágil y opera con dinero real: **ninguna fase puede quedar sin
  verificación de paridad ni sin rollback probado**.

## 2. Principios de la migración

1. **El dinero tiene un solo dueño y un solo escritor.** El estado financiero
   (operaciones, reservas, intenciones, conciliaciones) vive en un único
   servicio y en una única base de datos transaccional. No se reparte entre
   servicios y no se coordina con transacciones distribuidas.
2. **Se extrae la periferia, no el núcleo.** Telegram, panel, notificaciones,
   reportería y analítica ya son adaptadores en el código actual; son los
   primeros candidatos. La ruta caliente
   (feed → decisión → reserva → `POST` a QvaPay) permanece en un solo proceso.
3. **Cero saltos de red nuevos en la ruta caliente.** Un salto interno añade
   ~0,2–1 ms de p99 y un punto más de fallo. El feed, la decisión y el despacho
   se quedan juntos.
4. **Intención durable antes de mutar, también entre servicios.** Todo comando
   que cambie estado es idempotente (clave de idempotencia + consulta de
   estado); todo efecto externo cruza por `outbox` y se consume con dedupe
   (`inbox`), nunca por RPC síncrono dentro de una transacción.
5. **Una base por servicio, sin claves foráneas cruzadas.** La integridad
   referencial entre servicios se mantiene por eventos, IDs UUID y auditorías de
   reconciliación periódicas.
6. **Aislamiento de fallos medible.** Si Telegram, el panel o la analítica
   caen, el núcleo sigue cazando y el apagado de emergencia sigue disponible
   (a través de Telegram y del panel, que son superficies de lectura/control).
   Si el núcleo cae, las notificaciones se encolan y se reintentan.
7. **La suite actual es la especificación.** Antes de retirar una línea de
   TypeScript, su comportamiento debe estar cubierto por un test portado o por
   un fixture dorado ejecutado contra Go (ver
   [verification.md](verification.md) y
   [analysis/04-tests.md](analysis/04-tests.md)).
8. **Sin multi-escritor sobre la misma cuenta.** Aunque haya más servicios, la
   exclusión del capital se mantiene en una transacción de Postgres y un lock de
   liderazgo. NATS no sustituye la exclusión del dinero.

## 3. Topología objetivo

### 3.1 Estado E1 — el corte (3 servicios)

Este es el estado con el que se reemplaza producción. Minimiza la superficie
nueva en el momento más peligroso.

```text
                        Internet (HTTPS)
                              │
                         ┌────▼────┐
                         │  Nginx  │
                         └────┬────┘
              /            /api/*           /webhooks/qvapay/*
         ┌────▼─────┐   ┌────▼─────┐        ┌────▼──────┐
         │   edge   │   │   edge   │        │   core    │
         │ (Go)     │   │ (Go)     │        │  (Go)     │
         │ estáticos│   │ auth+BFF │        │ firma webhook
         └────┬─────┘   └────┬─────┘        └────┬──────┘
              │  HTTP interno (red privada, HMAC)│
              └──────────────┬───────────────────┘
                             ▼
                     ┌───────────────┐
                     │ trading-core  │  ← escritor único de dinero
                     │    (Go)       │
                     │ QvaPay, feed, │
                     │ decisiones,   │
                     │ capital, ops, │
                     │ intents, recon│
                     └──┬─────┬──────┘
                        │     │ outbox
              ┌─────────▼┐   ┌▼──────────┐
              │Postgres  │   │   NATS    │
              │core DB   │   │JetStream  │
              └──────────┘   └─────┬─────┘
                                   │ eventos de dominio
                            ┌──────▼───────┐
                            │  notifier    │
                            │ (Go)         │
                            │ Telegram·push│
                            └──────────────┘
```

Servicios:

| Servicio | Responsabilidad | Datos propios | Escala | Dominio de fallo |
| --- | --- | --- | --- | --- |
| `trading-core` | Adaptadores QvaPay (sesión/TOTP, cuentas de listado, SSE, webhook), polling, motor de decisión, política de riesgo, liquidez, presupuesto, reservas, operaciones/workflows, intenciones y despacho de mutaciones, conciliación/compensación, config versionada, auditoría, eventos de decisión, ledger fiat, recibos de pago/móvil, chat de operación, puente cooperativo | `core` (Postgres): todo el estado financiero | 1 instancia activa (lock de líder); vertical | Si cae, **no hay trading**; se recupera por reconciliación de arranque |
| `edge` | Estáticos del panel (`web/dist` + `public`), autenticación de panel (contraseña, sesión, CSRF, origen exacto), OpenAPI, API móvil, BFF de lectura, SSE al navegador, service worker | `edge` (Postgres): sesiones, rate-limit de login, telemetría de UI | N réplicas | Panel caído; el núcleo y el teléfono siguen |
| `notifier` | Bot de Telegram (UI y comandos), Web Push, FCM, cola de notificaciones con dedupe y reintentos | `notifier` (Postgres): notificaciones, suscripciones push, dispositivos, hilos de chat push | N réplicas | Avisos atrasados; el núcleo sigue y la cola se drena al volver |

Infraestructura: Postgres 16+ con una base y un rol por servicio; NATS JetStream
(ya usado para Sync Core) como bus interno; Docker Compose; Nginx existente.

### 3.2 Estado E2 — tras estabilizar el corte (+2 servicios)

- `analytics`: proyecciones de lectura para gráficas, rentabilidad, insights,
  simulación e historial. Consume `core.events.>` y mantiene sus tablas. La API
  del panel deja de consultar tablas de `core`.
- `coop-bridge`: aisla Sync Core (HTTP + NATS externo). Se extrae solo si la
  caída de Sync Core debe dejar de compartir proceso con el núcleo; hasta
  entonces vive en `trading-core` porque toca reservas de capital.

### 3.3 Estado E3 — solo si la medición lo justifica

- `market-ingest`: adquisición multi-cuenta (polling/SSE/webhook) separada.
  **No se extrae antes de E3** porque añade un salto en la ruta caliente; solo
  tiene sentido cuando el número de cuentas de listado sature un proceso o se
  quiera escalar la ingesta de forma independiente.
  El motivo que hoy justificaría separarla —aislar la ingesta del event loop de
  Node, que también sirve el panel— **desaparece en E1** porque el panel y el
  bot ya no comparten proceso con el núcleo. Además, el presupuesto de listados
  es un estado durable por *owner* que hoy vive en SQLite
  (`market_list_budget:v1`, `src/market-list-budget.ts`) y que debe seguir
  siendo único: separar el servicio sin un almacén de cuota compartido
  duplicaría consultas contra el límite de ~25/min. Ver
  [analysis/03-boundaries.md](analysis/03-boundaries.md) §6.4.
- `payments-ingest`: SMS bancarios y recibos móviles, si el volumen o el
  aislamiento del dispositivo lo justifican.

### 3.4 Fronteras a congelar antes de escribir Go

El análisis de fronteras
([analysis/03-boundaries.md](analysis/03-boundaries.md)) identificó siete
fronteras externas y tres acoplamientos peligrosos que condicionan cualquier
partición:

1. **Un solo escritor QvaPay.** La ventana durable de 2 aplicaciones por 60 s
   (`src/core/apply-budget.ts`) y las marcas persistentes
   (`qva_apply_last_*`) viven en la misma base que la decisión. Dos réplicas
   equivalen a dos presupuestos y a doble aplicación.
2. **Un solo contador de cuota de listado por owner.** Las credenciales de app
   comparten el cupo del propietario; escalar el polling en horizontal duplica
   consultas contra el mismo límite.
3. **Un solo estado de intención incierta.** Una mutación ambigua bloquea
   nuevas operaciones sobre la misma oferta hasta conciliar.

Los contratos K1–K14 del anexo (QvaPay REST/SSE/webhook, panel, Sync Core,
NATS, notificaciones, decimales, dedupe) se convierten en tests de conformidad
contra cualquier implementación. En particular se conserva el **login TOTP como
comando de operación** (no como endpoint HTTP): el token se obtiene fuera del
proceso residente y se cifra antes de persistir.

## 4. Qué NO se parte (y por qué)

Estas fronteras son deliberadamente monolíticas dentro de `trading-core`:

- **Reserva de capital + creación de operación/workflow + intención monetaria.**
  Hoy son una transacción SQLite. Partirlas permite dos reservas del mismo
  saldo o una mutación sin intención durable: doble gasto.
- **Decisión + reserva + despacho `apply`.** Si la decisión vive en un servicio
  y el despacho en otro, aparecen carreras entre la revalidación final y el
  `POST`, justo lo que los tests `manual-cancel-race`, `offer-latency`,
  `application-reservations` protegen.
- **Conciliación/compensación y las intenciones.** Un resultado incierto debe
  resolverse contra el mismo estado que lo creó.
- **Configuración versionada + revisiones de integridad + auditoría.** La cadena
  de revisiones es el mecanismo de defensa contra cambios de límites
  inconsistentes.
- **Feed + polling + dedupe.** La deduplicación entre canales (mismo evento por
  SSE y webhook) necesita el mismo estado. Con dos servicios, un evento puede
  procesarse dos veces.

Consecuencia: `trading-core` sigue siendo un servicio grande (estimado
12–15k LOC Go). Es un monolito modular desplegable como servicio, no un
nanoservicio. Eso es intencional y es la principal diferencia entre esta
propuesta y una "migración a microservicios" ingenua.

## 5. Comunicación

### 5.1 Síncrona (comandos y lecturas internas)

- `edge`/`notifier` → `core`: HTTP/JSON interno sobre la red privada de Docker,
  con cabecera `Authorization: Bearer <service-token>` (secreto distinto por
  servicio) y `Idempotency-Key` obligatoria en comandos.
- Formato: OpenAPI 3.1 generado (`oapi-codegen`), no gRPC en E1 para evitar
  toolchain extra; si en E2 aparecen contratos internos complejos, se evalúa
  gRPC.
- Timeouts explícitos, reintentos solo para lecturas y comandos idempotentes;
  **nunca** reintentos ciegos de comandos que mueven dinero.
- Los comandos devuelven `202 Accepted` con `commandId` cuando la ejecución es
  asíncrona; el cliente consulta estado por `GET /commands/{id}`.

### 5.2 Asíncrona (eventos de dominio)

- `outbox` transaccional en `core`: cada cambio relevante escribe su evento en la
  misma transacción que el estado; un relay publica a JetStream.
- Subject taxonomy (AsyncAPI versionado en `contracts/`):
  - `core.operation.applied|paid|completed|cancelled|recovery-required`
  - `core.decision.evaluated|blocked|rejected`
  - `core.recovery.opened|resolved`
  - `core.notification.requested`
  - `core.config.revised`
  - `core.audit.recorded` (para analítica)
  - `coop.capacity.changed|snapshot`
- Entrega at-least-once; cada consumidor mantiene `inbox` con dedupe por
  `event_id` (UUIDv7) + `consumer`.
- No se usa JetStream como sustituto de la exclusión del capital.

### 5.3 Contratos congelados

- `contracts/openapi/edge.yaml`, `contracts/openapi/core-internal.yaml`,
  `contracts/asyncapi/core-events.yaml`.
- El panel web/Android **no cambia de contrato** en E1: `edge` reproduce las 102
  declaraciones (109 efectivas) de ruta de `src/http-dashboard.ts` (incluidas
  `/api/mobile/*` y `/api/live/*`).
- Fake QvaPay determinista con cassette para tests de contrato (ver
  [analysis/03-boundaries.md](analysis/03-boundaries.md)).

## 6. Datos

- **Postgres** (una instancia, bases separadas) sustituye SQLite. Motivos:
  concurrencia de lectura/escritura entre servicios, backups estándar, roles por
  servicio, camino conocido para réplicas de lectura y migraciones. Coste:
  ~100–200 MiB de RAM adicionales en la VPS.
- Decisión confirmada (2026-11-12): la VPS de producción tiene 4–8 GB de RAM,
  suficiente para Postgres + 3–4 servicios Go con límites por contenedor. La
  alternativa SQLite por servicio queda documentada solo como plan B si el
  consumo real no cupiera: mantiene la memoria al mínimo pero multiplica
  backups y bloquea réplicas.
- **Tipos de dinero:** nunca `float64` para saldos ni importes. `NUMERIC(24,8)`
  en Postgres y tipo decimal con redondeo explícito en Go
  (`shopspring/decimal` o equivalente), replicando exactamente las funciones de
  redondeo actuales (`src/market-math.ts`, `rate-rounding.test.ts`). La paridad
  de redondeo es un test de primera clase, no un detalle. Evidencia del problema
  actual: el snapshot local guarda importes en `REAL` en más de 40 columnas y ya
  muestra drift binario (`SUM(amount)` de créditos `CLASICA` =
  `1244.1000000000001`); ver
  [analysis/02-persistence.md](analysis/02-persistence.md) §0 y §5.4.
- **Autoridad única de saldo:** hoy el saldo fiat tiene cuatro representaciones
  (`settings.fiat_balance:<coin>` autoritativa, `market_config.fiat_balance`,
  `fiat_accounts.declared_balance`, `fiat_balance_history` y
  `portfolio_snapshots`). En el destino debe haber **un libro** y **un saldo
  materializado**; el resto son proyecciones reconstruibles. Ver
  [analysis/02-persistence.md](analysis/02-persistence.md) §3.4.
- **IDs:** UUIDv7 generados en el servicio dueño; ningún ID se reutiliza entre
  servicios como FK.
- **Migración de datos:** herramienta dedicada con verificación por conteos,
  sumas de saldos, hashes de configuración y comparación de snapshots. El
  snapshot de desarrollo está en **schema v16**, no v31: antes de cualquier
  ensayo hay que llevarlo a v31 con el código actual, porque el camino
  v16→v31 nunca se ha ejecutado sobre datos reales. `config_revisions` es el
  85–87 % del tamaño (5.416 revisiones en 11 días, sin retención): su
  compactación/retención debe decidirse antes del dump. Ver
  [analysis/02-persistence.md](analysis/02-persistence.md) §2.3, §2.6 y §6.
- **Duplicación de `config_integrity_epoch` y `config_revisions`:** deben vivir
  con la misma autoridad (cadena SHA-256 + triggers) o la integridad de
  configuración deja de ser verificable.
- **Backups:** PostgreSQL exige PITR (archiving WAL) + `pg_dump` diario + prueba
  de restauración documentada; no basta con un dump. Durante la transición se
  conservan los backups SQLite y la base TS se mantiene intacta hasta 14 días
  después del corte.
- **Secretos:** los tokens cifrados viajan como ciphertext; si se adopta KMS o
  envelope encryption, se re-cifran en destino sin descifrarlos durante la
  migración.

## 7. Despliegue

### E1 (una VPS, Compose)

```text
nginx (TLS, único puerto público)
  ├─ static /            → edge:8080
  ├─ /api/*              → edge:8080
  ├─ /webhooks/*         → core:8081
  └─ (interno) core ← edge/notifier por red privada
postgres:16  (volumen persistente, solo red interna)
nats:2.10    (JetStream, solo red interna)
core / edge / notifier
```

- `core` con `restart: unless-stopped`, healthcheck real
  (`/internal/health` que comprueba DB + lock + última conciliación), shutdown
  ordenado con drenaje (el sistema ya usa `stop_grace_period: 90s`).
- Límites de memoria por contenedor (`mem_limit`) y alertas al 80 %.
- Solo `core` escribe en el volumen de datos; el resto usa su propia base.
- Secretos por `env_file` con permisos 600, como hoy; sin secretos en imágenes
  ni en Git.

### Camino de escala

- `core`: una instancia activa protegida por `pg_advisory_lock`; si se necesita
  HA, se pasa a líder con `fencing token` y recuperación de intents. Nunca dos
  escritores sin fencing.
- `edge`/`notifier`/`analytics`: escalan horizontalmente tras Nginx; sesiones en
  Postgres.
- Si el volumen de cuentas de listado crece: E3 `market-ingest` y réplicas de
  lectura para analítica.

## 8. Seguridad

- Se conserva el modelo actual: panel solo en loopback detrás de Nginx, sesión
  `HttpOnly`/`SameSite=Strict`, CSRF, origen exacto, contraseña con hash,
  secretos y `CONFIRM_REAL_TRADING` fuera del panel.
- Red interna de Docker sin puertos publicados salvo Nginx; `core` no expone
  `/api/*` público.
- Tokens de servicio por par de servicios; rotación documentada.
- Webhook QvaPay: validación de firma sobre cuerpo crudo y timestamp en `core`
  (el servicio que deduplica), no en `edge`.
- Cifrado local de tokens (AES-GCM con `LOCAL_ENCRYPTION_KEY`) se mantiene en
  `core`; la clave no se comparte con otros servicios.
- Auditoría: todo comando interno que cambie estado queda en `audit_log` con
  actor (web/telegram/mobile/scheduler) y `command_id`.
- Escaneo de secretos (`pnpm check:secrets` → versión Go) como gate de CI.

Hallazgos del análisis de fronteras que deben corregirse en la migración (no
heredarlos):

- La clave privada VAPID se guarda en claro en `settings`; el nuevo almacén debe
  cifrarla como el resto de secretos.
- `request.ip` sin `trustProxy` detrás de Nginx puede falsear el rate limiting
  por IP; el nuevo `edge` debe configurarlo explícitamente.
- El token NATS es la propia API key de Sync Core y viaja sobre `nats://`; hay
  que evaluar TLS y credenciales separadas.
- Nginx limita el cuerpo a 16 KiB mientras el chat admite imágenes de hasta
  1 MiB e iconos de 750 KB: el borde actual puede devolver 413 silenciosos. El
  nuevo `edge` debe reconciliar el límite real por ruta.
- Los tokens de operador Android ya emitidos deben migrarse por hash/scope o los
  dispositivos se reemparejan explícitamente.

## 9. Observabilidad

- Logs estructurados JSON (`slog`) con `trace_id`, `command_id`, `operation_uuid`;
  sin secretos ni tokens.
- Métricas Prometheus por servicio: latencia de decisión, cola de despacho de
  mutaciones, intents pendientes, feed lag, reconexiones SSE, errores por
  endpoint QvaPay, profundidad de outbox/inbox.
- Alertas al operador por Telegram (vía `notifier`) para: conciliación pendiente,
  lock de líder perdido, outbox estancado, feed caído > N s, saldo/ledger
  descuadrado.
- Trazas OpenTelemetry opcionales en E2; en E1 basta `trace_id` propagado.
- Panel de salud: se conserva `OperationalHealthMonitor` y `/api/operational-health`.

## 10. Compatibilidad

- `web/` (React + Vite + Tailwind) se compila igual y se sirve desde `edge`; los
  assets y el service worker no cambian de ruta.
- Android: mismas rutas `/api/mobile/*` y mismos payloads; `edge` actúa de BFF
  contra `core`.
- Telegram: mismo bot, mismos comandos y textos; el token solo lo usa `notifier`.
  Durante la transición solo puede haber **un** proceso haciendo long-polling:
  el corte del bot es una ventana corta, no una ejecución en paralelo.
- Sync Core: mismo contrato HTTP/NATS; `core` mantiene el cliente NATS externo
  en E1.
- `pnpm` deja de ser la vía principal de verificación del backend, pero se
  conserva para el build de `web/` y para la suite TypeScript mientras exista.

## 11. Estados y criterios de salida

| Estado | Contenido | Criterio para avanzar |
| --- | --- | --- |
| E0 | Análisis + arnés de paridad + fixtures | Fixtures reproducibles; 718 tests inventariados; fake QvaPay operativo |
| E1 | `core` + `edge` + `notifier` en producción | 14 días sin incidentes de reconciliación, paridad ≥99,9 %, rollback probado |
| E2 | `analytics` (y `coop-bridge` si aplica) extraídos | Proyecciones reconstruibles; tests de paridad de reportes |
| E3 | `market-ingest`/`payments-ingest` si la medición lo exige | p99 de la ruta caliente no empeora con el salto adicional |

## 12. Decisiones que este documento asume

1. Go como lenguaje de los servicios (ver [analysis/05-tech-eval.md](analysis/05-tech-eval.md)).
2. Postgres como base por servicio (confirmado: VPS de 4–8 GB).
3. NATS JetStream como bus interno, reutilizando la infraestructura de Sync Core.
4. Frontend React y app Android sin reescritura.
5. Un solo operador y una sola instancia activa de `core`; el diseño de HA queda
   preparado pero no se implementa hasta que exista necesidad.
