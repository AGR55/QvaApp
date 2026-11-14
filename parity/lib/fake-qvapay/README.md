# fake-qvapay — servidor determinista con cassettes (F0)

Fake local de la API QvaPay para los tests de contrato y de saga del arnés de
paridad. Reproduce las respuestas y los fallos que el oráculo TypeScript ya
prueba, **sin red externa, sin reloj real, sin azar y sin `sleep`**.

- Contratos: K1–K14 de [`docs/migration/analysis/03-boundaries.md`](../../../docs/migration/analysis/03-boundaries.md) §7.
- Capa L2: [`docs/migration/verification.md`](../../../docs/migration/verification.md) §L2.
- Diseño de cassettes: [`docs/migration/analysis/04-tests.md`](../../../docs/migration/analysis/04-tests.md) §4.8.

## Uso rápido

```bash
# CLI: servidor en un puerto efímero. Imprime UNA línea `ready` en stdout.
node --import tsx parity/lib/fake-qvapay/start.ts \
  --cassette parity/fixtures/contracts/qvapay/apply-409-contention.json \
  --port 0
# → {"ready":true,"url":"http://127.0.0.1:41234","host":"127.0.0.1","port":41234,...}

# Smoke reproducible (arranque + escenarios + validación del log; <1 s):
node --import tsx parity/scripts/fake-qvapay-smoke.ts
```

Helper in-process (lo que usa el runner/adaptador):

```ts
import { startFakeQvaPay } from "./parity/lib/fake-qvapay/index.js";

const fake = await startFakeQvaPay({
  cassette: "parity/fixtures/contracts/qvapay/list-xcache-429.json",
  host: "127.0.0.1", // solo loopback
  port: 0,           // 0 = efímero; o cualquier puerto libre
});
// … requests contra fake.url …
const log = fake.log();     // método, path, query, headers relevantes, body hash…
const state = fake.state(); // mundo determinista (ofertas, webhook dedupe…)
fake.advance(60_000);       // reloj virtual, sin dormir
fake.reset();               // reinicia estado/log/reloj
await fake.close();
```

La URL base que se le pasa al SUT debe ser `fake.url`. El fake acepta rutas con
y sin prefijo `/v2` (`/v2/p2p` y `/p2p` son equivalentes) porque el cliente
actual usa `${API}/p2p` y el contrato del arnés se escribe como `/v2/p2p`.

## Arquitectura

```text
parity/lib/fake-qvapay/
  types.ts     tipos del cassette, del log y del mundo
  clock.ts     VirtualClock (epoch fijo, advance explícito)
  cassette.ts  carga/validación + match estricto + logAssertions
  world.ts     estado determinista + HMAC/webhook/dedupe (K5/K13)
  server.ts    servidor HTTP node:net (API, SSE, webhook, control)
  start.ts     CLI (`node --import tsx …/start.ts --cassette … --port 0`)
  index.ts     API pública
```

Flujo de una petición de la API simulada:

1. Se lee el body crudo y se construye un descriptor (`method`, `path`
   normalizado, `query`, headers relevantes, `bodySha256` canónico).
2. Se busca, **en orden**, la primera exchange no agotada cuyo `match` cumple.
   Si ninguna cumple → `500 FAKE_UNEXPECTED_REQUEST` y contador
   `unexpectedRequests` (un request no declarado es un fallo explícito).
3. Se evalúan `logAssertions`; si fallan → `500 FAKE_LOG_ASSERTION_FAILED`.
4. Se avanza el reloj virtual `delayMs` y se aplican los `effects` al mundo.
5. Se escribe la `response`: JSON, JSON malformado, SSE, o fallo de transporte
   (`destroy` / `after-headers` / `hang`).

## Endpoints simulados

