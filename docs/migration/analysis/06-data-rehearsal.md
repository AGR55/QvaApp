# 06 — Ensayo de datos F0: migración SQLite v16 → v31 y manifiesto para F5

**Proyecto:** QvaApply · **Fase:** F0 (validación de datos) · **Base:** copia de `data/qvaapply.sqlite`  
**Estado:** ensayo ejecutado y reproducible. **Resultado: PASS (33/33 checks), sin errores.**  
**Contexto:** el plan de migración aprobado es Go + PostgreSQL. Antes de diseñar el dump definitivo hay que demostrar que el snapshot v16 migra a v31 sin pérdida ni corrupción con el código actual.

---

## 0. Resumen ejecutivo

| Pregunta | Respuesta |
| --- | --- |
| ¿Migró sin errores? | **Sí.** `Store` abrió la copia v16, creó el backup previo y aplicó v17–v31 en una transacción. `schemaVersion()` devolvió 31 y `verifyConfigRevisionChain()` devolvió `true`. |
| Tiempo | **≈70–185 ms** para abrir + backup + migrar una copia de 25,9 MB (dos corridas consecutivas: **139,5 ms** y **72,2 ms**; total del script 0,33–0,39 s). La varianza es caché de página del sistema, no del código. |
| Backups | **1** backup automático: `data/backups/qvaapply-before-v31-<timestamp>.sqlite`, 25.874.432 bytes, **sha256 idéntico al origen** (la base de origen no tenía frames en WAL). |
| Conteos clave antes/después | Sin pérdida: 26/26 tablas preexistentes con el mismo conteo. Solo cambian las tablas internas nuevas y los backfills previstos (ver 5.3). |
| Integridad | `integrity_check=ok`, `foreign_keys=0` violaciones, 41 tablas, 32 índices, 6 triggers, `journal_mode=wal`. |
| Cadena de configuración | Válida antes y después, 5.416 revisiones, mismo `lastId=5416` y mismo hash `d3489051…f52991`, `config_integrity_epoch=0`. |
| Dinero | Las 7 agrupaciones de `fiat_ledger` (coin + direction) suman **exactamente igual a 8 decimales**. El drift binario de `REAL` existe, pero no alcanza el quanto canónico de 1e-8 en estos datos. |
| Tamaño | 25.874.432 → 26.517.504 bytes (**+643.072, +2,49 %**), por las 14 tablas y 21 índices nuevos. `config_revisions` baja del 85,5 % al **83,5 %** del total solo porque el denominador crece. |
| Dato más relevante para F5 | El snapshot tiene **estado no resuelto** (2 workflows `apply_uncertain`, 2 reservas activas, 2 ofertas en `restore_requested`) que la migración **preserva tal cual**. F5 debe reproducirlo, no limpiarlo. |
| Reproducible | `node --import tsx tools/db-rehearsal/rehearse.mjs`. Exit `0` solo si pasan los 33 checks. |

---

## 1. Alcance, reglas y método

- Se trabajó **solo sobre copias**: `cp data/qvaapply.sqlite /tmp/...`; la original
  no se abrió con SQLite (el script calcula su `sha256` antes y después:
  `573f6767…79c5c8`, sin cambios).
- No se modificó `data/`, `src/` ni `test/`. Las únicas escrituras del análisis
  fueron `docs/migration/analysis/06-data-rehearsal.md` y `tools/db-rehearsal/`.
- La migración se ejecutó con **la clase `Store` actual** (`src/store.ts`), no con
  una reimplementación: es exactamente el código que arranca en producción
  (`src/index.ts:50`, `LATEST_SCHEMA_VERSION=31` en `src/store.ts:23`).
- No se volcaron filas ni valores sensibles: solo estructura, conteos, sumas
  agregadas por moneda/dirección y hashes/digests.
- No se ejecutaron deploys, servidor ni procesos largos.

**Fuentes de referencia:** el inventario y el plan de datos están en
[`02-persistence.md`](02-persistence.md). Este documento se centra en la
evidencia del ensayo y en el manifiesto reutilizable.

---

## 2. Comando reproducible

```bash
# Desde la raíz del repo. Requiere Node 25.9 y tsx (dependencias instaladas).
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --json /tmp/qvaapply-f0-manifest.json --clean
```

- `--source` permite apuntar a otra copia (por ejemplo, una copia de producción
  para F5).
