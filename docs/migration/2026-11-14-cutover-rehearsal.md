# Ensayo de cutover y rollback — 2026-11-14

> **Estado: ensayo local ejecutado contra una copia. Producción NO se ha tocado.**
>
> El corte real TS → Go **no se ha ejecutado**. Este documento describe y
> registra un ensayo reproducible de migración de datos y verificación en un
> Postgres temporal. No autoriza el cambio de autoridad, no modifica
> `/opt/qvaapply`, no cambia Nginx ni contenedores y no sustituye los gates
> G4/G5 del [checklist de cutover](2026-11-14-cutover-checklist.md).

## 1. Objetivo y alcance

El ensayo responde a una pregunta concreta: **¿una copia de la SQLite de
producción se puede migrar, importar y verificar en un Postgres limpio sin
tocar el origen?**

- Script: [`scripts/f3-rehearsal.sh`](../../scripts/f3-rehearsal.sh).
- Origen por defecto: `data/qvaapply.sqlite` (snapshot v16 del repositorio).
- Destino: base Postgres temporal creada y destruida por el propio script.
- Resultado esperado: migraciones, importación, invariantes, importes y conteos
  en verde; `sha256` del origen sin cambios.

Lo que **sí** demuestra:

1. La copia SQLite se puede llevar a v31 sin abrir el original con SQLite.
2. El esquema versionado se aplica en un Postgres vacío.
3. El importador reproduce 41 tablas y 16 533 filas con 40 índices y 6 FKs.
4. El auditor de invariantes y la verificación de saldos/ledger/operaciones
   pasan sobre los datos importados.
5. Los conteos por tabla coinciden exactamente con el manifiesto del importador.
6. La limpieza elimina la base y el directorio temporal, salvo que se pida
   conservarlos.

Lo que **no** demuestra: corte real, tráfico real, mutaciones QvaPay, Nginx,
servicios Go, triggers sobre datos importados, backup/PITR, ni un rollback TS
realmente ejecutado. Ver sección 9.

## 2. Garantías y controles del script

| Control | Comportamiento |
| --- | --- |
| Shell estricto | `set -Eeuo pipefail`; cualquier fallo corta el ensayo. |
| Ayuda | `--help` documenta uso, variables, ejemplos y códigos de salida. |
| Origen inmutable | Copia la SQLite y sus `-wal`/`-shm` a un workdir temporal; compara `sha256` antes y después. |
| Producción fuera de alcance | Rechaza rutas bajo `/opt/qvaapply`. |
| Base temporal segura | Exige prefijo `qvaapply_rehearsal_`; la limpieza solo puede borrar bases con ese prefijo. |
| Versión de esquema | Si la copia es < v31, la migra con `tools/db-rehearsal/rehearse.mjs` sobre otra copia; si es v31, la importa directamente. |
| Migraciones | Ejecuta `services/db/migrate.sh` (0001–0014) en la base temporal. |
| Importación | Usa `services/db/import-sqlite-to-postgres.mjs --schema core --replace --manifest`. |
| Auditorías | Ejecuta `services/db/audit-invariants.sh` y `services/db/verify-money.mjs`; si fallan, el script falla. |
| Conteos | Compara tabla a tabla y el total de filas contra `manifest.counts`/`manifest.rows`. |
| Limpieza | `DROP DATABASE` y `rm -rf` del workdir al salir; `KEEP_REHEARSAL=1` o `--keep` los conserva. |
| Sin corte real | No para TS, no arranca Go, no toca Nginx, Dockerfiles, compose ni `/opt/qvaapply`. |

Códigos de salida: `0` ensayo correcto, `1` fallo de migración/auditoría/
verificación/comparación, `2` error de uso o requisito ausente.

## 3. Requisitos

- `bash`, `psql` (cliente 16+), `node` 22+ con `node:sqlite`, `sqlite3` no es
  obligatorio.
- Dependencias del repositorio instaladas (`pnpm install`) si la copia es
  anterior a v31: el ensayo usa `node --import tsx` y `src/store.ts`.
- Un Postgres **de desarrollo o staging**, nunca producción.
- Variables (mismos defaults que `services/db/test-postgres-import.sh`):

