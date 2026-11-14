# 02 — Persistencia: inventario, atomicidad y migración de datos a PostgreSQL

**Proyecto:** QvaApply · **Ámbito:** base SQLite local, schema v31, ~41 tablas  
**Estado:** análisis para el plan maestro de migración a microservicios Go/Rust  
**Regla de oro:** la base actual es la única fuente de verdad de dinero real. Nada de lo aquí propuesto autoriza a partir el núcleo transaccional antes de que existan las garantías de la sección 4.

---

## 0. Resumen ejecutivo

1. **Una sola base, 41 tablas, 32 índices, 6 triggers y schema versionado hasta v31**. Toda la persistencia pasa por una única frontera (`src/store.ts`, 3.643 líneas): no hay ORM, no hay repositorios por agregado, no hay acceso a SQLite fuera de ese módulo salvo verificadores en solo lectura (`src/config-integrity.ts:47-57`, tests).
2. **El snapshot local del repo está en schema v16, no v31** (`schema_migrations` con 16 filas; 27 de las 41 tablas presentes). El código exige v31 (`src/store.ts:23`, `test/repository.test.ts:28-33`). Cualquier ensayo de migración debe primero llevar ese snapshot a v31 con el código actual: el camino v16→v31 **no ha sido ejercitado sobre estos datos**, solo sobre bases sintéticas en los tests.
3. **El 85 % del tamaño es historial de configuración**: `config_revisions` ocupa ≈22,1 MB de 25,9 MB (con su índice ≈22,6 MB, 87 %). Son 5.416 revisiones en 11 días, cada una con el JSON completo de configuración (`src/store.ts:1273-1304`), sin compactación. Es el primer problema de volumen a resolver, no el número de tablas.
4. **El dinero está en `REAL` (double) en más de 40 columnas de importes/tasas (más de 50 si se cuentan intervalos) y dentro de columnas JSON**. Hay evidencia física de drift binario en el propio snapshot: `SUM(amount)` de créditos `CLASICA` = `1244.1000000000001`. Migrar a `NUMERIC` no es una mejora cosmética: es un requisito de corrección.
5. **El saldo fiat tiene cuatro representaciones**: `settings.fiat_balance:<coin>` (autoritativa), `market_config.fiat_balance` y `fiat_accounts.declared_balance` (proyecciones), `fiat_balance_history` (auditoría) y `portfolio_snapshots` (derivada). Cualquier partición que separe esas escrituras rompe la conciliación.
6. **La atomicidad actual es por llamada, no por flujo de negocio**. Solo un puñado de operaciones compuestas son transaccionales de verdad (`BEGIN IMMEDIATE`, `src/store.ts:1746-1756`). Los flujos que cruzan una mutación remota (aplicar, marcar pagado, confirmar recepción, conciliar feed) son **secuencias de varias transacciones** y se sostienen con intenciones durables, `UNIQUE` idempotentes y reconciliación periódica, no con un `COMMIT` único.
7. **Consecuencia:** partir la base sin rediseñar esos flujos produce doble gasto y reservas huérfanas. La recomendación es **no dividir el núcleo monetario** en la primera fase: extraer primero analítica, notificaciones, ingesta de mercado y auditoría; mantener un único PostgreSQL ACID para dinero, intenciones, workflows y reservas, aunque el código se organice en servicios separados.
8. **Riesgos mayores:** pérdida de la garantía `UNIQUE(operation_uuid,direction)` del ledger, carrera en el tope de reservas (`reserveQusd`), reservas huérfanas al separar `mutation_intents` de `application_capital_reservations`, bifurcación de la configuración de riesgo, y rotura de la cadena de integridad (`config_revisions` + `config_integrity_epoch`) si deja de compartir transacción.
9. **Durabilidad actual:** WAL, `foreign_keys=ON`, escritor único, checkpoint previo a migrar, copia previa automática, `.backup` diario a las 04:15 UTC con 14 días de retención, y verificación de integridad de configuración por cadena SHA-256 en un worker de solo lectura. Todo eso tiene equivalente en PostgreSQL (sección 4.4), pero exige PITR y restauración probada, no solo `pg_dump`.
10. **Secretos:** tokens cifrados con AES-256-GCM y `LOCAL_ENCRYPTION_KEY` (`src/vault.ts`, `src/config.ts:55`). El dump debe transportar ciphertext y re-cifrarse con envelope encryption/KMS en destino; nunca descifrar durante la migración.

---

## 1. Alcance y método

**Leído para este análisis** (con las líneas citadas a lo largo del documento):

- `src/store.ts` completo en lo estructural: constructor, las 31 migraciones, DDL de las 41 tablas, índices, triggers, transacciones y métodos de escritura monetaria.
- `src/config-integrity.ts`, `src/config-integrity-monitor.ts`, `src/qusd-balance-cache.ts`, `src/market-accounts.ts`, `src/vault.ts`, `src/market-config.ts`, `src/session.ts`.
- `src/application/monetary-intents.ts`, `src/reconciliation-scheduler.ts`, `src/self-service-recovery.ts`, `src/payment-sms.ts` (flujo de recibos), `src/trading.ts` (proyección de feed, ledger fiat, `markPaid`/`confirmReceived`, `syncFiatFromQva`), `src/index.ts` (arranque y schedulers).
- `docs/adr/0002-sqlite-single-instance.md`, `0003-uncertain-mutations-require-reconciliation.md`, `0005-single-qusd-reserve.md`, `0006-local-first-remote-resources.md`, `0009-priority-application-transport-and-release-retention.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/VPS.md`, `docs/fixes/2026-10-19-fiat-accounting.md`.
- `test/repository.test.ts` y tests que abren SQLite con `node:sqlite` en solo lectura o para simular bases legacy.
- Inventario de datos **solo estructural** (tablas, filas, tamaños, índices, triggers, agregados) sobre una **copia en `/tmp`** de `data/qvaapply.sqlite`, abierta en modo solo lectura. No se escribió ni se escribirá en `data/qvaapply.sqlite`; no se volcaron valores sensibles.

**Limitaciones explícitas:**

- Los conteos de filas y tamaños corresponden al snapshot de desarrollo (última escritura: 2026-09-26, schema v16). **No son los de producción** (VPS en `/opt/qvaapply/data`, `docs/VPS.md:10-30`). El plan de migración debe repetir el inventario sobre una copia de producción antes de dimensionar la ventana.
- Las tablas añadidas en v17–v31 no existen en ese snapshot y aparecen como `—` en la columna de filas.
- El tamaño de producción es mayor: la retención de `config_revisions` es ilimitada y el snapshot ya muestra ≈490 revisiones/día.
- Este documento no propone código de producción; describe contratos de datos y un plan verificable.

**Comandos de referencia usados (repetibles, sin tocar la base real):**

```bash
cp data/qvaapply.sqlite /tmp/qa-copy.sqlite
sqlite3 -readonly /tmp/qa-copy.sqlite \
  "PRAGMA journal_mode; PRAGMA page_size; PRAGMA page_count; PRAGMA integrity_check;"
sqlite3 -readonly /tmp/qa-copy.sqlite ".tables"
sqlite3 -readonly /tmp/qa-copy.sqlite \
  "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC;"
# schema v31 materializado en /tmp sin tocar data/:
node --import tsx --eval "const {Store}=await import('./src/store.ts'); new Store('/tmp/qa-v31').close();"
```

---

## 2. Inventario de persistencia

### 2.1 Parámetros y modelo de uso de SQLite

| Aspecto | Estado actual | Evidencia |
| --- | --- | --- |
| Motor | SQLite embebido vía `node:sqlite` (`DatabaseSync`), API síncrona | `src/store.ts:7`, `src/store.ts:360` |
| Modo de journal | `WAL` | `src/store.ts:361` |
| Claves foráneas | `ON` (por conexión; hay 6 FKs reales, ver 2.5) | `src/store.ts:361` |
| Transacciones | `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`; helper privado `transaction()` | `src/store.ts:1746-1756` |
| `busy_timeout` | **No se fija** en la conexión principal. El worker de integridad usa `busy_timeout=1000` | `src/config-integrity.ts:49` |
| `synchronous` | **No se fija**: queda en el default de SQLite (`FULL`) | `src/store.ts:361` |
| Escritores | Uno solo: el proceso Node. No hay múltiples procesos ni réplicas | `docs/adr/0002`, `docs/VPS.md:18-19`, `deploy/compose.yaml` |
| Ruta | `DATA_DIR/qvaapply.sqlite` (`data/` en dev; volumen `/opt/qvaapply/data` en VPS) | `src/store.ts:356-360`, `deploy/compose.yaml:24-27` |
| Snapshot local | 25.874.432 bytes, `page_size=4096`, `page_count=6317`, `integrity_check=ok` | inspección /tmp |
| Schema local | `MAX(version)=16` (16 filas) | inspección /tmp |
| Schema del código | `LATEST_SCHEMA_VERSION = 31` | `src/store.ts:23` |

El proceso completo asume **un único escritor y una única instancia** (`docs/adr/0002`, `docs/VPS.md:18-19`). Esa suposición es la que justifica que hoy no haya bloqueos pesimistas ni `busy_timeout`: el event loop de Node serializa la mayoría de las escrituras. Al pasar a microservicios, esa serialización desaparece y ninguna restricción de la base la sustituye hoy (ver R15).

### 2.2 Migraciones y evolución del esquema

