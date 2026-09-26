#!/usr/bin/env bash
set -Eeuo pipefail

database="/opt/qvaapply/data/qvaapply.sqlite"
backup_dir="/opt/qvaapply/data/backups"

[[ -f $database ]] || exit 0
install -d -o 1000 -g 1000 -m 0700 "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary="$backup_dir/.qvaapply-$timestamp.sqlite"
destination="$backup_dir/qvaapply-$timestamp.sqlite"
sqlite3 "$database" ".timeout 5000" ".backup '$temporary'"
chown 1000:1000 "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$destination"
find "$backup_dir" -maxdepth 1 -type f -name 'qvaapply-*.sqlite' -mtime +14 -delete