- El script exige que el origen esté **por debajo de v31**; si ya está en v31
  aborta con código 2 (ese caso no es el camino v16→v31).
- Códigos de salida: `0` = PASS, `1` = algún check falló (el manifiesto lista
  `checks.failures`), `2` = error de entorno/uso.
- Detalle de opciones, checks y garantías en
  [`tools/db-rehearsal/README.md`](../../../tools/db-rehearsal/README.md).

---

## 3. Línea base (copia v16, antes de migrar)

| Propiedad | Valor |
| --- | --- |
| `journal_mode` | `wal` |
| `page_size` / `page_count` | 4.096 / 6.317 |
| `freelist_count` | 33 páginas |
| `user_version` | 0 (el versionado va en `schema_migrations`) |
| `integrity_check` | `ok` |
| `schema_migrations` | 16 filas, `MAX(version)=16` |
| Tablas / índices / triggers | 27 / 11 / 0 |
| Tamaño del fichero | 25.874.432 bytes |
| Cadena de config | válida, 5.416 filas, `lastId=5416`, hash `d3489051…f52991` |
| `foreign_key_check` | 0 violaciones |
| Claves `fiat_balance:*` | 5 (BANK_CUP, BANDECPREPAGO, CLASICA, ETECSA, ZELLE) |
| `settings` | 231 claves, digest `69090e8f…c56000` |
| Saldos fiat | 5 claves, digest `dfb655fd…cdecda` |

**Conteos de filas por tabla (27 preexistentes):**

| Tabla | Filas | Tabla | Filas |
| --- | ---: | --- | ---: |
| `audit_log` | 6.176 | `market_feed_events` | 0 |
| `bot_config` | 1 | `market_observations` | 3.166 |
| `capital_rebalance_jobs` | 2 | `market_reader_accounts` | 0 |
| `capital_reservations` | 11 | `mutation_intents` | 21 |
| `config_revisions` | 5.416 | `notification_events` | 352 |
| `dashboard_snapshots` | 661 | `operations` | 10 |
| `decision_events` | 237 | `payment_details` | 1 |
| `fiat_accounts` | 5 | `remote_resource_cache` | 9 |
| `fiat_ledger` | 71 | `risk_config` | 1 |
| `market_config` | 5 | `scheduled_actions` | 0 |
| `schema_migrations` | 16 | `seen_offers` | 21 |
| `settings` | 231 | `trade_workflows` | 11 |
| `trading_alerts` | 84 | `trading_config` | 1 |
| `workflow_own_offers` | 2 | | |

**Tamaños por tabla (top, `dbstat`):**

| Objeto | Bytes | % del total |
| --- | ---: | ---: |
| `config_revisions` | 22.130.688 | 85,5 % |
| `decision_events` | 909.312 | 3,5 % |
| `audit_log` | 880.640 | 3,4 % |
| `sqlite_autoindex_config_revisions_1` | 450.560 | 1,7 % |
| `remote_resource_cache` | 385.024 | 1,5 % |
| `notification_events` | 290.816 | 1,1 % |
| `market_observations` | 212.992 | 0,8 % |
| resto (preexistentes) | ≈600 KB | 2,4 % |

**Sumas canónicas del ledger fiat (línea base, decimal a 8 dp construido fila a fila con `printf('%.8f', amount)`):**

| Coin | Direction | Suma canónica |
| --- | --- | --- |
| `BANK_CUP` | credit | 173110.00000000 |
| `BANK_CUP` | debit | 42187.00000000 |
| `CLASICA` | credit | 1244.10000000 |
| `CLASICA` | debit | 635.29981623 |
| `ETECSA` | credit | 52180.00000000 |
| `ETECSA` | debit | 41995.00000000 |
| `ZELLE` | debit | 20.00000000 |

---

## 4. Migración v16 → v31

### 4.1 Cómo se ejecutó

1. Copia del fichero (y de `-wal`/`-shm` si existieran) a `/tmp/<workdir>/data/`.
2. `new Store(<workdir>/data)`. El constructor hace, en este orden:
   - `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` (`src/store.ts:361`);
   - detecta `schemaVersion=16 < 31` y crea el backup previo con
     `PRAGMA wal_checkpoint(TRUNCATE)` + copia a `data/backups/`
     (`src/store.ts:362-363`, `src/store.ts:1732-1744`);
   - ejecuta `migrate()` completo dentro de **una sola transacción**
     (`src/store.ts:379-991`);
   - aplica la reparación de arranque de intenciones `confirmed` con reserva de
     aplicación (`src/store.ts:367-369`), que aquí es un **no-op** porque
     `application_capital_reservations` acaba de crearse vacía;
   - crea 4 índices de runtime con `IF NOT EXISTS` (`src/store.ts:370-376`).