- Versionado por `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)`; `migrate()` se ejecuta dentro de **una sola transacción** (`src/store.ts:379-991`).
- Si la base existía y su versión es menor que 31, **antes** de migrar se ejecuta `PRAGMA wal_checkpoint(TRUNCATE)` y se copia el fichero a `data/backups/qvaapply-before-v31-<timestamp>.sqlite` (`src/store.ts:362-363`, `src/store.ts:1732-1744`). Verificado por test en `test/repository.test.ts:386-402`.
- Las migraciones usan `CREATE TABLE/INDEX IF NOT EXISTS`, `ensureColumn()` (basado en `PRAGMA table_info`) y varios **backfills/triggers**:
  - v22: `manual_cancel_exclusions` derivada de `audit_log` (`src/store.ts:857-868`).
  - v27: `config_integrity_epoch` + 3 triggers de detección de manipulación (`src/store.ts:898-910`).
  - v28: `application_capital_reservations` + trigger que libera la reserva al resolverse la intención (`src/store.ts:912-922`).
  - v29: `fiat_balance_history` + backfill desde `settings` + triggers que registran cada cambio de `fiat_balance:*` (`src/store.ts:924-948`).
  - v31: chat durable (`chat_threads`, `chat_push_*`, `src/store.ts:960-975`).
- Índices que dependen de expresiones JSON se crean **fuera** de la transacción de migración, en el constructor, con `IF NOT EXISTS` (`src/store.ts:370-376`): `idx_market_feed_offer_uuid` sobre `json_extract(payload_json,'$.data.uuid')`, parciales sobre `mutation_intents`.
- El constructor también ejecuta una **reparación de arranque**: convierte a `uncertain` las intenciones `confirmed` que tienen reserva de aplicación, para que un crash entre la confirmación HTTP y la proyección de la operación entre en recuperación sin liberar capital (`src/store.ts:367-369`).

**Consecuencia para la migración:** el esquema no es solo DDL; incluye *triggers con lógica de negocio* (`config_integrity_epoch`, `application_capital_reservations`, `fiat_balance_history`) y *backfills de arranque*. En PostgreSQL hay que reproducir esa semántica explícitamente (sección 4.4) o moverla a la aplicación con tests de equivalencia.

### 2.3 Inventario de las 41 tablas

Las filas son del snapshot local v16 (`—` = tabla aún no existía). El servicio destino es una **propuesta** para el plan maestro, no una decisión cerrada (ver sección 5).

#### A. Núcleo monetario y ejecución

| Tabla | Propósito | Claves / restricciones relevantes | Filas | Servicio propuesto |
| --- | --- | --- | ---: | --- |
| `operations` | Proyección de operaciones P2P (compra/venta QUSD por mercado) y su estado local | PK `uuid`; `idx_operations_cooldown(coin,counterparty_id,created_at)` | 10 | `money-core` |
| `fiat_ledger` | Libro idempotente de movimientos fiat por operación y dirección | PK `id`; **`UNIQUE(operation_uuid,direction)`**; `idx_fiat_ledger_created(coin,created_at)` | 71 | `money-core` |
| `fiat_balance_history` | Historial de saldo declarado/movido por moneda; `kind` ∈ opening/declaration/movement/historical | PK `id`; `ledger_id UNIQUE`; índices por `coin,id` y `coin,created_at`; triggers de `settings` | — | `money-core` |
| `fiat_accounts` | Proyección del saldo fiat por mercado | PK `market_code`, FK → `market_config(code) ON DELETE CASCADE` | 5 | `money-core` |
| `mutation_intents` | Intención durable previa a toda mutación remota monetaria; estados `submitted→confirmed/rejected/uncertain→reconciled` | PK `intent_id`; índices por `workflow_id,state`, `operation_uuid,created_at` (parcial apply), no resueltos | 21 | `money-core` |
| `application_capital_reservations` | Reserva de capital fiat/QUSD de una intención `apply`; bloquea doble gasto mientras la intención vive | PK `intent_id`, FK → `mutation_intents`; `offer_uuid UNIQUE`; CHECKs `fiat>=0,qusd>=0,amount>0`; trigger de liberación | — | `money-core` |
| `capital_reservations` | Reserva QUSD de un workflow compensable | PK/FK `workflow_id` → `trade_workflows`; CHECK `amount>0`; índice activo `(state,asset,market_code)` | 11 | `money-core` |
| `trade_workflows` | Máquina de estados de una aplicación con compensación (cancelar propias, aplicar, restaurar) | PK `id`; `target_offer_uuid UNIQUE`; `idx_trade_workflows_state` | 11 | `money-core` |
| `workflow_own_offers` | Snapshot + clave idempotente de cada oferta propia a cancelar/restaurar | PK `(workflow_id,original_uuid)`; FK → `trade_workflows ON DELETE CASCADE` | 2 | `money-core` |
| `payment_receipts` | Recibos SMS bancarios ingeridos desde el Android; estado pending/processing/matched/review/failed/duplicate | PK `id`; **`UNIQUE(bank,sender,transaction_id)`**; FK → `sms_devices`; `idx` por estado/fecha y reintento | — | `money-core` (o `receipts` con saga) |
| `sms_devices` | Dispositivos Android emisores de SMS, con token hasheado | PK `id`; `token_hash UNIQUE` | — | `money-core` / `identity` |

#### B. Configuración, riesgo y cadena de integridad

| Tabla | Propósito | Claves / restricciones relevantes | Filas | Servicio propuesto |
| --- | --- | --- | ---: | --- |
| `trading_config` | Config raíz (reserva QUSD, máx. ofertas propias), fila única. `qusd_reserve` es compatibilidad: la fuente de verdad es `risk_config.min_qusd_reserve` y se sincroniza (ADR-0005) | PK `id=1` | 1 | `config-registry` |
| `risk_config` | Límites de riesgo (por operación, exposición, diario, concurrencia, cooldowns), fila única | PK `id=1` | 1 | `config-registry` |
| `bot_config` | Automatización (intervalos, mensaje, flags de cacería), fila única | PK `id=1` | 1 | `config-registry` |
| `market_config` | Config por mercado **y su saldo fiat** (mezcla config + runtime) | PK `code`; proyecciones reconstruidas en cada guardado | 5 | `config-registry` (config) + `money-core` (saldo) |
| `payment_details` | Instrucciones de pago por mercado y posición | PK `(market_code,position)`; FK → `market_config ON DELETE CASCADE` | 1 | `config-registry` |
| `config_revisions` | Historial append-only de configuración completa, encadenado por SHA-256 | PK `id`; `hash UNIQUE`; `previous_hash`; 5.416 filas ≈22,1 MB | 5.416 | `config-registry` |
| `config_integrity_epoch` | Contador monotónico que se incrementa si se edita/borra/reinserta una revisión | PK `id=1`; triggers sobre `config_revisions` | — | `config-registry` |

#### C. Mercado, feed y cachés remotas

| Tabla | Propósito | Claves / restricciones relevantes | Filas | Servicio propuesto |
| --- | --- | --- | ---: | --- |
| `market_feed_events` | Cola durable de eventos del feed P2P (webhook/stream) con dedupe y reintentos | PK `event_key`; `idx` de cola; índice por `json_extract(payload,'$.data.uuid')`; índice parcial de simulación | 0 | `market-ingest` |
| `remote_resource_cache` | Última respuesta válida de cada recurso QvaPay (balance, own-offers, mercado, transacciones, promedios) | PK `resource_key`; `updated_at` indexado | 9 | `market-ingest` |
| `market_reader_accounts` | Cuentas lectoras QvaPay con token cifrado y salud por cuenta | PK `id`; `token_fingerprint UNIQUE`; CHECK `interval_seconds>=3` | 0 | `market-ingest` (+ `secrets`) |
| `market_observations` | Observaciones de mercado (promedios/medianas/mejores precios) para gráficas | PK `id`; índices por `created_at` y `coin,created_at` | 3.166 | `analytics` |
| `seen_offers` | Ofertas ya evaluadas (dedupe de escaneo) | PK `uuid` | 21 | `market-ingest` |
| `trading_alerts` | Ofertas bloqueadas accionables y su resolución | PK `offer_uuid`; `resolution/resolved_at` | 84 | `market-ingest`/`decisions` |

#### D. Decisiones, notificaciones y chat

| Tabla | Propósito | Claves / restricciones relevantes | Filas | Servicio propuesto |
| --- | --- | --- | ---: | --- |
| `decision_events` | Versión durable de cada decisión (applied/blocked/manual_review) con checks | PK `id`; `version UNIQUE`; `idx` de cola y por oferta | 237 | `decisions`/`market-ingest` |
| `notification_events` | Avisos durables con entrega y reintento independientes por canal (Telegram/push) | PK `id`; `idx` de entrega y no reconocidos; índices parciales | 352 | `notifier` |
| `chat_threads` | Hilos de chat operativo (payload JSON) | PK `id`; índices por `updated_at` y expresión sobre `state` | — | `chat` |
| `chat_push_devices` | Dispositivos push de operadores | PK `operator_id`; `token UNIQUE` | — | `chat` |
| `chat_push_events` | Cola de eventos push de chat | PK `id`; `idx_chat_push_pending(done,next_attempt_at,created_at)` | — | `chat` |
| `chat_push_deliveries` | Dedupe de entrega push por evento y dispositivo | PK `(event_id,device_hash)` | — | `chat` |

#### E. Analítica, históricos y estado interno

| Tabla | Propósito | Claves / restricciones relevantes | Filas | Servicio propuesto |
| --- | --- | --- | ---: | --- |
| `analytics_transactions` | Cache local de transacciones QvaPay por cuenta | PK `(account_uuid,uuid)`; índice por cuenta/fecha | — | `analytics` |
| `analytics_offers` | Cache local de ofertas completadas por cuenta | PK `(account_uuid,uuid)`; índice por cuenta/fecha | — | `analytics` |
| `analytics_fee_evidence` | Evidencia de comisiones (gross/fee QUSD) por oferta, versionada | PK `(account_uuid,offer_uuid)` | — | `analytics` |
| `portfolio_snapshots` | Serie temporal del portafolio (libre, comprometido, fiat, deuda) | PK `created_at`; columnas NOT NULL sin CHECK de importes | — | `analytics` |
| `dashboard_snapshots` | Serie temporal de KPIs del panel | PK `id`; `idx_dashboard_snapshots_created` | 661 | `analytics` |
| `audit_log` | Auditoría operativa append-only; se usa como cursor y como evidencia | PK `id`; índices `(action,id DESC)`, `(offer_uuid,action,id DESC)` | 6.176 | `audit` |
| `settings` | **Key-value sin esquema**: saldos, secretos cifrados, cursores, reintentos, estado de runtime | PK `key`; trigger de historial de saldos | 231 | transversal (ver 2.4) |
| `capital_rebalance_jobs` | Progreso durable de reajustes de capital entre mercados | PK `id`; `idx` por estado | 2 | `money-core`/`workflow` |
| `manual_cancel_exclusions` | Ofertas excluidas de reaplicación tras cancelación manual | PK `offer_uuid` | — | `money-core` |
| `scheduled_actions` | **Vestigial**: creada en v2, sin ningún uso en `src/` ni tests | PK `id` | 0 | retirar |
| `schema_migrations` | Versión aplicada del esquema | PK `version` | 16 | infraestructura |

