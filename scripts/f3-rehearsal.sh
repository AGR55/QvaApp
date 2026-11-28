#!/usr/bin/env bash
# Ensayo reproducible de migración SQLite -> Postgres, sin tocar producción.
#
# Garantías:
#   - Nunca abre la SQLite de origen con SQLite: copia el fichero (y sus -wal/-shm
#     si existen) a un directorio temporal y comprueba su sha256 antes/después.
#   - Si la copia es anterior a v31, la migra con tools/db-rehearsal/rehearse.mjs
#     (también sobre copia) para que core tenga todas las tablas auditadas.
#   - Crea una base Postgres temporal con prefijo qvaapply_rehearsal_, aplica
#     services/db/migrate.sh, importa con import-sqlite-to-postgres.mjs y ejecuta
#     audit-invariants.sh, verify-money.mjs y la comparación de conteos contra el
#     manifiesto del importador.
#   - Limpia la base y el directorio temporal al salir, salvo KEEP_REHEARSAL=1.
#   - No ejecuta el cutover, no escribe en /opt/qvaapply y no cambia producción.
#
# Uso:
#   scripts/f3-rehearsal.sh
#   scripts/f3-rehearsal.sh --help
#   scripts/f3-rehearsal.sh data/qvaapply.sqlite
#   scripts/f3-rehearsal.sh --source /tmp/copia.sqlite --database qvaapply_rehearsal_prueba
#
# Variables de conexión (mismos defaults que services/db/test-postgres-import.sh):
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... PGADMIN_DB=postgres
#
# Códigos de salida:
#   0  Ensayo completo correcto.
#   1  Falló una migración, auditoría, verificación o comparación.
#   2  Error de uso o falta un requisito de ejecución.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db_dir="$repo_root/services/db"
rehearse_script="$repo_root/tools/db-rehearsal/rehearse.mjs"

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGADMIN_DB:=postgres}"
: "${KEEP_REHEARSAL:=0}"

keep_rehearsal=0
case "$KEEP_REHEARSAL" in
  1 | true | TRUE | yes | YES) keep_rehearsal=1 ;;
  0 | false | FALSE | no | NO | "") keep_rehearsal=0 ;;
  *)
    printf 'KEEP_REHEARSAL inválido: %s (usa 1 o 0).\n' "$KEEP_REHEARSAL" >&2
    exit 2
    ;;
esac

usage() {
  cat <<'EOF'
Ensayo de migración SQLite -> Postgres sin tocar producción.

Uso:
  f3-rehearsal.sh [OPCIONES] [SQLITE] [NOMBRE_BD]

Argumentos:
  SQLITE       SQLite de origen (defecto: <repo>/data/qvaapply.sqlite).
               Solo se copia; el original no se abre ni se modifica.
  NOMBRE_BD    Base temporal (defecto: qvaapply_rehearsal_<UTC>_<pid>).
               Debe empezar por "qvaapply_rehearsal_" para que la limpieza
               nunca pueda borrar una base que no sea de ensayo.

Opciones:
  --source RUTA       Equivale al primer argumento posicional.
  --database NOMBRE   Equivale al segundo argumento posicional.
  --keep              Conserva la base y el directorio temporal (= KEEP_REHEARSAL=1).
  -h, --help          Muestra esta ayuda.

Variables de entorno:
  PGHOST        Host de Postgres (defecto: 127.0.0.1).
  PGPORT        Puerto de Postgres (defecto: 5432).
  PGUSER        Usuario de Postgres (defecto: postgres).
  PGPASSWORD    Contraseña; psql la lee del entorno y no se imprime.
  PGADMIN_DB    Base administrativa para CREATE/DROP DATABASE (defecto: postgres).
  KEEP_REHEARSAL=1  Conserva base temporal y workdir para inspección.

Ejemplos:
  # Postgres aislado de desarrollo
  PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
  PGPASSWORD=qvaapply_dev_only PGADMIN_DB=qvaapply \
    scripts/f3-rehearsal.sh data/qvaapply.sqlite

  # Conservar evidencia
  KEEP_REHEARSAL=1 scripts/f3-rehearsal.sh --source /tmp/copia.sqlite

Seguridad:
  - Rechaza rutas bajo /opt/qvaapply.
  - Solo crea y borra bases con prefijo qvaapply_rehearsal_.
  - No ejecuta el corte real ni escribe en producción.
EOF
}