3. `store.schemaVersion()` y `store.verifyConfigRevisionChain()` antes de cerrar.

### 4.2 Resultado y tiempos

| Corrida | Abrir + backup + migrar | Script completo | Resultado |
| --- | ---: | ---: | --- |
| 1 (caché fría) | 139,5 ms | 385,6 ms | PASS 33/33 |
| 2 (caché caliente) | 72,2 ms | 326,8 ms | PASS 33/33 |
| Referencia adicional | 160,5 / 183,5 / 99,6 ms | 357–478 ms | PASS 33/33 |

- **Errores/excepciones durante la migración: ninguno.**
- El script verifica la **determinación**: los conteos, sumas y columnas nuevas
  son idénticos entre corridas.
- El tiempo incluye copiar el backup de 25,9 MB (I/O dominante en esta base). En
  producción, con `config_revisions` mayor, habrá que medirlo otra vez; la
  migración en sí es lineal en filas de las tablas afectadas.

### 4.3 Backup automático

| Propiedad | Valor |
| --- | --- |
| Nombre | `qvaapply-before-v31-2026-11-12T21-16-52-527Z.sqlite` |
| Ruta | `<workdir>/data/backups/` |
| Tamaño | 25.874.432 bytes |
| `sha256` | `573f67670ddfebd3d6a0858374a197eaaa033d22c90c3db8b9935bd77779c5c8` |
| Comparación con el origen | **byte-idéntico** (el origen no tenía frames en WAL; si los tuviera, el backup sería el estado lógico tras checkpoint) |

**Implicación operativa:** una migración de una base de 25,9 MB requiere
≈26 MB adicionales libres en el directorio de datos. Es un backup que convive con
los backups diarios (14 días de retención, `scripts/backup-vps.sh`).

### 4.4 Qué migraciones se ejecutaron realmente

El snapshot ya estaba en v16, así que corrieron **v17–v31** (las v1–v16 ya se
habían aplicado cuando la base llegó a v16):

| Versión | Efecto en estos datos |
| --- | --- |
| v17 | 3 índices (`dashboard_snapshots`, `market_observations`). |
| v18 | Columna `mutation_intents.workflow_id`, backfill desde `request_json` (15 filas) y 1 índice. |
| v19–v21 | Tablas `sms_devices`, `payment_receipts` (vacías) y columnas de recibo (`retry_attempts`, `next_attempt_at`, `market`, `recipient_phone`, `receipt_kind`). |
| v22 | `manual_cancel_exclusions` + backfill desde `audit_log` (**1 fila**). |
| v23–v25 | Tablas `analytics_transactions`, `analytics_offers`, `portfolio_snapshots` (+ `liability_qusd`); vacías. |
| v26 | Columna `operations.order_uuid` (sin backfill; 10 operaciones quedan con `NULL`). |
| v27 | `config_integrity_epoch` + **3 triggers** de manipulación (epoch inicial 0). |
| v28 | `application_capital_reservations` + **trigger** de liberación (vacía). |
| v29 | `fiat_balance_history` + **2 triggers** + backfill de saldos declarados (**5 filas `opening`**) + 4 índices. |
| v30 | `analytics_fee_evidence` + 2 índices parciales. |
| v31 | `chat_threads`, `chat_push_devices`, `chat_push_events`, `chat_push_deliveries` + 3 índices; vacías. |

No hubo warnings ni errores impresos por `Store`. El único cambio de datos no
estructural fue el backfill de `workflow_id` (15 de 21 intenciones).

---

## 5. Verificación post-migración

### 5.1 Checks ejecutados (33/33 PASS)