**Total: 41 tablas.** Las 14 ausentes en el snapshot v16 son: `analytics_fee_evidence`, `analytics_offers`, `analytics_transactions`, `application_capital_reservations`, `chat_push_deliveries`, `chat_push_devices`, `chat_push_events`, `chat_threads`, `config_integrity_epoch`, `fiat_balance_history`, `manual_cancel_exclusions`, `payment_receipts`, `portfolio_snapshots`, `sms_devices`.

### 2.4 `settings`: el esquema implícito más peligroso

`settings` es una tabla KV usada como almacén de dominio. No es un detalle de implementación: contiene **dinero y secretos**. Familias detectadas en código (nombres exactos; sin valores):

| Familia de claves | Contenido | Destino propuesto |
| --- | --- | --- |
| `fiat_balance:<coin>` | **Saldo fiat autoritativo** (lo lee `market-config.ts:102-110` y lo escriben `store.ts:2247`, `store.ts:1229`) | tabla tipada en `money-core` (p. ej. `fiat_balance_state`) |
| `fiat_balance_declared_at:<coin>`, `fiat_ledger_started_at:<coin>` | Frontera de declaración y de inicio del ledger | `money-core` |
| `qvapay_token`, `cooperative_sync_token`, `market_feed_secret`, `market_feed_app_id`, `market_feed_app_secret` | **Secretos cifrados AES-256-GCM** (`src/session.ts:23`, `src/hunting-sync.ts:558`, `src/market-feed.ts:106-118`) | `secrets`/KMS; nunca en claro en un servicio |
| `web_push:vapid_keys`, `web_push:subscriptions`, `web_push:sent:*` | Claves VAPID y suscripciones push | `notifier` |
| `qusd_balance_epoch` | Contador de invalidación del cache de saldo QUSD (`src/store.ts:1359`, `src/store.ts:2541`, `src/trading.ts:136`) | `money-core` (contador tipado) |
| `cooperative_*` | Estado de la cacería cooperativa: `participation:*`, `participant_reserved:*`, `local_balance:*`, `owner_fiat:<uuid>`, `fiat_reserved:*`, `qusd_owed`, cursores y tokens | normalizar en tablas de `money-core`/`cooperative` |
| `reconciliation_retry:<intentId>`, `reconciliation_last_check:<intentId>`, `recovery_evidence:<intentId>`, `recovery_ack:<intentId>`, `recovery_manual_check_next_at` | Estado del reconciliador y de la recuperación manual (`src/reconciliation-scheduler.ts:13-67`, `src/self-service-recovery.ts:116-123`) | `recovery` (o `money-core`) |
| `fiat_order_state:<order>`, `fiat_flexible_polled_at:<uuid>`, `fiat_flexible_sync_error:<uuid>`, `fiat_sync_invalid_amount:<uuid>` | Cursores de conciliación de órdenes flexibles | `money-core` |
| `operation_sync_error:<uuid>`, `refresh_retry:<uuid>`, `refresh_attempts:<uuid>`, `last_refresh:<uuid>`, `refresh_enabled`, `last_offer_edit_at` | Estado de refresco de ofertas propias | `market-ingest` |
| `risk_notice_fingerprint`, `risk_notice_at`, `qva_throttle:*`, `last_scan*`, `last_qvapay_error`, `consecutive_errors`, `paused`, `mode`, `emergency_stop`, `chat` | Estado de runtime y throttling | `runtime`/`config-registry` |
| `trading:owned_offer_uuids`, `trading:own_offer_cycle:<uuid>`, `analytics_account_uuid` | Identidad/catálogo local de ofertas propias y cuenta | `identity`/`market-ingest` |

**Riesgo:** este KV concentra escrituras de dinero, secretos y cursores en la misma tabla, sin tipos ni FKs. Si un microservicio lo adopta como almacén genérico, se convierte en un acoplamiento distribuido invisible. Debe **desnormalizarse antes** de la migración (columna "destino propuesto") y no replicarse como KV compartido.

### 2.5 Índices, triggers y restricciones

**Índices (32, materializados con v31):**

- Núcleo: `idx_operations_cooldown`, `idx_fiat_ledger_created`, `idx_fiat_history_coin_id`, `idx_fiat_history_created`, `idx_capital_reservations_active`, `idx_trade_workflows_state`, `idx_capital_rebalance_jobs_state`, `idx_payment_receipts_state_created`, `idx_payment_receipts_retry`.
- Intenciones: `idx_apply_intent_offer` (parcial, `kind='apply'`), `idx_mutation_intents_unresolved_offer` (parcial, estados `submitted/uncertain`), `idx_mutation_intents_workflow_state`.
- Mercado/feed: `idx_market_feed_events_queue`, `idx_market_feed_offer_uuid` (expresión JSON), `idx_feed_simulation` (parcial), `idx_market_observations_created`, `idx_market_observations_coin_created`, `idx_market_reader_accounts_schedule`, `idx_remote_resource_cache_updated`.
- Decisiones/avisos: `idx_decision_events_queue`, `idx_decision_events_offer`, `idx_notification_delivery`, `idx_notification_unacknowledged`, `idx_notification_information` (parcial).
- Históricos/auditoría: `idx_insights_audit`, `idx_audit_offer_action`, `idx_dashboard_snapshots_created`.
- Analítica/chat: `idx_analytics_transactions_account_date`, `idx_analytics_offers_account_date`, `idx_chat_threads_updated`, `idx_chat_threads_active` (expresión sobre JSON), `idx_chat_push_pending`.

**Triggers (6, con lógica de negocio):**

1. `config_integrity_update`, `config_integrity_delete`, `config_integrity_insert` → incrementan `config_integrity_epoch` ante UPDATE/DELETE/reinserción histórica (`src/store.ts:902-908`).
2. `application_reservation_resolved` → borra la reserva de aplicación cuando la intención pasa a `rejected`/`reconciled` (`src/store.ts:918-921`).
3. `fiat_history_insert`, `fiat_history_update` → registran en `fiat_balance_history` los cambios de `settings.fiat_balance:*` (`src/store.ts:937-947`).

**Foreign keys reales (6; el resto de relaciones son TEXT lógicos sin FK):**

`payment_details.market_code → market_config.code` · `fiat_accounts.market_code → market_config.code` · `workflow_own_offers.workflow_id → trade_workflows.id` · `capital_reservations.workflow_id → trade_workflows.id` · `payment_receipts.device_id → sms_devices.id` · `application_capital_reservations.intent_id → mutation_intents.intent_id`.

**Uniques que son invariantes de dinero** (deben preservarse como constraints en PostgreSQL, no solo como validación de app):

- `fiat_ledger UNIQUE(operation_uuid, direction)` — idempotencia del libro (impide doble débito/crédito).
- `payment_receipts UNIQUE(bank, sender, transaction_id)` — dedupe de SMS.
- `application_capital_reservations.offer_uuid UNIQUE` — una reserva por oferta.
- `capital_reservations.workflow_id` PK y `trade_workflows.target_offer_uuid UNIQUE` — una reserva y un workflow por objetivo.
- `config_revisions.hash UNIQUE` y `decision_events.version UNIQUE` — dedupe de configuración/decisiones.

### 2.6 Volumen y crecimiento

Distribución por tabla (`dbstat` sobre la copia, snapshot v16):

| Objeto | Bytes | % del total |
| --- | ---: | ---: |
| `config_revisions` | 22.130.688 | 85,5 % |
| `sqlite_autoindex_config_revisions_1` | 450.560 | 1,7 % |
| `decision_events` | 909.312 | 3,5 % |
| `audit_log` | 880.640 | 3,4 % |
| `remote_resource_cache` | 385.024 | 1,5 % |
| `notification_events` | 290.816 | 1,1 % |
| `market_observations` | 212.992 | 0,8 % |
| `trade_workflows` | 49.152 | 0,2 % |
| `settings` | 40.960 | 0,2 % |
| resto (34 tablas/índices) | ≈524 KB | ~2 % |
| **Total** | **25.874.432** | 100 % |

Datos de crecimiento observados en el snapshot:

- `config_revisions`: 5.416 filas entre el 2026-09-15 y el 2026-09-26 (~490/día), 11.548.249 caracteres de `config_json` (≈11,5 MB de texto), tabla de ≈22,1 MB por overflow. Cada guardado inserta el **JSON completo**, no un diff (`src/store.ts:1283-1303`). No hay retención ni particionado.
- `audit_log`: 6.176 filas; top de acciones: `scan_complete` (1.962), `refresh_offer` (1.633), `risk_block` (1.533). Crecimiento acotado por el escaneo.
- `decision_events`: 237 filas; `notification_events`: 352 (340 `blocked-offer`).
- `market_observations`: 3.166; `dashboard_snapshots`: 661.

**Consecuencia:** antes de mover 41 tablas hay que decidir qué hacer con `config_revisions` (compacción, snapshots periódicos + diffs, retención por antigüedad, o archivo a object storage manteniendo la cadena verificable). Si se migra tal cual, el 87 % del peso y del tiempo de dump corresponde a una tabla histórica que el runtime no necesita para operar.

---