die() {
  printf 'f3-rehearsal: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'f3-rehearsal: %s\n' "$*" >&2
  printf 'Usa --help para ver la ayuda.\n' >&2
  exit 2
}

step() {
  printf '\n== %s ==\n' "$*"
}

info() {
  printf '[info] %s\n' "$*"
}

sha256_file() {
  sha256sum -- "$1" | awk '{print $1}'
}

source_arg=""
db_name=""
positional=()

while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --source)
      (($# >= 2)) || usage_error "Falta el valor de --source."
      source_arg="$2"
      shift 2
      ;;
    --database)
      (($# >= 2)) || usage_error "Falta el valor de --database."
      db_name="$2"
      shift 2
      ;;
    --keep)
      keep_rehearsal=1
      shift
      ;;
    --)
      shift
      positional+=("$@")
      break
      ;;
    -*)
      usage_error "Opción no reconocida: $1"
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

if ((${#positional[@]} > 2)); then
  usage_error "Demasiados argumentos posicionales."
fi
if ((${#positional[@]} >= 1)); then
  [[ -z "$source_arg" ]] || usage_error "La SQLite se indicó dos veces."
  source_arg="${positional[0]}"
fi
if ((${#positional[@]} >= 2)); then
  [[ -z "$db_name" ]] || usage_error "El nombre de base se indicó dos veces."
  db_name="${positional[1]}"
fi
[[ -n "$source_arg" ]] || source_arg="$repo_root/data/qvaapply.sqlite"

if [[ -z "$db_name" ]]; then
  db_name="qvaapply_rehearsal_$(date -u +%Y%m%d%H%M%S)_$$"
fi
if [[ ! "$db_name" =~ ^qvaapply_rehearsal_[A-Za-z0-9_]+$ ]]; then
  usage_error "Nombre de base no seguro: $db_name (debe empezar por qvaapply_rehearsal_ y usar [A-Za-z0-9_])."
fi
if ((${#db_name} > 63)); then
  usage_error "El nombre de base supera los 63 caracteres de Postgres."
fi

for command_name in psql node sha256sum mktemp cp rm awk sort wc diff tee date; do
  command -v "$command_name" >/dev/null 2>&1 ||
    usage_error "Falta el comando requerido: $command_name"
done
[[ -r "$db_dir/migrate.sh" ]] || usage_error "Falta $db_dir/migrate.sh"
[[ -r "$db_dir/import-sqlite-to-postgres.mjs" ]] ||
  usage_error "Falta $db_dir/import-sqlite-to-postgres.mjs"
[[ -r "$db_dir/audit-invariants.sh" ]] || usage_error "Falta $db_dir/audit-invariants.sh"
[[ -r "$db_dir/verify-money.mjs" ]] || usage_error "Falta $db_dir/verify-money.mjs"

if [[ ! -e "$source_arg" ]]; then
  usage_error "No existe la SQLite de origen: $source_arg"
fi
if [[ ! -f "$source_arg" ]]; then
  usage_error "La ruta de origen no es un fichero: $source_arg"
fi
if [[ ! -r "$source_arg" ]]; then
  usage_error "No se puede leer la SQLite de origen: $source_arg"
fi
source_path="$(cd "$(dirname "$source_arg")" && pwd -P)/$(basename "$source_arg")"
case "$source_path" in
  /opt/qvaapply | /opt/qvaapply/*)
    usage_error "Ruta de producción rechazada: $source_path. Copia la SQLite fuera de /opt/qvaapply."
    ;;
esac

if ! psql -X -q -At -d "$PGADMIN_DB" -c 'SELECT 1' >/dev/null 2>&1; then
  printf 'f3-rehearsal: no se puede conectar a Postgres como %s@%s:%s (admin DB %s).\n' \
    "$PGUSER" "$PGHOST" "$PGPORT" "$PGADMIN_DB" >&2
  exit 2
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/qva-f3-rehearsal-XXXXXX")"
copy="$workdir/source.sqlite"
import_source=""
manifest="$workdir/import-manifest.json"
db_created=0

cleanup() {
  local status=$?
  trap - EXIT
  if ((db_created == 1)) && ((keep_rehearsal == 0)); then
    psql -X -q -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$db_name\"" >/dev/null 2>&1 || true
  fi
  if ((keep_rehearsal == 0)); then
    rm -rf -- "$workdir"
  else
    if ((db_created == 1)); then
      printf 'f3-rehearsal: base %s conservada (KEEP_REHEARSAL=1).\n' "$db_name" >&2
    fi
    printf 'f3-rehearsal: workdir %s conservado (KEEP_REHEARSAL=1).\n' "$workdir" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

printf 'QvaApply — ensayo de migración SQLite -> Postgres (sin producción)\n'
printf 'Fecha UTC:   %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Origen:      %s\n' "$source_path"
printf 'Postgres:    %s@%s:%s (admin %s)\n' "$PGUSER" "$PGHOST" "$PGPORT" "$PGADMIN_DB"
printf 'Base ensayo: %s\n' "$db_name"
printf 'Workdir:     %s\n' "$workdir"

step "1. Copia de trabajo y comprobación de integridad"
source_sha_before="$(sha256_file "$source_path")"
info "sha256 origen: $source_sha_before"
cp -f -- "$source_path" "$copy"
for suffix in -wal -shm; do
  if [[ -f "${source_path}${suffix}" ]]; then
    cp -f -- "${source_path}${suffix}" "${copy}${suffix}"
  fi
done
source_sha_after="$(sha256_file "$source_path")"
[[ "$source_sha_before" == "$source_sha_after" ]] ||
  die "la SQLite de origen cambió durante la copia; no se continúa."
info "copia: $copy"

if ! schema_version="$(node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
let version = 0;
try {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get();
  version = Number(row?.v ?? 0);
} catch {
  version = 0;
} finally {
  db.close();
}
console.log(version);
' "$copy")"; then
  die "no se pudo leer la versión de esquema de la copia (¿SQLite corrupta?)."
fi

if [[ ! "$schema_version" =~ ^[0-9]+$ ]] || ((schema_version < 1)); then
  die "la copia no tiene schema_migrations válido (versión $schema_version)."
fi
if ((schema_version > 31)); then
  die "versión de esquema desconocida: v$schema_version (el ensayo soporta <= v31)."
fi

if ((schema_version == 31)); then
  info "esquema v$schema_version: no hace falta migrar la copia."
  import_source="$copy"
else
  info "esquema v$schema_version: migrando la copia a v31 con tools/db-rehearsal/rehearse.mjs."
  [[ -r "$rehearse_script" ]] || die "Falta $rehearse_script"
  if ! node --import tsx -e 'process.exit(0)' >/dev/null 2>&1; then
    die "La copia es v$schema_version y 'node --import tsx' no está disponible (instala devDependencies)."
  fi
  if ! node --import tsx "$rehearse_script" \
    --source "$copy" \
    --workdir "$workdir/rehearsal" \
    --json "$workdir/rehearsal.json" >"$workdir/rehearse.log" 2>&1; then
    printf 'f3-rehearsal: falló la migración de la copia a v31.\n' >&2
    tail -n 40 "$workdir/rehearse.log" >&2 || true
    exit 1
  fi
  grep '^RESULT:' "$workdir/rehearse.log" || true
  import_source="$workdir/rehearsal/data/qvaapply.sqlite"
  [[ -f "$import_source" ]] || die "El ensayo no produjo la copia v31 esperada."
fi

import_sha="$(sha256_file "$import_source")"
info "sha256 a importar: $import_sha"

step "2. Creación de la base temporal"
existing="$(psql -X -q -At -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM pg_database WHERE datname = '$db_name'")"
[[ -z "$existing" ]] || die "La base $db_name ya existe; usa otro nombre."
psql -X -q -d "$PGADMIN_DB" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db_name\""
db_created=1
info "base creada: $db_name"

step "3. Migraciones versionadas"
if ! PGDATABASE="$db_name" bash "$db_dir/migrate.sh" >"$workdir/migrate.log" 2>&1; then
  printf 'f3-rehearsal: fallaron las migraciones.\n' >&2
  tail -n 40 "$workdir/migrate.log" >&2 || true
  exit 1
fi
grep -E '^(skip|apply|migrations:)' "$workdir/migrate.log" || true

step "4. Importación SQLite -> Postgres (schema core)"
if ! PGDATABASE="$db_name" node "$db_dir/import-sqlite-to-postgres.mjs" \
  --source "$import_source" \
  --database "$db_name" \
  --schema core \
  --replace \
  --manifest "$manifest" >"$workdir/import.log" 2>&1; then
  printf 'f3-rehearsal: falló la importación.\n' >&2
  tail -n 40 "$workdir/import.log" >&2 || true
  exit 1
fi
node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(
  `import-manifest: ${manifest.tables} tablas · ${manifest.rows} filas · ` +
    `${manifest.indexes} índices · ${manifest.foreignKeys} FKs · ` +
    `sha256=${String(manifest.sourceSha256).slice(0, 12)}…`,
);
' "$manifest"

step "5. Auditoría de invariantes"
PGDATABASE="$db_name" bash "$db_dir/audit-invariants.sh" 2>&1 | tee "$workdir/audit.log"

step "6. Verificación de importes (saldos, ledger y operaciones)"
PGDATABASE="$db_name" node "$db_dir/verify-money.mjs" --source "$import_source" \
  2>&1 | tee "$workdir/verify-money.log"

step "7. Conteos core frente al manifiesto del importador"
expected_counts="$workdir/manifest-counts.tsv"
actual_counts="$workdir/core-counts.tsv"

node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
for (const [table, count] of Object.entries(manifest.counts)) {
  console.log(`${table}\t${count}`);
}
' "$manifest" >"$expected_counts"

: >"$actual_counts"
while IFS= read -r table; do
  [[ "$table" == "_import_manifest" ]] && continue
  quoted_table="${table//\"/\"\"}"
  count="$(psql -X -q -At -d "$db_name" -v ON_ERROR_STOP=1 \
    -c "SELECT count(*) FROM core.\"$quoted_table\"")"
  printf '%s\t%s\n' "$table" "$count" >>"$actual_counts"
done < <(psql -X -q -At -d "$db_name" -v ON_ERROR_STOP=1 \
  -c "SELECT tablename FROM pg_tables WHERE schemaname = 'core' ORDER BY tablename")

if ! diff -u <(LC_ALL=C sort "$expected_counts") <(LC_ALL=C sort "$actual_counts") \
  >"$workdir/counts.diff"; then
  printf 'f3-rehearsal: los conteos core no coinciden con el manifiesto.\n' >&2
  cat "$workdir/counts.diff" >&2
  exit 1
fi

expected_tables="$(wc -l <"$expected_counts" | tr -d '[:space:]')"
actual_tables="$(wc -l <"$actual_counts" | tr -d '[:space:]')"
expected_rows="$(awk -F'\t' '{sum += $2} END {printf "%.0f\n", sum}' "$expected_counts")"
actual_rows="$(awk -F'\t' '{sum += $2} END {printf "%.0f\n", sum}' "$actual_counts")"
manifest_tables="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(manifest.tables);
' "$manifest")"
manifest_rows="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(manifest.rows);
' "$manifest")"
manifest_sha="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(manifest.sourceSha256);
' "$manifest")"

[[ "$manifest_sha" == "$import_sha" ]] ||
  die "el sha256 del manifiesto no coincide con la copia importada."
[[ "$expected_tables" == "$manifest_tables" ]] ||
  die "el manifiesto declara $manifest_tables tablas pero lista $expected_tables."
[[ "$actual_tables" == "$manifest_tables" ]] ||
  die "core tiene $actual_tables tablas y el manifiesto declara $manifest_tables."
[[ "$expected_rows" == "$manifest_rows" ]] ||
  die "el manifiesto declara $manifest_rows filas pero suma $expected_rows."
[[ "$actual_rows" == "$manifest_rows" ]] ||
  die "core tiene $actual_rows filas y el manifiesto declara $manifest_rows."

printf 'Conteos por tabla (core):\n'
while IFS=$'\t' read -r table count; do
  printf '  %-42s %s\n' "$table" "$count"
done <"$actual_counts"
printf 'core: %s tablas · %s filas (manifiesto: %s tablas · %s filas)\n' \
  "$actual_tables" "$actual_rows" "$manifest_tables" "$manifest_rows"

printf '\nResultado: ENSAYO OK — migración, auditoría, importes y conteos verificados.\n'
printf 'Este ensayo NO ejecuta el cutover ni cambia producción.\n'
if ((keep_rehearsal == 1)); then
  printf 'KEEP_REHEARSAL=1: base %s y workdir %s conservados.\n' "$db_name" "$workdir"
  printf 'Manifiesto: %s\n' "$manifest"
else
  printf 'Base temporal y workdir se eliminarán al salir. Usa KEEP_REHEARSAL=1 para conservarlos.\n'
fi
exit 0