| Método y ruta | Contrato | Notas |
|---|---|---|
| `GET /v2/p2p` | K2/K12 | Listado paginado; el cassette decide envelope `data` u `offers`, `total`, `current_page`, `per_page` y `x-cache`. |
| `GET /v2/p2p/:uuid` | K2 | `{ "p2p": … }`; sirve para conciliación y preflight. |
| `POST /v2/p2p/:uuid/apply` | K3 | 200 vacío o `{order,amount,receive}` (flexible); 409/429/timeout/ambiguo vía cassette. |
| `POST /v2/p2p/:uuid/cancel` | K4 | `?order=`. |
| `POST /v2/p2p/:uuid/edit` | K4 | Body libre validado por el SUT. |
| `POST /v2/p2p/:uuid/paid` | K4 | Body `{tx_id}`. |
| `POST /v2/p2p/:uuid/received` | K4 | — |
| `POST /v2/p2p/create` | K4 | `idempotency_key` en el body. |
| `GET /v2/user` | K1/K2 | Perfil/saldo; el SUT acepta `balance`/`available`/`data.*`. |
| `GET /v2/transaction` | K12 | Historial (`take` 1..30 lo valida el SUT). |
| `GET /v2/p2p/averages` | K2 | Promedios por mercado. |
| `GET /v2/p2p/:uuid/chat` | K7 | Envelopes `array`/`chat`/`messages`/`data.messages`. |
| `POST /v2/p2p/:uuid/chat` | K7 | Texto o multipart (el cassette decide el body de respuesta). |
| `GET /v2/p2p/:uuid/chat/stream` | K7 | SSE mínima del hilo. |
| `GET /v2/p2p/stream` | K6 | SSE del feed; autenticación `app-id`/`app-secret` la decide el cassette. |
| `POST /auth/login`, `POST /auth/request-pin` | K1 | 200/202/401/423/429/timeout. |

No se simulan `/storage/**` (descarga de imágenes), NATS ni Sync Core: quedan
fuera del alcance de esta pieza (ver *Pendientes*).

## Webhook (K5/K13)

El fake trae **dos** piezas, porque el webhook es una frontera entrante al SUT:

1. **Receptor de referencia** — `POST /webhooks/qvapay/p2p-feed`, con el mismo
   contrato que `src/market-feed.ts`:
   - cuerpo ∈ (0, 10 000 B], si no `400`;
   - `x-qvapay-timestamp` obligatorio, ±5 min contra el **reloj virtual**, si no `401`;
   - `x-qvapay-signature: sha256=<hex>` = HMAC-SHA256 del secreto del cassette
     sobre el **cuerpo crudo**, comparación `timingSafeEqual`, si no `401`;
   - JSON y oferta validados (evento, `sent_at`, `uuid`, `type`, `coin`,
     `amount`/`receive` > 0, `status`), si no `400`;
   - dedupe con la misma clave que el código actual
     (`event:uuid:version[:sent_at[:available_amount]]`), 202
     `{ok,duplicate,queued}` **solo tras persistir** en memoria.
   - Los requests de webhook **no consumen exchanges**; se registran con
     `kind:"webhook"`.
2. **Emisor firmado** — `POST /__fake/webhook/send` (solo destinos loopback):
   firma un payload con el secreto del cassette y lo entrega al SUT, para que el
   runner simule a QvaPay sin red externa. Devuelve status/body del receptor.

## Formato de cassette

Un archivo JSON por escenario:

```json
{
  "cassetteVersion": 1,
  "name": "apply-409-contention",
  "description": "qué certifica y con qué contrato",
  "contract": "K3",
  "clockMs": 1767225600000,
  "webhookSecret": "whsec_fake_test_0123456789abcdef",
  "world": {
    "user":  { "uuid": "user-owner-0001", "balance": "250.00000000" },
    "offers": [ { "uuid": "offer-1", "type": "sell", "coin": "QUSD",
                  "amount": "20.00000000", "receive": "20.00000000",
                  "status": "open", "User": { "uuid": "peer-1" }, "Peer": {} } ],
    "transactions": [],
    "chats": { "offer-1": [ { "id": "m1", "peer_id": "peer-1", "message": "hola" } ] }
  },
  "exchanges": [
    {
      "id": "apply-contended",
      "contract": "K3",
      "match": {
        "method": "POST",
        "path": "/v2/p2p/offer-1/apply",
        "query": { "order": "order-1" },
        "headers": { "authorization": "Bearer test-owner-token" },
        "body": { "amount": 20 },
        "bodyContains": "idempotency_key",
        "bodySha256": "<sha256 canónico>"
      },
      "delayMs": 1218,
      "abort": "hang",
      "atMost": 1,
      "optional": false,
      "effects": [
        { "op": "apply", "uuid": "offer-1", "order": "order-0001" }
      ],
      "response": {
        "status": 409,
        "headers": { "x-cache": "MISS", "retry-after": "2" },
        "body": { "error": "La oferta está en contención", "code": "OFFER_CONTENDED" },
        "bodyRaw": "{\"data\":[",
        "partialBody": "{\"order\":\"order-0001\",",
        "sse": { "retryMs": 2500, "events": [ { "event": "init", "data": { "expires_at": "…" } } ] }
      },
      "logAssertions": {
        "method": "POST",
        "path": "/v2/p2p/offer-1/apply",
        "query": { "order": "order-1" },
        "headers": { "authorization": "Bearer test-owner-token" },
        "bodySha256": "<sha256 canónico>",
        "body": { "amount": 20 }
      }
    }
  ]
}
```