## 3. Grafo de dependencias transaccionales

### 3.1 La primitiva de transacción actual

```ts
// src/store.ts:1746-1756
private transaction<T>(action: () => T): T {
  this.db.exec("BEGIN IMMEDIATE");
  try { const result = action(); this.db.exec("COMMIT"); return result; }
  catch (error) { this.db.exec("ROLLBACK"); throw error; }
}
```

- Es **privada** y **no anidable**: no hay `SAVEPOINT` ni soporte de transacciones anidadas. Por tanto, dos métodos públicos que abren su propia transacción **no pueden combinarse** en una unidad mayor desde `src/trading.ts`.
- `BEGIN IMMEDIATE` toma el write-lock al inicio: evita upgrades de lock y carreras locales, y es la razón por la que los chequeos "leer suma → insertar" de `reserveQusd` son seguros hoy.
- La serialización de decisiones financieras depende también del event loop y de estructuras en memoria (`operationActionsInFlight`, `ownDecisionPending`, colas del scheduler). **Nada de eso existe en una base compartida con varios procesos.**

### 3.2 Unidades atómicas reales hoy

| # | Unidad | Tablas implicadas | Evidencia |
| --- | --- | --- | --- |
| 1 | Persistir intención + reserva de aplicación | `mutation_intents` + `application_capital_reservations` | `src/store.ts:1309-1335` |
| 2 | Crear workflow + snapshots de ofertas propias | `trade_workflows` + `workflow_own_offers` | `src/store.ts:1485-1515` |
| 3 | Reservar QUSD con tope global (leer suma activa → insertar) | `capital_reservations` | `src/store.ts:1622-1634` |
| 4 | Registrar movimiento fiat (ledger + historial + saldo KV + 2 proyecciones + auditoría) | `fiat_ledger`, `fiat_balance_history`, `settings`, `market_config`, `fiat_accounts`, `audit_log` | `src/store.ts:2225-2264` |
| 5 | Reparto cooperativo por lote (estados, débitos, checkpoints) | `settings` + `fiat_ledger` + `fiat_balance_history` | `src/store.ts:2272-2311` |
| 6 | Crear/actualizar operación y limpiar reserva de aplicación de esa oferta | `operations` + `application_capital_reservations` + `settings` | `src/store.ts:2509-2544` |
| 7 | Reclamar recibo SMS para una operación (exclusividad) | `payment_receipts` | `src/store.ts:2701-2709` |
| 8 | Resolver manualmente una intención incierta (CAS + auditoría + ack) | `mutation_intents` + `audit_log` + `notification_events` | `src/store.ts:1404-1433` |
| 9 | Guardar configuración completa + revisión encadenada + reconstruir proyecciones de mercado | `trading_config`, `risk_config`, `bot_config`, `market_config`, `payment_details`, `fiat_accounts`, `settings`, `config_revisions` | `src/store.ts:1122-1236` |
| 10 | Migración completa del esquema (con backup previo) | todas + `schema_migrations` | `src/store.ts:379-991`, `1732-1744` |
| 11 | Preparar resumen de notificaciones (crear + reconocer lote) | `notification_events` + `audit_log` | `src/store.ts:3074-3094` |

Estas 11 unidades son las que **deben seguir siendo transaccionales** en cualquier topología. Si se separan en bases distintas, se sustituyen por sagas con compensación y deben demostrarse con pruebas de fallo inyectado.

### 3.3 Secuencias multi-transacción que hoy sostiene la lógica de negocio

Estas son las que realmente importan al partir la base, porque **hoy no son atómicas** y el sistema ya las tolera con idempotencia/reconciliación:

| Secuencia | Transacciones implicadas | Ventana de inconsistencia | Recuperación actual |
| --- | --- | --- | --- |
| Proyectar estado del feed → mover fiat | `updateOperation()` y luego `recordFiatMovement()` son transacciones distintas, ambas dentro de `ingestMarketStateEvent` | Crash entre ambas: operación `completed` sin asiento en `fiat_ledger` | Reentrega del feed (dedupe por `event_key`), `UNIQUE(operation_uuid,direction)` evita duplicado, y `syncFiatFromQva` cada 30 s reconstruye desde QvaPay (`src/trading.ts:1443-1456`, `2427-2544`, `src/index.ts:560`) |
| Aplicar oferta | 1) intención+reserva → 2) POST remoto → 3) intención `confirmed`/`uncertain` → 4) crear/actualizar operación → 5) liberar reserva | Varias ventanas; la más grave: crash tras confirmación HTTP y antes de proyectar operación | Intención durable; arranque convierte `confirmed` con reserva a `uncertain` (`src/store.ts:367-369`); `reconcilePendingStandaloneMutations` cada 60 s (`src/index.ts:556-557`); prohibición de operar con mutación sin resolver (`hasUnresolvedMutation`) |
| Marcar pagado / confirmar recepción | 1) intención → 2) POST remoto → 3) `updateMutationIntent('confirmed')` → 4) `updateOperation` → 5) ledger/auditoría | Crash antes de `4` deja intención confirmada con la operación sin actualizar (o al revés si falla la proyección) | `recoverableMutationIntents()` incluye `confirmed` de tipo `paid`/`received`/`apply`/`cancel` (`src/store.ts:1450-1463`); `syncFiatFromQva` reconstruye el asiento |
| Recibo SMS → operación pagada | 1) claim (tx) → 2) `markPaid` (intención + remoto) → 3) `updatePaymentReceipt('matched')` (tx) | Crash tras `2`: recibo en `processing` con `mutation_started=1`; crash tras `1`: recibo reclamado sin pago | Reconciliación de acciones de operación y revisión manual; el claim impide que otro recibo reutilice la operación |
| Guardado de configuración vs saldo | `saveTradingConfig` es una transacción, pero antes/después `trading.saveConfig` vuelve a fijar `fiat_balance:*` en otra transacción (`src/trading.ts:255-268`) y `updateBalance` decide guardar por comparación de JSON (`src/market-config.ts:181-192`) | Crash entre ambas deja saldo proyectado distinto del KV | Trigger de historial y siguiente `fiat_sync` re-proyecta; **no hay verificación de consistencia al arrancar** |
| Workflow compensable | `updateWorkflowState`, `updateWorkflowOwnOffer`, `reserveQusd`/`releaseCapitalReservation` son llamadas separadas | Estados intermedios (`cancelling_own_offers`, `apply_uncertain`, `restoring_own_offers`) persistentes | `recoverableWorkflows()` y reconciliación; el snapshot local tiene 2 workflows en `apply_uncertain` y 2 propias en `restore_requested` |
| Resumen de notificaciones | Crear resumen + reconocer fuentes en una tx; entrega posterior en otra | Crash tras crear resumen y antes de marcar fuentes → duplicados posibles | Dedupe por id determinista (`information:<bucket>:<hash>`), reentrega at-least-once |

**Lectura para el plan maestro:** el sistema ya opera con consistencia eventual entre su estado local y QvaPay. La migración no debe intentar convertir eso en transacciones distribuidas; debe **preservar exactamente los mismos mecanismos** (intención durable, idempotencia por unique, reconciliación periódica, bloqueo por mutación sin resolver) y añadir pruebas de caos entre servicios.

### 3.4 Tablas que deben permanecer juntas

Agrupación por invariante, no por conveniencia de dominio:

| Grupo | Tablas | Invariante que lo obliga | ¿Puede separarse? |
| --- | --- | --- | --- |
| **A. Money-core** | `operations`, `fiat_ledger`, `fiat_balance_history`, `fiat_accounts`, `settings` (`fiat_balance:*`, `qusd_balance_epoch`, `fiat_*`), `application_capital_reservations`, `capital_reservations`, `mutation_intents`, `trade_workflows`, `workflow_own_offers`, `payment_receipts`, `sms_devices` | `UNIQUE(operation_uuid,direction)`, tope de reservas `reserveQusd`, trigger de liberación, CAS de intenciones, claim de recibos, `BEGIN IMMEDIATE` de 11 unidades | **No en fase 1.** Es un único PostgreSQL/schema con transacciones ACID. Se puede modularizar el código, no la base |
| **B. Config-registry** | `trading_config`, `risk_config`, `bot_config`, `market_config` (solo campos de config), `payment_details`, `config_revisions`, `config_integrity_epoch` | Cadena SHA-256 + triggers de epoch solo tienen sentido con `config_revisions` en la misma base; las decisiones de riesgo deben registrar la versión/hash usada | Sí, como servicio separado **con su propia base**; `money-core` consume config versionada y guarda el hash usado por decisión |
| **C. Market-ingest** | `market_feed_events`, `remote_resource_cache`, `market_reader_accounts`, `seen_offers`, `trading_alerts` | Dedupe de eventos (`event_key`) y cache por recurso; puede perder datos sin perder dinero | Sí, primero. `money-core` recibe comandos idempotentes con la clave del evento |
| **D. Decisions/notifier/chat** | `decision_events`, `notification_events`, `chat_*` | At-least-once y dedupe propios; no mueven dinero | Sí, primero (D) y con outbox desde A |
| **E. Analytics** | `analytics_*`, `portfolio_snapshots`, `dashboard_snapshots`, `market_observations` | Derivados/reconstruibles; pérdida tolerada | Sí, primero; reconstruir desde A + QvaPay |
| **F. Audit** | `audit_log` | Append-only, usado como evidencia y como cursor (`id` monótono); hoy se escribe desde todos los flujos | Centralizar como log de eventos, alimentado por outbox de cada servicio; no bloquear la transacción de dinero esperando al audit remoto |

**Fronteras prohibidas (fase 1):** `operations` ↔ `fiat_ledger`; `mutation_intents` ↔ `application_capital_reservations`; `trade_workflows` ↔ `capital_reservations`/`workflow_own_offers`; `payment_receipts` ↔ `operations`; `config_revisions` ↔ `config_integrity_epoch`; `settings.fiat_balance:*` ↔ `market_config`/`fiat_accounts`.

