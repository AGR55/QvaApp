# 03 — Fronteras externas y superficie HTTP/adaptadores

**Proyecto:** QvaApply · **Fase:** análisis previo a la migración a microservicios (Go/Rust)
**Autor:** boundaries-mapper (equipo de migración) · **Fecha:** 2026-11-12
**Base analizada:** worktree local, `git HEAD 02bb5afc04b5eb95f5ac3996ef7634dedf073d02` (2026-11-03T19:46:26-05:00), Node 24 fijado en producción (`.node-version`), Node 25.9.0 en el entorno local de análisis.

**Método y límites.** Análisis estático con `read`/`grep`/`glob` sobre el árbol; no se ejecutó el servidor, no se llamó a QvaPay, Telegram, Sync Core, NATS ni al panel, y no se envió ninguna mutación. Las cifras son las declaradas por el código y por la documentación operativa; donde una afirmación proviene de una medición histórica se cita el documento. Este análisis es de fronteras: no cubre el dominio (`01-domain.md`) ni el esquema (`02-persistence.md`), pero sí los contratos que ambos deben respetar.

---

## 0. Resumen ejecutivo

QvaApply es hoy **un único proceso Node** que concentra siete fronteras externas y **una sola base SQLite**. Casi todas las decisiones de dinero dependen de que un único escritor conozca, en memoria y en disco, el estado de la sesión QvaPay, el presupuesto de listados, la ventana durable de aplicaciones y las intenciones inciertas. La migración no puede repartir esas cuatro piezas entre servicios sin un plan explícito de exclusión y reconciliación.

Las fronteras, por orden de criticidad para el dinero:

| # | Frontera | Dirección | Criticidad | Qué se congela primero |
| --- | --- | --- | --- | --- |
| F1 | QvaPay API REST (`api.qvapay.com`) | saliente | **Máxima** | Cliente HTTP: colas, cuotas, timeouts, ambigüedad e idempotencia |
| F2 | QvaPay webhook `POST /webhooks/qvapay/p2p-feed` | entrante | **Máxima** | HMAC, timestamp, dedupe, 202 tras persistir |
| F3 | QvaPay SSE `GET /v2/p2p/stream` | saliente | Alta | Eventos, `retry`, reconexión sin replay, 401/402 |
| F4 | Panel/API HTTP Fastify (web + Android) | entrante | **Máxima** | 102 declaraciones de ruta, auth/CSRF/origen, envelopes y códigos |
| F5 | Sync Core HTTP (`/hunts*`) | saliente | Alta | Snapshot, aportes, reserva/commit/release, concurrencia |
| F6 | NATS JetStream `cacerias.sync` | saliente | Alta | Stream/durable/ack/dedupe por snapshot |
| F7 | Notificaciones: Telegram, Web Push, FCM | saliente | Media | Idempotencia por evento y destino; outbox |

**Contratos que hay que congelar antes de escribir una línea de Go/Rust:**

1. **Cliente QvaPay** (F1): clasificación `QvaApiError` / `QvaConnectionError` / `QvaMutationUncertainError`, las 11 políticas de cola, la ventana durable de 2 aplicaciones por 60 s, el presupuesto de listados de 2 401 ms por owner y el tratamiento de `429`/`Retry-After`.
2. **Webhook P2P** (F2): firma HMAC-SHA256 sobre el cuerpo crudo, ventana de ±5 min, dedupe `event+uuid+versión(+sent_at/available_amount)`, 202 solo tras persistir.
3. **Superficie HTTP local** (F4): envelopes `{data}`/`{error}`, códigos, cookies, CSRF, Origin, límites de cuerpo y las rutas que hoy consumen Android y el panel.
4. **Reserva cooperativa** (F5/F6): el reparto `owner_fiat + Σ contributions ≈ offer.receive` (±0.011) y la prohibición de usar `POST /hunts/perform` (ver `docs/OPERATIONS.md:26-33`).

**Tres acoplamientos peligrosos** (detalle en §8):

- **Un solo escritor QvaPay.** La ventana de aplicaciones (`src/core/apply-budget.ts:5-6`) y las marcas persistentes (`src/qvapay.ts:898-899`) viven en SQLite y en memoria del mismo proceso. Dos réplicas → dos presupuestos → doble aplicación.
- **Un solo contador de cuota de listado por owner.** `ListingReadBudget` coordina todas las cuentas del proceso contra el mismo owner QvaPay (`src/market-list-budget.ts:9-41`); las credenciales de app comparten el cupo del propietario (`docs/2026-11-02-hunting-opportunities-review.md:91`). Escalar horizontalmente el polling duplica consultas contra un límite de ~25/min.
- **Un solo estado de intención incierta.** Una mutación ambigua bloquea nuevas operaciones sobre la misma oferta hasta conciliar (`docs/ARCHITECTURE.md:78-82`); ese estado es local y transaccional.

---

## 1. Modelo de proceso actual

Un único proceso (`dist/index.js`, `deploy/Dockerfile:24`) hace *todo*:

```text
┌─────────────────────────────── contenedor qvaapply (Node 24) ───────────────────────────────┐
│                                                                                              │
│  Fastify :3000 ── panel web (React estático) + API JSON + webhook firmado + service worker    │
│  grammy ──────── Telegram long polling (sin webhook), solo chat admin                        │
│  Scheduler ───── 24 tareas setTimeout encadenadas (sin solapamiento)                         │
│  QvaPayClient ── colas en memoria (apply, urgent_read, list, chat, general) + SQLite         │
│  QvaPayFeedStream ─ SSE /v2/p2p/stream (solo modo híbrido)                                   │
│  HuntingSync ─── HTTP Sync Core + consumidor NATS JetStream                                  │
│  OperationChatService ─ SSE de chat por operación (máx. 8) + caché local                     │
│  WebPushService / FirebaseChatPush ── VAPID + FCM HTTP v1                                    │
│                                                                                              │
│  SQLite WAL /app/data/qvaapply.sqlite  (única fuente de verdad; una instancia por diseño)    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Evidencia del arranque y del *wiring*: `src/index.ts:50-217` (store, vault, clientes, coordinadores, panel), `src/index.ts:533-605` (registro del scheduler), `src/index.ts:628-661` (`bootstrap`), `src/index.ts:1646-1687` (Telegram long polling y apagado ordenado con `stop_grace_period: 90s` en `deploy/compose.yaml:13`).

El scheduler es de intervalo fijo con reentrada bloqueada (`src/scheduler.ts:46-82`); no hay cron externo, ni cola de trabajos distribuida, ni leader election. Esta es la propiedad que hoy evita que dos escritores compitan por el mismo saldo.

---

## 2. Frontera saliente F1 — QvaPay API REST

### 2.1 Transporte, colas y timeouts

- Base URL fija: `https://api.qvapay.com` (`src/qvapay.ts:17`). Sin dispatcher HTTP explícito; `fetch` global (`src/qvapay.ts:155`).
- Cabecera de autenticación: `authorization: Bearer <token>`; el token se lee descifrado en cada petición (`src/qvapay.ts:588-605`, `src/session.ts:12-20`).
- Timeouts por tipo de operación (`src/qvapay.ts:158-160`):
  - autenticación: **20 s**;
  - lectura: **5 s**;
  - mutación: **25 s**.
- Colas independientes por política, serializadas por promesa encadenada (`src/qvapay.ts:141-146`, `:745-799`): general (`read`, `create`, `apply`, `edit`, `cancel`, `paid`, `received`), prioritaria (`urgent_read`), listado (`list`), chat (`chat`, `chat_read`) y aplicación (cola propia con presupuesto durable).
- Espaciado local aplicado = `max(1 667 ms desde la última petición general, intervalo de la política)`; las lecturas prioritarias omiten el espaciado general (`src/qvapay.ts:761-775`).

Tabla de políticas (`src/qvapay.ts:101-126`):

| Política | Intervalo local | Reintentos | Timeout | Persistente tras reinicio | Uso |
| --- | ---: | --- | ---: | --- | --- |
| `read` | 1 667 ms | 3 en lecturas con `retryRead` | 5 s | no | perfil, transacciones, promedios, ofertas |
| `urgent_read` | 1 667 ms (sin espera general) | 3 | 5 s | no | saldo y oferta en ruta crítica |
| `chat_read` | 1 667 ms | 3 | 5 s | no | listar chat |
| `list` | **2 401 ms** | 3 | 5 s | sí (vía `ListingReadBudget`, SQLite) | `GET /p2p` |
| `create` | 5 000 ms | 0 | 25 s | sí (`qva_throttle:create`) | crear oferta |
| `apply` | ventana durable **2 / 60 001 ms** | 0 | 25 s | sí (`qva_throttle:apply_window`) | aplicar |
| `edit` | 20 000 ms | 0 | 25 s | sí | editar oferta |
| `cancel` | 20 000 ms | 0 | 25 s | sí | cancelar |
| `paid` | 10 000 ms | 0 | 25 s | sí | marcar pagado |
| `received` | 5 000 ms | 0 | 25 s | sí | confirmar recepción |
| `chat` | 1 667 ms | 0 | 25 s | no | enviar mensaje/imagen |

Reintentos exactos:

- Autenticación: 3 intentos con espera `750 ms × 2^n` (`src/qvapay.ts:699-720`). Solo fallos de transporte; **un TOTP/PIN rechazado no se reintenta** (`docs/OPERATIONS.md:37`).
- Lecturas: 3 intentos; `429` se reintenta con `800 ms × 2^n` hasta el tercer intento (`src/qvapay.ts:670-697`).
- Listado: 3 intentos, cada uno precedido por la puerta de presupuesto; un `429` **no** se convierte en reintento, se propaga y se anota en el budget (`src/qvapay.ts:644-668`).
- Mutaciones: **0 reintentos**; un fallo de transporte se convierte en `QvaMutationUncertainError` (`src/qvapay.ts:625-630`, `:44-54`).

### 2.2 Inventario de endpoints salientes

