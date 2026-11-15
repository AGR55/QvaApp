#!/usr/bin/env bash
# Despliega trading-core F3 en modo shadow dentro de la VPS.
#
# Uso (como root, en la VPS):
#   deploy-f3-shadow.sh <release.tar.gz> <revision>
#
# Este script administra exclusivamente /opt/qvaapply-f3-shadow. No modifica
# /opt/qvaapply, no reemplaza el contenedor Node `qvaapply`, no publica puertos
# fuera de loopback y nunca elimina los volúmenes de Postgres.
set -Eeuo pipefail

archive=${1:?Falta el archivo de release}
revision=${2:?Falta la revisión Git}

readonly app_root="/opt/qvaapply-f3-shadow"
export F3_MARKET_ICONS_DIR="$app_root/market-icons"
readonly prod_root="/opt/qvaapply"
readonly shadow_port=8090
release_dir="$app_root/releases/$revision"
env_file="$app_root/.env"
compose_rel="deploy/compose.f3-shadow.yaml"

if (( EUID != 0 )); then
  echo "El despliegue debe ejecutarse como root." >&2
  exit 2
fi

# Salvaguarda explícita: este script jamás debe operar sobre producción.
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

for command_name in docker curl openssl flock tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done

if [[ ! $revision =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "La revisión no es un nombre seguro: $revision" >&2
  exit 2
fi
if [[ ! -f $archive ]]; then
  echo "No existe el archivo de release: $archive" >&2
  exit 2
fi

install -d -m 755 "$app_root" "$app_root/releases"

exec 9>"$app_root/deploy.lock"
if ! flock -n 9; then
  echo "Ya hay otro despliegue de qvaapply-f3-shadow en curso." >&2
  exit 1
fi

# Contraseña propia del shadow. Solo se genera la primera vez; si el archivo
# ya existe se respeta para no perder acceso a una base ya inicializada.
umask 077
if [[ ! -f $env_file ]]; then
  temporary_env=$(mktemp "$app_root/.env.XXXXXX")
  printf 'F3_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$temporary_env"
  chmod 600 "$temporary_env"
  mv -f "$temporary_env" "$env_file"
  echo "Creado $env_file con una contraseña aleatoria." >&2
fi
chmod 600 "$env_file"

shadow_password=$(sed -n 's/^[[:space:]]*F3_POSTGRES_PASSWORD=//p' "$env_file" | tail -n 1 | tr -d '\r')
shadow_password=${shadow_password#\"}
shadow_password=${shadow_password%\"}
if [[ -z $shadow_password ]]; then
  echo "Falta F3_POSTGRES_PASSWORD en $env_file" >&2
  exit 2
fi
export F3_POSTGRES_PASSWORD="$shadow_password"
export F3_REVISION="$revision"

compose_for() {
  local file=$1
  shift
  docker compose --env-file "$env_file" -f "$file" "$@"
}

install -d -m 755 "$release_dir"
tar -xzf "$archive" -C "$release_dir"

compose_file="$release_dir/$compose_rel"
migration_file="$release_dir/services/db/migrations/0004_shadow.sql"
invariants_migration_file="$release_dir/services/db/migrations/0005_invariants.sql"
soak_migration_file="$release_dir/services/db/migrations/0006_soak.sql"
qvapay_migration_file="$release_dir/services/db/migrations/0007_qvapay.sql"
offers_migration_file="$release_dir/services/db/migrations/0008_qvapay_offers.sql"
hunter_migration_file="$release_dir/services/db/migrations/0009_hunter.sql"
hunter_events_migration_file="$release_dir/services/db/migrations/0010_hunter_events.sql"
hunter_source_migration_file="$release_dir/services/db/migrations/0011_hunter_source.sql"
core_decisions_migration_file="$release_dir/services/db/migrations/0012_core_decisions.sql"
core_executions_migration_file="$release_dir/services/db/migrations/0013_core_executions.sql"
core_operations_migration_file="$release_dir/services/db/migrations/0014_core_operations.sql"
push_subscriptions_migration_file="$release_dir/services/db/migrations/0015_push_subscriptions.sql"
transactions_migration_file="$release_dir/services/db/migrations/0016_qvapay_transactions.sql"
runtime_config_migration_file="$release_dir/services/db/migrations/0017_runtime_config.sql"
if [[ ! -f $compose_file || ! -f $release_dir/services/trading-core/Dockerfile.binary ]]; then
  echo "El archivo de release no contiene el despliegue F3 esperado." >&2
  exit 2
fi
if [[ ! -f $migration_file || ! -f $invariants_migration_file || ! -f $soak_migration_file || ! -f $qvapay_migration_file || ! -f $offers_migration_file || ! -f $hunter_migration_file || ! -f $hunter_events_migration_file || ! -f $hunter_source_migration_file || ! -f $core_decisions_migration_file || ! -f $core_executions_migration_file || ! -f $core_operations_migration_file || ! -f $push_subscriptions_migration_file || ! -f $transactions_migration_file || ! -f $runtime_config_migration_file ]]; then
  echo "El release no contiene las migraciones shadow 0004/0005/0006/0007/0008/0009/0010/0011/0012/0013/0014/0015/0016/0017." >&2
  exit 2
fi

# Genera una única vez el par VAPID del shadow. No se imprime por stdout ni se
# commitea; queda en un archivo 600 reutilizado por notifier y edge.
push_env="$app_root/push.env"
if [[ ! -s $push_env ]]; then
  temporary_push=$(mktemp "$app_root/push.env.XXXXXX")
  python3 "$release_dir/scripts/f3-generate-vapid.py" > "$temporary_push"
  chmod 600 "$temporary_push"
  mv -f "$temporary_push" "$push_env"
fi
chmod 600 "$push_env"
export F3_NOTIFIER_ENV="$push_env"

# Valida la interpolación antes de construir.
compose_for "$compose_file" config -q

previous_release=""
if [[ -L $app_root/current ]]; then
  previous_release=$(readlink -f "$app_root/current" 2>/dev/null || true)
fi

if ! compose_for "$compose_file" build; then
  echo "Falló la construcción de la imagen shadow; se conserva la release activa." >&2
  exit 1
fi

# Aplica la migración (idempotente) antes de activar la release. Si falla,
# /opt/qvaapply-f3-shadow/current sigue apuntando a la release anterior y no
# se levanta ningún contenedor nuevo.
if ! compose_for "$compose_file" run --rm -T shadow-migrate; then
  echo "Falló la migración shadow; se conserva la release activa." >&2
  exit 1
fi

# Siembra una única vez la configuración editable desde el SQLite de
# producción. Los redeploys no sobrescriben cambios hechos desde el panel.
if [[ -r /opt/qvaapply/data/qvaapply.sqlite ]]; then
  runtime_config=$(python3 "$release_dir/scripts/f3-export-runtime-config.py" /opt/qvaapply/data/qvaapply.sqlite)
  if [[ -n $runtime_config ]]; then
    docker exec -i qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -v ON_ERROR_STOP=1 -v config="$runtime_config" <<'SQL'
WITH inserted AS (
  INSERT INTO shadow.runtime_config (id, config_json, version, reason, updated_by, updated_at)
  VALUES (1, :'config'::jsonb, 1, 'Configuración inicial desde producción', 'deploy', (extract(epoch from now()) * 1000)::bigint)
  ON CONFLICT (id) DO NOTHING
  RETURNING version, config_json, reason, updated_by, updated_at
)
INSERT INTO shadow.runtime_config_revisions (version, config_json, reason, updated_by, created_at)
SELECT version, config_json, reason, updated_by, updated_at FROM inserted;
SQL
  fi
fi

# Prepara el hunter long-running con secretos y config fuera del repositorio.
hunter_enabled=false
hunter_env="$app_root/hunter.env"
hunter_data_dir="$app_root/data"
prod_env="/opt/qvaapply/config/env"
prod_db="/opt/qvaapply/data/qvaapply.sqlite"
if [[ -r $prod_env && -r $prod_db ]]; then
  # Reutiliza el par VAPID de producción para que las suscripciones Push sigan
  # siendo válidas tras el cutover. El archivo es 600 y nunca se imprime.
  python3 - "$prod_db" "$push_env" <<'PY' || true
import json
import os
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
row = connection.execute("SELECT value FROM settings WHERE key = 'web_push:vapid_keys'").fetchone()
connection.close()
if row:
    keys = json.loads(row[0])
    public = keys.get("publicKey")
    private = keys.get("privateKey")
    if isinstance(public, str) and isinstance(private, str) and public and private:
        target = sys.argv[2]
        temporary = target + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(f"WEB_PUSH_PUBLIC_KEY={public}\n")
            handle.write(f"WEB_PUSH_PRIVATE_KEY={private}\n")
            handle.write("WEB_PUSH_SUBJECT=mailto:admin@qvapply.honux.tech\n")
            handle.write("PUSH_SEND_ENABLED=true\n")
            handle.write(f"EDGE_PUSH_PUBLIC_KEY={public}\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
PY
  local_key=$(sed -n 's/^[[:space:]]*LOCAL_ENCRYPTION_KEY=//p' "$prod_env" | tail -n 1 | tr -d '\r')
  local_key=${local_key#\"}
  local_key=${local_key%\"}
  encrypted_token=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
    "SELECT value FROM settings WHERE key = 'qvapay_token';" | tr -d '\r')
  encrypted_app_id=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
    "SELECT value FROM settings WHERE key = 'market_feed_app_id';" | tr -d '\r')
  encrypted_app_secret=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
    "SELECT value FROM settings WHERE key = 'market_feed_app_secret';" | tr -d '\r')
  if [[ $local_key =~ ^[a-fA-F0-9]{64}$ && -n $encrypted_token ]]; then
    install -d -m 700 "$hunter_data_dir"
    temporary_env=$(mktemp "$app_root/hunter.env.XXXXXX")
    {
      printf 'LOCAL_ENCRYPTION_KEY=%s\n' "$local_key"
      printf 'QVA_TOKEN_CIPHERTEXT=%s\n' "$encrypted_token"
      if [[ -n $encrypted_app_id && -n $encrypted_app_secret ]]; then
        printf 'QVA_APP_ID_CIPHERTEXT=%s\n' "$encrypted_app_id"
        printf 'QVA_APP_SECRET_CIPHERTEXT=%s\n' "$encrypted_app_secret"
      fi
    } > "$temporary_env"
    chmod 600 "$temporary_env"
    mv -f "$temporary_env" "$hunter_env"
    markets=$(sqlite3 -readonly -json "file:${prod_db}?mode=ro" \
      "SELECT code, active, buy_max_rate, sell_min_rate, purchase_max_qusd, outgoing_transfer_fee, hunt_buy_enabled, hunt_sell_enabled FROM market_config ORDER BY code;")
    [[ -n $markets ]] || markets='[]'
    temporary_config=$(mktemp "$hunter_data_dir/hunter-config.XXXXXX")
    printf '{"price_guard_percent":15,"markets":%s}\n' "$markets" > "$temporary_config"
    chmod 644 "$temporary_config"
    mv -f "$temporary_config" "$hunter_data_dir/hunter-config.json"
    risk=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_object('max_qusd_per_operation', max_qusd_per_operation, 'max_concurrent_qusd_exposure', max_concurrent_qusd_exposure, 'max_daily_applied_qusd', max_daily_applied_qusd, 'max_concurrent_operations', max_concurrent_operations, 'min_qusd_reserve', min_qusd_reserve, 'max_quote_age_seconds', max_quote_age_seconds, 'min_expected_margin_percent', min_expected_margin_percent, 'max_slippage_percent', max_slippage_percent, 'max_consecutive_errors', max_consecutive_errors, 'market_cooldown_seconds', market_cooldown_seconds, 'counterparty_cooldown_seconds', counterparty_cooldown_seconds) FROM risk_config WHERE id = 1;")
    core_markets=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_group_array(json_object('code', code, 'active', active, 'buy_max_rate', buy_max_rate, 'sell_min_rate', sell_min_rate, 'purchase_max_qusd', purchase_max_qusd, 'sell_fee_percent', sell_fee_percent, 'outgoing_transfer_fee', outgoing_transfer_fee, 'hunt_buy_enabled', hunt_buy_enabled, 'hunt_sell_enabled', hunt_sell_enabled)) FROM market_config ORDER BY code;")
    core_fiat=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_group_array(json_object('key', key, 'value', value)) FROM (SELECT key, value FROM settings WHERE key LIKE 'fiat_balance:%' ORDER BY key);")
    [[ -n $risk ]] || risk='{}'
    [[ -n $core_markets ]] || core_markets='[]'
    [[ -n $core_fiat ]] || core_fiat='[]'
    temporary_core_config=$(mktemp "$hunter_data_dir/core-config.XXXXXX")
    printf '{"risk":%s,"markets":%s,"fiat":%s}\n' "$risk" "$core_markets" "$core_fiat" > "$temporary_core_config"
    chmod 644 "$temporary_core_config"
    mv -f "$temporary_core_config" "$hunter_data_dir/core-config.json"
    edge_password=$(sed -n 's/^[[:space:]]*DASHBOARD_ADMIN_PASSWORD=//p' "$prod_env" | tail -n 1 | tr -d '\r')
    edge_password=${edge_password#\"}
    edge_password=${edge_password%\"}
    if [[ -n $edge_password ]]; then
      trusted_origin=$(sed -n 's/^[[:space:]]*DASHBOARD_TRUSTED_ORIGIN=//p' "$prod_env" | tail -n 1 | tr -d '\r')
      trusted_origin=${trusted_origin#\"}
      trusted_origin=${trusted_origin%\"}
      temporary_edge_env=$(mktemp "$app_root/edge.env.XXXXXX")
      {
        printf 'EDGE_ADMIN_PASSWORD=%s\n' "$edge_password"
        printf 'EDGE_SESSION_SECRET=%s\n' "$local_key"
        printf 'EDGE_SECURE_COOKIES=false\n'
        printf 'EDGE_TRUSTED_ORIGIN=%s\n' "$trusted_origin"
        printf 'LOCAL_ENCRYPTION_KEY=%s\n' "$local_key"
        push_public=$(sed -n 's/^WEB_PUSH_PUBLIC_KEY=//p' "$push_env" | tail -n 1 | tr -d '\r')
        if [[ -n $push_public ]]; then
          printf 'EDGE_PUSH_PUBLIC_KEY=%s\n' "$push_public"
        fi
      } > "$temporary_edge_env"
      chmod 600 "$temporary_edge_env"
      mv -f "$temporary_edge_env" "$app_root/edge.env"
    fi
    # Snapshot público de operadores móviles: solo campos que el panel puede
    # mostrar. tokenHash y las ventanas de rate limit nunca salen de producción.
    operators=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_group_array(json_object('id', json_extract(value,'\$.id'), 'label', json_extract(value,'\$.label'), 'scopes', json(json_extract(value,'\$.scopes')), 'createdAt', json_extract(value,'\$.createdAt'), 'revokedAt', json_extract(value,'\$.revokedAt'))) FROM json_each((SELECT value FROM settings WHERE key = 'mobile_operators_v1'));")
    [[ -n $operators ]] || operators='[]'
    temporary_operators=$(mktemp "$app_root/operators.XXXXXX")
    printf '%s\n' "$operators" > "$temporary_operators"
    chmod 644 "$temporary_operators"
    mv -f "$temporary_operators" "$app_root/operators.json"
    # Metadatos de hilos de chat (sin mensajes): solo lectura para el panel.
    threads=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_group_array(json(payload_json)) FROM (SELECT payload_json FROM chat_threads ORDER BY updated_at DESC LIMIT 500);")
    [[ -n $threads ]] || threads='[]'
    temporary_threads=$(mktemp "$app_root/chat-threads.XXXXXX")
    printf '%s\n' "$threads" > "$temporary_threads"
    chmod 644 "$temporary_threads"
    mv -f "$temporary_threads" "$app_root/chat-threads.json"
    # Hashes de credenciales móviles. El archivo es privado (600) y el edge solo
    # compara sha256(token); nunca publica ni registra estos valores.
    mobile_auth=$(sqlite3 -readonly -noheader "file:${prod_db}?mode=ro" \
      "SELECT json_object('devices', (SELECT json_group_array(json_object('tokenHash', token_hash, 'revokedAt', revoked_at)) FROM sms_devices), 'operators', (SELECT json_group_array(json_object('id', json_extract(value,'\$.id'), 'tokenHash', json_extract(value,'\$.tokenHash'), 'scopes', json(json_extract(value,'\$.scopes')), 'revokedAt', json_extract(value,'\$.revokedAt'))) FROM json_each((SELECT value FROM settings WHERE key = 'mobile_operators_v1'))), 'receipts', (SELECT json_group_array(json_object('id', id, 'status', state, 'receivedAt', received_at, 'operationUuid', operation_uuid, 'reason', reason)) FROM (SELECT id, state, received_at, operation_uuid, reason FROM payment_receipts ORDER BY created_at DESC LIMIT 100)));")
    [[ -n $mobile_auth ]] || mobile_auth='{"devices":[],"operators":[],"receipts":[]}'
    temporary_mobile_auth=$(mktemp "$app_root/mobile-auth.XXXXXX")
    printf '%s\n' "$mobile_auth" > "$temporary_mobile_auth"
    # El edge corre como UID 65532 en una imagen distroless; el archivo debe
    # pertenecerle para poder leerlo sin abrirlo al resto de usuarios.
    chown 65532:65532 "$temporary_mobile_auth"
    chmod 600 "$temporary_mobile_auth"
    mv -f "$temporary_mobile_auth" "$app_root/mobile-auth.json"
    # Snapshot público para rutas GET de lectura del dashboard. El exportador
    # solo emite campos visibles y nunca tokens, hashes, teléfonos ni chats.
    dashboard_snapshot=$(python3 "$release_dir/scripts/f3-export-dashboard-snapshot.py" "$prod_db")
    if [[ -z $dashboard_snapshot ]]; then
      dashboard_snapshot='{"generatedAt":0,"devices":[],"receipts":[],"fiatHistory":[],"rebalanceJobs":[],"marketObservations":[],"analyticsFees":[]}'
    fi
    temporary_dashboard=$(mktemp "$app_root/dashboard-snapshot.XXXXXX")
    printf '%s\n' "$dashboard_snapshot" > "$temporary_dashboard"
    chmod 644 "$temporary_dashboard"
    mv -f "$temporary_dashboard" "$app_root/dashboard-snapshot.json"
    python3 - "$app_root/dashboard-snapshot.json" "$app_root/operational-health.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    snapshot = json.load(source)
health = snapshot.get("operationalHealth") or {}
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(health, target, ensure_ascii=False, separators=(",", ":"))
PY
    chmod 644 "$app_root/operational-health.json"
    web_extras=$(python3 "$release_dir/scripts/f3-export-web-extras.py" "$prod_db")
    if [[ -n $web_extras ]]; then
      temporary_extras=$(mktemp "$app_root/web-extras.XXXXXX")
      printf '%s\n' "$web_extras" > "$temporary_extras"
      chmod 644 "$temporary_extras"
      mv -f "$temporary_extras" "$app_root/web-extras.json"
      python3 - "$app_root/web-extras.json" "$app_root/cooperative.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    extras = json.load(source)
with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(extras.get("cooperative") or {}, target, ensure_ascii=False, separators=(",", ":"))
PY
      chmod 644 "$app_root/cooperative.json"
    fi
    hunter_enabled=true
    unset local_key encrypted_token encrypted_app_id encrypted_app_secret edge_password trusted_origin
  fi
fi
export F3_HUNTER_ENV="$hunter_env"
export F3_HUNTER_DATA_DIR="$hunter_data_dir"
export F3_HUNTER_CONFIG_FILE="$hunter_data_dir/hunter-config.json"
export F3_CORE_CONFIG_FILE="$hunter_data_dir/core-config.json"
export F3_EDGE_ENV="$app_root/edge.env"
if [[ -s "$app_root/operators.json" ]]; then
  export F3_OPERATORS_FILE="$app_root/operators.json"
fi
if [[ -s "$app_root/chat-threads.json" ]]; then
  export F3_CHAT_THREADS_FILE="$app_root/chat-threads.json"
fi
if [[ -s "$app_root/mobile-auth.json" ]]; then
  export F3_MOBILE_AUTH_FILE="$app_root/mobile-auth.json"
fi
if [[ -s "$app_root/dashboard-snapshot.json" ]]; then
  export F3_DASHBOARD_SNAPSHOT_FILE="$app_root/dashboard-snapshot.json"
fi
if [[ -s "$app_root/operational-health.json" ]]; then
  export F3_OPERATIONAL_HEALTH_FILE="$app_root/operational-health.json"
fi
if [[ -s "$app_root/web-extras.json" ]]; then
  export F3_WEB_EXTRAS_FILE="$app_root/web-extras.json"
fi
if [[ -s "$app_root/cooperative.json" ]]; then
  export F3_COOPERATIVE_FILE="$app_root/cooperative.json"
fi
install -d -m 755 "$app_root/market-icons"
chown 65532:65532 "$app_root/market-icons" 2>/dev/null || true

ln -sfn "$release_dir" "$app_root/current.next"
mv -Tf "$app_root/current.next" "$app_root/current"

started=true
if [[ $hunter_enabled == true ]]; then
  if ! compose_for "$compose_file" --profile hunter --profile notifier --profile edge up -d --remove-orphans; then
    started=false
  fi
else
  echo "Hunter deshabilitado: no hay token QvaPay utilizable." >&2
  if ! compose_for "$compose_file" --profile notifier --profile edge up -d --remove-orphans; then
    started=false
  fi
fi

healthy=false
for _ in {1..60}; do
  [[ $started == true ]] || break
  if curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:${shadow_port}/healthz" >/dev/null \
    && curl --fail --silent --show-error --max-time 3 \
      "http://127.0.0.1:${shadow_port}/readyz" >/dev/null; then
    if [[ $hunter_enabled != true ]]; then
      healthy=true
      break
    fi
    if curl --fail --silent --show-error --max-time 3 \
        "http://127.0.0.1:8091/healthz" >/dev/null \
      && curl --fail --silent --show-error --max-time 3 \
        "http://127.0.0.1:8091/readyz" >/dev/null \
      && curl --fail --silent --show-error --max-time 3 \
        "http://127.0.0.1:8092/healthz" >/dev/null \
      && curl --fail --silent --show-error --max-time 3 \
        "http://127.0.0.1:8093/healthz" >/dev/null; then
      healthy=true
      break
    fi
    # Hunter aún arrancando: seguir esperando, no abortar el bucle.
  fi
  sleep 2
done

if [[ $healthy != true ]]; then
  echo "La nueva release shadow no superó /healthz y /readyz." >&2
  compose_for "$compose_file" logs --no-color --tail=100 >&2 || true

  if [[ -n $previous_release && -d $previous_release && $previous_release != "$release_dir" ]]; then
    ln -sfn "$previous_release" "$app_root/current.next"
    mv -Tf "$app_root/current.next" "$app_root/current"
    F3_REVISION=$(basename "$previous_release")
    export F3_REVISION
    if compose_for "$previous_release/$compose_rel" --profile hunter --profile notifier --profile edge up -d --build --remove-orphans; then
      echo "Se restauró la release anterior: $previous_release" >&2
    else
      echo "No se pudo restaurar la release anterior: $previous_release" >&2
    fi
  else
    # `down` sin --volumes: el volumen de Postgres se conserva.
    compose_for "$compose_file" down || true
    rm -f "$app_root/current"
    echo "No había una release anterior; el shadow quedó detenido. Los volúmenes se conservan." >&2
  fi
  exit 1
fi

echo "trading-core shadow desplegado en $release_dir"
echo "  healthz: http://127.0.0.1:${shadow_port}/healthz"
echo "  readyz:  http://127.0.0.1:${shadow_port}/readyz"
echo "  metrics: http://127.0.0.1:${shadow_port}/metrics"
if [[ $hunter_enabled == true ]]; then
  echo "  hunter:  http://127.0.0.1:8091/metrics"
  echo "  notifier: http://127.0.0.1:8092/metrics"
  echo "  edge:     http://127.0.0.1:8093/metrics"
fi