Campo a campo:

| Campo | Obligatorio | Semántica |
|---|---|---|
| `name` | sí | Id del escenario; aparece en `/__fake/log` y en el header `x-fake-cassette`. |
| `contract` | no | K citado (K1–K14) para el reporte. |
| `clockMs` | no | Epoch inicial del reloj virtual. Defecto `2026-01-01T00:00:00Z`. |
| `webhookSecret` | no | Secreto HMAC del receptor/emisor de webhook. |
| `world` | no | Semilla del estado determinista; se clona en cada `reset`. |
| `exchanges[]` | sí | Autómata ordenado; **una request consume la primera exchange no agotada que cumple `match`**. Sin match ⇒ 500 y fallo. |
| `match.method` | sí | `GET/POST/PUT/PATCH/DELETE`. |
| `match.path` | sí | Exacta o plantilla `:param` (`/v2/p2p/:uuid/apply`); `/v2` opcional. |
| `match.query` | no | Subconjunto de query params; comparación textual (el SUT envía números como string). |
| `match.headers` | no | Subconjunto case-insensitive, valores exactos. |
| `match.body` | no | Igualdad canónica estricta (objetos ordenados, `1 !== "1"`). |
| `match.bodyContains` | no | Subcadena del body crudo (útil para `idempotency_key`). |
| `match.bodySha256` | no | sha256 canónico del body (JSON canónico si parsea). |
| `response.status` | no | Defecto 200. |
| `response.headers` | no | Se añaden `x-fake-cassette`, `x-fake-exchange`, `x-fake-virtual-now`, `x-fake-latency-ms`. |
| `response.body` | no | JSON serializado. Admite plantillas reservadas (abajo). |
| `response.bodyRaw` | no | Body crudo: JSON malformado, HTML, etc. |
| `response.partialBody` | no | Body parcial con `abort:"after-headers"` (respuesta ambigua). |
| `response.sse` | no | `{retryMs?, events:[{event?,data?,comment?}], holdOpen?}`; manda sobre `body`. |
| `delayMs` | no | **Latencia virtual**: solo avanza `VirtualClock` y se anota (`latencyMs`, header `x-fake-latency-ms`). No duerme. |
| `abort` | no | `destroy` (reset antes de responder), `after-headers` (aplica y corta), `hang` (nunca responde; el SUT aborta con su timeout inyectado). |
| `atMost` | no | Nº máximo de requests que consumen la exchange (defecto 1). Al agotarse, la siguiente request busca otra o falla como no declarada. |
| `optional` | no | Si `true`, no aparece en `unconsumed` (para exchanges de escenarios condicionales). |
| `effects` | no | Cambios deterministas en `world` **antes** de responder (ver abajo). |
| `logAssertions` | no | Aserciones sobre el request recibido; si fallan, 500 y `assertionFailures`. |

### Plantillas de `response.body`

Para no duplicar el estado del mundo en el cassette:

- `{ "$offer": "<uuid>" }` → se sustituye por la oferta actual de `world.offers`.
- `{ "$state": true }` → snapshot completo del mundo (solo depuración).

Ejemplo: `"body": { "p2p": { "$offer": "offer-success-1" } }` devuelve el estado
**después** de aplicar `effects`, de modo que un `GET` de conciliación ve
`status:"applied"` y `Orders` sin repetir datos.

### Efectos

| `op` | Efecto |
|---|---|
| `status` | `{uuid,status}`: cambia `status` y `updated_at`. |
| `patch` | `{uuid,patch}`: merge superficial. |
| `apply` | `{uuid,order?}`: `status:"applied"` + orden determinista en `Orders`/`appliedOrders`. |
| `cancel` | `{uuid,status?}`: `status` por defecto `cancelled`. |
| `create` | `{offer}`: crea oferta (uuid determinista si falta). |
| `chat` | `{uuid,message}`: añade mensaje a `world.chats[uuid]`. |
| `transaction` | `{transaction}`: añade a `world.transactions`. |

