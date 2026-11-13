# Evidencia F1 — importación SQLite → Postgres (2026-11-13)

## Resultado

Se importó una **copia** migrada a v31 de la SQLite actual a un Postgres 16
aislado, sin tocar la base original:

- **41 tablas**, **16 533 filas**, **0 mismatches** de conteo.
- **41 claves primarias**, **40 índices**, **6 claves foráneas**.
- Digest de `settings` idéntico (`md5` con orden binario).
- `sha256` del fichero `data/qvaapply.sqlite` antes y después:
  `573f67670ddfebd3d6a0858374a197eaaa033d22c90c3db8b9935bd77779c5c8`.

## Camino reproducible

```bash
node --import tsx tools/db-rehearsal/rehearse.mjs \
  --source /tmp/prod-copy/qvaapply.sqlite \
  --workdir /tmp/qva-f1-rehearsal --keep

PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply PGPASSWORD=qvaapply_dev_only \
node services/db/import-sqlite-to-postgres.mjs \
  --source /tmp/qva-f1-rehearsal/data/qvaapply.sqlite \
  --database qvaapply --schema core --replace \
  --manifest /tmp/qva-f1-import.json
```

El snapshot `services/db/schema/core-v1.sql` se aplicó a una base Postgres 16
vacía: 41 tablas, 40 índices y 6 FKs.

## Garantías de seguridad

- El origen solo se copia; se verifica su hash antes y después.
- Toda la escritura va a una base Postgres nueva y un schema explícito.
- `--replace` es obligatorio para recrear el schema.
- No se versionan datos ni secretos; solo DDL, conteos y digests agregados.

## Triggers y migraciones

- Los **6 triggers** se tradujeron a funciones/triggers PL/pgSQL y se aplican
  después de la carga.
- `services/db/migrate.sh` aplica migraciones versionadas y registra cada
  versión en `public.qvaapply_schema_migrations` dentro de una transacción.
- `test-postgres.sh` valida esquema + triggers; `test-postgres-import.sh` valida
  la importación desde un fixture SQLite mínimo. Ambos pasan en PostgreSQL 16.
- El workflow de CI `postgres-f1` ejecuta ambas pruebas; el deploy depende de
  ese job.

## Pendiente

1. Verificación de importes/redondeo en Postgres y auditor SQL de invariantes.
2. Fixture SQLite más amplio para cubrir todas las tablas financieras en CI.
3. Tiempos de CI documentados y `golangci-lint` cuando haya release para Go 1.27.