### 3.5 Qué implicaría partirlas mal

| Partición propuesta | Fallo esperado | Severidad |
| --- | --- | --- |
| `operations` en un servicio y `fiat_ledger` en otro | Un `completed` sin asiento o un asiento sin operación; doble crédito/débito al reintentar; el operador ve saldo distinto del libro | **Crítica** |
| `mutation_intents` separado de `application_capital_reservations` | Reservas huérfanas que bloquean capital para siempre, o capital libre sin reserva → **doble gasto** en la siguiente aplicación | **Crítica** |
| `capital_reservations` separado de `trade_workflows` | Dos workflows reservan el mismo QUSD porque el tope se evalúa en bases distintas | **Crítica** |
| `settings.fiat_balance` separado de `fiat_ledger`/`market_config` | Cuatro vistas de saldo divergentes; decisiones con capital fantasma | **Crítica** |
| `payment_receipts` separado de `operations` | Dos recibos reclaman la misma operación; pago declarado dos veces | Alta |
| `config_integrity_epoch` separado de `config_revisions` | La cadena deja de detectar manipulación; epoch inexistente | Alta |
| `market_feed_events` separado del consumidor | Duplicado de eventos si falta la clave de idempotencia en el comando | Media |
| `audit_log` escrito de forma síncrona en la transacción de dinero | Caída del audit bloquea pagos, o pérdida de evidencia si es asíncrono sin outbox | Media |

---

## 4. Durabilidad e integridad

### 4.1 Garantías actuales

| Mecanismo | Implementación | Evidencia | Equivalente requerido en PostgreSQL |
| --- | --- | --- | --- |
| WAL | `PRAGMA journal_mode=WAL` | `src/store.ts:361` | WAL nativo + `synchronous_commit=on`; `full_page_writes=on` |
| Escritor único | Un proceso Node, sin réplicas | `docs/adr/0002`, `docs/VPS.md:18-19` | Un único servicio dueño por agregado + locks de fila/asesoría |
| Transacción explícita | `BEGIN IMMEDIATE` | `src/store.ts:1746-1756` | `BEGIN; SELECT … FOR UPDATE` / `SERIALIZABLE` con reintentos |
| FKs | `PRAGMA foreign_keys=ON` | `src/store.ts:361` | FKs reales dentro del servicio; referencias lógicas entre servicios con validación de aplicación |
| Backup pre-migración | checkpoint + copia a `data/backups` | `src/store.ts:1732-1744` | Snapshot/PITR antes de cada migración |
| Backup periódico | `sqlite3 .backup` diario 04:15 UTC, retención 14 días | `scripts/backup-vps.sh`, `deploy/qvaapply-backup.timer` | `pg_basebackup` + archivo WAL (WAL-G/pgBackRest), retención ≥14 días, copia externa cifrada |
| Restauración documentada | Parar proceso, conservar base dañada, copiar backup, permisos 600 | `docs/OPERATIONS.md:94-108` | Runbook de restore probado; objetivo RTO/RPO explícito |
| Integridad de fichero | `PRAGMA integrity_check` (manual) | runbook | `pg_checksums`, `amcheck`, verificación de página |
| Integridad de configuración | Cadena SHA-256 + epoch + worker read-only | `src/config-integrity.ts:13-43`, `src/config-integrity-monitor.ts:27-60` | Tabla + trigger/check + verificación en app y en job programado |
| Docker | FS read-only, volumen solo para datos, `stop_grace_period=90s` | `deploy/compose.yaml` | Equivalente en el orquestador; PVC con backups |

**Detalle importante:** el proceso no fija `synchronous` ni `busy_timeout` en la conexión principal. En SQLite el default es `synchronous=FULL`, lo que da durabilidad a costa de latencia. Al migrar a PostgreSQL, la durabilidad debe ser explícita (`synchronous_commit`, `full_page_writes`, replicación síncrona si el RPO lo exige); no debe heredarse por defecto.

### 4.2 Integridad de la configuración (cadena + epoch)

- Cada revisión guarda `previous_hash` y `hash = SHA-256(JSON({previousHash, createdAt, source, reason, configJson}))` (`src/config-integrity.ts:13-16`, `src/store.ts:1273-1303`).
- `config_integrity_epoch` se incrementa si una fila histórica se actualiza, borra o reinserta (triggers, `src/store.ts:902-908`). La verificación normal es incremental desde el último checkpoint; si el epoch cambió, se re-verifica la cadena completa (`src/config-integrity.ts:26-41`).
- Un worker independiente abre la base en `readOnly` con `query_only=ON; busy_timeout=1000` (`src/config-integrity.ts:47-57`) y el monitor cachea el resultado 30 s (`src/config-integrity-monitor.ts:22-25`). Así la verificación no bloquea el event loop de cacería.
- La UI expone el estado en **Auditoría → Salud e integridad** (`docs/OPERATIONS.md:5-6`).

**Esto no es un detalle de configuración: es una garantía de que los límites de riesgo con los que se autorizó dinero no fueron alterados.** En la migración:

1. Mantener `config_revisions` y `config_integrity_epoch` en la misma base y con los mismos triggers (o una función/trigger equivalente).
2. Recalcular la cadena completa en destino y comparar el hash de la última revisión con el origen.
3. Registrar en `decision_events`/auditoría el `hash` de configuración vigente al decidir (hoy se guarda `riskDecision` y versión de decisión, pero no siempre el hash de config; es una mejora recomendada para la topología distribuida).
4. Restringir escrituras: en PostgreSQL, `REVOKE UPDATE, DELETE ON config_revisions` al rol de aplicación; solo el owner puede migrar.

### 4.3 Idempotencia y estados

- **Intenciones:** el protocolo es *persistir antes de despachar* (`src/application/monetary-intents.ts:43-89`). Una excepción de red no se clasifica como rechazo: `QvaMutationUncertainError` o HTTP ≥500 produce `uncertain`; HTTP <500 produce `rejected` (`src/application/monetary-intents.ts:92-106`). El estado `uncertain` bloquea nuevas operaciones (`hasUnresolvedMutation`, `src/store.ts:1465-1479`).
- **Ledger:** `INSERT OR IGNORE` + unique `(operation_uuid,direction)` hacen el asiento idempotente; `recordFiatMovement` devuelve `false` si ya existía (`src/store.ts:2229-2234`).
- **Reservas de aplicación:** viven mientras la intención está viva; el trigger las borra en `rejected`/`reconciled` (`src/store.ts:918-921`) y `createOperation` las limpia al proyectar la oferta (`src/store.ts:2542-2543`). La consulta `applicationReservedCapital` descuenta capital de todas las intenciones activas (`src/store.ts:1366-1372`).
- **Workflows:** `updateWorkflowState`/`updateWorkflowOwnOffer` no son CAS, pero los estados intermedios son durables y `recoverableWorkflows()` los retoma (`src/store.ts:1536-1547`). El snapshot tiene 2 workflows en `apply_uncertain`, 2 ofertas propias en `restore_requested` y 2 reservas activas: **son datos que la migración debe preservar y la verificación debe reproducir**.
- **Recibos:** `claimPaymentOperation` es CAS implícito (comprueba que no exista otro recibo con `mutation_started=1` para la operación y actualiza solo si `state='pending'`), `src/store.ts:2701-2709`. La unique `(bank,sender,transaction_id)` deduplica el SMS.
- **Notificaciones:** at-least-once por canal, con entregas independientes y dedupe de resumen por id determinista (`src/store.ts:3074-3094`).

### 4.4 Cómo preservar estas garantías en PostgreSQL (por servicio)

1. **Un PostgreSQL por servicio dueño del dato**, no una base compartida entre servicios. Regla: ninguna transacción cruza bases.
2. **Dinero:** `REPEATABLE READ` o `SERIALIZABLE` con reintentos, o `SELECT … FOR UPDATE` sobre la fila de saldo/intención antes de decidir. Prohibido decidir con una lectura sin lock sobre capital.
3. **Constraints como contrato:** trasladar todas las uniques y CHECK de 2.5; añadir `CHECK (amount > 0)` y `CHECK (fiat >= 0)` donde hoy solo hay validación de app; `EXCLUDE`/unique parciales para invariantes de reserva (`UNIQUE(offer_uuid)`).
4. **Idempotencia de comandos:** tabla `inbox`/`processed_commands(command_id PK, result JSONB)` en cada servicio, alimentada por el outbox del emisor. La clave del evento de feed (`event_key`) o de la intención (`intent_id`) debe viajar en el mensaje.
5. **Outbox transaccional:** en `money-core`, escribir `outbox(id, topic, payload, created_at)` en la misma transacción que el cambio de dinero; un relay lo publica. Así no se pierde la notificación a `analytics`/`notifier`/`audit` y no se bloquea la transacción esperando al broker.
6. **Cadena de configuración:** `config_revisions` + `config_integrity_epoch` con función/trigger equivalente, y verificación periódica fuera del path de escritura. En PostgreSQL, `SECURITY DEFINER` para el trigger y permisos revocados al rol de app.
7. **PITR:** archivo continuo de WAL + `pg_basebackup` diario; restaurar en staging al menos una vez por trimestre; cifrado en reposo y copia externa.
8. **Reconciliación:** conservar el scheduler (60 s mutaciones, 30 s fiat, 15 s recibos SMS, `src/index.ts:533-600`) como proceso separado o worker, con la misma semántica.
9. **Auditoría:** `audit_log` centralizado por outbox; `id` debe ser monótono (BIGINT identity) porque se usa como cursor (`after=id`, `src/store.ts:2769-2803`).
10. **Epochs/caches:** `qusd_balance_epoch` pasa a ser un contador en tabla (`balance_epoch(id=1, version BIGINT)`), incrementado en la misma transacción que confirma la mutación o crea la operación de compra (`src/store.ts:1359`, `src/store.ts:2541`).

---

## 5. Mapa de migración SQLite → PostgreSQL por servicio

### 5.1 Servicios destino propuestos

