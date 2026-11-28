#!/usr/bin/env bash
# Comprobación de vigilancia del cutover. Solo lee: no muta dinero ni cambia
# banderas. Devuelve 0 si todo está sano y 1 si hay un fallo crítico.
set -Eeuo pipefail

APP_ROOT="/opt/qvaapply-f3-shadow"
ORIGIN="https://qvapply.honux.tech"
PSQL=(docker exec -i qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -Atc)
failures=0
warnings=0

pass() { echo "[ OK ] $*"; }
warn() { echo "[WARN] $*"; warnings=$((warnings + 1)); }
fail() { echo "[FAIL] $*"; failures=$((failures + 1)); }

echo "== identidad y banderas"
status=$(docker inspect -f '{{.State.Status}}' qvaapply 2>/dev/null || echo missing)
if [[ "$status" == "exited" ]]; then
  pass "TS detenido (exited)"
else
  fail "TS no está detenido: $status"
fi
if grep -q 'proxy_pass http://127.0.0.1:8093' /etc/nginx/sites-available/qvaapply.conf; then
  pass "Nginx apunta al edge"
else
  fail "Nginx no apunta al edge"
fi
grep -q '^CORE_AUTOTRADE_DRY_RUN=false' "$APP_ROOT/core.env" &&
  pass "core en modo real" || fail "core no está en modo real"
grep -q '^EDGE_MUTATIONS_LIVE=true' "$APP_ROOT/edge.env" &&
  pass "edge con mutaciones live" || fail "edge sin mutaciones live"

echo "== contenedores"
for container in qvaapply-f3-shadow-postgres qvaapply-f3-shadow-trading-core \
  qvaapply-f3-shadow-hunter qvaapply-f3-shadow-notifier qvaapply-f3-shadow-edge; do
  state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || echo missing)
  case "$state" in
    "running healthy") pass "$container" ;;
    running*) warn "$container sin healthcheck o iniciando: $state" ;;
    *) fail "$container: $state" ;;
  esac
done

echo "== web"
root=$(curl -k -sS -o /dev/null -w '%{http_code}' "$ORIGIN/" || echo 000)
[[ "$root" == "200" ]] && pass "dominio $root" || fail "dominio $root"
edge=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8093/healthz || echo 000)
[[ "$edge" == "200" ]] && pass "edge health $edge" || fail "edge health $edge"

password=$(sed -n 's/^DASHBOARD_ADMIN_PASSWORD=//p' /opt/qvaapply/config/env | tail -1 | tr -d '\r')
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
login=$(curl -k -sS -c "$jar" -H "Origin: $ORIGIN" -X POST -H 'Content-Type: application/json' \
  --data "{\"password\":\"$password\"}" "$ORIGIN/api/session" || true)
csrf=$(python3 -c 'import json,sys
try:
    print(json.loads(sys.argv[1])["data"]["csrfToken"])
except Exception:
    print("")' "$login")
[[ -n "$csrf" ]] && pass "login y CSRF" || fail "login o CSRF"
config_code=$(curl -k -sS -b "$jar" -o /tmp/f3-watch-config.json -w '%{http_code}' "$ORIGIN/api/config" || echo 000)
[[ "$config_code" == "200" ]] && pass "config $config_code" || fail "config $config_code"
dash_code=$(curl -k -sS -b "$jar" -o /tmp/f3-watch-dashboard.json -w '%{http_code}' "$ORIGIN/api/dashboard" || echo 000)
if [[ "$dash_code" == "200" ]]; then
  pass "dashboard $dash_code"
  python3 - <<'PY'
import json
data = json.load(open("/tmp/f3-watch-dashboard.json"))["data"]
print("       balance", data.get("balance"),
      "ownOffers", len(data.get("ownOffers", [])),
      "operations", len(data.get("operations", [])),
      "transactions", len(data.get("transactions", [])))
PY
else
  fail "dashboard $dash_code"
fi

echo "== operaciones"
uncertain=$("${PSQL[@]}" "select count(*) from shadow.core_operations where state='uncertain';" | tr -d '[:space:]')
[[ "$uncertain" == "0" ]] && pass "sin operaciones inciertas" || warn "operaciones inciertas: $uncertain"
reserved=$("${PSQL[@]}" "select count(*) from shadow.core_operations where state in ('reserved','submitted');" | tr -d '[:space:]')
[[ "$reserved" == "0" ]] && pass "sin operaciones a medias" || warn "operaciones reserved/submitted: $reserved"
pending=$("${PSQL[@]}" "select count(*) from shadow.hunter_events where state='pending';" | tr -d '[:space:]')
[[ "$pending" == "0" ]] && pass "sin eventos pendientes" || warn "eventos pendientes: $pending"
applied=$(curl -sS http://127.0.0.1:8090/metrics | awk '/^trading_core_autotrade_applied_total/{print $2}')
echo "       aplicaciones reales desde el arranque: ${applied:-?}"
fiat_rows=$("${PSQL[@]}" "select count(*) from shadow.fiat_ledger;" | tr -d '[:space:]')
echo "       movimientos fiat registrados: ${fiat_rows:-?}"

echo "== backup y disco"
latest=$(find /opt/qvaapply/data/backups -maxdepth 1 -name 'qvaapply-*.sqlite' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
if [[ -n "$latest" ]]; then
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))
  if (( age_hours <= 48 )); then
    pass "backup reciente: $(basename "$latest") (${age_hours}h)"
  else
    warn "backup con ${age_hours}h: $latest"
  fi
else
  fail "sin backup SQLite"
fi
disk=$(df --output=pcent /opt/qvaapply/data | tail -1 | tr -dc '0-9')
if (( disk < 85 )); then pass "disco ${disk}%"; else warn "disco ${disk}%"; fi

echo
echo "Resumen: $failures fallos, $warnings avisos"
if (( failures > 0 )); then
  exit 1
fi
exit 0