| # | Método y ruta | Propósito | Límite/cuota | Idempotencia disponible | Errores especiales | Consumidor / quién lo usa |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `POST /auth/login` | Login con email+password, `remember: true`; segundo intento con `two_factor_code` | 3 intentos de transporte; sin reintento ante 4xx/429 | No documentada; no se repite automáticamente | `202` con `has_otp` / `notified`; 401 credencial/TOTP; 403 bloqueo; 423 cuenta bloqueada; 429 rate limit (`src/login.ts:76-92`) | CLI `pnpm login` únicamente (`src/login.ts:42-67`); **no** lo usa el proceso residente |
| 2 | `POST /auth/request-pin` | Solicitar PIN cuando el `202` no notificó (`notified !== true`) | **1 solo intento** (`maxAttempts = 1`) | No | Redacción de mensaje de error | `pnpm login`, fallback (`src/qvapay.ts:186`, `:199-206`) |
| 3 | `GET /p2p?take&page&type&coin&status&orderBy&orderType&my` | Listado paginado de ofertas (100 por página) | **~25 consultas/min por cuenta/owner** (2 401 ms); caché de servidor y `X-Cache` | No aplica (lectura) | 429 + `Retry-After`; 401/403 → cuenta `requires_attention` | `PollingMarketSource` (`src/market-source.ts:179-187`), `PaymentSmsService` (operaciones manuales), panel `/api/live/own-offers`, validación de tokens lectores (`src/market-accounts.ts:225-231`) |
| 4 | `GET /p2p/{uuid}` | Leer una oferta (conciliación, preflight, pago asistido) | 1 667 ms (`read`) o `urgent_read` | No aplica | 404 oferta inexistente; 429 | `TradingEngine`, `CooperativeHunter.reconcile`, `PaymentSmsService.process`, `AssistedPaymentService.prepare`, panel `/api/live/operations` |
| 5 | `GET /user` | Perfil y saldo QUSD (`uuid`, `balance`/`available`/`data.*`) | 1 667 ms | No aplica | Respuesta sin saldo reconocible → bloqueo de venta (`src/qvapay.ts:312-314`) | caché QUSD de `trading`, `PaymentSmsService.getProfileUuid`, `MarketAccountService.readIdentity`, `AssistedPaymentService`, panel `/api/live/balance` |
| 6 | `GET /p2p/averages` | Promedios por mercado | 1 667 ms, 3 intentos | No aplica | Envelope inválido → error de parseo | `TradingEngine` (medianas/analítica) |
| 7 | `GET /transaction?take&page&status=paid&order=desc&include_total=true&date_from&date_to` | Historial de transacciones propias | 1 667 ms; `take` 1..30 | No aplica | Respuesta no-lista → error | `trading.syncFiatFromQva`, panel `/api/live/transactions`, analítica |
| 8 | `POST /p2p/{uuid}/apply` | Aplicar a una oferta fija; `{amount}` solo para órdenes flexibles | **2 / 60 s** durables; preflight antes de gastar cupo | Parcial: el presupuesto evita duplicados locales; **QvaPay no documenta idempotency key para apply** | `409` `OFFER_CONTENDED`, `OFFER_PAUSED`, `PEER_REQUIREMENTS_NOT_MET` (+`missing`), `HTTP_400`; `429` guarda `apply_retry_at` | `TradingEngine.apply`, `BlockedOffer.apply`, guardas de `CooperativeHunter` (secundaria) |
| 9 | `POST /p2p/{uuid}/apply` (secundaria) | Aplicación cooperativa de segunda prioridad | Solo si `primaryApplyPending === 0` y sin intentos en ventana (`src/qvapay.ts:392-401`) | Igual que #8 | Cede con `409 LOCAL_SECONDARY_YIELD` | `CooperativeHunter.take` (`src/cooperative-hunter.ts:132-137`) |
| 10 | `POST /p2p/{uuid}/cancel?order=` | Cancelar oferta/orden | 20 s (`cancel`) | **No**; mutación incierta exige conciliación | 4xx definitivo vs timeout incierto | `TradingEngine.cancelOwnOffer`, panel `/api/offers/:uuid` DELETE, `/api/operations/:uuid/cancel` |
| 11 | `POST /p2p/{uuid}/paid?order=` | Marcar pagado con `tx_id` (referencia) | 10 s (`paid`) | **No**; `markPaid` usa intento durable local (`src/store.ts` mutation_intents) | `QvaMutationUncertainError` si no hay confirmación | `TradingEngine.markPaid`, `PaymentSmsService` (recibo SMS), panel y Android |
| 12 | `POST /p2p/{uuid}/received?order=` | Confirmar recepción de fiat | 5 s (`received`) | **No** | Igual que #11 | `TradingEngine.confirmReceived`, panel y Android |
| 13 | `POST /p2p/{uuid}/chat?order=` | Enviar texto o multipart (`file`+`message`) | 1 667 ms (`chat`) | `attemptId` durable **solo cliente-side**; no idempotencia upstream documentada (`docs/chat-images.md:69-81`) | `redirect: "error"`; 4xx definitivo vs resultado incierto | `OperationChatService.send`, panel y Android |
| 14 | `GET /p2p/{uuid}/chat?order=` | Listar chat | 1 667 ms (`chat_read`) | No aplica | Envelopes variables (`array`, `data`, `chat`, `messages`) | `OperationChatService.refresh` |
| 15 | `GET /p2p/{uuid}/chat/stream?order=` | SSE de chat de una operación | Sin reintento; `AbortSignal.timeout(90 s)` | No aplica; se re-sincroniza por #14 | 401 sin sesión; content-type distinto → error | `OperationChatService.manageStreams` (máx. 8, throttle 2 s) |
| 16 | `POST /p2p/create` | Crear oferta propia; `idempotency_key` en body | 5 s persistente | Parcial: `idempotency_key` en el body, solo como compatibilidad del adaptador (`src/qvapay.ts:540`) | Timeout/respuesta sin `p2p` → `QvaMutationUncertainError` | `TradingEngine.createOwnOffer`, panel `/api/offers`, rebalanceo |
| 17 | `POST /p2p/{uuid}/edit` | Editar oferta; body libre validado por negocio | 20 s persistente | No documentada | Respuesta sin `p2p` → incierta | `TradingEngine.editOwnOffer`, panel, rebalanceo |
| 18 | `GET https://www.qvapay.com/storage/**.{jpg,png}` (también `api.qvapay.com`) | Descargar imagen de chat | 12 s; máx. 1 MiB; sin redirecciones ni query/fragmento | No aplica | Host/esquema/path fuera de lista → rechazo (`src/chat-images.ts:56-61`) | `QvaPayClient.downloadChatImage` vía panel/Android |

Notas de contrato verificables en el decodificador: montos se aceptan como número **o string decimal** (`src/qvapay.ts:1023-1035`); una oferta exige `uuid`, `type` `buy`/`sell`, `coin`, `amount > 0`, `receive > 0`, `status`, `User.uuid` y `Peer.uuid` cuando corresponde (`src/qvapay.ts:934-961`); las transacciones toleran `total` ausente o vacío (`src/qvapay.ts:371-375`).

### 2.3 Idempotencia real disponible

| Operación | Garantía local | Garantía QvaPay documentada |
| --- | --- | --- |
| Aplicar | ventana durable 2/60 s + preflight + intención antes del POST | Dos intentos por 60 s; sin clave de idempotencia |
| Crear oferta | `idempotency_key` en el body (adaptador actual) | Campo enviado por el cliente; no consta como contrato documentado de QvaPay |
| Editar/cancelar/pagar/recibir | Intención durable + estado incierto bloquea repetición | No documentada |
| Chat | `attemptId` local + tombstone; no se reintenta un POST incierto | No documentada |
| Listar/leer | Ninguna (lectura) | Caché de servidor y `X-Cache` |

**Regla que el gateway/servicio nuevo debe conservar:** persistir la intención *antes* del POST y no reintentar nunca un resultado incierto (`docs/ARCHITECTURE.md:78-82`, `docs/OPERATIONS.md:80-84`).

### 2.4 Clasificación de errores (contrato del adaptador)

```text
fetch/QvaPay
   ├─ error de transporte o timeout de lectura/mutación
   │    ├─ política de lectura → QvaConnectionError("timeout"|"network")
   │    └─ política de mutación → QvaMutationUncertainError(policy)
   └─ respuesta HTTP
        ├─ 2xx → JSON parseado; si el cuerpo no encaja con el schema → Error de parseo (no reintento)
        ├─ 4xx/5xx → QvaApiError(status, message, retryAfterMs?, code?)
        │    ├─ data.code === "PEER_REQUIREMENTS_NOT_MET" → registra data.missing
        │    └─ Retry-After se convierte a ms (segundos o fecha HTTP)
        └─ 429 en listado → además ListingReadBudget.noteRateLimit(owner, retryAfter)
```

Evidencia: `src/qvapay.ts:19-54` (jerarquía), `:722-743` (`json`), `:904-911` (`retryAfterMilliseconds`), `:913-926` (`isTimeoutFailure`); el panel mapea un `QvaApiError` a 502 si el status no es de la lista 400/401/403/404/409/429 (`src/http-dashboard.ts:1331-1343`).

**Códigos locales que no vienen de QvaPay** y que el servicio nuevo debe seguir emitiendo (o traducir explícitamente): `LOCAL_APPLY_QUOTA`, `LOCAL_CONDITIONS_CHANGED`, `LOCAL_PREFLIGHT_FAILED`, `LOCAL_SECONDARY_YIELD`, `LOCAL_SECONDARY_PREFLIGHT_FAILED` (`src/qvapay.ts:777`, `:815`, `:825-828`, `:833`, `:863`, `:868`).

Códigos upstream observados en documentación/operación: `OFFER_CONTENDED` (conflicto reintentable, **no tratado como pérdida definitiva**), `OFFER_PAUSED`, `PEER_REQUIREMENTS_NOT_MET`, y el rechazo "oferta ya tomada" que llega como HTTP 409 genérico (`docs/2026-11-02-hunting-opportunities-review.md:65`, `docs/2026-10-29-hunting-performance-review.md:17`).

### 2.5 Login TOTP (frontera peculiar: CLI, no proceso residente)

```text
pnpm login
  POST /auth/login {email,password,remember:true}
    ├─ 202 + has_otp=true  → pedir TOTP 6 dígitos → POST /auth/login + two_factor_code
    ├─ 202 + has_otp=false → pedir PIN 4 dígitos; si notified !== true → POST /auth/request-pin
    └─ 2xx + accessToken   → GET /user (verifica) → cifrar token AES-256-GCM → SQLite
```