| Variable | Default | Uso |
| --- | --- | --- |
| `PGHOST` | `127.0.0.1` | Host de Postgres. |
| `PGPORT` | `5432` | Puerto. |
| `PGUSER` | `postgres` | Usuario. |
| `PGPASSWORD` | — | Contraseña; `psql` la lee del entorno y no se imprime. |
| `PGADMIN_DB` | `postgres` | Base para `CREATE`/`DROP DATABASE`. |
| `KEEP_REHEARSAL` | `0` | `1` conserva base y workdir para inspección. |

Postgres aislado de desarrollo del repositorio:

```bash
docker compose -f services/db/compose.postgres.yaml up -d
# 127.0.0.1:55432 · base/admin qvaapply · usuario qvaapply
# contraseña solo de desarrollo: qvaapply_dev_only
```

## 4. Uso y comandos de ejemplo

```bash
# Ayuda
scripts/f3-rehearsal.sh --help

# Ensayo por defecto contra el Postgres dev aislado
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=qvaapply_dev_only PGADMIN_DB=qvaapply \
  scripts/f3-rehearsal.sh

# Ruta explícita (recomendado: una copia fuera del árbol de producción)
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=qvaapply_dev_only PGADMIN_DB=qvaapply \
  scripts/f3-rehearsal.sh --source /tmp/copia-prod/qvaapply.sqlite

# Nombre de base explícito y evidencia conservada
KEEP_REHEARSAL=1 scripts/f3-rehearsal.sh \
  --source /tmp/copia.sqlite \
  --database qvaapply_rehearsal_20261114

# Argumentos posicionales equivalentes: SQLITE NOMBRE_BD
scripts/f3-rehearsal.sh /tmp/copia.sqlite qvaapply_rehearsal_20261114
```

No se debe copiar la base de producción dentro del repositorio ni ejecutar el
script contra `/opt/qvaapply`. Para un ensayo en la VPS, copiar primero fuera de
`/opt/qvaapply` (por ejemplo `/tmp/qva-rehearsal-src/`) y usar credenciales de
staging.

## 5. Qué hace el script, paso a paso

1. **Valida** argumentos, comandos, ruta de origen, nombre de base y conexión a
   `PGADMIN_DB`.
2. **Copia** la SQLite y sus `-wal`/`-shm` a `/tmp/qva-f3-rehearsal-XXXXXX/`;
   calcula `sha256` del origen antes y después.
3. **Detecta la versión** de `schema_migrations` en la copia. Si es v31, la usa
   directamente. Si es v1–v30, ejecuta el ensayo existente
   `tools/db-rehearsal/rehearse.mjs` sobre la copia y usa su salida v31.
4. **Crea** una base `qvaapply_rehearsal_<UTC>_<pid>` y comprueba que no exista.
5. **Aplica** `services/db/migrate.sh` (0001–0014, registradas en
   `public.qvaapply_schema_migrations`).
6. **Importa** la copia v31 con `import-sqlite-to-postgres.mjs --database
   <temporal> --schema core --replace --manifest <workdir>/import-manifest.json`.
7. **Audita** con `audit-invariants.sh` y **verifica importes** con
   `verify-money.mjs` contra la misma copia.
8. **Compara** los conteos reales de `core` (excluyendo `_import_manifest`) con
   `manifest.counts`, y el total con `manifest.rows`; también comprueba el
   `sha256` del manifiesto.
9. **Limpia** base y workdir al salir, salvo `KEEP_REHEARSAL=1`.

Nota técnica: `--replace` recrea el schema `core`. Por eso este ensayo valida
datos, auditoría e importes, pero **no** valida el comportamiento de los
triggers de `0002_triggers.sql` sobre los datos importados. Esa cobertura está
en `services/db/test-postgres.sh` con fixtures. No se debe confundir con el
procedimiento definitivo de corte (F5).

## 6. Resultado del ensayo local

Ejecutado el **2026-11-14 20:16 UTC** contra el Postgres dev aislado:

- Origen: `data/qvaapply.sqlite`, esquema v16.
- `sha256` del origen:
  `573f67670ddfebd3d6a0858374a197eaaa033d22c90c3db8b9935bd77779c5c8`
  (idéntico antes y después; el origen no se modificó).
