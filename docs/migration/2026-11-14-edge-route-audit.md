# Auditoría de rutas edge — 2026-11-14

## Propósito

Este documento registra una **auditoría estática** de las rutas HTTP declaradas por el
monolito TypeScript (`src/http-dashboard.ts`) y por el servicio edge en Go
(`services/trading-core/cmd/edge/main.go` y `services/trading-core/internal/edge/*.go`).

La auditoría responde a una sola pregunta: **qué rutas existen en cada lado y cuáles
coinciden por método y ruta normalizada**.

No es un test funcional. No levanta servidores, no ejecuta peticiones, no consulta
Postgres, no valida autenticación, CSRF, esquemas de body/query, códigos de estado,
contratos de respuesta ni comportamiento bajo carga. Una ruta marcada como
"cubierta exactamente" sólo significa que ambos lados declaran el mismo método y la
misma ruta; no significa que el comportamiento sea equivalente.

El edge **no sustituye al monolito TS**. El monolito sigue siendo la referencia
funcional y autoritativa. El edge es un borde de sólo lectura, limitado a estáticos,
sesión y un subconjunto de endpoints de dashboard/móvil.

## Herramienta

Script: `scripts/f3-edge-route-audit.sh`

```bash
bash scripts/f3-edge-route-audit.sh
bash scripts/f3-edge-route-audit.sh --json
```

Propiedades:

- Sólo lectura: usa `grep`, `sed` y `awk`; no añade dependencias.
- No imprime secretos: únicamente métodos y rutas.
- Exit `0` si el escaneo funciona, aunque queden rutas pendientes.
- Exit `2` si faltan archivos o no se extraen rutas.
- `--json` emite un documento parseable con las listas completas.

### Normalización aplicada

| Origen | Normalización |
| --- | --- |
| Parámetros `:id`, `:uuid`, `:intentId`, etc. | `:param` |
| Comodines `*` y `**` | `:wildcard` |
| `HEAD` | Se contabiliza como `GET` |
| Barra final | Se elimina salvo en `/` |
| Plantillas `${prefix}/...` | Se expanden con los prefijos del bucle de `src/http-dashboard.ts` |

La extracción TS reconoce `app.get/post/put/delete/patch/all`, incluidas las
declaraciones con genéricos multi-línea. La extracción Go toma literales de ruta de
los archivos objetivo, descarta prefijos de dispatch (`/api/mobile/`, `/api/live/`) y
assets internos, y representa el fallback estático/SPA del shell como `GET /*`.

## Estado actual medido

Salida del script en el commit de trabajo de esta auditoría:

```text
Rutas TS únicas:          109
Rutas edge únicas:        16
Cubiertas exactamente:    11
Rutas TS no cubiertas:    98
Rutas edge extra:         5 (la auditoría estática no cuenta los prefijos
estáticos P4 implementados en `static_routes.go`)
```

### Rutas cubiertas exactamente (11)

```text
DELETE /api/session
GET    /api/dashboard
GET    /api/live/balance
GET    /api/live/operations
GET    /api/live/own-offers
GET    /api/mobile/alerts
GET    /api/mobile/markets
GET    /api/mobile/operations
GET    /api/mobile/overview
GET    /api/session
POST   /api/session
```

### Rutas edge extra (5)

```text
GET /api/edge/summary
GET /healthz
GET /metrics
GET /readyz
GET /:wildcard    # shell estático / fallback SPA
```

`/healthz`, `/readyz`, `/metrics` y `/api/edge/summary` son rutas propias del borde.
`GET /:wildcard` representa el shell Go que sirve assets y el fallback de navegación;
no equivale a las rutas estáticas específicas del monolito (`/`, `/dashboard/*`,
`/icons/:name`, etc.).

### Rutas TS no cubiertas (98)

La lista completa la emite el script. Agrupada por área:

- **Estáticos y web:** `GET /`, `GET /dashboard/*`, `GET /service-worker.js`,
  `GET /auth/:name`, `GET /icons/:name`, `GET /logo/:name`,
  `GET /market-icons/:name`.
- **Sesión:** no hay pendientes; las tres rutas de sesión están cubiertas.
- **Dashboard/live:** `GET /api/live/markets/:coin`, `GET /api/live/transactions`.
- **Móvil (sólo lectura):** `GET /api/mobile/device-check`,
  `GET /api/mobile/devices`, `GET /api/mobile/operators`,
  `GET /api/mobile/operator-check`, `GET /api/mobile/insights`,
  `GET /api/mobile/payment-receipts`, `GET /api/mobile/receipt-outcomes`,
  `GET /api/mobile/operations/:uuid/payment-preview`,
  `GET /api/mobile/operations/chats`, `GET /api/mobile/operations/:uuid/chat`,
  `GET /api/mobile/operations/:uuid/chat/images/:messageId`,
  `GET /api/mobile/operations/:uuid/chat/sends/:attemptId`.
- **Operaciones/chats (web):** `GET /api/operations/chats`,
  `GET /api/operations/chats/unread`, `GET /api/operations/:uuid/chat`,
  `GET /api/operations/:uuid/chat/images/:messageId`,
  `GET /api/operations/:uuid/chat/sends/:attemptId`.
- **Configuración y observabilidad (lectura):** `GET /api/config`,
  `GET /api/config-revisions`, `GET /api/market-source`, `GET /api/notifications`,
  `GET /api/audit`, `GET /api/operational-health`, `GET /api/logs`,
  `GET /api/recovery`, `GET /api/openapi.json`, `GET /api/push/public-key`.
