#!/usr/bin/env bash
# Retira TS después de la vigilancia. Es destructivo: exige confirmación
# explícita y que la fecha de fin de vigilancia haya pasado.
set -Eeuo pipefail

WATCH_END="${F3_WATCH_END:-2026-11-29T20:28:49Z}"
ARCHIVE_DIR="${F3_ARCHIVE_DIR:-/opt/qvaapply-archive}"
DRY_RUN="${F3_DRY_RUN:-no}"

if [[ "$DRY_RUN" != "yes" && "${F3_CONFIRM_REMOVE:-}" != "yes" ]]; then
  echo "Falta F3_CONFIRM_REMOVE=yes. Este script borra el contenedor/imagen de TS." >&2
  exit 2
fi

now=$(date -u +%s)
end=$(date -u -d "$WATCH_END" +%s)
if [[ "$DRY_RUN" != "yes" ]] && (( now < end )) && [[ "${F3_FORCE:-}" != "yes" ]]; then
  echo "La vigilancia termina en $WATCH_END. Faltan $(( (end - now) / 3600 )) horas." >&2
  echo "Usa F3_FORCE=yes solo con autorización explícita." >&2
  exit 3
fi

echo "== comprobación final de vigilancia"
if [[ -x /usr/local/sbin/qvaapply-watch ]]; then
  /usr/local/sbin/qvaapply-watch || {
    echo "La comprobación de vigilancia falló; no se retira TS." >&2
    exit 8
  }
fi

echo "== comprobaciones previas"
[[ "$(docker inspect -f '{{.State.Status}}' qvaapply 2>/dev/null || echo missing)" == "exited" ]] ||
  { echo "TS no está detenido" >&2; exit 4; }
grep -q 'proxy_pass http://127.0.0.1:8093' /etc/nginx/sites-available/qvaapply.conf ||
  { echo "Nginx no apunta al edge" >&2; exit 5; }
[[ "$(curl -k -sS -o /dev/null -w '%{http_code}' https://qvapply.honux.tech/)" == "200" ]] ||
  { echo "El dominio no responde 200" >&2; exit 6; }
uncertain=$(docker exec -i qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -Atc \
  "select count(*) from shadow.core_operations where state='uncertain';" | tr -d '[:space:]')
[[ "$uncertain" == "0" ]] || { echo "Hay $uncertain operaciones inciertas" >&2; exit 7; }

if [[ "$DRY_RUN" == "yes" ]]; then
  echo "== dry-run: no se archiva ni se borra nada"
  echo "archivo previsto: $ARCHIVE_DIR/qvaapply-ts-<timestamp>.tar.gz"
  echo "contenedor: $(docker inspect -f '{{.Name}} {{.State.Status}}' qvaapply 2>/dev/null || echo missing)"
  echo "imagen: $(docker inspect -f '{{.Image}}' qvaapply 2>/dev/null || echo missing)"
  echo "comando real: F3_CONFIRM_REMOVE=yes $0"
  exit 0
fi

echo "== archivo de seguridad"
install -d -m 0700 "$ARCHIVE_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$ARCHIVE_DIR/qvaapply-ts-$stamp.tar.gz"
tar -czf "$archive" \
  -C /opt qvaapply/config \
  qvaapply/data/qvaapply.sqlite \
  qvaapply/data/qvaapply.sqlite-wal \
  qvaapply/data/qvaapply.sqlite-shm 2>/dev/null || true
chmod 600 "$archive"
echo "archivo=$archive"

echo "== retirar contenedor e imagen de TS"
if [[ -f /opt/qvaapply/current/deploy/compose.yaml ]]; then
  (cd /opt/qvaapply/current/deploy && docker compose down --rmi local) || true
fi
docker rm -f qvaapply >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

echo "== conservar backups y datos de auditoría"
echo "Se conservan /opt/qvaapply/data/backups y $ARCHIVE_DIR"
echo "TS retirado. Rollback posible desde la imagen/compose original y el archivo."