| Grupo | Checks |
| --- | --- |
| Origen inmutable | `source_sha256_unchanged_at_start`, `source_sha256_unchanged_at_end` |
| Línea base | `baseline_integrity_ok`, `baseline_config_chain_valid` |
| Migración y backup | `migration_no_error`, `backup_created_once`, `backup_named_before_v31`, `backup_byte_identical_to_source` |
| Esquema | `post_schema_is_31`, `schema_migrations_31_rows` (versiones 1..31 contiguas), `post_tables_41`, `post_indexes_32`, `post_triggers_6`, `new_tables_present`, `reference_objects_match` (contra una base v31 recién creada: 0 diferencias) |
| Integridad física | `post_integrity_ok`, `post_journal_mode_wal`, `post_foreign_keys_clean` |
| Datos | `key_table_counts_preserved` (26/26), `expected_fiat_balance_history` (5=5), `expected_manual_cancel_exclusions` (1=1), `workflow_id_backfill_exact`, `vip_decision_backfill_exact`, `vip_alert_backfill_exact` |
| Configuración | `config_integrity_epoch_present`, `config_chain_still_valid`, `config_chain_head_unchanged`, `config_epoch_created_at_zero`, `chain_verified_by_store_class` |
| Dinero | `money_ledger_sums_equal_8dp` (7/7 grupos), `settings_balances_digest_equal`, `settings_keys_digest_equal`, `fiat_ledger_still_unique` |

### 5.2 Esquema post-migración

| Propiedad | Antes | Después |
| --- | ---: | ---: |
| `schema_migrations` (max) | 16 | **31** |
| Filas en `schema_migrations` | 16 | 31 |
| Tablas | 27 | **41** |
| Índices | 11 | **32** |
| Triggers | 0 | **6** |
| `integrity_check` | ok | **ok** |
| Violaciones FK | 0 | **0** |
| `journal_mode` | wal | **wal** |
| `config_integrity_epoch` | — | **0** |
| Fichero | 25.874.432 B | **26.517.504 B** (+2,49 %) |
| Peso `config_revisions` | 22.130.688 B (85,5 %) | 22.130.688 B (**83,5 %** del nuevo total) |

Los 6 triggers son: `config_integrity_update/delete/insert`,
`application_reservation_resolved`, `fiat_history_insert`, `fiat_history_update`.

El conjunto de tablas/índices/triggers se comparó contra una base v31 recién
creada por el mismo `Store`: **coincidencia exacta, sin objetos de más ni de
menos**.

### 5.3 Conteos antes/después (todas las 41 tablas)

| Tabla | v16 | v31 | Δ |
| --- | ---: | ---: | --- |
| `analytics_fee_evidence` | — | 0 | nueva, vacía |
| `analytics_offers` | — | 0 | nueva, vacía |
| `analytics_transactions` | — | 0 | nueva, vacía |
| `application_capital_reservations` | — | 0 | nueva, vacía |
| `audit_log` | 6.176 | 6.176 | 0 |
| `bot_config` | 1 | 1 | 0 |
| `capital_rebalance_jobs` | 2 | 2 | 0 |
| `capital_reservations` | 11 | 11 | 0 |
| `chat_push_deliveries` | — | 0 | nueva, vacía |
| `chat_push_devices` | — | 0 | nueva, vacía |
| `chat_push_events` | — | 0 | nueva, vacía |
| `chat_threads` | — | 0 | nueva, vacía |
| `config_integrity_epoch` | — | 1 | nueva (singleton) |
| `config_revisions` | 5.416 | 5.416 | 0 |
| `dashboard_snapshots` | 661 | 661 | 0 |
| `decision_events` | 237 | 237 | 0 |
| `fiat_accounts` | 5 | 5 | 0 |
| `fiat_balance_history` | — | **5** | backfill v29 |
| `fiat_ledger` | 71 | 71 | 0 |
| `manual_cancel_exclusions` | — | **1** | backfill v22 |
| `market_config` | 5 | 5 | 0 |
| `market_feed_events` | 0 | 0 | 0 |
| `market_observations` | 3.166 | 3.166 | 0 |
| `market_reader_accounts` | 0 | 0 | 0 |
| `mutation_intents` | 21 | 21 | 0 (15 con `workflow_id` rellenado) |
| `notification_events` | 352 | 352 | 0 |
| `operations` | 10 | 10 | 0 |
| `payment_details` | 1 | 1 | 0 |
| `payment_receipts` | — | 0 | nueva, vacía |
| `portfolio_snapshots` | — | 0 | nueva, vacía |
| `remote_resource_cache` | 9 | 9 | 0 |
| `risk_config` | 1 | 1 | 0 |
| `scheduled_actions` | 0 | 0 | 0 (vestigial) |
| `schema_migrations` | 16 | 31 | +15 |
| `seen_offers` | 21 | 21 | 0 |
| `settings` | 231 | 231 | 0 (digest idéntico) |
| `sms_devices` | — | 0 | nueva, vacía |
| `trade_workflows` | 11 | 11 | 0 |
| `trading_alerts` | 84 | 84 | 0 |
| `trading_config` | 1 | 1 | 0 |
| `workflow_own_offers` | 2 | 2 | 0 |