- Migración de la copia a v31: `RESULT: PASS (33/33 checks)`.
- Importación: **41 tablas · 16 533 filas · 40 índices · 6 FKs**.
- Auditoría: `audit-invariants: OK`.
- Importes: `verify-money: OK · 5 saldos · 7 grupos de ledger · 10 operaciones`.
- Conteos: **41 tablas · 16 533 filas** en `core`, exactamente igual al
  manifiesto.
- Base temporal y workdir eliminados al terminar.
- Código de salida: `0`.

Salida resumida (los hashes de la copia v31 varían entre ejecuciones porque la
migración escribe backups y metadatos con marca de tiempo; el hash relevante es
el del origen, que no cambia):

```text
QvaApply — ensayo de migración SQLite -> Postgres (sin producción)
Fecha UTC:   2026-11-14T20:16:35Z
Origen:      /home/agore/Proyectos/QvaApply/data/qvaapply.sqlite
Postgres:    qvaapply@127.0.0.1:55432 (admin qvaapply)
Base ensayo: qvaapply_rehearsal_20261114201635_1211699
Workdir:     /tmp/qva-f3-rehearsal-GZnO17

== 1. Copia de trabajo y comprobación de integridad ==
[info] sha256 origen: 573f67670ddfebd3d6a0858374a197eaaa033d22c90c3db8b9935bd77779c5c8
[info] esquema v16: migrando la copia a v31 con tools/db-rehearsal/rehearse.mjs.
RESULT: PASS (33/33 checks)
[info] sha256 a importar: e265cf49e8a8a24ed56ac4609e5b66a3214830f33bce54dea6bdf80b4d6ad724

== 2. Creación de la base temporal ==
[info] base creada: qvaapply_rehearsal_20261114201635_1211699

== 3. Migraciones versionadas ==
apply 0001_core
apply 0002_triggers
apply 0003_outbox_inbox
apply 0004_shadow
apply 0005_invariants
apply 0006_soak
apply 0007_qvapay
apply 0008_qvapay_offers
apply 0009_hunter
apply 0010_hunter_events
apply 0011_hunter_source
apply 0012_core_decisions
apply 0013_core_executions
apply 0014_core_operations
migrations: OK (qvaapply_rehearsal_20261114201635_1211699)

== 4. Importación SQLite -> Postgres (schema core) ==
import-manifest: 41 tablas · 16533 filas · 40 índices · 6 FKs · sha256=e265cf49e8a8…

== 5. Auditoría de invariantes ==
audit-invariants: OK (qvaapply_rehearsal_20261114201635_1211699)

== 6. Verificación de importes (saldos, ledger y operaciones) ==
verify-money: OK · 5 saldos · 7 grupos de ledger · 10 operaciones

== 7. Conteos core frente al manifiesto del importador ==
core: 41 tablas · 16533 filas (manifiesto: 41 tablas · 16533 filas)

Resultado: ENSAYO OK — migración, auditoría, importes y conteos verificados.
Este ensayo NO ejecuta el cutover ni cambia producción.
```

Conteos por tabla de esa ejecución (evidencia completa en el workdir si se usa
`KEEP_REHEARSAL=1`; aquí se omiten las 24 tablas con 0 filas):

```text
audit_log                   6176    market_observations       3166
config_revisions            5416    notification_events        352
dashboard_snapshots          661    decision_events            237
settings                     231    trading_alerts              84
fiat_ledger                   71    seen_offers                 21
mutation_intents              21    capital_reservations        11
trade_workflows               11    operations                  10
remote_resource_cache          9    fiat_accounts                5
fiat_balance_history           5    market_config                5
capital_rebalance_jobs         2    workflow_own_offers          2
bot_config                     1    config_integrity_epoch       1
manual_cancel_exclusions       1    payment_details              1
risk_config                    1    trading_config               1
schema_migrations             31
```

## 7. Runbook del corte real (propuesto, no ejecutado)

> Esta sección es el procedimiento a ensayar y firmar. Ningún paso de aquí se
> ha ejecutado contra producción. Los comandos son plantillas: adaptar rutas,
> release, contenedor de Postgres y puertos antes de usarlos.

### 7.1 T-7 días: congelación y backup

- [ ] Congelar código, configuración, límites, mercados y tarifas; solo se
      admiten correcciones de rollback.
- [ ] Confirmar que la release TS que se conservará
      (`02bb5afc04b5eb95f5ac3996ef7634dedf073d02` en la evidencia actual) sigue
      completa en `/opt/qvaapply/releases/`.
