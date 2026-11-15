#!/usr/bin/env bash
# Copia consistente del SQLite de QvaApply.
#
# Producción usa las rutas por defecto. Los tests pueden sobrescribirlas con
# QVAAPPLY_DB, QVAAPPLY_BACKUP_DIR y QVAAPPLY_BACKUP_RETENTION_DAYS.
set -Eeuo pipefail

database="${QVAAPPLY_DB:-/opt/qvaapply/data/qvaapply.sqlite}"
backup_dir="${QVAAPPLY_BACKUP_DIR:-/opt/qvaapply/data/backups}"
retention_days="${QVAAPPLY_BACKUP_RETENTION_DAYS:-14}"

[[ -f $database ]] || exit 0
install -d -m 0700 "$backup_dir"
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  chown 1000:1000 "$backup_dir" 2>/dev/null || true
fi
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || exit 0

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$backup_dir/.qvaapply-$timestamp.sqlite"
destination="$backup_dir/qvaapply-$timestamp.sqlite"
rm -f "$temporary"
# VACUUM INTO toma un snapshot consistente en una sola pasada. El .backup
# clásico reinicia cuando la fuente cambia y con escrituras cada 3 s puede
# tardar horas.
sqlite3 "$database" ".timeout 5000" "VACUUM INTO '$temporary'"
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  chown 1000:1000 "$temporary" 2>/dev/null || true
fi
chmod 600 "$temporary"
mv "$temporary" "$destination"
find "$backup_dir" -maxdepth 1 -type f -name 'qvaapply-*.sqlite' -mtime "+$retention_days" -delete