### 5.4 Dinero: sumas canónicas y drift de `REAL`

Comparación línea base ↔ post-migración, suma construida fila a fila con
`printf('%.8f', amount)` y agregada en enteros escalados 1e8 (BigInt):

| Coin | Direction | Suma 8 dp (idéntica) | Suma float nativa (17 dígitos) | Δ a 8 dp |
| --- | --- | --- | --- | ---: |
| `BANK_CUP` | credit | 173110.00000000 | 173110.00000000000 | 0.00000000 |
| `BANK_CUP` | debit | 42187.00000000 | 42187.000000000000 | 0.00000000 |
| `CLASICA` | credit | 1244.10000000 | **1244.1000000000001** | 0.00000000 |
| `CLASICA` | debit | 635.29981623 | **635.29981622999992** | 0.00000000 |
| `ETECSA` | credit | 52180.00000000 | 52180.000000000000 | 0.00000000 |
| `ETECSA` | debit | 41995.00000000 | 41995.000000000000 | 0.00000000 |
| `ZELLE` | debit | 20.00000000 | 20.000000000000000 | 0.00000000 |

**Lectura:** el drift binario es real (`CLASICA` crédito = `1244.1000000000001`
en el acumulador double), pero en estos datos **no cruza el quanto canónico de
1e-8**. La migración a `NUMERIC(24,8)` debe canonicalizar cada fila con
`printf('%.8f', amount)` **antes** de sumar; sumar primero en `REAL` y luego
redondear es lo que produce artefactos como el anterior. Es exactamente el
motivo por el que el manifiesto de F5 exige sumas decimales y no `SUM(REAL)`.

### 5.5 Configuración y hashes

| Propiedad | Antes | Después |
| --- | --- | --- |
| Cadena válida | sí | **sí** |
| Filas verificadas | 5.416 | **5.416** |
| `lastId` / `lastHash` | 5416 / `d3489051…f52991` | **idéntico** |
| `config_integrity_epoch` | — | **0** |
| `verifyConfigRevisionChain()` de `Store` | — | **`true`** |
| Digest de claves de `settings` | `69090e8f…c56000` (231) | **idéntico** |
| Digest de saldos `fiat_balance:*` | `dfb655fd…cdecda` (5) | **idéntico** |

El hash de la última revisión y el epoch son los valores de referencia para F5:
si en PostgreSQL la cadena se recalcula y el head no coincide, el destino está
mal cargado. Si el epoch en producción no es 0, hay que investigarlo **antes** de
migrar (indicaría manipulación histórica detectada por los triggers).

### 5.6 Estado no resuelto preservado (crítico para F5)

| Estado | v16 | v31 |
| --- | ---: | ---: |
| `mutation_intents` en `submitted`/`uncertain` | 0 | 0 |
| Intenciones `confirmed` | 14 | 14 |
| Workflows en `apply_uncertain` | 2 | 2 |
| `capital_reservations` activas | 2 | 2 |
| `workflow_own_offers` en `restore_requested` | 2 | 2 |

La migración **no toca** estos estados. Cualquier verificación de F5 debe exigir
que el destino reproduzca exactamente estos conteos; “limpiar” estados para que
la migración parezca ordenada es un fallo grave.

---

## 6. Diferencias y sorpresas observadas

1. **Solo 2 columnas nuevas en tablas preexistentes**: `mutation_intents.workflow_id`
   y `operations.order_uuid`. El resto del delta de esquema son tablas/índices/
   triggers nuevos.
2. **Backfill no trivial de `workflow_id`**: 15 de 21 intenciones tenían el
   `workflowId` en `request_json` y ahora lo tienen también en columna; 6 quedan
   `NULL` (correcto: no tenían workflow). No se pierde ni se inventa relación.
3. **Backfills v22/v29**: `manual_cancel_exclusions` (1 fila, de un `audit_log`
   con acción `cancel`) y `fiat_balance_history` (5 filas `opening`, una por
   clave de saldo). Ambos son derivados y quedaron exactos.
