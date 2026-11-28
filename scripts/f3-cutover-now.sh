#!/usr/bin/env bash
# Cutover definitivo: Nginx -> edge, dinero real en Go y TS detenido.
# Deja TS parado (no borrado) para rollback durante la vigilancia.
set -Eeuo pipefail

if [[ "${F3_CONFIRM_CUTOVER:-}" != "yes" ]]; then
  echo "Falta F3_CONFIRM_CUTOVER=yes" >&2
  exit 2
fi

APP_ROOT="/opt/qvaapply-f3-shadow"
RELEASE="$(readlink -f "$APP_ROOT/current")"
COMPOSE="$RELEASE/deploy/compose.f3-shadow.yaml"
CORE_ENV="$APP_ROOT/core.env"
EDGE_ENV="$APP_ROOT/edge.env"
NGINX_CONF="/etc/nginx/sites-available/qvaapply.conf"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NGINX_BACKUP="/tmp/qvaapply.conf.cutover.$STAMP"
CORE_BACKUP="/tmp/core.env.cutover.$STAMP"
EDGE_BACKUP="/tmp/edge.env.cutover.$STAMP"
ORIGIN="https://qvapply.honux.tech"
PSQL=(docker exec -i qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1)
OK=0

export F3_REVISION="$(basename "$RELEASE")"
export F3_CORE_ENV="$CORE_ENV"
export F3_EDGE_ENV="$EDGE_ENV"
export F3_MARKET_ICONS_DIR="$APP_ROOT/market-icons"
export F3_CORE_CONFIG_FILE="$APP_ROOT/data/core-config.json"

compose_up() {
  (cd "$RELEASE" && docker compose --env-file "$APP_ROOT/.env" -f "$COMPOSE" up -d trading-core)
  (cd "$RELEASE" && docker compose --env-file "$APP_ROOT/.env" -f "$COMPOSE" --profile edge up -d edge)
}

wait_http() {
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null --max-time 2 "$1" && return 0
    sleep 1
  done
  return 1
}

rollback() {
  echo "== ROLLBACK" >&2
  cp -a "$NGINX_BACKUP" "$NGINX_CONF"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  cp -a "$CORE_BACKUP" "$CORE_ENV"
  cp -a "$EDGE_BACKUP" "$EDGE_ENV"
  compose_up >/dev/null 2>&1 || true
  docker start qvaapply >/dev/null 2>&1 || true
  echo "rollback: Nginx -> TS, flags seguras, TS arrancado" >&2
}
trap 'if [[ $OK -ne 1 ]]; then rollback; fi' EXIT

echo "== 1. backups"
cp -a "$NGINX_CONF" "$NGINX_BACKUP"
cp -a "$CORE_ENV" "$CORE_BACKUP"
cp -a "$EDGE_ENV" "$EDGE_BACKUP"
systemctl start qvaapply-backup.service || true
for _ in $(seq 1 90); do
  systemctl is-active --quiet qvaapply-backup.service || break
  sleep 2
done
ls -lh /opt/qvaapply/data/backups/qvaapply-*.sqlite | tail -1
echo "nginx_backup=$NGINX_BACKUP"

echo "== 2. saldos fiat reales"
python3 "$RELEASE/scripts/f3-sync-fiat-balances.py"

echo "== 3. activar dinero real"
sed -i 's/^CORE_AUTOTRADE_DRY_RUN=.*/CORE_AUTOTRADE_DRY_RUN=false/' "$CORE_ENV"
sed -i 's/^EDGE_MUTATIONS_LIVE=.*/EDGE_MUTATIONS_LIVE=true/' "$EDGE_ENV"
compose_up >/dev/null
wait_http "http://127.0.0.1:8090/healthz"
wait_http "http://127.0.0.1:8093/healthz"
grep -E '^CORE_AUTOTRADE' "$CORE_ENV"
grep -E '^EDGE_MUTATIONS_LIVE' "$EDGE_ENV"

echo "== 4. conmutar Nginx al edge"
sed -i 's#127\.0\.0\.1:8782#127.0.0.1:8093#' "$NGINX_CONF"
nginx -t
systemctl reload nginx
sleep 2

echo "== 5. detener TS"
docker stop qvaapply >/dev/null

echo "== 6. verificar el dominio servido por Go"
echo -n "root="; curl -k -sS -o /dev/null -w '%{http_code}\n' "$ORIGIN/"
pw=$(sed -n 's/^DASHBOARD_ADMIN_PASSWORD=//p' /opt/qvaapply/config/env | tail -1 | tr -d '\r')
jar=$(mktemp)
login=$(curl -k -sS -c "$jar" -H "Origin: $ORIGIN" -X POST -H 'Content-Type: application/json' \
  --data "{\"password\":\"$pw\"}" "$ORIGIN/api/session")
csrf=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["data"]["csrfToken"])' "$login")
curl -k -sS -b "$jar" "$ORIGIN/api/config" > /tmp/f3-cutover-config.json
curl -k -sS -b "$jar" "$ORIGIN/api/dashboard" > /tmp/f3-cutover-dashboard.json
python3 - <<'PY'
import json
config = json.load(open("/tmp/f3-cutover-config.json"))["data"]
dashboard = json.load(open("/tmp/f3-cutover-dashboard.json"))["data"]
print("config_markets", len(config.get("markets", [])), "version", config.get("version"))
print("balance", dashboard.get("balance"),
      "ownOffers", len(dashboard.get("ownOffers", [])),
      "operations", len(dashboard.get("operations", [])),
      "transactions", len(dashboard.get("transactions", [])))
PY
echo -n "chat="; curl -k -sS -b "$jar" -o /dev/null -w '%{http_code}\n' \
  "$ORIGIN/api/operations/7300365f-f090-4ca6-a545-ce8be903af3a/chat"
echo -n "edge_health="; curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8093/healthz
echo -n "ts_status="; docker inspect -f '{{.State.Status}}' qvaapply
rm -f "$jar"

echo "== 7. observar 20s de operación live"
sleep 20
"${PSQL[@]}" -Atc "select state,count(*) from shadow.core_operations group by state order by state;"
"${PSQL[@]}" -Atc "select uuid,coin,state,amount,coalesce(order_uuid,'') from shadow.local_operations order by updated_at desc limit 5;"
curl -sS http://127.0.0.1:8090/metrics | grep -E '^trading_core_autotrade_applied_total'
docker logs --tail 20 qvaapply-f3-shadow-trading-core 2>&1 | grep -E 'autotrade|aplicación|concili' | tail -5 || true

OK=1
trap - EXIT
echo "== CUTOVER COMPLETADO"
echo "watch_start=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "rollback: cp -a $NGINX_BACKUP $NGINX_CONF && nginx -t && systemctl reload nginx && docker start qvaapply"