- [ ] Verificar el timer de backup SQLite y su retención de 14 días.
- [ ] Copiar `/opt/qvaapply/data` y `/opt/qvaapply/config` a un destino externo
      cifrado; no guardar secretos en el repositorio.
- [ ] Probar una restauración completa de la copia en un entorno desechable:
      `PRAGMA integrity_check`, conteos y arranque del panel con la copia.
- [ ] Ejecutar el ensayo de datos **dos veces** desde copias distintas y
      comparar conteos, sumas, hashes y manifiestos.
- [ ] Ejecutar a diario `scripts/f3-cutover-check.sh` y archivar la salida.

### 7.2 T-24 h: ensayo general

- [ ] Repetir el ensayo con la copia más reciente y firmar el manifiesto.
- [ ] Confirmar que el rollback usa la misma release, configuración y datos.
- [ ] Revisar `invariant_runs`, `shadow.runs`, `hunter_events` y
      `core_decisions`; sin fallos, pendientes ni divergencias.
- [ ] Confirmar que no hay `mutation_intents` en `submitted`/`uncertain` y que
      no hay operaciones a medio reconciliar.
- [ ] Avisar de la ventana a quien use panel, Telegram y Android.

### 7.3 T0: drenaje

Orden obligatorio: **pausar → drenar → reconciliar → snapshot → parar TS**.

- [ ] Pausar cacerías y acciones programadas; no parar TS todavía.
- [ ] Dejar de aceptar operaciones nuevas y esperar a las que estén en curso.
- [ ] Reconciliar mutaciones e intenciones hasta que
      `mutation_intents` en `submitted`/`uncertain` sea 0.
- [ ] Comprobar el drenaje con consultas de solo lectura:

  ```bash
  sqlite3 -readonly -header -column \
    "file:/opt/qvaapply/data/qvaapply.sqlite?mode=ro" "
    SELECT state, COUNT(*) AS n FROM operations GROUP BY state;
    SELECT state, COUNT(*) AS n FROM mutation_intents GROUP BY state;
    SELECT COUNT(*) AS unresolved
      FROM mutation_intents WHERE state IN ('submitted','uncertain');
    SELECT state, COUNT(*) AS n FROM trade_workflows GROUP BY state;
    SELECT COUNT(*) AS pending_actions
      FROM scheduled_actions WHERE state = 'pending';
    SELECT state, COUNT(*) AS n FROM market_feed_events GROUP BY state;
  "
  ```

- [ ] Dejar por escrito cualquier excepción aceptada.

### 7.4 Snapshot final

- [ ] Parar TS de forma ordenada respetando el `stop_grace_period` de 90 s.
- [ ] Con TS parado, hacer el backup final y verificar integridad:

  ```bash
  umask 077
  install -d -m 700 /var/backups/qvaapply-cutover
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  sqlite3 /opt/qvaapply/data/qvaapply.sqlite \
    ".timeout 5000" \
    ".backup '/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite'"
  sqlite3 "/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite" \
    "PRAGMA integrity_check;"
  sha256sum "/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite" \
    > "/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite.sha256"
  ```

- [ ] Copiar el snapshot y la configuración cifrada fuera de la VPS y verificar
      los hashes.
- [ ] Exportar el manifiesto de migración: conteos por tabla, ofertas abiertas,
      operaciones no terminales, cadena/epoch de configuración y snapshots de
      lectura. Las sumas de saldos van al manifiesto privado.
- [ ] Hacer `pg_dump` del Postgres migrado antes de arrancar Go y validar que se
      puede listar/restaurar:

  ```bash
  CORE_PG_CONTAINER=<postgres-core-produccion>
  docker exec "$CORE_PG_CONTAINER" pg_dump -U qvaapply -Fc qvaapply \
    > "/var/backups/qvaapply-cutover/core-$ts.dump"
  docker run --rm -i postgres:16 pg_restore --list \
    < "/var/backups/qvaapply-cutover/core-$ts.dump" >/dev/null
  ```

### 7.5 Importación en staging

Nunca importar directamente el archivo de producción. Copiar el snapshot a un
host/entorno de staging y ejecutar el ensayo:

```bash
install -d -m 700 /tmp/qva-rehearsal-src
cp --preserve=mode,timestamps \
  /var/backups/qvaapply-cutover/qvaapply-$ts.sqlite \
  /tmp/qva-rehearsal-src/qvaapply.sqlite

PGHOST=<staging-pg> PGPORT=5432 PGUSER=qvaapply \
PGPASSWORD=... PGADMIN_DB=postgres \
  scripts/f3-rehearsal.sh --source /tmp/qva-rehearsal-src/qvaapply.sqlite
```

- [ ] Ejecutar dos veces (idealmente con copias del mismo snapshot) y comparar
      `import-manifest.json`, `core-counts.tsv` y las sumas.
- [ ] Guardar el manifiesto firmado y el `sha256` del snapshot.
- [ ] No reutilizar credenciales de producción en staging.

### 7.6 Verificación antes de abrir escrituras

- [ ] `audit-invariants.sh` sin violaciones.
- [ ] `verify-money.mjs` con saldos, ledger y operaciones idénticos.
- [ ] Conteos por tabla idénticos al manifiesto (41 tablas en el snapshot
      actual) y `sha256` del manifiesto igual al de la copia importada.
- [ ] Comprobar ofertas abiertas, operaciones no terminales, `mutation_intents`,
      configuración/epoch y workflows duplicados con consultas de solo lectura.
- [ ] Arrancar Go en modo cauteloso: un mercado, límites mínimos, cupo diario
      bajo y aprobación manual de las primeras N aplicaciones.
- [ ] Smoke de `/healthz`, `/readyz`, sesión, panel, Telegram y Android.
- [ ] No ejecutar una operación real sin autorización y conciliación preparadas.

### 7.7 Ventana

| Parámetro | Propuesta |
| --- | --- |
| Duración del cambio | 2 h en horario de bajo tráfico. |
| Congelación | Desde T-24 h hasta T+14 días para cambios ajenos al corte. |
| Observación intensiva | 48 h (cada 15–30 min al inicio). |
| Rollback disponible | 14 días desde el corte. |
| Fecha definitiva | Pendiente; no se asigna hasta cerrar G1–G8. |

La ventana se confirma en UTC y en la zona del operador. Si el volumen no es
bajo, se pospone: la prisa no es un criterio.

### 7.8 Rollback a TypeScript (14 días)

Disparadores: `apply` duplicado, mutación sin intención durable, saldo/ledger
descuadrado, intención `uncertain` sin resolver > 15 min, divergencia
sistemática > 0,1 % en una hora, pérdida de notificaciones, fallo de la
superficie de control o imposibilidad de leer/escribir de forma consistente.

Procedimiento:

- [ ] Declarar el rollback y congelar nuevas mutaciones en Go.
- [ ] Parar `trading-core` y cualquier worker que pueda despachar.
- [ ] Reconciliar contra QvaPay **todas** las intenciones creadas por Go;
      ninguna puede quedar `submitted`/`uncertain`.
- [ ] Reconciliar los datos posteriores al corte: la SQLite TS es la base de
      retorno, pero puede haberse quedado atrás. Restaurar/mergear antes de
      reabrir escrituras. **No basta con volver a levantar el contenedor.**
- [ ] Devolver Nginx a TS o mantener el puerto TS original.
- [ ] Arrancar la release TS conservada:

  ```bash
  TS_RELEASE=/opt/qvaapply/releases/02bb5afc04b5eb95f5ac3996ef7634dedf073d02
  QVAAPPLY_REVISION=$(basename "$TS_RELEASE") \
  QVAAPPLY_HOST_PORT=$(cat /opt/qvaapply/config/host-port) \
    docker compose -f "$TS_RELEASE/deploy/compose.yaml" up -d
  ```

- [ ] Verificar `/api/session` 200, panel, login, Telegram y Android.
- [ ] Reabrir la automatización solo con la conciliación cerrada y aprobación
      del verificador.
- [ ] Conservar base Go, logs, manifiestos y dumps para el post-mortem; no
      borrar evidencia.
- [ ] Registrar hora, intenciones reconciliadas y estado final de cada
      operación.

**Retención de 14 días:** no borrar la release TS, la SQLite previa, el snapshot
final, el dump de Postgres, los manifiestos ni los logs durante los 14 días
posteriores al corte. Cualquier incidente de conciliación o doble aplicación
reinicia el reloj de estabilidad y activa revisión.