| Servicio | Responsabilidad | Tablas propias | ¿Fase? |
| --- | --- | --- | --- |
| `money-core` | Ledger, saldos, operaciones, intenciones, reservas, workflows, recibos | `operations`, `fiat_ledger`, `fiat_balance_history`, `fiat_accounts`, `mutation_intents`, `application_capital_reservations`, `capital_reservations`, `trade_workflows`, `workflow_own_offers`, `payment_receipts`, `sms_devices`, `capital_rebalance_jobs`, `manual_cancel_exclusions`, `fiat_balance_state` (nueva, desde `settings`) | 1 (no se parte) |
| `config-registry` | Configuración versionada, límites de riesgo, cadena de integridad, secretos de política | `trading_config`, `risk_config`, `bot_config`, `payment_details`, `market_config` (solo campos de configuración), `config_revisions`, `config_integrity_epoch` | 2 |
| `market-ingest` | Feed P2P, polling, cachés remotas, cuentas lectoras, dedupe de ofertas | `market_feed_events`, `remote_resource_cache`, `market_reader_accounts`, `seen_offers`, `trading_alerts` | 1 (solo lectura/ingesta; puede ir antes) |
| `decisions` | Versiones durables de decisiones y su resolución | `decision_events` | 2 |
| `notifier` | Entrega Telegram/push, resúmenes, dedupe | `notification_events`, `web_push:*` | 1 (derivado) |
| `chat` | Hilos y push de chat operativo | `chat_threads`, `chat_push_devices`, `chat_push_events`, `chat_push_deliveries` | 1 (derivado) |
| `analytics` | Históricos, portafolio, observaciones, caches de analítica | `analytics_transactions`, `analytics_offers`, `analytics_fee_evidence`, `portfolio_snapshots`, `dashboard_snapshots`, `market_observations` | 1 (reconstruible) |
| `audit` | Log append-only de eventos de negocio y operativos | `audit_log` | 2 |
| `secrets` (puede vivir en `config-registry`) | Tokens cifrados y claves | `settings` (secretos), `market_reader_accounts.encrypted_token` | 0 (prerrequisito) |

**Recomendación de secuencia:** extraer primero lo que no mueve dinero (`analytics`, `notifier`, `chat`, `market-ingest`, `decisions`) para ganar experiencia operativa, y **mantener `money-core` + `config-registry` como bases ACID separadas pero internamente monolíticas** en toda la fase 1. Partir el núcleo solo cuando existan: inbox/outbox probados, pruebas de caos, reconciliación multi-servicio y presupuesto de doble escritura.

### 5.2 Conflictos de propiedad de tablas

| Tabla | Conflicto | Resolución propuesta |
| --- | --- | --- |
| `market_config` | Mezcla configuración (tasas, fees, moneda) con runtime (saldo fiat) | Dividir en `market_config` (config-registry) y `fiat_account`/`fiat_balance_state` (money-core). `money-core` mantiene una proyección de solo lectura de los campos de config que necesita para decisiones |
| `settings` | KV transversal con dinero, secretos, cursores y runtime | Desnormalizar en tablas tipadas por servicio (2.4). No replicar el KV |
| `audit_log` | Escrito por todos los flujos | Un solo `audit` con inbox; emisores usan outbox. El cursor por `id` se preserva |
| `remote_resource_cache` | Cache genérica usada por panel, feed y fiat | Propiedad de `market-ingest`; claves namespaced (`market:<coin>`, `own-offers`, `balance`, `transactions`, `averages`) |
| `config_integrity_epoch` | Solo tiene sentido con `config_revisions` | Misma base, mismo trigger, permisos restringidos |
| `application_capital_reservations` | Depende de intención y de operación | `money-core`; si en el futuro se separa órdenes, la reserva sigue al lado de la intención, no de la orden |

### 5.3 Tipos y conversión

| Origen SQLite | Destino PostgreSQL | Regla |
| --- | --- | --- |
| `INTEGER` epoch en ms (`created_at`, `updated_at`, `next_attempt_at`, `received_at`, etc.) | `BIGINT` (canónico) + columna generada `timestamptz` (`to_timestamp(ms/1000.0)`) | No convertir el canónico a `timestamptz` para lógica de negocio: se perdería la semántica de comparación exacta usada hoy (`Date.now()`, ventanas de 60 s, backoff) |
| `REAL` de dinero (`amount`, `receive`, `fiat_balance`, `declared_balance`, `qusd_*`, `fee_*`, `balance_*`) | `NUMERIC(24,8)` | Escala canónica 1e-8. Ver 5.4 |
| `REAL` de tasas (`rate`, `buy_max_rate`, `sell_min_rate`, `reference_rate`, `average_*`, `median_*`, `best_*`) | `NUMERIC(24,8)` | Misma escala; el redondeo conservador por dirección (comprar arriba/vender abajo) se mantiene en la aplicación |
| `REAL` de porcentajes (`sell_fee_percent`, `price_guard_percent`, `min_expected_margin_percent`, `max_slippage_percent`) | `NUMERIC(9,6)` | No usar `float` para comparar contra umbrales de riesgo |
| `REAL` de tiempo (`*_seconds`, `*_minutes`) | `DOUBLE PRECISION` o `NUMERIC(12,3)` | No es dinero; mantener precisión suficiente para intervalos de 3 s |
| `INTEGER` booleano (`active`, `auto_applied`, `enabled`, `done`, `web_delivered`) | `BOOLEAN` | Convertir `0/1`; conservar default |
| `INTEGER PRIMARY KEY AUTOINCREMENT` (`audit_log.id`, `fiat_ledger.id`, `decision_events.id`, `dashboard_snapshots.id`, `market_observations.id`, `fiat_balance_history.id`) | `BIGINT GENERATED BY DEFAULT AS IDENTITY` | **Preservar los ids existentes** (`OVERRIDING SYSTEM VALUE`) y reajustar la secuencia con `setval(max(id)+1)`. `audit_log.id` y `decision_events.id` son cursores |
| `TEXT` con JSON (`request_json`, `response_json`, `config_json`, `checks_json`, `payload_json`, `snapshot_json`, `target_json`, `risk_decision_json`, `adjustments_json`) | `JSONB` | Añadir `CHECK (jsonb_typeof(col)='object')` cuando aplique. JSONB guarda números como `numeric`, pero el texto de origen ya contiene el `double` serializado por `JSON.stringify` (p. ej. `1244.1000000000001`): **canonicalizar a 8 decimales en el export** y, si el campo participa en dinero, sacarlo del JSON a una columna `NUMERIC` |
| `TEXT` uuid/identificadores (`operation_uuid`, `intent_id`, `workflow_id`, `event_key`) | `TEXT` | No convertir a tipo `UUID` sin validar: hay claves compuestas y valores no-UUID (`cooperative:<id>`, `recovery:<id>`, `information:<bucket>:<hash>`) |
| `TEXT` enums (`state`, `kind`, `decision`, `resolution`, `health`) | `TEXT` + `CHECK (col IN (…))` | Los enums nativos complican evolucionar estados; los CHECK reproducen hoy la garantía |
| Columnas calculadas/expresiones (`json_extract`, índices parciales) | Índices de expresión (`((payload->'data'->>'uuid'))`) e índices parciales (`WHERE kind='apply'`) | Reproducir los 32 índices; validar planes con `EXPLAIN` sobre datos reales |

### 5.4 Reglas de redondeo y aritmética (crítico)

**Escala canónica: 8 decimales (1e-8).** Es la que ya impone el dominio:

- `roundQusd(v) = Math.round(v * 1e8) / 1e8` (`src/core/liquidity-plan.ts:285-286`).
- `roundDecimal(v) = Math.round(v * 1e8) / 1e8` (`src/market-math.ts:112-114`).
- Tolerancias de comparación de `1e-7`/`1e-8` en liquidez y reservas (`src/core/liquidity-plan.ts:150-153`, `src/store.ts:1624`).

Reglas para la migración y para el código Go/Rust:

1. **No convertir `REAL` con un cast directo a `NUMERIC`.** En PostgreSQL `float8::numeric` puede producir `1244.1000000000001` (el drift real del snapshot). Canonicalizar con `round(col::numeric, 8)`, o mejor: exportar desde SQLite con `printf('%.8f', col)` y cargar el texto como `NUMERIC(24,8)`.
2. **Todo cálculo monetario en decimal**, nunca en `float64`. En Go: `shopspring/decimal` o `NUMERIC` en la base; en Rust: `rust_decimal`/`bigdecimal`. Sumas de saldos, reservas y exposición se hacen en la base (`SUM(NUMERIC)`) o en decimal, no en double.
3. **Redondeo half-away-from-zero a 8 decimales** para equivaler a `Math.round` sobre valores positivos (los importes son positivos; los signos se modelan con `direction`). Documentar y testear la equivalencia con vectores del dominio.
4. **Redondeo de tasas de presentación**: conservar la regla conservadora por dirección (compras redondean hacia arriba, ventas hacia abajo; `src/market-math.ts:40-93`). No aplicarla en la base sino en el dominio, pero testearla contra los mismos fixtures.
5. **Comparaciones:** después de cuantizar a 8 decimales, usar igualdad exacta; retirar los `EPSILON`/`1e-7` de la lógica nueva o justificarlos como tolerancia de redondeo documentada. No mezclar tolerancias con `float`.
6. **Agregados de verificación:** sumar `NUMERIC` y comparar con la suma calculada en SQLite sobre texto decimal canónico. Nunca comparar con `SUM(REAL)`.

Evidencia del problema (snapshot, solo agregados):

```
CLASICA credit: 21 movimientos, suma REAL = 1244.1000000000001
CLASICA debit : 15 movimientos, suma REAL =  635.29981622999992
```

Con `NUMERIC(24,8)` esas sumas deben ser `1244.10000000` y `635.29981623` exactamente.

---

## 6. Plan de migración de datos

### 6.1 Principios