`src/login.ts:42-67`, `src/application/qvapay-login.ts:16-40`, `src/qvapay.ts:169-206`, `src/session.ts:22-27`. El token vive cifrado en `settings.qvapay_token` y se descifra en cada petición; rotar `LOCAL_ENCRYPTION_KEY` invalida el token y exige volver a ejecutar `pnpm login` (`docs/OPERATIONS.md:110-116`). **El proceso residente no tiene credenciales de QvaPay**: si el token no existe o no descifra, `QvaPayClient.request` falla con `QvaApiError(401)` (`src/qvapay.ts:588-593`) y el panel sigue sirviendo datos locales. Este detalle es clave para el *secrets service*: el login no es un flujo de la API.

### 2.6 Listado multi-cuenta y presupuesto compartido

- `ListingReadBudget` guarda en `settings` (`market_list_budget:v1`): `universal`, `lastAny` y `owners` indexado por SHA-256 del owner; reserva `now + 2 401 ms` antes de cada despacho (`src/market-list-budget.ts:5-41`).
- `PollingMarketSource` coordina: máximo 4 *claims* en vuelo, una lectura en vuelo por cuenta, intervalos por cuenta 3–3 600 s, exclusión por owner (una sola lectura simultánea por owner aunque haya varias cuentas) y `nextEligibleAt` persistido (`src/market-source.ts:125-240`).
- Los `401/403` degradan la cuenta a `requires_attention` (no se reintenta hasta intervención); `429` la deja en `cooldown` con `Retry-After`; otros errores usan backoff 3 s × 2^n hasta 60 s (`src/market-source.ts:367-385`, `:431-433`).
- Las cuentas lectoras usan tokens `p2p:read` cifrados; el intervalo válido es 3–3 600 s y el token 12–2 048 caracteres (`src/market-accounts.ts:252-263`). La identidad se valida contra `/user`, que es opcional porque el token puede no concederlo (`src/market-accounts.ts:197-204`).

**Acoplamiento crítico:** el presupuesto es por *owner* QvaPay, no por proceso. Si se separa el *polling* del *apply* en dos servicios, ambos deben compartir el mismo contador durable o el presupuesto se duplica.

### 2.7 Feed SSE (frontera F3)

- URL por defecto `https://api.qvapay.com/v2/p2p/stream`; autenticación por cabeceras **`app-id` y `app-secret`** (no Bearer) (`src/qvapay-feed-stream.ts:50`, `:80-89`).
- Fases públicas: `idle → connecting → connected → backoff`, más `unauthorized` (401), `subscription_required` (402), `expired` (`subscription_expired`) (`src/qvapay-feed-stream.ts:6-19`, `:90-123`).
- Backoff: 1 s base con jitter 0.8–1.2, tope 60 s; errores exigen mínimo 10 s; un cierre limpio usa el `retry:` del servidor (mínimo 1 s); respeta `Retry-After` en 429 (`src/qvapay-feed-stream.ts:101-102`, `:126-145`, `:219-222`).
- Parser SSE propio con límite de evento de **64 KB** y campo `retry` (`src/qvapay-feed-stream.ts:158-206`).
- **No hay replay al reconectar** (documentado por QvaPay; `docs/2026-11-02-hunting-opportunities-review.md:89`), por eso el webhook existe como respaldo durable.
- Redacción de errores: elimina `app-secret`/`app-id` del texto (`src/qvapay-feed-stream.ts:262-265`).

---

## 3. Otras fronteras salientes

### 3.1 Telegram Bot API (long polling)

- `grammy` con `bot.start({ drop_pending_updates: true })`; **sin webhook** (`src/index.ts:1646-1660`).
- Único filtro de autorización: `ctx.chat.id === TELEGRAM_ADMIN_CHAT_ID`; todo lo demás responde "No autorizado" (`src/index.ts:219-229`).
- Salidas: `sendMessage` HTML con teclado inline, `setMyCommands`, `setChatMenuButton`, `answerCallbackQuery` (`src/index.ts:90-104`, `:608-626`).
- Reintento por el propio proceso: si `bot.start` falla, reintenta cada 10 s (`src/index.ts:1650-1659`). Errores de envío no bloquean: la notificación queda en outbox SQLite y se reintenta con backoff 15 s → 1 h (`src/notification-dispatcher.ts:39`, `:137-154`).
- Consumo: los comandos (`/panel`, `/balance`, `/hunting`, `/network`, `/coop`, `/markets`, `/offers`, `/recovery`, `/operations`, `/strategy`, `/automation`, `/scan`, `/logs`, `/diagnostico`, `/historial`, `/salud`, `/rentabilidad`, `/simular`, `/help`) son una **segunda UI sobre la fachada de dominio**, no un cliente HTTP (`src/telegram-menu.ts:5-23`).

### 3.2 Sync Core HTTP (red cooperativa)

Cliente `SyncCoreClient` (`src/hunting-sync.ts:96-233`): timeout **8 s**, tope de respuesta **1 MB**, `Authorization: Bearer <api_key>`; la API key se obtiene por login y empieza por `csk_` (`:103-111`). Se cifra y se reutiliza 4 días (`:20`, `:540-562`).

| Método y ruta | Propósito | Dedupe/idempotencia | Quién |
| --- | --- | --- | --- |
| `POST /auth/login` | Obtener API key (`csk_…`) | No; se re-emite al expirar o ante 401 | `HuntingSyncCoordinator.ensureToken` |
| `GET /hunts/sync` | Snapshot de agregados por mercado | proyección sobrescrita; sin versión monotónica | `reconcileWithToken` (cada 60 s) |
| `GET /hunts?me=true&active=true&page_size=100` | Aportes propios confirmados | No | `contributions` / `syncCapacityInternal` |
| `GET /hunts/participations?after=<cursor>` | Historial de participaciones por cursor | Cursor estrictamente creciente; tope 100 páginas | `setAccountingRefresh` (arranque/30 s) |
| `POST /hunts` | Publicar/actualizar aporte; `expected_updated_at` opcional | Revisión optimista por `revision` | `publish`, `syncCapacity` |
| `DELETE /hunts/{coin}` | Retirar aporte | No | `withdraw`, `syncCapacity` |
| `POST /hunts/reserve` | Reservar capital remoto antes de aplicar | Devuelve `external_id`, `state`, `contributions`; se valida suma ±0.011 | `CooperativeHunter.take` |
| `POST /hunts/reservations/{uuid}/commit` | Confirmar reserva | Reintentable; estado local `commit_pending` | `commit` |
| `POST /hunts/reservations/{uuid}/release` | Liberar reserva | Reintentable; estado local `release_pending` | `release` |

Reglas de negocio en el borde: mínimo cooperativo 5 QUSD, épsilon de capacidad 0.009, reintento de capacidad cada 30 s (`src/hunting-sync.ts:21-23`). `POST /hunts/perform` **no se usa** y está explícitamente fuera de la UI por los defectos P0 documentados (`docs/OPERATIONS.md:29-32`, `docs/upstream/qvapay-bot-sync-issues.md:7-33`).

### 3.3 NATS JetStream

- Conexión `nats://…:4222` con **token = API key de Sync Core**, `reconnect: true`, `maxReconnectAttempts: -1` (`src/hunting-sync.ts:594-600`).
- Stream `CACERIAS`, consumidor durable `qvaapply-<sha256(email)[0:16]>`, `filter_subject: "cacerias.sync"`, `AckPolicy.Explicit`, `DeliverPolicy.Last`, `max_messages: 1` (`src/hunting-sync.ts:601-621`, `:723-725`).
- Payload = snapshot cooperativo completo (mismo parser que `/hunts/sync`); `ack()` tras proyectar, `term("invalid cooperative snapshot")` ante payload inválido, `term("payload too large")` si >1 MB (`src/hunting-sync.ts:628-654`, `:19`).
- HTTP y NATS escriben **la misma proyección** en SQLite (`CooperativeNetworkState`) y pueden llegar fuera de orden; no hay `revision` monotónica (`src/hunting-sync.ts:564-578`, `:628-645`). Riesgo ya señalado en `docs/2026-11-02-hunting-opportunities-review.md:57`.

### 3.4 Web Push (VAPID)

- Claves VAPID generadas al primer arranque y guardadas **en claro** en `settings.web_push:vapid_keys` (`src/web-push.ts:140-150`); suscripciones en `settings.web_push:subscriptions`.
- Envío a endpoints `https://…` arbitrarios (servicios push del navegador) con payload JSON; dedupe por `web_push:sent:<version>:<sha256(endpoint)[0:20]>` (`src/web-push.ts:117-138`).
- 404/410 eliminan la suscripción; otros fallos se agregan y se lanzan (`src/web-push.ts:128-137`).
- Tipos de payload: `blocked-offer`, `operation-applied`, `own-offer-applied`, `reconciliation-required`, `recovery-blocked`, `rebalance-completed`, `rebalance-attention`, `chat-message`, `system-health`, `informational-summary` (`src/web-push.ts:65-115`) y el service worker los renderiza (`src/http-dashboard.ts:1256-1294`).

### 3.5 Firebase Cloud Messaging (Android)

- Solo si `QVAAPPLY_FCM_CREDENTIALS_FILE` existe; carga el JSON de service account (`src/index.ts:547-551`).
- JWT RS256 → `https://oauth2.googleapis.com/token` → `https://fcm.googleapis.com/v1/projects/{project}/messages:send`; timeout 8 s; mensaje **data-only**, prioridad `HIGH`, `ttl 86400s`, `restricted_package_name: com.qvaapply.sms` (`src/chat-push.ts:24-51`).
- `UNREGISTERED` → `PushTokenExpired` y se elimina el dispositivo; 401 invalida el access token (`src/chat-push.ts:46-50`).
- Dedupe local por evento y por hash de token de dispositivo (`chat_push_deliveries`) (`src/chat-push.ts:77-89`).

### 3.6 SMS (no es una API externa)

No existe integración con un proveedor SMS: la app Android lee los SMS bancarios/ETECSA y los publica como **comprobante estructurado** al endpoint device-bearer `POST /api/mobile/payment-receipts` (`src/payment-sms.ts:80-93`, `android/README.md:12-14`). El servidor concilia el comprobante con operaciones locales y remotas antes de `markPaid`; nunca inventa una referencia (`src/payment-sms.ts:239-394`).