Referenciar una oferta inexistente es un error explícito
(`500 FAKE_EFFECT_FAILED`), no un no-op silencioso.

## Log de requests

`GET /__fake/log` devuelve un snapshot ordenado:

```json
{
  "cassette": "apply-409-contention",
  "contract": "K3",
  "virtualNow": 1767225602250,
  "startedAtVirtual": 1767225600000,
  "requestCount": 6,
  "unexpectedRequests": 0,
  "assertionFailures": [],
  "requests": [
    {
      "seq": 1,
      "kind": "api",
      "virtualAt": 1767225600000,
      "method": "POST",
      "path": "/v2/p2p/offer-contended-1/apply",
      "normalizedPath": "/p2p/offer-contended-1/apply",
      "query": {},
      "querySorted": "",
      "headers": { "authorization": "Bearer <redacted>", "content-type": "application/json" },
      "headerHashes": { "authorization": "<sha256 del header completo>" },
      "bodyBytes": 0,
      "bodySha256": "e3b0c442…",
      "bodyJson": null,
      "exchange": "apply-offer-contended",
      "contract": "K3",
      "status": 409,
      "responseHeaders": { "x-cache": "MISS" },
      "responseBodySha256": "…",
      "latencyMs": 1218,
      "aborted": null,
      "responseEnded": true,
      "assertionErrors": []
    }
  ],
  "exchanges": [ { "id": "apply-offer-contended", "consumed": 1, "atMost": 1, "…": "…" } ],
  "unconsumed": []
}
```

Reglas del log:

- `querySorted` ordena `k=v` para comparar `mutationParity` exacta.
- `bodySha256` es **canónico** (objetos con claves ordenadas) si el body es
  JSON; si no parsea, sha256 del crudo; body vacío = sha256 de la cadena vacía.
- `authorization` se registra redactada; su valor exacto queda hasheado en
  `headerHashes` para comparación sin filtrar el token. `app-secret` igual.
- `unconsumed` lista las exchanges obligatorias no consumidas: un request **de
  menos** también falla (el runner debe exigir `unconsumed == []`).
- `kind` distingue `api` (consume cassette), `webhook` (receptor de referencia;
  no consume) y `control` (endpoints `/__fake/*`).

## Endpoints de control

| Endpoint | Uso |
|---|---|
| `GET /__fake/health` | readiness: cassette, reloj virtual, nº requests, `unexpected`. |
| `GET /__fake/log` | snapshot del log (arriba). |
| `GET /__fake/state` | snapshot del mundo: ofertas, usuario, chats, orden determinista, webhook dedupe. |
| `POST /__fake/advance` | `{ms}`: avanza el reloj virtual. |
| `POST /__fake/reset` | reinicia estado/log/reloj; opcional `{cassette: {...}}` para recargar. |
| `POST /__fake/webhook/send` | emisor firmado a un destino loopback: `{targetUrl, secret?, payload, timestampMs?}`. |

## Determinismo

- **Reloj**: `VirtualClock` con epoch fijo; `delayMs` solo lo avanza. No hay
  `Date.now()` en la lógica de simulación (solo `startedAt` real del smoke).
- **Sin `sleep`**: los timeouts se provocan con `hang` (el SUT aborta) o
  `destroy`; la respuesta ambigua con `after-headers`. El estado nunca depende
  de latencia real.
- **IDs deterministas**: `order-0001`, `offer-0001`, … por contador del mundo;
  se reinician con `reset`.
- **Sin azar**: no hay `Math.random` ni jitter.
- **Sin red externa**: escucha en `127.0.0.1` (configurable) y el emisor de
  webhook rechaza cualquier destino no loopback.
- **Reset entre casos**: `POST /__fake/reset` (o `fake.reset()`), y cada
  cassette se clona desde `world`.

## Catálogo de fixtures (`parity/fixtures/contracts/qvapay/`)