4. **Limpieza “VIP” ya aplicada**: v11 marca como resueltos los eventos con
   “vip” en el motivo; en esta base ya estaba aplicada desde que alcanzó v16, así
   que el delta fue 0. En una base más antigua sí movería filas: el check
   compara contra las filas pendientes antes de migrar.
5. **11 de 14 tablas nuevas quedan vacías**: son features todavía no usadas en
   este snapshot (SMS, chat, analytics, reservas de aplicación, portfolio). No es
   un error; el esquema v31 las exige.
6. **+21 índices** (de 11 a 32), muchos sobre datos históricos; el mayor es
   `idx_audit_offer_action` (282.624 B) seguido de `idx_insights_audit`
   (155.648 B). Crecimiento total del fichero: +643.072 B (+2,49 %).
7. **`config_revisions` sigue dominando**: 22,1 MB, ahora 83,5 % del total
   (antes 85,5 %). El ensayo no lo compacta, a propósito: mide la base real.
8. **`settings` intacto**: 231 claves, mismo conteo y mismos digests de claves y
   saldos. La migración no añade ni borra claves.
9. **`scheduled_actions` sigue vacía y sin uso**; es candidata a no migrar.
10. **`Store` no emitió warnings** durante la migración; el único efecto lateral
    fue el backfill de `workflow_id`.

---

## 7. Manifiesto de verificación para F5

Este es el contrato que F5 debe reproducir en PostgreSQL. Los valores concretos
se recalcularán sobre una copia de producción; la **estructura** de los checks es
la misma.

### 7.1 Manifiesto de referencia (snapshot v16 → v31)

```json
{
  "source_sha256": "573f67670ddfebd3d6a0858374a197eaaa033d22c90c3db8b9935bd77779c5c8",
  "baseline": {
    "schema": 16, "tables": 27, "indexes": 11, "triggers": 0,
    "file_bytes": 25874432, "integrity": "ok",
    "settings_keys_sha256": "69090e8f...c56000", "fiat_balances_sha256": "dfb655fd...cdecda",
    "config_chain_last_hash": "d3489051958dad9c9d1f7957cbfa5d659f4d85d930eca1140de2d1b02bf52991",
    "config_chain_rows": 5416
  },
  "post": {
    "schema": 31, "tables": 41, "indexes": 32, "triggers": 6,
    "file_bytes": 26517504, "integrity": "ok", "fk_violations": 0,
    "config_epoch": 0,
    "config_chain_last_hash": "d3489051958dad9c9d1f7957cbfa5d659f4d85d930eca1140de2d1b02bf52991",
    "fiat_ledger_sums_8dp": {
      "BANK_CUP/credit": "173110.00000000", "BANK_CUP/debit": "42187.00000000",
      "CLASICA/credit": "1244.10000000", "CLASICA/debit": "635.29981623",
      "ETECSA/credit": "52180.00000000", "ETECSA/debit": "41995.00000000",
      "ZELLE/debit": "20.00000000"
    }
  },
  "result": "PASS",
  "checks_total": 33
}
```

### 7.2 Reglas de canonicalización (obligatorias en F5)

1. **Dinero:** exportar desde SQLite con `printf('%.8f', amount)`; cargar en
   PostgreSQL como `NUMERIC(24,8)`; sumar `SUM(amount::numeric)` y comparar la
   representación con 8 decimales. **Nunca** comparar `SUM(REAL)` con
   `SUM(NUMERIC)` sin canonicalizar.
2. **Conteos:** `COUNT(*)` por tabla en el punto de congelación y en destino.
   Delta 0 en tablas preexistentes; en tablas nuevas, el valor esperado se deriva
   del origen (p. ej. `fiat_balance_history = nº de claves fiat_balance:*`).
3. **Hashes:** `sha256` por tabla sobre filas ordenadas por PK y serialización
   canónica de campos; para columnas `REAL` de dinero, hash sobre el texto
   `printf('%.8f')`, no sobre el binario.
4. **Configuración:** recalcular la cadena completa en destino con la misma
   función (`previous_hash` + `hash`) y comparar el head y el número de filas.
5. **Estado no resuelto:** comparar conteos de intenciones no resueltas,
   workflows en `apply_uncertain` y reservas activas. Deben coincidir.

### 7.3 Checks SQL reutilizables