---

## 4. Frontera entrante F4 — Superficie HTTP local

### 4.1 Pipeline de autenticación

Todo pasa por un `preHandler` único (`src/http-dashboard.ts:103-126`):

```text
request
 ├─ /api/mobile/device-check (GET)            → sin sesión; Bearer de dispositivo en el handler
 ├─ /api/mobile/payment-receipts (POST)       → sin sesión; Bearer de dispositivo en el handler
 ├─ prefijo mobile operator (lista blanca)    → sin sesión; Bearer de operador en el handler
 │     └─ si TAMBIÉN hay cookie de sesión y el método no es GET/HEAD:
 │           Origin exacto + content-type JSON + CSRF
 ├─ /api/session (no DELETE)                  → público (login)
 ├─ cualquier otra ruta que no empiece /api/  → público (estáticos, webhook)
 └─ resto de /api/*
       ├─ sin cookie válida → 401
       └─ método no GET/HEAD → Origin + content-type JSON + CSRF
```

Propiedades del modelo (`src/dashboard-auth.ts`):

- Contraseña admin ≥14 caracteres (`:34-35`), comparación por SHA-256 y `timingSafeEqual` (`:55`, `:132-138`).
- Sesión: token aleatorio 32 B en cookie `qvaapply_session`, `HttpOnly; SameSite=Strict; Path=/`, `Secure` opcional; 8 h (`:61-65`, `:106-108`).
- Sesiones **en memoria**: reiniciar el proceso cierra todas las sesiones (`docs/OPERATIONS.md:113`).
- Login: máximo 5 intentos por `request.ip` en 15 min (`:50-59`).
- CSRF: token de 24 B ligado a la sesión, exigido en cabecera `x-csrf-token` (`:99-104`).
- Origin exacto contra `DASHBOARD_TRUSTED_ORIGIN`; solo se aceptan equivalencias de loopback con mismo protocolo y puerto (`:81-97`).

### 4.2 Límites de transporte

| Capa | Límite | Evidencia |
| --- | --- | --- |
| Fastify | cuerpo JSON **10 000 B**; 60 s por petición; 10 s de conexión; 100 peticiones por socket | `src/http-dashboard.ts:60-66` |
| Fastify (excepciones) | iconos de mercado **750 000 B**; imágenes de chat **1 MiB + 16 KiB** | `:586`, `:945`; `src/chat-images.ts:1-2` |
| Imágenes de chat | JPEG/PNG, ≤1 MiB, ≤1000×1000; texto ≤599 caracteres; `attemptId` 16–80 | `src/chat-images.ts:9-40`; `docs/chat-images.md:19-33` |
| Nginx | `client_max_body_size 16k`; timeouts proxy 60 s; HSTS 180 días | `deploy/nginx-qvaapply.conf:14`, `:28-30`, `:15` |
| Webhook | cuerpo ≤10 000 B | `src/market-feed.ts:188` |

> **Riesgo de frontera detectado (verificar en producción):** Nginx limita el cuerpo a **16 KiB** mientras la API acepta subidas de chat de hasta **1 MiB + 16 KiB** (`/api/*/operations/:uuid/chat/images`) e iconos de 750 KB (`/api/market-icons`). Con la configuración versionada, esas rutas devolverían `413` en Nginx antes de llegar a Node. `docs/chat-images.md:100-101` exige desplegar backend y APK juntos, pero no menciona el límite de Nginx. Confirmar si la VPS tiene una excepción manual; si no, es un contrato roto entre capas que el gateway nuevo debe resolver con `client_max_body_size` por `location`.

### 4.3 Mapa de rutas (109 entradas efectivas)

Conteo: **102 declaraciones** de ruta en `src/http-dashboard.ts`; el bucle `for (const prefix of ["/api/operations", "/api/mobile/operations"])` (`:915-977`) duplica 7 rutas, total **109**. Envelopes: la mayoría de la API responde `{data: …}` y los errores `{error: "mensaje"}`; algunas rutas móviles/de dispositivo devuelven cuerpo directo (`{ok: …}`) y los estáticos no usan envelope. Algunos GET añaden `source: "sqlite"` y `stale` (`:1211-1223`).

Leyenda de columnas: **Auth** = `sesión` (cookie), `móvil` (Bearer operador), `dispositivo` (Bearer de dispositivo), `público`, `HMAC`; **CSRF** = exige Origin+JSON+`x-csrf-token` (o `—`); **Upstream** = llamada saliente que dispara.

#### 4.3.1 Estáticos y sesión

| Método y ruta | Auth | CSRF | Upstream | Consumidor | Notas |
| --- | --- | --- | --- | --- | --- |
| `GET /` | según cookie | — | — | navegador | HTML del panel o login; `vary: Cookie` |
| `GET /auth/:name` | público | — | — | navegador | solo `login.js`, `login.css`, `theme.js` |
| `GET /service-worker.js` | público | — | — | navegador | genera el SW con VAPID/branding |
| `GET /icons/:name`, `GET /logo/:name` | público | — | — | navegador | whitelist de extensión y path-traversal guard |
| `GET /market-icons/:name` | público | — | — | navegador | iconos subidos por el dueño |
| `GET /dashboard/*` | público | — | — | navegador | estáticos compilados; fingerprint inmutable |
| `GET /api/session` | público | — | — | web/Android | `{authenticated, csrfToken, expiresAt}` |
| `POST /api/session` | público (Origin) | — (Origin sí) | — | navegador | login; schema password 1–256; 201 + cookie |
| `DELETE /api/session` | sesión | sí | — | navegador | logout; 204 |

Los estáticos (`/dashboard/*`, `/icons`, `/logo`, `/auth/:name`, `/market-icons`) se sirven con `ETag` débil, `304` en `If-None-Match`, `HEAD`, compresión precalculada `.br`/`.gz`, `content-length` y streaming con backpressure (`src/static-assets.ts:7-33`). Un gateway que los reemplace debe conservar `ETag`/`304`/encoding o el panel pierde caché y puede romperse en `HEAD`.

#### 4.3.2 Emparejamiento y dispositivos (sesión admin)

| Método y ruta | Auth | CSRF | Upstream | Consumidor |
| --- | --- | --- | --- | --- |
| `POST /api/mobile/devices` | sesión | sí | — | panel (crear credencial SMS) |
| `GET /api/mobile/devices` | sesión | — | — | panel |
| `DELETE /api/mobile/devices/:id` | sesión | sí | — | panel |
| `POST /api/mobile/operators` | sesión | sí | — | panel (crear credencial Android) |
| `GET /api/mobile/operators` | sesión | — | — | panel |
| `DELETE /api/mobile/operators/:id` | sesión | sí | — | panel |
| `GET /api/mobile/payment-receipts` | sesión | — | — | panel (lista de comprobantes) |
| `POST /api/mobile/payment-receipts` | dispositivo | — | — | Android (receptor SMS); 202/200 duplicate |

#### 4.3.3 API móvil (Bearer de operador Android)

| Método y ruta | Scopes | Rate limit | Upstream | Lectura/escritura |
| --- | --- | --- | --- | --- |
| `GET /api/mobile/device-check` | dispositivo | 30/min por dispositivo | — | lectura local |
| `GET /api/mobile/operator-check` | read | 60/min | — | lectura local |
| `GET /api/mobile/operations` | read | 60/min | — | lectura local |
| `GET /api/mobile/alerts` | read | 60/min | — | lectura local |
| `GET /api/mobile/markets` | read | 60/min | — | lectura local |
| `GET /api/mobile/overview` | read | 60/min | — | lectura local (nunca refresca remoto) |
| `GET /api/mobile/insights` | read | 60/min | — | lectura local |
| `GET /api/mobile/receipt-outcomes` | read | 60/min | — | lectura local |
| `POST /api/mobile/simulate` | read | 60/min | — | **solo lectura** aunque sea POST |
| `GET /api/mobile/operations/:uuid/payment-preview` | actions | 20/min (se valida como escritura) | `GET /user`, `GET /p2p/:uuid` | lectura remota, sin mutación (`docs/plans/2026-11-03-operation-payment-handoff.md:10-24`) |
| `POST /api/mobile/operations/:uuid/:action` | actions | **20/min** | `paid`/`received`/`cancel` | **mutación QvaPay** |
| `POST /api/mobile/push-device`, `DELETE /api/mobile/push-device` | read | 60/min | — | registro FCM |
| `GET /api/mobile/operations/chats`, `…/chat`, `…/chat/sends/:attemptId`, `…/chat/images/:messageId` | read | 60/min | `GET chat` / descarga de imagen | lectura remota |
| `POST /api/mobile/operations/:uuid/chat`, `…/chat/images` | actions | 20/min | `POST chat` | **mutación QvaPay** |
| `POST /api/mobile/operations/:uuid/chat/read` | read | 60/min | — | solo local |

Evidencia de rate limiting: `src/mobile-operator.ts:46-67` (read 60/min, write 20/min, ventana 60 s) y `src/store.ts:2673-2682` (dispositivo 30/min). Scopes `read`/`actions` (`src/mobile-operator.ts:49-52`).

#### 4.3.4 Lecturas del panel (sesión)

| Método y ruta | Upstream | Notas |
| --- | --- | --- |
| `GET /api/dashboard` | — | local-first; nunca red |
| `GET /api/live/balance` | `GET /user` | fallback `stale` con caché |
| `GET /api/live/own-offers` | `GET /p2p` (`my`) | ídem |
| `GET /api/live/transactions` | `GET /transaction` | ídem |
| `GET /api/live/operations` | `GET /p2p/:uuid` por operación | ídem |
| `GET /api/live/markets/:coin` | `GET /p2p` | ídem |
| `GET /api/config`, `GET /api/config-revisions` | — | configuración versionada |
| `GET /api/market-source` | — | estado de polling/SSE/webhook + readers |
| `GET /api/market-analytics`, `GET /api/trading-analytics`, `GET /api/analytics/fees` | — | SQLite |
| `GET /api/offers/rebalance/:id` | — | progreso de reajuste |
| `GET /api/recovery` | — | intenciones locales |
| `GET /api/operations/chats/unread`, `GET /api/operations/chats` | — | caché local |
| `GET /api/operations/:uuid/chat` | opcional `GET chat` con `?fresh=1` | sin `fresh` es local |
| `GET /api/operations/:uuid/chat/sends/:attemptId` | — | estado del envío |
| `GET /api/operations/:uuid/chat/images/:messageId` | descarga de imagen | binario `no-store` |
| `GET /api/audit`, `GET /api/logs`, `GET /api/decision-events` | — | SQLite paginado |
| `GET /api/operational-health` | — | última comprobación |
| `GET /api/fiat-history` | — | SQLite paginado |
| `GET /api/hunting/diagnostics` | — | local acotado |
| `GET /api/push/public-key` | — | VAPID pública |
| `GET /api/notifications` | — | outbox persistente |
| `GET /api/openapi.json` | — | OpenAPI manual (ver §4.6) |