| Cassette | Contrato | Qué certifica |
|---|---|---|
| `list-xcache-429.json` | K2/K12 | Envelope `data`/`offers`, `x-cache` HIT/MISS, 429 con/sin `Retry-After`, JSON truncado, oferta malformada, timeout de listado. |
| `apply-409-contention.json` | K3 | `OFFER_CONTENDED`, `OFFER_PAUSED`, `PEER_REQUIREMENTS_NOT_MET` (+`missing`), oferta ya tomada genérica, éxito con `Orders` y latencia virtual. |
| `apply-429.json` | K3 | 429 con `Retry-After` segundos/fecha/ausente y dos despachos de la ventana 2/60 s. |
| `apply-timeout-ambiguous.json` | K3/K4 | `hang` (timeout), `destroy` (reset), `after-headers` (aplicó y la respuesta se corta) + reconciliación. |
| `errors-4xx-5xx.json` | K11/K4 | 400/401/403/404, 500/502/503+`Retry-After`, 2xx con cuerpo no-JSON. |
| `k1-login.json` | K1 | 202 `has_otp`, 200 token, 401 TOTP, 423, 429, timeout reintentado 3 veces. |
| `k7-chat.json` | K7 | Envelopes `array`/`chat`/`messages`/`data.messages`, send, ambiguo, stream. |
| `k6-sse.json` | K6 | 401/402, `init`+`retry:`, `subscription_expired`, evento >64 KB, keepalive. |
| `k4-mutations-ambiguous.json` | K4 | `create` con `idempotency_key`, duplicado sin duplicar oferta, edit/cancel/paid/received, 4xx definitivo vs timeout/5xx incierta. |
| `webhook-signed.json` | K5/K13 | Receptor HMAC/timestamp/dedupe y emisor firmado; sin exchanges de API. |

## Smoke

```bash
node --import tsx parity/scripts/fake-qvapay-smoke.ts
```

Arranca el servidor por CLI con `--port 0` y con el helper in-process, y ejecuta
11 bloques (141 checks): arranque CLI, listado x-cache/429/JSON roto, apply 409,
apply 429, timeout/ambiguo, webhook HMAC/dedupe/emisor, 4xx/5xx, strictness y
control (advance/reset), SSE K6, chat K7 y login K1. Valida respuestas **y** el
log (hash de body, hash de authorization, `querySorted`, `latencyMs`,
`aborted`, `unexpectedRequests`, `unconsumed`, `assertionFailures`) y la recarga de cassette vía HTTP. Sale con código ≠ 0 si algo
falla o si tarda ≥10 s. Resultado actual: **141/141 en ~0,3 s**.

## Pendientes (F0 → F1)

- **Descarga de imágenes de chat** (`/storage/**`, ≤1 MiB, host allowlist, K7):
  el fake no sirve binarios; el cassette podría añadir una `response.binary`
  (base64) y un caso de imagen >1 MiB.
- **Multipart de chat**: el SUT envía `FormData`; el fake no inspecciona el
  boundary, solo el body crudo (`match.bodyContains` sirve como aproximación).
- **`average` envelope** y respuestas de `/p2p/averages` con variantes
  legacy/no-lista (K2): no hay cassette todavía.
- **`Retry-After` como fecha HTTP vs reloj virtual**: el cliente convierte con
  `Date.now()` real, así que el valor en ms no es determinista; el cassette
  fija la fecha y el runner debe comparar la cabecera, no el delta.
- **Escalas de timeout del SUT**: `delayMs` es virtual y no bloquea, así que un
  `slow-response` realista requiere que el SUT use `CONFORMANCE_TIMEOUT_SCALE`
  (04-tests.md §4.8). Documentado aquí y en la cabecera de `apply-timeout-ambiguous`.
- **Casos K8 (Sync Core), K9 (NATS), K10 (superficie HTTP del gateway),
  K14 (notificaciones)**: son otras fronteras; este fake solo cubre QvaPay
  REST/SSE/webhook (F1/F2/F3). K10/K14 necesitan fakes separados.
- **Contador de despachos de listado** (`LOCAL_APPLY_QUOTA`,
  `ListingReadBudget`): el fake registra los POST/GET, pero la ventana 2/60 s y
  el presupuesto 2 401 ms los impone el SUT. Los cassettes dan los 200 y el log
  permite verificar que no hay un tercer despacho.
- **Modo `record`** (grabar desde sandbox): no implementado; el diseño
  (04-tests.md §4.8) lo restringe a un humano y a un sandbox. Solo `replay`
  estricto.
- **Webhook 503** (fuente de mercado parada) y **cuerpo >10 KB** del receptor
  real: el receptor de referencia replica 400/401; el 503 es estado interno del
  SUT y no se simula.
