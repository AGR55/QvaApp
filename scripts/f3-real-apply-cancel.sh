#!/usr/bin/env bash
# Ensayo real controlado: aplica una oferta y la cancela.
#
# Congela TS, activa mutaciones live, verifica QvaPay y restaura todo con trap.
# No mueve dinero: aplica y cancela antes de pagar. Para ofertas fijas aplica
# sin cuerpo y cancela sin `order`; para flexibles aplica con importe y usa el
# UUID de orden que devuelve QvaPay.
#
# Requiere confirmación explícita:
#   F3_CONFIRM_REAL=yes F3_OFFER_UUID=<uuid> bash scripts/f3-real-apply-cancel.sh
set -Eeuo pipefail

if [[ "${F3_CONFIRM_REAL:-}" != "yes" ]]; then
  echo "Falta F3_CONFIRM_REAL=yes. Este script aplica una orden real en QvaPay." >&2
  exit 2
fi

APP_ROOT="/opt/qvaapply-f3-shadow"
RELEASE="$(readlink -f "$APP_ROOT/current")"
COMPOSE="$RELEASE/deploy/compose.f3-shadow.yaml"
CORE_ENV="$APP_ROOT/core.env"
EDGE_ENV="$APP_ROOT/edge.env"
ORIGIN="https://qvapply.honux.tech"
OFFER="${F3_OFFER_UUID:?F3_OFFER_UUID requerida}"
EVENT="${F3_EVENT_ID:-dddddddd-dddd-4ddd-8ddd-dddddddddddd}"
COIN="${F3_COIN:-CLASICA}"
SIDE="${F3_SIDE:-buy}"
DECISION="${F3_DECISION:-auto_buy}"
AMOUNT="${F3_AMOUNT:-10}"
RECEIVE="${F3_RECEIVE:-10.6}"
RATE="${F3_RATE:-1.06}"
KIND="${F3_OFFER_KIND:-fixed}"
AVAILABLE="${F3_AVAILABLE:-$AMOUNT}"
PSQL=(docker exec -i qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1)

TS_WAS_RUNNING="$(docker inspect -f '{{.State.Running}}' qvaapply 2>/dev/null || echo false)"
CORE_BACKUP="$(mktemp /tmp/core.env.apply.XXXXXX)"
EDGE_BACKUP="$(mktemp /tmp/edge.env.apply.XXXXXX)"
cp -a "$CORE_ENV" "$CORE_BACKUP"
cp -a "$EDGE_ENV" "$EDGE_BACKUP"

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
  local url=$1
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null --max-time 2 "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

restore() {
  cp -a "$CORE_BACKUP" "$CORE_ENV"
  cp -a "$EDGE_BACKUP" "$EDGE_ENV"
  compose_up >/dev/null 2>&1 || true
  if [[ "$TS_WAS_RUNNING" == "true" ]]; then
    docker start qvaapply >/dev/null 2>&1 || true
  fi
  wait_http "http://127.0.0.1:8090/healthz" || true
  wait_http "http://127.0.0.1:8093/healthz" || true
}
trap restore EXIT