#### 4.3.5 Mutaciones del panel (sesión + Origin + JSON + CSRF)

| Método y ruta | Efecto | Upstream |
| --- | --- | --- |
| `PUT /api/market-source` | cambia polling/híbrido | arranca/detiene SSE |
| `PUT /api/market-source/webhook-secret` | cifra secreto HMAC | — |
| `PUT /api/market-source/stream-credentials` | cifra `app-id`/`app-secret` | — |
| `POST /api/market-readers` | añade cuenta lectora | `GET /p2p` (validación) + `GET /user` |
| `PUT /api/market-readers/:id`, `PUT …/token`, `DELETE …/:id` | administra lectores | `GET /p2p`/`GET /user` al rotar |
| `POST /api/market-icons` | guarda icono (≤750 KB) | — |
| `PUT /api/config` | activa revisión de configuración | — |
| `PUT /api/strategy`, `PUT /api/hunting` | límites y cacerías | — |
| `PUT /api/cooperative-network/contributions`, `DELETE …/:coin` | publica/retira aporte | Sync Core |
| `POST /api/cooperative-network/reconcile` | fuerza reconciliación | Sync Core |
| `PUT /api/cooperative-network/hunting` | on/off cooperativo | — |
| `POST /api/cooperative-network/executions/check` | revisa ejecuciones | Sync Core + `GET /p2p/:uuid` |
| `POST /api/cooperative-network/executions/:uuid/distributed` | declara reparto manual | — |
| `PUT /api/control` | pausa/refresco/parada de emergencia | — |
| `POST /api/analytics/fees` | registra comisión con evidencia | — |
| `POST /api/hunting/simulate`, `POST /api/offers/rebalance/preview` | simulación/preview local | — |
| `POST /api/offers/rebalance/apply` | inicia reajuste durable | `POST /p2p/:uuid/edit` |
| `POST /api/offers` | crea oferta | `POST /p2p/create` |
| `PUT /api/offers/:uuid`, `DELETE /api/offers/:uuid` | edita/cancela | `POST /p2p/:uuid/edit` / `cancel` |
| `POST /api/operations/:uuid/:action` (`ack`/`paid`/`received`/`cancel`) | acción humana | `paid`/`received`/`cancel` |
| `POST /api/operations/:uuid/chat`, `…/chat/images`, `…/chat/read` | chat | `POST chat` / solo local (`read`) |
| `POST /api/recovery/:intentId/evidence`, `…/acknowledge`, `…/resolve` | evidencia y resolución manual | — |
| `POST /api/recovery/:intentId/check`, `POST /api/workflows/:id/reconcile` | concilia sin mutar | `GET /p2p/:uuid` |
| `POST /api/blocked-offers/:uuid/preview` | previsualiza | — |
| `POST /api/blocked-offers/:uuid/apply` | aplica omitiendo price guard | `POST /p2p/:uuid/apply` |
| `POST /api/blocked-offers/:uuid/dismiss` | descarta | — |
| `POST /api/decision-events/:id/dismiss`, `…/dismiss-all` | descarta decisiones | — |
| `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` | alta/baja VAPID | — |
| `POST /api/notifications/:id/ack` | confirma lectura | — |

Todas las mutaciones reciben schema JSON estricto (`additionalProperties: false`) y devuelven 204/201/202 según la tabla (`src/http-dashboard.ts:468-1163`). El content-type JSON se exige en el `preHandler` (`requireJson`, `:1296-1305`), lo que bloquea CSRF por formularios simples; la única excepción es multipart de imágenes de chat, que además exige Origin+CSRF cuando hay cookie.

#### 4.3.6 Webhook entrante

| Método y ruta | Auth | Límite | Respuesta | Dedupe |
| --- | --- | --- | --- | --- |
| `POST /webhooks/qvapay/p2p-feed` | HMAC-SHA256 `x-qvapay-signature` + `x-qvapay-timestamp` (±5 min) | 10 000 B | 202 `{ok, duplicate, queued}`; 400/401/503 | `event+uuid+versión(+sent_at/available_amount)` |

Evidencia: `src/http-dashboard.ts:218-239`, `src/market-feed.ts:184-201`, `:348-396`, `:493-514`.

### 4.4 Consumidores de la superficie HTTP

| Consumidor | Protocolo | Rutas que usa | Auth |
| --- | --- | --- | --- |
| Panel web (React) | HTTPS + cookie | `/`, estáticos, `/api/session`, `/api/dashboard`, `/api/live/*`, `/api/config*`, `/api/offers*`, `/api/operations*`, `/api/market-*`, `/api/audit`, `/api/logs`, `/api/notifications`, `/api/push/*` | sesión + CSRF |
| Android (APK Kotlin) | HTTPS + Bearer | `/api/mobile/*` (overview, operations, alerts, markets, insights, simulate, receipts, push-device, chat, payment-preview, actions) + `/api/mobile/payment-receipts` (dispositivo) | Bearer operador / dispositivo; FCM; polling 5 s (15 s en chat) y 30 s para SMS (`android/README.md:6-14`) |
| Telegram | long polling (no HTTP) | — | `TELEGRAM_ADMIN_CHAT_ID` |
| QvaPay | HTTPS entrante | `/webhooks/qvapay/p2p-feed` | HMAC |
| Sync Core | HTTPS/NATS saliente | — | API key `csk_` |
| Service worker | mismo origen | `/service-worker.js`, `/api/push/*`, `/api/notifications` | sesión del navegador |
| CI/CD | HTTP local | `/api/session` como healthcheck (`deploy/compose.yaml:34-43`, `docs/VPS.md:107`) | público |
| Nginx | proxy inverso | todo | — |

### 4.5 Qué es solo lectura y qué no

- **Solo lectura pura (SQLite):** dashboard, config, revisiones, auditoría, logs, decision-events (GET), notifications (GET), operational-health, fiat-history, analytics locales, hunting diagnostics, chats cacheados, recovery (GET), rebalance job (GET), openapi, push public-key.
- **Lectura con `GET` remoto (no muta):** `/api/live/*`, `payment-preview`, `chat?fresh=1`, descarga de imágenes, `recovery/:id/check`, `workflows/:id/reconcile`, validación al añadir/rotar cuentas lectoras.
- **`POST` que en realidad es lectura:** `/api/mobile/simulate`, `/api/hunting/simulate`, `/api/offers/rebalance/preview`, `/api/blocked-offers/:uuid/preview`, `/api/recovery/:intentId/check`, `/api/workflows/:id/reconcile`. Un gateway que asuma "POST = escritura" rompería idempotencia/CSRF si las trata distinto.
- **Escritura local con efecto remoto indirecto:** `POST /api/control` (pausa el motor), cambios de `market-source` (arrancan SSE), `push/subscriptions`.

### 4.6 Deriva del OpenAPI

`GET /api/openapi.json` se construye **a mano** (`src/http-dashboard.ts:1363-1438`). No documenta `/api/session`, el emparejamiento de dispositivos/operadores móviles, `receipt-outcomes`, `insights`, `simulate`, `push-device`, las rutas de imágenes de chat ni el webhook con su `security: []`; y declara `security` global por cookie que no aplica a las rutas móviles o al webhook. No es una fuente de verdad para el gateway: la lista de §4.3 sí lo es. Al congelar contratos conviene generar el OpenAPI desde los schemas reales (Fastify los tiene) y compararlo con esta lista.

---

## 5. Eventos, streams y canales asíncronos

| Canal | Dirección | Transporte | Autenticación | Dedupe / idempotencia | Durabilidad | Reintento |
| --- | --- | --- | --- | --- | --- | --- |
| Feed SSE QvaPay | saliente | `GET /v2/p2p/stream`, `text/event-stream` | `app-id` + `app-secret` | clave `event+uuid+versión`; sin replay upstream | eventos persistidos en `market_feed_events` | backoff 1 s→60 s, mínimo 10 s en error, `retry:` respetado |
| Webhook QvaPay | entrante | HTTPS POST | HMAC-SHA256 + timestamp ±5 min | misma clave que SSE; el `INSERT` decide `duplicate` | 202 solo tras `enqueueMarketFeedEvent` | QvaPay reintenta; cola local con backoff hasta 5 intentos (`src/store.ts:1965-1978`) |
| Polling P2P | saliente | HTTPS | Bearer (cuenta principal y lectores) | por versión de oferta y secuencia de despacho (`src/market-source.ts:198-202`) | snapshot en SQLite | presupuesto + `Retry-After` + backoff por cuenta |
| Cola interna del feed | interna | microtask + SQLite | — | estados `pending/processed/ignored/failed` | SQLite `market_feed_events` | `attempts` 1..5, backoff 1 s×2^n tope 60 s |
| NATS JetStream | saliente (consumo) | NATS | token = API key Sync | ack explícito; sin dedupe por mensaje (snapshot completo) | stream `CACERIAS` durable `qvaapply-<hash>` | reconexión infinita; `DeliverPolicy.Last` |
| Sync Core HTTP | saliente | HTTPS | Bearer `csk_` | revisión optimista en aportes; reservas con `external_id` | estado local `remote_resource_cache` | reintento por tarea (60 s/5 s/30 s) y refresh de token ante 401 |
| Web Push | saliente | HTTPS a push service | VAPID (claves en claro) | `web_push:sent:<version>:<endpoint-hash>` | suscripciones en SQLite | 404/410 purga; otros errores reintento por outbox |
| FCM | saliente | HTTPS OAuth2 | service account RS256 | por evento + hash de token (`chat_push_deliveries`) | cola `chat_push_events` | backoff 2 s×2^n tope 300 s; `UNREGISTERED` purga |
| Chat SSE por operación | saliente | `GET /p2p/:uuid/chat/stream` | Bearer QvaPay | re-sync por listado; throttle 2 s | caché 30 días | abort 90 s, reintento 30 s, máx. 8 hilos |
| Telegram | saliente | long polling | token bot + chat id admin | outbox `notification_events` con `id` determinista | SQLite | 15 s→1 h, dos canales independientes |
| SMS (Android→backend) | entrante | HTTPS POST | Bearer de dispositivo | `(bank,sender,transaction_id)` + `INSERT OR IGNORE` | SQLite `payment_receipts` | ventana 10 min de reintento, backoff 15 s×2^n |

