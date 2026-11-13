# `services/db` — persistencia F1

Camino **no destructivo** desde la SQLite actual a un Postgres de desarrollo.
Nunca se abre ni se escribe en `data/qvaapply.sqlite`:

1. Se copia el fichero a `/tmp` y se verifica su `sha256` antes y después.
2. La copia se migra a v31 con `tools/db-rehearsal/rehearse.mjs` (también sobre
   copia).
3. Se importa a una base Postgres **nueva** y un schema explícito (`core`).

## Postgres local aislado

```bash
docker compose -f services/db/compose.postgres.yaml up -d
```

- `127.0.0.1:55432`
- base `qvaapply`
- usuario `qvaapply`
- contraseña **solo de desarrollo**: `qvaapply_dev_only`
- volumen `qvaapply-f1-pgdata`

No usar estas credenciales fuera de desarrollo.

## Importar una copia v31

```bash
# 1) Copia de trabajo + migración v16→v31 (nunca toca el original)
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --source /tmp/prod-copy/qvaapply.sqlite \
  --workdir /tmp/qva-f1-rehearsal \
  --json /tmp/qva-f1-rehearsal.json --keep

# 2) Importación raw→core al Postgres aislado
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=qvaapply_dev_only \
node services/db/import-sqlite-to-postgres.mjs \
  --source /tmp/qva-f1-rehearsal/data/qvaapply.sqlite \
  --database qvaapply --schema core --replace \
  --manifest /tmp/qva-f1-import.json
```

El importador exige `--replace` para recrear un schema existente y verifica:

- conteos por tabla (SQLite vs Postgres);
- digest MD5 de `settings` con orden binario (`COLLATE "C"`);
- `sha256` del origen sin cambios;
- 41 tablas / **16 533 filas** en la copia de ensayo;
- 41 claves primarias, 40 índices y 6 claves foráneas.

## Esquema versionado

`schema/core-v1.sql` es el snapshot `pg_dump --schema-only` del schema `core`
(41 tablas, PKs, índices y FKs). Se aplica a una base vacía con:

```bash
createdb qvaapply_f1
psql -d qvaapply_f1 -v ON_ERROR_STOP=1 -f services/db/schema/core-v1.sql
```

Validado en **PostgreSQL 16** (contenedor aislado): 41 tablas, 6 FKs y 40
índices.

> Los 6 triggers de SQLite (integridad de configuración e histórico fiat) aún
> no están traducidos. Deben añadirse **después** de la importación para no
> duplicar filas de histórico. Es el siguiente paso de persistencia.

## Seguridad

- `--replace` es obligatorio para borrar un schema; no hay borrado implícito.
- El importador solo escribe en `--database`/`--schema` y usa `psql` con
  `ON_ERROR_STOP=1`.
- No se versionan dumps ni filas; solo estructura, conteos y digests agregados.
- `data/` permanece intacto: el `sha256` del fichero original se comprueba antes
  y después.