```sql
-- A) Conteos por tabla (bucle sobre sqlite_master / information_schema)
SELECT COUNT(*) FROM "operations";
SELECT COUNT(*) FROM "fiat_ledger";
SELECT COUNT(*) FROM "mutation_intents";
SELECT COUNT(*) FROM "capital_reservations";
SELECT COUNT(*) FROM "trade_workflows";
SELECT COUNT(*) FROM "workflow_own_offers";
SELECT COUNT(*) FROM "config_revisions";
SELECT COUNT(*) FROM "settings";
SELECT COUNT(*) FROM "market_config";
SELECT COUNT(*) FROM "fiat_balance_history";
SELECT COUNT(*) FROM "manual_cancel_exclusions";
SELECT COUNT(*) FROM "config_integrity_epoch";

-- B) Sumas de dinero canónicas (origen SQLite; destino PostgreSQL)
SELECT coin, direction, COUNT(*),
       SUM(CAST(printf('%.8f', amount) AS TEXT))  -- SQLite: usar el script/JS para decimal exacto
  FROM fiat_ledger GROUP BY coin, direction ORDER BY coin, direction;
-- PostgreSQL: SELECT coin, direction, COUNT(*), SUM(amount::numeric(24,8))
--               FROM fiat_ledger GROUP BY 1,2 ORDER BY 1,2;

-- C) Saldos y reservas
SELECT key, value FROM settings WHERE key GLOB 'fiat_balance:*' ORDER BY key; -- comparar por digest
SELECT asset, market_code, SUM(amount), COUNT(*)
  FROM capital_reservations WHERE state='active' GROUP BY 1,2;
SELECT coin, SUM(fiat), SUM(qusd), COUNT(*) FROM application_capital_reservations GROUP BY coin;
SELECT state, COUNT(*) FROM capital_reservations GROUP BY state;
SELECT state, COUNT(*) FROM trade_workflows GROUP BY state;
SELECT state, COUNT(*) FROM workflow_own_offers GROUP BY state;

-- D) Estado no resuelto (debe coincidir exactamente)
SELECT COUNT(*) FROM mutation_intents WHERE state IN ('submitted','uncertain');
SELECT COUNT(*) FROM trade_workflows WHERE state NOT IN ('applied','restored','blocked');
SELECT COUNT(*) FROM capital_reservations WHERE state='active';

-- E) Idempotencia e integridad
SELECT operation_uuid, direction, COUNT(*) FROM fiat_ledger
 GROUP BY 1,2 HAVING COUNT(*) > 1;            -- debe ser vacío
SELECT COUNT(*) FROM fiat_ledger l
 WHERE NOT EXISTS (SELECT 1 FROM operations o WHERE o.uuid=l.operation_uuid)
   AND l.operation_uuid NOT LIKE 'cooperative:%';  -- revisar, no es 0 necesariamente
SELECT COUNT(*) FROM (
  SELECT bank, sender, transaction_id FROM payment_receipts
   GROUP BY 1,2,3 HAVING COUNT(*) > 1);       -- debe ser 0

-- F) Configuración (PostgreSQL): comparar head y filas
SELECT id, hash FROM config_revisions ORDER BY id DESC LIMIT 1;
SELECT COUNT(*) FROM config_revisions;
SELECT version FROM config_integrity_epoch WHERE id=1;
-- y re-verificar la cadena completa en el script de carga (sha256 encadenado)
```

### 7.4 Criterios de aceptación de F5

- Conteos por tabla: delta 0 en preexistentes; derivados exactos en nuevas.
- Sumas de ledger: 0 diferencias a 8 dp en todos los grupos.
- Digests de saldos y claves de `settings`: idénticos.
- Cadena de configuración: válida, mismo head y mismas filas.
- Estado no resuelto: mismos conteos que el origen congelado.
- `integrity`/FK/servicio: sin violaciones; smoke test funcional en verde.
- Cualquier discrepancia detiene el cutover (fail closed).

---

## 8. Riesgos y decisiones abiertas para F0/F5