**Dedupe del feed, en detalle** (`src/market-feed.ts:348-396`): clave base `event:uuid:versión` donde versión = `data.updated_at` si existe o `sent_at`; para `p2p.range_*` se añade `sent_at` y `available_amount`; para `p2p.paused`/`p2p.resumed` se añade `sent_at`. Esto es lo que permite que SSE y webhook entreguen el mismo evento sin duplicar la aplicación. Un servicio de ingesta nuevo debe reproducir exactamente esta clave o el motor verá duplicados.

**Eventos del feed**: oportunidad = `p2p.created`, `p2p.reopened`, `p2p.resumed`, `p2p.range_created`, `p2p.range_updated`; estado = `p2p.paused`, `p2p.applied`, `p2p.paid`, `p2p.completed`, `p2p.cancelled`, `p2p.range_closed` (`src/market-feed.ts:438-449`). Contrato del payload: `{event, sent_at, data:{uuid, type, coin, amount>0, receive>0, status, …}}`; `uuid` con regex `^[A-Za-z0-9-]{8,100}$`, `coin` `^[A-Z0-9_]{2,40}$` (`src/market-feed.ts:467-491`).

---

## 6. Topología actual y servicios nuevos

### 6.1 Diagrama (producción)

```text
                       Internet
                          │ 80/443
                 ┌────────▼────────┐
                 │      Nginx      │  qvapply.honux.tech
                 │  TLS + HSTS     │  client_max_body_size 16k
                 │  proxy / → :8782│  proxy timeouts 60 s
                 └────────┬────────┘
                          │ 127.0.0.1:8782 (host port → 3000)
        ┌─────────────────▼──────────────────────────────────────┐
        │ Docker network "caceria-net" (externa) + "default"      │
        │                                                         │
        │  ┌───────────────────────────────────────────────────┐  │
        │  │ qvaapply (Node 24, read_only, cap_drop ALL)       │  │
        │  │ :3000 Fastify · Telegram polling · Scheduler      │  │
        │  │ QvaPay REST+SSE · Sync HTTP · NATS · VAPID · FCM  │  │
        │  │ vol: /opt/qvaapply/data → /app/data (SQLite WAL)  │  │
        │  └───────────────────────────────────────────────────┘  │
        │                                                         │
        │  ┌───────────────────────────┐                          │
        │  │ caceria-sync-server       │  HTTP :8080 · NATS :4222 │
        │  │ (otro contenedor, misma   │  solo red interna        │
        │  │  VPS; puertos no públicos)│                          │
        │  └───────────────────────────┘                          │
        └─────────────────────────────────────────────────────────┘

Salidas externas: api.qvapay.com (REST/SSE), api.telegram.org (long polling),
www/api.qvapay.com/storage (imágenes), oauth2.googleapis.com + fcm.googleapis.com,
push services del navegador, y el propio Sync Core.
```

Evidencia: `deploy/compose.yaml:3-48`, `deploy/nginx-qvaapply.conf:1-32`, `docs/VPS.md:8-30`, `:98`, `:128-148`.

### 6.2 Puertos y procesos

| Elemento | Puerto | Exposición | Notas |
| --- | --- | --- | --- |
| Nginx HTTP | 80 | pública | redirige a TLS tras `enable-vps-tls.sh` |
| Nginx HTTPS | 443 | pública | HSTS; proxy a 8782 |
| QvaApply (host) | `QVAAPPLY_HOST_PORT` (8782 en docs) | solo loopback | `127.0.0.1:${QVAAPPLY_HOST_PORT}:3000` |
| QvaApply (contenedor) | 3000 | red Docker | Fastify escucha `0.0.0.0` en compose |
| Sync Core HTTP | 8080 | red `caceria-net` | no publicado al host/Internet |
| NATS | 4222 | red `caceria-net` | mismo criterio |
| SQLite | — | volumen host | `read_only` + volumen; una sola instancia |

### 6.3 Tareas programadas (frontera temporal)

Registradas en `src/index.ts:533-605`; el scheduler encadena `setTimeout` y no solapa ejecuciones (`src/scheduler.ts:70-82`). La tabla es representativa de las fronteras externas, no un inventario exhaustivo del dominio:

| Tarea | Intervalo | Frontera externa / efecto |
| --- | ---: | --- |
| `chat_push` | 2 s | FCM + Web Push |
| `refresh` | 5 s | `GET /p2p` (ofertas propias) |
| `capital_rebalance` | 5 s | ediciones QvaPay |
| `operation_chat` | 5 s | SSE/listado de chat |
| `cooperative_capacity` | 5 s | Sync Core `POST/DELETE /hunts` |
| `recovery_alerts` | 10 s | Telegram/Web Push |
| `notifications` | 15 s | outbox Telegram/Web Push |
| `sms_receipts` | 15 s | conciliación de comprobantes |
| `market_observation` | 15 s | lecturas QvaPay |
| `operation_sync` | 30 s | `GET /p2p/:uuid` |
| `fiat_sync` | 30 s | `GET /transaction` |
| `dashboard_cache` | 30 s | lecturas QvaPay |
| `cooperative_hunt_reconcile` | 30 s | Sync Core + `GET /p2p/:uuid` |
| `operational_health` | 60 s | diagnóstico local/remoto |
| `mutation_reconcile` | 60 s | `GET /p2p/:uuid` |
| `market_reader_identity` | 60 s | `GET /user` por lector |
| `portfolio_commitments` | 60 s | local |
| `completed_offer_history` | 60 s | `GET /p2p`/`GET /transaction` |
| `cooperative_reconcile` | 60 s | Sync Core HTTP |
| bucles de cacería/saldo | dinámicos | polling/feed/evaluación |

### 6.4 Servicios nuevos que exige este mapa

| Servicio propuesto | Fronteras que absorbe | Estado que **debe** ser único/durable | Riesgo si se separa mal |
| --- | --- | --- | --- |
| `gateway` | F4 (TLS, sesión, CSRF, Origin, rate limits, validación de schema, proxy ruta→servicio) | sesiones (hoy en memoria), tabla de rutas y envelopes | Cambiar envelopes/códigos rompe panel y Android ya instalados |
| `qvapay-adapter` / `executor` | F1, F3, F2 (cliente REST, SSE, webhook) | presupuesto de listados por owner, ventana 2/60 s, intenciones inciertas, token QvaPay | **Doble gasto** o doble aplicación con dos réplicas |
| `market-ingest` | F2, F3, polling | dedupe `event+uuid+versión`, caché de ofertas, cuentas lectoras | Duplicados de eventos → doble aplicación |
| `trading-core` | lógica de decisión (dominio) | reservas, workflows, ledger fiat, epoch de configuración | Pedir dos veces el mismo capital |
| `notification-service` | Telegram, Web Push, FCM | outbox `notification_events`, dedupe por versión | Avisos duplicados o perdidos (no bloquea dinero) |
| `chat-service` | SSE de chat, imágenes, intentos de envío | tombstones `attemptId`, caché por hilo | Reenvío ciego de un POST incierto |
| `sync-coop-adapter` | F5, F6 | token `csk_`, proyección con revisión monotónica | Sobrescritura de snapshot fuera de orden |
| `dashboard-bff` | lecturas del panel | caché local (hoy SQLite del mismo proceso) | Mostrar datos "actuales" que son viejos |

**Regla de oro para el plan maestro:** el *executor* QvaPay debe ser un **único escritor por cuenta** con presupuesto durable compartido y fencing explícito; cualquier escalado horizontal de ese componente sin exclusión reproduce los incidentes de doble aplicación que el diseño actual evita. NATS no sustituye la exclusión del dinero (`docs/2026-11-02-hunting-opportunities-review.md:77`).

---

## 7. Contratos a congelar como tests de contrato

La suite actual ya cubre gran parte de esto en TypeScript; al migrar, cada punto debe existir como **test de conformidad** contra cualquier implementación (HTTP/CLI), con un **fake QvaPay determinista** que no toque red. Diseño propuesto: cassette de respuestas (fixtures JSON + cabeceras) con reloj inyectable, igual que hoy `QvaPayRuntime` inyecta `fetch`, `now`, `sleep`, `random` (`src/qvapay.ts:71-90`, `src/qvapay-feed-stream.ts:21-26`).

