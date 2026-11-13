# tools/db-rehearsal — ensayo de migración SQLite v16 → v31

Script de un solo uso para **F0** (validación de datos) y base del manifiesto de
verificación que se reutilizará en **F5** (migración real a PostgreSQL).

Hace, sobre una **copia** de la base:

1. Línea base: PRAGMAs, `integrity_check`, `schema_migrations`, tablas, índices,
   triggers, conteos y tamaños por tabla, cadena SHA-256 de configuración,
   sumas canónicas del ledger fiat y digests de saldos/claves de `settings`.
2. Migración real v16 → v31 usando la clase `Store` de `src/store.ts` (el mismo
   código que arranca en producción), midiendo tiempo y verificando el backup
   automático previo.
3. Post-verificación: schema v31, 41 tablas, 32 índices, 6 triggers, integridad,
   FKs, conteos sin pérdida, backfills exactos, cadena de configuración,
   sumas de dinero a 8 decimales y unicidad del ledger.
4. Manifiesto JSON con todos los valores observados y el resultado de cada check.

## Requisitos

- Node.js del repo (`.node-version`, actualmente v25.9) con `node:sqlite`.
- Dependencias instaladas (`pnpm install`), en particular `tsx`.
- Opcional: `sqlite3` CLI solo para inspección manual; el script no lo necesita.
- Un fichero SQLite de origen con schema **< v31** (el snapshot del repo está en
  v16). Si el origen ya está en v31 el script aborta con código 2: úsalo solo
  para el ensayo v16→v31.

## Comando reproducible

```bash
# Desde la raíz del repo
node --import tsx tools/db-rehearsal/rehearse.mjs

# Guardar el manifiesto y borrar el directorio temporal
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --json /tmp/qvaapply-f0-manifest.json --clean

# Copia explícita (por ejemplo, una copia de producción para F5)
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --source /tmp/prod-copy/qvaapply.sqlite \
  --workdir /tmp/rehearsal-prod \
  --json /tmp/qvaapply-f0-prod.json
```

## Opciones

| Opción | Descripción |
| --- | --- |
| `--source <ruta>` | Base de origen. Por defecto `data/qvaapply.sqlite`. **Solo se copia; nunca se abre con SQLite.** |
| `--workdir <dir>` | Directorio de trabajo. Por defecto `/tmp/qva-rehearsal-XXXXXX`. Si existe y no está vacío, se añade un sufijo temporal. |
| `--json <ruta>` | Escribe el manifiesto JSON completo. |
| `--keep` | Conserva el workdir (comportamiento por defecto). |
| `--clean` | Borra el workdir al terminar (imprime antes su ruta y resultado). |
| `-h`, `--help` | Ayuda. |

## Salida y códigos de salida

- `0` — **PASS**: los 33 checks pasan.
- `1` — **FAIL**: al menos un check de integridad falló; el manifiesto lista
  `checks.failures`.
- `2` — error de entorno o de uso (falta el fichero, no se importa `tsx`, la base
  de origen no está por debajo de v31, o su `integrity_check`/cadena de
  configuración no son válidos).

El script imprime secciones legibles (`Línea base`, `Migración`, `Post-migración`,
`Diferencias observadas`, `Resultado`) y, al final, el manifiesto JSON completo
entre marcadores `<!-- MANIFEST_JSON ... MANIFEST_JSON -->` para poder capturarlo
desde CI sin depender de `--json`.

## Checks que realiza

| Grupo | Checks |
| --- | --- |
| Origen | `source_sha256_unchanged_at_start`, `source_sha256_unchanged_at_end` |
| Línea base | `baseline_integrity_ok`, `baseline_config_chain_valid` |
| Migración | `migration_no_error`, `backup_created_once`, `backup_named_before_v31`, `backup_byte_identical_to_source` |
| Esquema | `post_schema_is_31`, `schema_migrations_31_rows`, `post_tables_41`, `post_indexes_32`, `post_triggers_6`, `new_tables_present`, `reference_objects_match` |
| Integridad física | `post_integrity_ok`, `post_journal_mode_wal`, `post_foreign_keys_clean` |
| Datos | `key_table_counts_preserved` (26 tablas preexistentes), `expected_fiat_balance_history`, `expected_manual_cancel_exclusions`, `workflow_id_backfill_exact`, `vip_decision_backfill_exact`, `vip_alert_backfill_exact` |
| Configuración | `config_integrity_epoch_present`, `config_chain_still_valid`, `config_chain_head_unchanged`, `config_epoch_created_at_zero`, `chain_verified_by_store_class` |
| Dinero | `money_ledger_sums_equal_8dp`, `settings_balances_digest_equal`, `settings_keys_digest_equal`, `fiat_ledger_still_unique` |

## Seguridad y datos

- El origen se copia con `fs.copyFileSync`; no se abre nunca con SQLite. Se
  calcula su `sha256` antes y después para demostrar que no se modificó.
- Todo el trabajo ocurre en el workdir (`/tmp` por defecto). No se escribe en
  `data/`, `src/` ni `test/`.
- Solo se imprimen estructura, conteos, sumas agregadas y hashes. No se vuelcan
  filas, tokens ni valores de `settings`.
- El manifiesto contiene conteos por tabla, sumas del ledger por moneda/dirección
  (agregados), digests SHA-256 de saldos y la cadena de configuración.

## Relación con F5

El ensayo valida el camino v16→v31 y produce los valores de referencia
(conteos, sumas canónicas, hashes) que F5 debe reproducir en PostgreSQL. Para F5
se reutilizan los checks SQL del documento
[`docs/migration/analysis/06-data-rehearsal.md`](../../docs/migration/analysis/06-data-rehearsal.md),
adaptando el origen a una copia de producción y el destino a PostgreSQL. El
script en sí solo migra SQLite→SQLite; no escribe en Postgres.