| # | Riesgo / decisión | Estado y recomendación |
| --- | --- | --- |
| 1 | **Versión real de producción desconocida** | El snapshot del repo es v16; la VPS podría estar en otra versión. Antes de F5, copiar `data/qvaapply.sqlite` de producción y registrar `MAX(schema_migrations)`. Si está entre v17 y v31, el script sigue sirviendo; si ya está en v31, el camino v16→v31 ya no aplica a ese origen. |
| 2 | **Este ensayo es SQLite→SQLite** | Valida el esquema y los backfills, no la carga a PostgreSQL. El manifiesto (7.2–7.4) es lo que se traslada a F5; el script no escribe en Postgres. |
| 3 | **Estado no resuelto** | Hay 2 workflows `apply_uncertain`, 2 reservas activas y 2 ofertas `restore_requested`. Congelar y migrar tal cual; nunca limpiar para “dejar la base ordenada”. Verificar los mismos conteos en destino. |
| 4 | **Volumen de `config_revisions`** | 83,5 % del peso. Decidir en F0 si se compacta/archiva (manteniendo la cadena verificable) antes de F2; el ensayo no lo hace porque debe medir la base real. |
| 5 | **Drift de `REAL`** | Existe (CLASICA credit `1244.1000000000001`) pero no cruza 8 dp en estos datos. F5 debe canonicalizar fila a fila; no confiar en `SUM(REAL)`. |
| 6 | **Espacio en disco** | La migración crea un backup del tamaño de la base (≈26 MB aquí; en producción será mayor). Verificar espacio libre ≥2× el tamaño de la base antes de arrancar. |
| 7 | **Tiempo de ventana** | Este snapshot migra en <0,2 s. En producción el tiempo depende de `config_revisions`; medir en F5 con la copia real antes de fijar la ventana. |
| 8 | **Integridad de configuración** | El epoch post-migración es 0 y la cadena es válida. Si en producción el epoch es ≠0, investigar antes de migrar (evidencia de manipulación histórica). |
| 9 | **Determinación** | Dos corridas produjeron conteos, sumas y columnas nuevas idénticos. Si F5 no es determinista, es señal de un proceso no idempotente o de lectura concurrente; abortar. |
| 10 | **Backup automático y retención** | El backup pre-migración se añade al directorio `backups/` ya rotado a 14 días. Confirmar que la rotación no borre el backup recién creado antes de validar el cutover. |

---

## Anexo A — Objetos de esquema nuevos (v16 → v31)

**Tablas nuevas (14):** `analytics_fee_evidence`, `analytics_offers`,
`analytics_transactions`, `application_capital_reservations`,
`chat_push_deliveries`, `chat_push_devices`, `chat_push_events`,
`chat_threads`, `config_integrity_epoch`, `fiat_balance_history`,
`manual_cancel_exclusions`, `payment_receipts`, `portfolio_snapshots`,
`sms_devices`.

**Columnas nuevas en tablas preexistentes (2):** `mutation_intents.workflow_id`,
`operations.order_uuid`.

**Triggers nuevos (6):** `config_integrity_update`, `config_integrity_delete`,
`config_integrity_insert`, `application_reservation_resolved`,
`fiat_history_insert`, `fiat_history_update`.

**Índices nuevos (21):** `idx_analytics_offers_account_date`,
`idx_analytics_transactions_account_date`, `idx_apply_intent_offer`,
`idx_audit_offer_action`, `idx_chat_push_pending`, `idx_chat_threads_active`,
`idx_chat_threads_updated`, `idx_dashboard_snapshots_created`,
`idx_feed_simulation`, `idx_fiat_history_coin_id`, `idx_fiat_history_created`,
`idx_fiat_ledger_created`, `idx_insights_audit`, `idx_market_feed_offer_uuid`,
`idx_market_observations_coin_created`, `idx_market_observations_created`,
`idx_mutation_intents_unresolved_offer`, `idx_mutation_intents_workflow_state`,
`idx_notification_information`, `idx_payment_receipts_retry`,
`idx_payment_receipts_state_created`.

---

## Anexo B — Cómo se generó este documento

```bash
# 1) Ensayo reproducible sobre copia (nunca sobre data/ directamente)
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --json /tmp/qvaapply-f0-manifest.json --clean

# 2) El script imprime línea base, migración, post-verificación, diferencias,
#    33 checks y el manifiesto JSON. Exit 0 = PASS.
```

Los valores concretos de este documento provienen de dos corridas consecutivas
idénticas (`PASS 33/33`) más una corrida previa de calibración. Cualquier
regresión en el código de `Store`, en los triggers o en el esquema v31 hará
fallar el script y este documento quedará desactualizado: **re-ejecutarlo es
parte de F5**.