| ID | Contrato | Casos obligatorios del fake | Por qué (evidencia) |
| --- | --- | --- | --- |
| K1 | Login TOTP/PIN | 200 token; 202 `has_otp:true`; 202 `notified:false` → request-pin; 401 TOTP; 423; 429; timeout que reintenta 3 veces | `src/qvapay.ts:169-206`, `docs/OPERATIONS.md:37` |
| K2 | Listado | 200 envelope `data`/`offers`, `total/current_page/per_page`, `x-cache` HIT/MISS; 429+`Retry-After`; timeout a los 3 intentos; oferta malformada → error de parseo; presupuesto 2 401 ms entre despachos del mismo owner | `src/qvapay.ts:214-272`, `:644-668`, `src/market-list-budget.ts` |
| K3 | Aplicar | 200 vacío; 409 `OFFER_CONTENDED`; 409 `OFFER_PAUSED`; 409 `PEER_REQUIREMENTS_NOT_MET` con `missing`; 429 con/sin `Retry-After`; timeout → `QvaMutationUncertainError`; tercer intento en <60 s → `LOCAL_APPLY_QUOTA`; preflight falso → `LOCAL_CONDITIONS_CHANGED` | `src/qvapay.ts:378-401`, `:801-887`, `src/core/apply-budget.ts` |
| K4 | Mutaciones ambiguas | `create`/`edit`/`cancel`/`paid`/`received`: timeout y 5xx → incierta; 4xx definitiva no bloquea reintento manual; `create` con `idempotency_key` repetido no duplica | `src/qvapay.ts:509-573`, `:625-630`; `docs/ARCHITECTURE.md:78-84` |
| K5 | Webhook | HMAC válida `sha256=<hex>`; firma inválida; timestamp ausente/vencido >5 min; cuerpo >10 KB; JSON inválido; oferta inválida; duplicado → `duplicate:true`; 202 solo tras persistir | `src/market-feed.ts:184-201`, `:493-514` |
| K6 | SSE feed | `init` con `expires_at`; `subscription_expired`; 401; 402; `retry:` respetado; cierre limpio; evento >64 KB rechazado; `app-secret` nunca aparece en el error | `src/qvapay-feed-stream.ts` completo |
| K7 | Chat | listar con envelopes `array`/`data`/`chat`/`messages`; enviar texto con `id` en `message`/`data`/raíz; multipart acepta `file`+`message`; `attemptId` mismo contenido → confirmado sin segundo POST; contenido distinto → 409; stream sin `text/event-stream` → error; frame SSE >64 KiB → error y el SSE solo invalida caché, nunca decide dinero; imagen fuera de host → rechazo; >1 MiB → rechazo | `src/qvapay.ts:423-507`, `src/operation-chat.ts:135-172`, `src/chat-stream.ts:1-21`, `src/chat-images.ts` |
| K8 | Sync Core | login devuelve `csk_`; snapshot/contributions con `data`; reserva con suma `owner_fiat + Σ fiat_amount = offer.receive` ±0.011 → si no, error; 401 refresca token y reconecta NATS; cursor no creciente → error; respuesta >1 MB → error; timeout 8 s | `src/hunting-sync.ts:103-232`, `:165-184`; `docs/upstream/qvapay-bot-sync-issues.md` |
| K9 | NATS | consumidor durable `qvaapply-<hash>` sobre `CACERIAS`/`cacerias.sync`, `DeliverPolicy.Last`, ack explícito; payload inválido → `term`; >1 MB → `term`; reconexión conserva suscripción | `src/hunting-sync.ts:580-654` |
| K10 | Entrada HTTP | cookie ausente → 401; Origin distinto → 403; JSON no-`application/json` → 403; CSRF ausente/erróneo → 403; Bearer móvil sin scope → 401; rate read 60/min, write 20/min → 429; dispositivo 30/min → 429; login 5/15 min → 429; body >10 KB → 413; path traversal en estáticos → 404 | `src/http-dashboard.ts:103-138`, `src/dashboard-auth.ts`, `src/mobile-operator.ts:46-67` |
| K11 | Envelopes/códigos HTTP | `{data}` éxito, `{error}` fallo; `stale:true` con caché; `QvaApiError` no listado → 502; 400/401/403/404/409/429 pasan tal cual; 204 en mutaciones sin cuerpo | `src/http-dashboard.ts:1211-1223`, `:1331-1343` |
| K12 | Decimales | montos como string decimal o número; `amount`/`receive` >0; `take` de transacciones ≤30; fiat de pago asistido con 2 decimales exactos | `src/qvapay.ts:1023-1035`, `:359-376`; `src/assisted-payment.ts:81-82` |
| K13 | Dedupe feed | mismo evento por SSE y webhook → una sola aplicación; `range_*` con `available_amount` distinto → no es duplicado; `p2p.paused`/`resumed` con `sent_at` distinto → no es duplicado; `updated_at` constante y `sent_at` repetido no genera ciclos | `src/market-feed.ts:352-359`, `docs/2026-10-29-hunting-performance-review.md:25-28` |
| K14 | Notificaciones | mismo evento → mismo `id`; reintento no duplica; 404/410 de push purga endpoint; FCM `UNREGISTERED` revoca dispositivo; fallo de un canal no impide el otro | `src/notification-dispatcher.ts:127-167`, `src/web-push.ts:117-138`, `src/chat-push.ts:38-51` |

**Casos negativos que hoy son requisito de producto, no "nice to have":** respuesta ambigua de mutación **nunca** se reintenta; un `409 OFFER_CONTENDED` **no** se trata como pérdida definitiva; una lectura fallida **nunca** borra la caché; un `429` **no** se convierte en reintento de listado; una firma inválida **no** se registra en auditoría como evento válido.

---

## 8. Incidentes documentados y contrato que exigen

| Incidente / hallazgo (documento) | Consecuencia real | Contrato/tests que exige |
| --- | --- | --- |
| `docs/2026-10-07-offer-race-latency.md:9-12` | Decisión local 3 ms vs 1 218 ms de respuesta remota; rechazos por límite de 10 operaciones y comisión efectiva > nominal | K3, K12 (tasa efectiva con comisión, no nominal) |
| `docs/2026-10-16-fiat-cooperative-reconciliation.md:5-7` | Movimientos del feed aplicados a operaciones locales canceladas; la base cooperativa se sustituía por el saldo actual absorbiendo movimientos personales; una respuesta HTTP de capacidad sobrescribía ajustes concurrentes | K13 (estado terminal gana), K8 (delta, no reemplazo), K11 (idempotencia de proyecciones) |
| `docs/fixes/2026-10-22-runtime-and-own-offer-safety.md:3-7` | **16 intenciones de cancelación en producción** por preparación de liquidez sin oportunidad concreta | Regla de dominio (no frontera) + K4: cancelar nunca es "preparación" automática |
| `docs/2026-10-29-hunting-performance-review.md:9-19` | 79 aplicaciones en 48 h: 41 confirmadas, 23 HTTP_409, 11 `OFFER_CONTENDED`, 2 HTTP_400, 2 `OFFER_PAUSED`; respuesta remota p50 1 015 ms / p95 1 557 ms; 25 080 eventos con p95 de entrega 48,9 s (mezcla de canales) | K3 (clasificación de 409), K6/K13 (entrega tardía y duplicados) |
| `docs/2026-10-29-hunting-performance-review.md:42` | Tres carreras reproducidas: pausa oculta por un tercer evento con el mismo `sent_at`; ciclos con `updated_at` constante; reanudación antigua tras cotización nueva | K13 con fixtures de múltiples eventos same-`sent_at` y versiones |
| `docs/2026-10-30-continuous-hybrid-polling.md:5-9` | No se hacía polling con SSE conectado; `last_scan` no se escribía; dos lectores confirmados en producción | K2 (polling y SSE simultáneos), contrato de estado de fuente |
| `docs/2026-11-02-hunting-opportunities-review.md:45-57` | Cupo de aplicación retenido durante respuesta; HTTP y NATS sobrescriben la misma proyección; `aggregate` exige HTTP reciente aunque NATS funcione; `OFFER_CONTENDED` marcado como visto | K8/K9 (revisión monotónica), K3 (`OFFER_CONTENDED`) |
| `docs/upstream/qvapay-bot-sync-issues.md:7-33` | Sync Core descuenta dos veces con el mismo `external_id`; validación devuelve errores equivocados; NATS no publica al eliminar | K8: la reserva debe ser atómica y verificable; **prohibido** depender de `/hunts/perform` (ya excluido) |
| `docs/2026-10-29-hunting-performance-review.md:26` | 983 intenciones históricas, 3 inciertas; índice parcial bajó búsqueda de 1 456 ms a 0,25 ms | K4: la intención incierta es un estado durable consultable |
| `docs/2026-11-02-hunting-release-verification.md:19-21` | Healthcheck solo `GET /api/session`; no demuestra latencia ni captura | K10/K11: el contrato de salud del gateway debe ser explícito |
| `docs/plans/2026-11-03-operation-payment-handoff.md:10-24` (pago asistido) | `payment-preview` verifica identidad/rol/contraparte/importe y no muta; huella + vencimiento de 2 min; nunca elige un destino entre varios | K12 y contrato de `payment-preview` (`fingerprint` + `expiresAt` 120 s, `src/assisted-payment.ts:81-95`) |

---

## 9. Seguridad de fronteras

### 9.1 Inventario de secretos

| Secreto | Origen | Almacenamiento | Cifrado | Rotación |
| --- | --- | --- | --- | --- |
| Token bot Telegram | `TELEGRAM_BOT_TOKEN` | env (`/opt/qvaapply/config/env`, 600) | no aplica | BotFather + reinicio |
| Chat admin | `TELEGRAM_ADMIN_CHAT_ID` | env | no aplica | manual |
| Clave maestra local | `LOCAL_ENCRYPTION_KEY` (64 hex) | env | — | invalida tokens cifrados (`docs/OPERATIONS.md:114`) |
| Contraseña panel | `DASHBOARD_ADMIN_PASSWORD` (≥14) | env | hash SHA-256 en memoria | reinicio |
| Token de sesión QvaPay | login | `settings.qvapay_token` | **AES-256-GCM** (`src/vault.ts`) | `pnpm login` |
| Tokens lectores `p2p:read` | alta/rotación | `market_reader_accounts.encrypted_token` | AES-256-GCM; fingerprint SHA-256 | rotación por panel |
| Secreto webhook | panel | `settings.market_feed_secret` | AES-256-GCM | panel |
| `app-id`/`app-secret` SSE | panel | `settings.market_feed_app_id/app_secret` | AES-256-GCM | panel |
| API key Sync Core | login Sync | `settings.cooperative_sync_token` | AES-256-GCM | rotación + reinicio |
| Usuario/clave Sync | `SYNC_EMAIL`/`SYNC_PASSWORD` | env | no aplica | cambio + reinicio |
| Token/dispositivo Android | panel genera | `token_hash` SHA-256 | hash (no reversible) | revocar y reemparejar |
| Token de operador Android | panel genera | hash SHA-256 + scopes | hash | revocar |
| Credencial FCM | `QVAAPPLY_FCM_CREDENTIALS_FILE` | archivo 0400 fuera de Git | no cifrado en reposo (lo protege el FS) | rotar service account |
| Clave privada VAPID | generada | `settings.web_push:vapid_keys` | **en claro** | regenerar invalida suscripciones |
| Suscripciones push | navegador | `settings.web_push:subscriptions` | no sensible | purga 404/410 |

### 9.2 Controles y hallazgos