- SQLite sigue siendo la fuente de verdad hasta el cutover; el destino se valida en modo solo lectura/ensayo.
- La migración es **un evento con ventana de congelación**, no una sincronización permanente. La doble escritura, si se usa, es un mecanismo de transición con outbox e idempotencia, no el estado final.
- **Fail closed:** ante cualquier discrepancia de conteo, suma o hash, se aborta y se restaura; no se "corrige a mano" un saldo.
- Nada de descifrar secretos: se transporta ciphertext.
- Todo el plan se ensaya dos veces en staging con una copia de producción antes de tocar producción.

### 6.2 Fases

| Fase | Objetivo | Entregable | Criterio de salida |
| --- | --- | --- | --- |
| **F0. Reconciliar esquema** | Llevar la copia al schema v31 con el código actual (especialmente si producción está por debajo) | Backup pre-migración + `schema_migrations=31` | `integrity_check=ok`, `foreign_key_check` vacío, `defaults`/triggers presentes, arranque en seco con `CONFIRM_REAL_TRADING=false` |
| **F1. Preparar destino** | PostgreSQL por servicio, roles, extensiones, migraciones de esquema, secuencias | DDL versionado del destino | Esquema idéntico al inventario de 2.3; constraints de 2.5; roles sin UPDATE/DELETE en `config_revisions`/`audit_log` |
| **F2. Export** | Exportar cada tabla con orden estable y tipos canónicos | Ficheros CSV/JSONL + `manifest.sha256` + conteos | Export idempotente; hashes por tabla; sin valores sensibles en logs |
| **F3. Transform + load** | Cargar en destino con `COPY`, preservando ids y secuencias | Base destino cargada | `setval` correcto; constraints validados (`NOT VALID` + `VALIDATE` si hace falta) |
| **F4. Verificación** | Comprobar 6.5 completo | Informe de verificación firmado | 100 % de checks en verde; 0 diferencias de dinero |
| **F5. Ensayo en staging** | Repetir F2–F4 con copia de producción, medir tiempos y ensayar rollback | Runbook cronometrado | Dos ensayos consecutivos sin diferencias; ventana medida |
| **F6. Cutover** | Congelación, delta final, cambio de tráfico, smoke tests | Producción sobre PostgreSQL | Checks de 6.5 sobre datos de cutover + operación real pequeña verificada |
| **F7. Post-cutover** | Operación y conciliación | SQLite read-only conservada 14 días; libro de incidencias | 72 h sin discrepancias; rollback disponible y probado |

### 6.3 Ventana de congelación

1. Anunciar ventana; activar **parada de emergencia** y pausar automatización.
2. Esperar a que no haya mutaciones `submitted`/`uncertain` ni workflows activos; si las hay, **no congelar**: resolverlas primero. (El snapshot local tiene 2 workflows `apply_uncertain` y 2 reservas activas; en producción hay que decidir si se congelan y migran tal cual o se resuelven antes. Recomendado: migrarlas tal cual y verificar que la lista de recuperación coincide.)
3. Parar el proceso (`systemctl --user stop qvaapply` o `docker stop`), que ya vacía el WAL por el shutdown ordenado.
4. `sqlite3 data/qvaapply.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"` y `.backup` final; calcular `sha256sum` del fichero y guardarlo con el manifiesto.
5. Export final y delta (6.4), load, verificación (6.5).
6. Cambiar el flag de almacenamiento del runtime a PostgreSQL (variable de entorno), arrancar, ejecutar smoke tests: `/api/session`, Auditoría → Salud e integridad, lista de recuperación, saldos, reservas, operaciones.
7. **No borrar ni modificar** el SQLite: se conserva read-only 14 días como rollback.

Duración estimada con el volumen local (25,9 MB, 41 tablas): export + load + verificación automatizada en minutos. En producción el tiempo lo dominará `config_revisions`; si no se compacta antes, el dump puede ser varias veces mayor. Medir en F5.

### 6.4 Delta y tablas difíciles

- **Tablas append-only** (`audit_log`, `fiat_ledger`, `fiat_balance_history`, `decision_events`, `market_observations`, `notification_events`, `chat_push_events`): delta por `id`/`created_at` desde el corte de la copia.
- **Tablas mutables con `updated_at`** (`operations`, `mutation_intents`, `trade_workflows`, `workflow_own_offers`, `payment_receipts`, `market_config`…): delta por `updated_at` y, para mayor seguridad, re-lectura completa de las filas con estado no terminal.
- **Tablas sin `updated_at`** (`capital_reservations`, `application_capital_reservations`, `settings`, `fiat_accounts`, `payment_details`): recarga completa en la ventana final; son pequeñas.
- **Borrados duros:** `saveTradingConfig` hace `DELETE FROM payment_details/fiat_accounts/market_config` y reinserta (`src/store.ts:1198-1233`); `pruneChatData` borra hilos/eventos antiguos (`src/store.ts:2194-2203`); `application_capital_reservations` se borra por trigger. El delta debe manejar tombstones o hacer snapshot completo de esas tablas en la ventana.
- **`config_revisions`:** cargar el histórico completo una vez; decidir política de retención/compacción (R10). No cargarla dos veces con estrategias distintas.

### 6.5 Verificación (criterios de aceptación)

**A. Conteos y hashes**

- Conteo por tabla en origen y destino; diferencia 0 (para tablas con delta, contar en el punto de congelación final).
- Hash canónico por tabla: ordenar por PK, serializar campos en orden fijo, `sha256` del stream; comparar origen y destino. Para `REAL` de dinero, el hash se calcula **después** de canonicalizar a 8 decimales.

**B. Dinero (bloqueantes)**

```sql
-- 1) Sumas del ledger por moneda y dirección (origen SQLite con printf('%.8f');
--    destino PostgreSQL con SUM(amount::numeric))
SELECT coin, direction, COUNT(*), SUM(amount) FROM fiat_ledger GROUP BY coin, direction;

-- 2) Saldo autoritativo vs último historial vs proyecciones
SELECT key, value FROM settings WHERE key LIKE 'fiat_balance:%';
SELECT coin, balance_after FROM fiat_balance_history h
 WHERE id = (SELECT MAX(id) FROM fiat_balance_history WHERE coin = h.coin);
SELECT code, fiat_balance FROM market_config;
SELECT market_code, declared_balance FROM fiat_accounts;

-- 3) Reservas: suma activa por activo/mercado
SELECT asset, market_code, SUM(amount) FROM capital_reservations WHERE state='active' GROUP BY 1,2;
SELECT coin, SUM(fiat), SUM(qusd), COUNT(*) FROM application_capital_reservations GROUP BY coin;

-- 4) Idempotencia e integridad del ledger
SELECT operation_uuid, direction, COUNT(*) FROM fiat_ledger GROUP BY 1,2 HAVING COUNT(*) > 1; -- debe ser vacío
SELECT COUNT(*) FROM fiat_ledger l WHERE NOT EXISTS (SELECT 1 FROM operations o WHERE o.uuid = l.operation_uuid)
  AND l.operation_uuid NOT LIKE 'cooperative:%'; -- revisar: backfills históricos pueden no tener operación

-- 5) Intenciones y workflows no resueltos (deben coincidir exactamente con origen)
SELECT state, COUNT(*) FROM mutation_intents GROUP BY state;
SELECT state, COUNT(*) FROM trade_workflows GROUP BY state;
SELECT COUNT(*) FROM mutation_intents WHERE state IN ('submitted','uncertain');
SELECT COUNT(*) FROM application_capital_reservations;
```

**C. Configuración (bloqueante)**

- Recalcular en destino la cadena SHA-256 completa de `config_revisions` (misma función `previous_hash` + `hash`) y comparar el hash de la última fila con el origen.
- `SELECT version FROM config_integrity_epoch WHERE id=1` igual en origen y destino.
- `COUNT(*)`, `MIN/MAX(created_at)` y `SUM(length(config_json))` de `config_revisions` iguales.
- Verificar que las 5 monedas (`BANK_CUP`, `BANDECPREPAGO`, `CLASICA`, `ETECSA`, `ZELLE`) y sus tasas/límites/fees coinciden campo a campo (comparación decimal).

**D. Estados y catálogos**

- Distribución de estados idéntica (en el snapshot: `operations` 7 `cancelled` + 3 `completed`; `trade_workflows` 9 `applied` + 2 `apply_uncertain`; `capital_reservations` 2 `active` + 9 `released`; `mutation_intents` 14 `confirmed` + 6 `rejected` + 1 `reconciled`; `notification_events` 340 `blocked-offer` + 10 `operation-applied` + 2 `rebalance-completed`).
- `settings` sin pérdida: comparar el conjunto de claves y el conteo por prefijo (sin volcar valores).
- Índices/constraints presentes: comparar `pg_indexes`/`pg_constraint` con la lista de 2.5.

**E. Cifrado**

- `qvapay_token`, `cooperative_sync_token`, `market_feed_secret`, `market_feed_app_id`, `market_feed_app_secret`, `market_reader_accounts.encrypted_token` presentes y con formato `iv.tag.data`; descifrar una muestra en staging con la clave nueva para probar el KMS.

**F. Humo funcional**

- `GET /api/session`, panel, Auditoría → Salud e integridad, lista de recuperación, `/recovery`, una operación de lectura de saldo, un escaneo sin aplicación, y (solo si se autoriza) una operación real pequeña con conciliación verificada.

### 6.6 Rollback

- **Criterio de aborto:** cualquier diferencia de dinero (B), cualquier diferencia de cadena de configuración (C), o smoke test fallido. Se decide antes de retirar SQLite.
- **Mecanismo:** restaurar el release anterior con `DATA_DIR` apuntando al SQLite congelado (que nunca se modificó), reactivar trading solo tras conciliar con QvaPay. No se hace *reverse migration* de PostgreSQL a SQLite si ya hubo escrituras en destino: se resuelve hacia delante o se repite el cutover desde el snapshot.
- **Conservación:** SQLite + backups + manifiesto durante al menos 14 días (alineado con la retención actual, `scripts/backup-vps.sh`), y copia externa cifrada.