### 7.9 Responsables

| Rol | Responsabilidad | Nombre / firma |
| --- | --- | --- |
| Operador-ejecutor | Ejecuta ventana, backup, parada, migración y smoke. | |
| Verificador independiente | Ejecuta comprobaciones, revisa evidencia y firma el go/no-go. No implementó el cambio. | |
| Observador | Vigila métricas, logs, QvaPay, panel y alertas durante 48 h. | |
| Aprobador de rollback | Puede ordenar el rollback sin esperar consenso. | |

Una persona puede cubrir varios roles operativos, pero la firma de verificación
debe ser independiente. Si no hay segunda persona, se usa un agente revisor con
acceso de solo lectura y se documenta.

## 8. Criterios de éxito y de no-go

El ensayo es **verde** solo si:

- el script termina con código `0`;
- `rehearse.mjs` devuelve `RESULT: PASS`;
- las 0001–0014 se aplican y `migrate.sh` termina en `OK`;
- `audit-invariants.sh` no devuelve ninguna violación;
- `verify-money.mjs` devuelve `OK` con los mismos saldos, grupos de ledger y
  operaciones;
- los 41 conteos y las 16 533 filas coinciden con el manifiesto;
- el `sha256` del origen no cambia;
- la base temporal y el workdir se limpian (o se conservan de forma explícita).

Cualquier discrepancia sin explicar es **no-go**. Un fallo de auditoría no se
compensa con un reinicio ni con ignorar el contador.

## 9. Límites actuales y lo que no se ha probado

- **Producción no se ha tocado.** El ensayo se ejecutó contra una copia del
  snapshot v16 del repositorio y un Postgres dev en `127.0.0.1:55432`.
- **El corte real no se ha ejecutado.** No hay cambio de autoridad, Nginx,
  contenedores Go ni release de producción.
- **No se ha ejecutado un rollback TS real.** La sección 7.8 es el procedimiento
  a ensayar; restaurar TS y reconciliar intenciones sigue pendiente (G5).
- **No se ha probado backup/PITR ni restauración de Postgres** en este ensayo
  (G7).
- **No se validan triggers sobre los datos importados.** El importador usa
  `--replace` y recrea `core` después de `0002_triggers.sql`; los triggers se
  cubren con fixtures en `services/db/test-postgres.sh`, no aquí.
- **La migración v16→v31 usa el código TS actual** (`src/store.ts` vía `tsx`),
  no un procedimiento F5 independiente.
- **Una sola muestra local.** El gate G4 exige al menos dos dry-runs con el
  snapshot de producción, manifiesto firmado y reconciliación.
- **No hay paridad de servicios Go, ni soak, ni 7 días de decisiones** en este
  documento; eso pertenece a G1–G3.
- **No se imprimen secretos, tokens ni saldos.** Los conteos y hashes agregados
  son evidencia; el manifiesto completo y los logs deben guardarse en un
  directorio privado.

## 10. Evidencia a conservar

Con `KEEP_REHEARSAL=1` el workdir contiene:

- `import-manifest.json` (conteos, hashes, índices, FKs, identidades);
- `manifest-counts.tsv` y `core-counts.tsv` (comparación exacta);
- `counts.diff` (vacío si todo coincide);
- `migrate.log`, `import.log`, `audit.log`, `verify-money.log`;
- `rehearse.log` y `rehearsal.json` si la copia era < v31.

Guardar además: comando exacto, versión de Node/psql/Postgres, `sha256` del
origen, hora UTC, salida del script y firmas del operador y del verificador.
No versionar dumps, filas, secretos ni saldos.

## 11. Referencias

- [Checklist de cutover TS → Go](2026-11-14-cutover-checklist.md)
- [Persistencia F1 y ensayo de datos](../../services/db/README.md)
- [Análisis de ensayo de datos](analysis/06-data-rehearsal.md)
- [Runbook shadow F3](f3-shadow-runbook.md)
- [Script de comprobación pre-cutover](../../scripts/f3-cutover-check.sh)

## 12. Declaración final

Este documento registra un **ensayo local de migración y verificación**. No
afirma que el cutover esté hecho, aprobado ni ensayado de extremo a extremo. No
afirma que Go tenga permiso para mutar dinero. No sustituye la revisión
independiente, el manifiesto firmado ni la decisión del operador.