- **Analítica (lectura):** `GET /api/market-analytics`,
  `GET /api/trading-analytics`, `GET /api/analytics/fees`,
  `GET /api/fiat-history`, `GET /api/hunting/diagnostics`,
  `GET /api/decision-events`, `GET /api/offers/rebalance/:id`.
- **Mutaciones (no portadas):** el resto son `POST`, `PUT` y `DELETE` de
  configuración, ofertas, market readers, recovery, workflows, contribuciones,
  push subscriptions, blocked offers, simulaciones y webhooks.

## Limitaciones

1. **Estática, no funcional.** No se ejecuta ningún handler. La paridad de rutas no
   implica paridad de contrato, autenticación, autorización, CSRF, idempotencia,
   validación ni errores.
2. **Comparación exacta por método + ruta normalizada.** Un comodín Go no se expande
   contra rutas TS concretas. Por eso `GET /:wildcard` aparece como ruta extra y las
   rutas estáticas TS aparecen como no cubiertas.
3. **Extracción heurística.** Las rutas TS se detectan por el patrón
   `app.<método>(...)`; las Go por literales de ruta y `http.MethodX` en cada archivo.
   Código generado, rutas construidas en runtime o registradas por plugins no se
   detectarían.
4. **Métodos inferidos por archivo.** En Go no se hace un análisis de flujo por ruta.
   Un archivo con varios verbos puede asociar métodos de más a una ruta; en el estado
   actual los archivos están separados por dominio y el resultado coincide con lo
   declarado en los comentarios de cada handler.
5. **HEAD/OPTIONS.** `HEAD` se pliega a `GET`; `OPTIONS` y el comportamiento
   automático de Fastify no se auditan.
6. **Prefijos dinámicos.** La expansión de `${prefix}` depende del array del bucle
   actual de `src/http-dashboard.ts`. Si el código cambia de forma, la expansión
   puede quedar incompleta.
7. **Sin verificación de despliegue.** No se comprueba qué binario edge está
   desplegado, qué flags están activos ni si el servicio tiene base de datos,
   `EDGE_ADMIN_PASSWORD` o `EDGE_SESSION_SECRET`.

## Rutas priorizadas para portar

La prioridad asume que el edge debe seguir siendo **de sólo lectura** y que cualquier
ampliación debe mantener al monolito TS como fallback autoritativo.

### P0 — Identidad y lectura móvil mínima

Sin estas rutas la app móvil no puede completar comprobaciones básicas de operador ni
consultar el detalle de una operación:

1. `GET /api/mobile/device-check`
2. `GET /api/mobile/operators`
3. `GET /api/mobile/operator-check`
4. `GET /api/mobile/operations/:uuid/payment-preview`
5. `GET /api/mobile/operations/chats`
6. `GET /api/mobile/operations/:uuid/chat`
7. `GET /api/mobile/operations/:uuid/chat/sends/:attemptId`
8. `GET /api/mobile/operations/:uuid/chat/images/:messageId`

### P1 — Lectura de dashboard y operaciones web

1. `GET /api/live/markets/:coin`
2. `GET /api/live/transactions`
3. `GET /api/operations/chats`
4. `GET /api/operations/chats/unread`
5. `GET /api/operations/:uuid/chat`
6. `GET /api/operations/:uuid/chat/sends/:attemptId`
7. `GET /api/operations/:uuid/chat/images/:messageId`

### P2 — Configuración y observabilidad de lectura

1. `GET /api/config`
2. `GET /api/config-revisions`
3. `GET /api/market-source`
4. `GET /api/notifications`
5. `GET /api/audit`
6. `GET /api/operational-health`
7. `GET /api/logs`
8. `GET /api/recovery`
9. `GET /api/openapi.json`
10. `GET /api/push/public-key`

### P3 — Analítica de lectura

1. `GET /api/market-analytics`
2. `GET /api/trading-analytics`
3. `GET /api/analytics/fees`
4. `GET /api/fiat-history`
5. `GET /api/hunting/diagnostics`
6. `GET /api/decision-events`
7. `GET /api/offers/rebalance/:id`

### P4 — Estáticos específicos

El shell Go ya sirve assets y hace fallback SPA, pero no replica las rutas estáticas
del monolito. Antes de considerarlas cubiertas hay que validar caché, MIME, CSP,
service worker y compatibilidad de rutas:

1. `GET /`
2. `GET /dashboard/*`
3. `GET /service-worker.js`
4. `GET /auth/:name`
5. `GET /icons/:name`
6. `GET /logo/:name`
7. `GET /market-icons/:name`

### Fuera de alcance del edge actual

Las rutas `POST`, `PUT` y `DELETE` restantes no deberían portarse sin un diseño
explícito de autenticación, autorización, CSRF, idempotencia y escritura. El edge
actual abre el pool de Postgres en modo `read_only`; mantener esa restricción es parte
del valor de seguridad del borde. Cualquier mutación debe seguir en el monolito TS
hasta que exista una decisión de arquitectura y pruebas de paridad funcional.

## Cómo actualizar esta auditoría

1. Ejecutar `bash scripts/f3-edge-route-audit.sh` y guardar el resumen.
2. Revisar las listas de rutas no cubiertas y extra.
3. Actualizar este documento con la fecha y los totales.
4. Si se porta una ruta, añadir pruebas Go y evidencia funcional; la auditoría
   estática por sí sola no es evidencia de paridad.