login_edge() {
  local jar=$1
  local pw
  pw=$(sed -n 's/^DASHBOARD_ADMIN_PASSWORD=//p' /opt/qvaapply/config/env | tail -1 | tr -d '\r')
  local body
  body=$(curl -sS -c "$jar" -H "Origin: $ORIGIN" -X POST \
    -H 'Content-Type: application/json' --data "{\"password\":\"$pw\"}" \
    http://127.0.0.1:8093/api/session)
  python3 -c 'import json,sys;print(json.loads(sys.argv[1])["data"]["csrfToken"])' "$body"
}

echo "== 1. backup"
systemctl start qvaapply-backup.service || true
for _ in $(seq 1 90); do
  if ! systemctl is-active --quiet qvaapply-backup.service; then break; fi
  sleep 2
done
ls -lh /opt/qvaapply/data/backups/qvaapply-*.sqlite | tail -1

echo "== 2. sincronizar saldos fiat"
python3 "$RELEASE/scripts/f3-sync-fiat-balances.py"

echo "== 3. congelar TS"
docker stop qvaapply >/dev/null

echo "== 4. activar dinero real"
sed -i 's/^CORE_AUTOTRADE_DRY_RUN=.*/CORE_AUTOTRADE_DRY_RUN=false/' "$CORE_ENV"
sed -i 's/^EDGE_MUTATIONS_LIVE=.*/EDGE_MUTATIONS_LIVE=true/' "$EDGE_ENV"
compose_up >/dev/null
wait_http "http://127.0.0.1:8090/healthz"
wait_http "http://127.0.0.1:8093/healthz"
grep -E '^CORE_AUTOTRADE' "$CORE_ENV"
grep -E '^EDGE_MUTATIONS_LIVE' "$EDGE_ENV"

echo "== 5. insertar evento de la oferta $OFFER"
cat > /tmp/f3-event.sql <<SQL
INSERT INTO shadow.hunter_events
  (event_id, offer_uuid, coin, side, decision, rate, payload_json, state, attempts, available_at, created_at)
VALUES
  ('$EVENT', '$OFFER', '$COIN', '$SIDE', '$DECISION', '$RATE',
   json_build_object('offerUuid', '$OFFER', 'coin', '$COIN', 'side', '$SIDE',
     'decision', '$DECISION', 'amount', '$AMOUNT', 'receive', '$RECEIVE',
     'rate', '$RATE', 'offerKind', '$KIND', 'available', '$AVAILABLE')::text,
   'pending', 0, 0, (extract(epoch from now())*1000)::bigint)
ON CONFLICT (event_id) DO NOTHING;
SQL
"${PSQL[@]}" < /tmp/f3-event.sql

echo "== 6. esperar aplicación"
state=""
for _ in $(seq 1 40); do
  state=$("${PSQL[@]}" -Atc "select state from shadow.core_operations where operation_id='$EVENT';" | tr -d '[:space:]')
  case "$state" in
    confirmed|rejected|uncertain) break ;;
  esac
  sleep 1
done
"${PSQL[@]}" -Atc "select operation_id,state,qusd_amount,fiat_amount,coalesce(order_uuid,'') from shadow.core_operations where operation_id='$EVENT';"
if [[ "$state" != "confirmed" ]]; then
  echo "ERROR: la aplicación terminó en estado '$state'" >&2
  exit 1
fi

echo "== 7. verificar QvaPay antes de cancelar"
jar=$(mktemp)
csrf=$(login_edge "$jar")
curl -sS -b "$jar" -H "Origin: $ORIGIN" -H "X-CSRF-Token: $csrf" \
  -X POST -H 'Content-Type: application/json' --data '{}' \
  "http://127.0.0.1:8093/api/workflows/$OFFER/reconcile" | tee /tmp/f3-reconcile-before.json | python3 -m json.tool | sed -n '1,30p'

echo "== 8. cancelar la aplicación"
status=$(curl -sS -b "$jar" -H "Origin: $ORIGIN" -H "X-CSRF-Token: $csrf" \
  -X POST -H 'Content-Type: application/json' --data '{}' \
  -o /tmp/f3-cancel.json -w '%{http_code}' \
  "http://127.0.0.1:8093/api/operations/$OFFER/cancel")
echo "cancel_http=$status"
cat /tmp/f3-cancel.json || true

echo "== 9. verificar QvaPay después de cancelar"
sleep 2
curl -sS -b "$jar" -H "Origin: $ORIGIN" -H "X-CSRF-Token: $csrf" \
  -X POST -H 'Content-Type: application/json' --data '{}' \
  "http://127.0.0.1:8093/api/workflows/$OFFER/reconcile" | tee /tmp/f3-reconcile-after.json | python3 -m json.tool | sed -n '1,30p'
rm -f "$jar"

echo "== 10. marcar operación como conciliada tras cancelar"
"${PSQL[@]}" -Atc "update shadow.core_operations set state='reconciled', updated_at=(extract(epoch from now())*1000)::bigint where operation_id='$EVENT' and state='confirmed'; select operation_id,state from shadow.core_operations where operation_id='$EVENT';"

echo "== 11. restaurar banderas seguras y TS"
restore
trap - EXIT
sleep 3
echo -n "edge_live="; grep '^EDGE_MUTATIONS_LIVE=' "$EDGE_ENV"
echo -n "core_dry_run="; grep '^CORE_AUTOTRADE_DRY_RUN=' "$CORE_ENV"
echo -n "ts_status="; docker inspect -f '{{.State.Status}}' qvaapply
echo -n "prod="; curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8782/api/session