---

## 7. Riesgos concretos

| ID | Riesgo | Severidad | Detalle / mitigación |
| --- | --- | --- | --- |
| **R1** | Doble gasto al separar operación del ledger | Crítica | `operations` y `fiat_ledger` deben compartir transacción o el flujo debe rehacerse como saga con reserva y reconciliación. Prohibida la partición en fase 1 (3.4) |
| **R2** | Reservas huérfanas | Crítica | `application_capital_reservations` depende de la intención (trigger) y de la operación (`createOperation`). Si se separan, hay que añadir job de expiración con evidencia y nunca liberar sin conciliar |
| **R3** | Carrera en el tope de capital | Crítica | `reserveQusd` es un `leer suma + insertar` seguro solo por `BEGIN IMMEDIATE` y escritor único. En PostgreSQL: `SELECT … FOR UPDATE`/`SERIALIZABLE` sobre el contador de reservas o una fila de cuenta |
| **R4** | Dinero en `REAL`/float | Alta | Más de 40 columnas y JSON. Migrar a `NUMERIC(24,8)` con canonicalización; pruebas de equivalencia con las sumas conocidas (5.4) |
| **R5** | Cuádruple representación de saldo | Alta | `settings` autoritativo + 2 proyecciones + historial. Definir una sola autoridad (libro + saldo materializado) y tratar el resto como proyecciones reconstruibles |
| **R6** | Rotura de la cadena de configuración | Alta | `config_revisions`+`config_integrity_epoch` deben compartir base/transacción; conservar triggers y recalcular cadena en la verificación |
| **R7** | Secretos cifrados y rotación de clave | Alta | `LOCAL_ENCRYPTION_KEY` (`src/config.ts:55`, `src/vault.ts`) descifra tokens de QvaPay/Sync/feed. Plan: transportar ciphertext, re-cifrar con KMS en destino, probar descifrado en staging, documentar rotación (`docs/OPERATIONS.md:110-118`) |
| **R8** | Drift de esquema (snapshot v16 vs código v31) | Alta | Migrar primero a v31 con el código actual y verificar triggers/backfills; el snapshot local no ha pasado por v17–v31 |
| **R9** | `config_revisions` domina volumen y tiempo | Alta | 85 % del tamaño; decidir compacción/retención antes de F2 o el dump se vuelve el evento principal |
| **R10** | `settings` como esquema implícito | Alta | Desnormalizar antes de la migración; un KV compartido entre servicios reintroduce acoplamiento distribuido |
| **R11** | Referencias lógicas sin FK | Media | Solo 6 FKs reales; el resto son TEXT. Verificación de huérfanos explícita y validación de aplicación en destino |
| **R12** | Dedupe de feed entre servicios | Media | `event_key` = llave de idempotencia del comando; debe viajar en el mensaje y persistirse en inbox del consumidor |
| **R13** | Entrega de avisos/chat duplicada o perdida | Media | At-least-once ya es el comportamiento; preservar dedupe por id determinista y por canal |
| **R14** | Semántica temporal | Media | Epoch ms, `occurredAt` histórico vs saldo declarado, backfill de ledger (`src/store.ts:2238-2243`), ventanas de 60 s del transporte. Mantener BIGINT canónico y probar comparaciones |
| **R15** | Serialización en memoria no replicada | Media | `operationActionsInFlight`, colas del scheduler y gates de decisión desaparecen con múltiples procesos. Sustituir por locks de base o partición por `offer_uuid` |
| **R16** | Backup/restore no probado | Media | Existe backup diario y runbook, pero el RTO/RPO no está medido. En PostgreSQL añadir PITR, restauración trimestral y copia externa cifrada |
| **R17** | Migración con intenciones/workflows pendientes | Media | El snapshot tiene 2 workflows `apply_uncertain` y 2 reservas activas. Congelar sin resolver y verificar que la lista de recuperación se reproduce; nunca "limpiar" estados para migrar |
| **R18** | `scheduled_actions` y tablas vestigiales | Baja | Retirar del mapa de migración o marcarlas como no migrables (no se usan) |
| **R19** | Rollback imposible tras escrituras en destino | Media | Congelar, verificar y no abrir tráfico hasta F4/F5; conservar SQLite intacto; decidir antes de retirar el release anterior |
| **R20** | Auditoría como cuello de botella | Baja/Media | Centralizar por outbox; el `audit` no debe estar en la transacción crítica de dinero ni perder eventos |

---

## 8. Acciones recomendadas para el plan maestro

**Bloqueantes antes de escribir el destino:**

1. **Congelar el modelo de dinero:** definir `NUMERIC(24,8)` como escala canónica, elegir librería decimal por lenguaje y escribir vectores de equivalencia con `roundQusd`/`roundDecimal`. Sin esto, la migración no es verificable.
2. **Resolver `config_revisions`:** política de retención/compacción y formato de verificación de cadena. Es el 85 % del peso.
3. **Definir la autoridad única de saldo:** ledger + saldo materializado; `market_config`/`fiat_accounts` como proyecciones; `settings.fiat_balance:*` desnormalizado a tabla tipada.
4. **Reproducir el snapshot local a v31 y ensayar F2–F4** sobre él (es barato y detecta sorpresas de v17–v31).
5. **Diseñar el contrato de `money-core`** (comandos idempotentes, inbox/outbox, locks) antes de proponer cualquier partición.

**Puede ir en paralelo (bajo riesgo):**

6. Extraer `analytics` (reconstruible) y `notifier`/`chat` (derivados) con outbox.
7. Extraer `market-ingest` manteniendo `event_key` como idempotencia.
8. Centralizar `audit` con outbox y cursor `BIGINT`.

**Decisiones que necesitan al propietario:**

9. RPO/RTO aceptables y ventana de mantenimiento (afecta a PITR, replicación y coste).
10. Si se acepta compactar el historial de configuración (hoy es evidencia de integridad; comprimir no debe romper la cadena).
11. Si la migración se hace con `money-core` + `config-registry` en **una sola instancia PostgreSQL con dos bases**, o con dos instancias (recomendado: una instancia, dos bases, sin transacciones cruzadas).
12. Política de secretos: KMS externo vs clave local replicada; quién rota y cuándo.

---

## Anexo A — Líneas de código citadas

| Tema | Referencia |
| --- | --- |
| Versión de esquema y constructor | `src/store.ts:23`, `src/store.ts:350-377` |
| PRAGMAs, backup previo, migración | `src/store.ts:361-364`, `src/store.ts:1732-1744` |
| Reparación de arranque de intenciones | `src/store.ts:367-369` |
| Transacción `BEGIN IMMEDIATE` | `src/store.ts:1746-1756` |
| Migraciones y triggers | `src/store.ts:379-991`, `898-948` |
| Intención + reserva de aplicación | `src/store.ts:1306-1335` |
| CAS de resolución manual | `src/store.ts:1404-1433` |
| Workflows y snapshots | `src/store.ts:1481-1515` |
| Reserva QUSD con tope | `src/store.ts:1614-1635` |
| Ledger fiat y saldos | `src/store.ts:2215-2264` |
| Reparto cooperativo atómico | `src/store.ts:2272-2311` |
| Creación de operación y limpieza de reserva | `src/store.ts:2509-2544` |
| Recibos SMS (claim/defer) | `src/store.ts:2684-2733` |
| Configuración + revisión encadenada | `src/store.ts:1122-1236`, `src/store.ts:1273-1304` |
| Notificaciones y resúmenes | `src/store.ts:3058-3094` |
| Caché de saldo QUSD | `src/qusd-balance-cache.ts:1-115`, `src/trading.ts:136` |
| Protocolo de intención monetaria | `src/application/monetary-intents.ts:43-106` |
| Reconciliación con backoff persistido | `src/reconciliation-scheduler.ts:1-79` |
| Recuperación manual | `src/self-service-recovery.ts:93-330` |
| Proyección de feed → ledger | `src/trading.ts:1441-1456` |
| `syncFiatFromQva` | `src/trading.ts:2427-2544` |
| `markPaid` / `confirmReceived` | `src/trading.ts:2126-2200` |
| Cadena de integridad | `src/config-integrity.ts:13-43`, `src/config-integrity-monitor.ts:22-60` |
| Cifrado AES-256-GCM | `src/vault.ts:14-38`, `src/config.ts:55` |
| Secretos cifrados en `settings` | `src/session.ts:23`, `src/hunting-sync.ts:558`, `src/market-feed.ts:106-118` |
| Overlay de saldo en config | `src/market-config.ts:102-110`, `src/market-config.ts:169-192` |
| Schedulers | `src/index.ts:533-600` |
| Backup/restore operativo | `scripts/backup-vps.sh`, `docs/OPERATIONS.md:94-108`, `docs/VPS.md:124-126` |
| Tests de referencia | `test/repository.test.ts:28-33`, `386-402`, `541-611`; `test/config-integrity-performance.test.ts:38-49` |

## Anexo B — Manifiesto de verificación sugerido

```text
migration/
  manifest.json            # versión origen (v31), timestamp de congelación, sha256 del sqlite
  counts.csv               # tabla, filas_origen, filas_destino, delta
  hashes.csv               # tabla, sha256_canonico_origen, sha256_canonico_destino
  money-sums.csv           # coin, direction, sum_origen, sum_destino (8 decimales)
  balances.csv             # coin, settings, historial, market_config, fiat_accounts
  reservations.csv         # asset, market, sum_active, count
  config-chain.txt         # último hash, epoch, filas, rango temporal
  orphans.txt              # intenciones sin operación, ledger sin operación, reservas sin intención
  encrypted-secrets.txt    # claves presentes, longitudes, formato; sin valores
  smoke-tests.txt          # salida de /api/session, salud e integridad, recuperación
```

Este manifiesto es el contrato de aceptación de la migración: si un solo archivo no cuadra, el cutover no se aprueba.