- **Cookies:** `HttpOnly`, `SameSite=Strict`, `Secure` solo con `DASHBOARD_SECURE_COOKIES=true`; en producción TLS lo activa (`docs/VPS.md:89-96`). Sin `Domain` (host-only).
- **CSRF:** token por sesión en cabecera, comparación por digest y `timingSafeEqual`; además se exige content-type JSON, lo que bloquea el envío cross-site por formulario (`src/http-dashboard.ts:121-125`, `:1296-1305`).
- **Origin:** comparación exacta más equivalencia de loopback; no hay CORS (ningún `Access-Control-Allow-Origin`), CSP `connect-src 'self'`, `frame-ancestors 'none'` (`src/http-dashboard.ts:88-101`, `src/dashboard-auth.ts:81-97`). Los clientes nativos no envían Origin y usan Bearer; si además hay cookie, se les exige Origin+CSRF (`:107-116`).
- **Hallazgo — `request.ip` detrás de Nginx:** Fastify no configura `trustProxy`, y Nginx envía `X-Forwarded-For` (`deploy/nginx-qvaapply.conf:24-25`). El rate limit de login (5/15 min) usa `request.ip`, que será la IP de Nginx (127.0.0.1) para todos: el límite se vuelve global (protege fuerza bruta, pero un atacante puede agotar el login del dueño). El gateway nuevo debe fijar `trustProxy` con la lista correcta o rate-limitar en el borde.
- **Hallazgo — VAPID privada en claro** en `settings` (`src/web-push.ts:140-150`). Cualquier lectura de SQLite/backup permite enviar push suplantando el panel. Debe cifrarse con `LOCAL_ENCRYPTION_KEY` en el servicio nuevo.
- **Hallazgo — token NATS = API key Sync Core** transmitido sobre `nats://` (sin TLS en el esquema por defecto). Aceptable solo dentro de `caceria-net`; el compose nuevo debe fijar TLS o mantener la red privada y documentarlo.
- **Listeners:** el contenedor escucha `0.0.0.0:3000` pero el puerto host se publica en loopback (`deploy/compose.yaml:18-21`). El panel es vulnerable si se publica más allá de Nginx.
- **Webhook público:** HMAC + ventana de 5 min + dedupe; sin allowlist de IP (QvaPay no la documenta). Riesgo de replay dentro de la ventana mitigado por dedupe; un atacante con el cuerpo firmado no puede forjar eventos nuevos sin el secreto.
- **Tokens de listado:** nunca se devuelven al navegador (`PublicMarketReaderAccount.tokenConfigured: true`, `src/market-accounts.ts:206-223`); se validan con un listado mínimo y `/user` opcional. Comparten cupo del owner: un token filtrado puede consumir cuota, aunque no puede mutar.
- **Cifrado en reposo:** solo secretos; los datos financieros de SQLite no están cifrados (se protege con permisos 600/umask 077 y backups). `read_only` + `cap_drop ALL` + `no-new-privileges` (compose).
- **Redacción de logs:** `safeError` elimina `Bearer`, `app-secret`/`app-id`, `csk_…` y `N|token` en varios módulos (`src/market-source.ts:439-444`, `src/qvapay-feed-stream.ts:262-265`, `src/hunting-sync.ts:727-732`). El servicio nuevo debe conservar esta disciplina; los errores HTTP del panel no exponen stack (`src/http-dashboard.ts:128-138`).
- **Superficie Android:** Bearer de operador con scopes y rate limits; dispositivos SMS con 30 req/min; comprobantes solo de los últimos 7 días y +5 min de tolerancia (`src/payment-sms.ts:419-428`). El APK conserva una copia cifrada de lectura y guarda adjuntos con AES-GCM y clave de Android Keystore (`android/README.md:6`, `docs/chat-images.md:62-64`), pero la API es la misma superficie pública: el gateway nuevo debe mantener la autenticación Bearer y los códigos exactos o las versiones instaladas dejarán de funcionar.

---

## 10. Recomendaciones para el plan maestro

1. **Congelar el *adapter* QvaPay antes que el dominio.** Un paquete/servicio con la interfaz exacta (`apply`, `applySecondary`, `cancel`, `edit`, `create`, `paid`, `received`, `listOffersPage`, `getOffer`, `qusdBalance`, `profile`, `transactions`, `averages`, `chat*`, `stream`) y la clasificación de errores de §2.4 permite portar el dominio sin volver a descubrir el transporte. Hoy ese contrato está en `src/qvapay.ts` y en los tipos `P2P` de `src/types.ts`.
2. **El executor debe ser singleton lógico con presupuesto durable.** Mantener en el nuevo storage las claves `qva_throttle:*`, `market_list_budget:v1`, `qva_apply_last_*`, y un mecanismo de fencing por cuenta. Sin esto, ningún escalado es seguro.
3. **Gateway como "reemplazo observable" del Fastify actual.** Debe reproducir: envelopes, códigos, headers de seguridad, cookie/CSRF/Origin, límites de cuerpo, rutas estáticas, service worker y el webhook HMAC. Empezar por congelar §4.3 como tabla de rutas + K10/K11.
4. **Separar primero lo que no toca dinero:** notificaciones (outbox ya existe en SQLite) y dashboard de lectura (BFF con caché). Son los de menor riesgo de doble gasto y ya tienen contratos claros (K14, K11).
5. **Ingesta de mercado como servicio dedicado** (SSE + webhook + polling + dedupe), con el presupuesto de listados compartido vía almacén central. Es la mayor fuente de latencia y la que más se beneficia de un proceso aislado del event loop del panel (`docs/2026-11-02-hunting-opportunities-review.md:75`).
6. **No mover la reserva cooperativa** hasta que Sync Core tenga idempotencia transaccional verificada (P0 upstream). El adaptador nuevo debe exponer `reserve/settle` como operaciones de negocio auditables y no como llamadas HTTP sueltas.
7. **Preservar el modo CLI del login QvaPay.** El token se obtiene fuera del proceso residente; el servicio nuevo necesita un `secrets provider` o un comando de operación equivalente, no un endpoint HTTP de login (hoy no existe y no debe añadirse como superficie pública).
8. **Resolver la inconsistencia Nginx 16 KiB vs subidas de 1 MiB** antes de separar el gateway: si no, el nuevo borde heredará un 413 silencioso.
9. **Verificación read-only recomendada** para el equipo de migración (sin red):
   - `grep -n "app\.\(get\|post\|put\|delete\)" src/http-dashboard.ts` → lista viva de rutas;
   - `grep -n "POLICY_INTERVAL_MS\|RequestPolicy" src/qvapay.ts` → cuotas locales;
   - `grep -n "client_max_body_size" deploy/nginx-qvaapply.conf` → límite del borde;
   - `node --import tsx --test test/*.test.ts` en un checkout aislado para la línea base (no ejecutar `pnpm dev` contra el `.env` de producción).

### Preguntas abiertas para el dueño / plan maestro

- ¿Se mantendrá una sola instancia (SQLite) durante la transición o se escribirá un *strangler* con doble escritura? El contrato de fronteras no decide esto, pero el presupuesto durable sí condiciona la respuesta.
- ¿El panel web seguirá siendo servido por el mismo origen que la API (cookie + CSRF) o se separará el frontend? Si se separa, hay que rediseñar CSRF/Origin, hoy acoplados a mismo origen.
- ¿Se conservarán los tokens de operador Android ya emitidos? El contrato de hashes y scopes debe migrarse o los dispositivos se reemparejan.
- ¿Se externaliza la clave VAPID a un secreto cifrado? Recomendado antes de mover notificaciones.

---

## Anexo A — Archivos fuente citados

- QvaPay: `src/qvapay.ts`, `src/qvapay-feed-stream.ts`, `src/market-feed.ts`, `src/market-source.ts`, `src/market-accounts.ts`, `src/market-list-budget.ts`, `src/core/apply-budget.ts`, `src/login.ts`, `src/application/qvapay-login.ts`, `src/session.ts`, `src/vault.ts`, `src/chat-images.ts`.
- Sync: `src/hunting-sync.ts`, `src/cooperative-hunter.ts`.
- HTTP/panel: `src/http-dashboard.ts`, `src/dashboard-auth.ts`, `src/mobile-operator.ts`, `src/static-assets.ts`, `src/dashboard.ts`.
- Notificaciones/chat/SMS: `src/web-push.ts`, `src/chat-push.ts`, `src/notification-dispatcher.ts`, `src/operation-chat.ts`, `src/chat-stream.ts`, `src/payment-sms.ts`, `src/assisted-payment.ts`.
- Arranque: `src/index.ts`, `src/scheduler.ts`, `src/reconciliation-scheduler.ts`, `src/config.ts`.
- Operación: `deploy/compose.yaml`, `deploy/nginx-qvaapply.conf`, `deploy/Dockerfile`, `docs/VPS.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `docs/chat-images.md`, `android/README.md`, `README.md`.
- Incidentes: `docs/2026-10-07-offer-race-latency.md`, `docs/2026-10-16-fiat-cooperative-reconciliation.md`, `docs/2026-10-29-hunting-performance-review.md`, `docs/2026-10-30-continuous-hybrid-polling.md`, `docs/2026-11-02-hunting-opportunities-review.md`, `docs/2026-11-02-hunting-release-verification.md`, `docs/fixes/2026-10-22-runtime-and-own-offer-safety.md`, `docs/upstream/qvapay-bot-sync-issues.md`, `docs/plans/2026-11-03-operation-payment-handoff.md`.

## Anexo B — Glosario mínimo de frontera

| Término | Significado en este documento |
| --- | --- |
| **owner** | Cuenta QvaPay dueña de un token; el cupo de listado y la ventana de aplicación son por owner |
| **presupuesto de listado** | Reserva durable de 2 401 ms por despacho de `GET /p2p` (`market_list_budget:v1`) |
| **ventana de aplicación** | 2 aplicaciones por 60 001 ms, persistidas antes del POST |
| **intención incierta** | Mutación sin confirmación remota; bloquea repetición y exige conciliación |
| **read model** | Proyección local (SQLite) que el panel sirve sin esperar a QvaPay |
| **outbox** | Cola durable de notificaciones/efectos, reintentada por el scheduler |
| **dedupe key** | Clave que decide si un evento del feed ya fue procesado |
| **stale** | Dato servido desde caché cuando el refresco remoto falla |
| **fencing** | Mecanismo que garantiza un único escritor vigente por cuenta/recurso |
