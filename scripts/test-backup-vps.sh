#!/usr/bin/env bash
# Prueba el backup sin tocar producción: SQLite temporal, integridad, conteos,
# retención y ausencia de base.
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_script="$script_dir/backup-vps.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/qvaapply-backup-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

database="$work/qvaapply.sqlite"
backup_dir="$work/backups"
mkdir -p "$backup_dir"

sqlite3 "$database" "CREATE TABLE events(id INTEGER PRIMARY KEY, detail TEXT); INSERT INTO events(detail) VALUES ('uno'),('dos'),('tres');"
# Copia antigua que debe borrarse por retención.
touch -d '20 days ago' "$backup_dir/qvaapply-20000101T000000Z.sqlite"
# Copias recientes que también deben acotarse por número.
for index in 1 2 3 4 5; do
  touch "$backup_dir/qvaapply-2026010${index}T000000Z.sqlite"
done

QVAAPPLY_DB="$database" QVAAPPLY_BACKUP_DIR="$backup_dir" \
QVAAPPLY_BACKUP_RETENTION_DAYS=14 QVAAPPLY_BACKUP_RETENTION_COUNT=3 "$backup_script"

backup=$(find "$backup_dir" -maxdepth 1 -name 'qvaapply-*.sqlite' -newer "$database" | head -n 1)
[[ -n $backup ]] || { echo "no se creó el backup" >&2; exit 1; }
[[ $(sqlite3 -readonly "file:$backup?mode=ro" 'PRAGMA quick_check;') == ok ]] || {
  echo "quick_check falló" >&2; exit 1;
}
[[ $(sqlite3 -readonly "file:$backup?mode=ro" 'SELECT count(*) FROM events;') == 3 ]] || {
  echo "conteo incorrecto" >&2; exit 1;
}
[[ ! -e "$backup_dir/qvaapply-20000101T000000Z.sqlite" ]] || {
  echo "no se aplicó la retención por días" >&2; exit 1;
}
[[ $(find "$backup_dir" -maxdepth 1 -name 'qvaapply-*.sqlite' | wc -l) -eq 3 ]] || {
  echo "no se aplicó la retención por número" >&2; exit 1;
}

# Segunda ejecución y base ausente.
QVAAPPLY_DB="$database" QVAAPPLY_BACKUP_DIR="$backup_dir" "$backup_script"
QVAAPPLY_DB="$work/no-existe.sqlite" QVAAPPLY_BACKUP_DIR="$backup_dir" "$backup_script"

echo "backup test: OK"
