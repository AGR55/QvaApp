#!/usr/bin/env bash
# Auditoría estática de paridad de rutas entre el monolito TS y el edge Go.
#
# No ejecuta servidores, no consulta la base de datos y no modifica archivos.
# Sólo lee el código fuente y compara las rutas declaradas.
#
# Uso:
#   scripts/f3-edge-route-audit.sh
#   scripts/f3-edge-route-audit.sh --json
#
# Códigos de salida:
#   0  el escaneo produjo rutas en ambos lados (aunque falten rutas por portar)
#   2  faltan archivos o el escaneo no pudo extraer rutas
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

TS_FILE="${ROOT_DIR}/src/http-dashboard.ts"
EDGE_MAIN="${ROOT_DIR}/services/trading-core/cmd/edge/main.go"
EDGE_DIR="${ROOT_DIR}/services/trading-core/internal/edge"

JSON=0

usage() {
  cat <<'EOF'
Uso: scripts/f3-edge-route-audit.sh [--json]

Audita estáticamente la paridad de rutas entre:
  - src/http-dashboard.ts (monolito TS, Fastify)
  - services/trading-core/cmd/edge/main.go
  - services/trading-core/internal/edge/*.go (sin *_test.go)

Salida humana por defecto. Con --json emite un documento JSON parseable.

Normalización:
  - :id, :uuid y cualquier :parametro se comparan como :param
  - comodines (*) se comparan como :wildcard
  - los métodos HEAD se contabilizan como GET

Códigos de salida:
  0  escaneo correcto (puede haber rutas pendientes)
  2  faltan archivos o no se pudieron extraer rutas

No imprime secretos: sólo rutas y métodos.
EOF
}

for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      usage
      exit 0
      ;;
    --json)
      JSON=1
      ;;
    *)
      printf 'Opción desconocida: %s\n\n' "${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -r "${TS_FILE}" ]]; then
  printf 'ERROR: no existe o no es legible %s\n' "${TS_FILE}" >&2
  exit 2
fi
if [[ ! -r "${EDGE_MAIN}" ]]; then
  printf 'ERROR: no existe o no es legible %s\n' "${EDGE_MAIN}" >&2
  exit 2
fi
if [[ ! -d "${EDGE_DIR}" ]]; then
  printf 'ERROR: no existe el directorio %s\n' "${EDGE_DIR}" >&2
  exit 2
fi

EDGE_FILES=()
while IFS= read -r file; do
  EDGE_FILES+=("${file}")
done < <(find "${EDGE_DIR}" -maxdepth 1 -type f -name '*.go' ! -name '*_test.go' | sort)

if [[ ${#EDGE_FILES[@]} -eq 0 ]]; then
  printf 'ERROR: no se encontraron archivos Go en %s\n' "${EDGE_DIR}" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/f3-edge-route-audit.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT

# ---------------------------------------------------------------------------
# Normalización
# ---------------------------------------------------------------------------
normalize_path() {
  local path="$1"

  # Sin query string ni fragmento (las rutas extraídas no los incluyen, pero
  # se recorta por robustez).
  path="${path%%\?*}"
  path="${path%%#*}"

  # Colapsa barras duplicadas.
  path="$(printf '%s' "${path}" | sed -E 's#/{2,}#/#g')"

  # Quita la barra final salvo en la raíz.
  if [[ "${path}" != "/" && "${path}" == */ ]]; then
    path="${path%/}"
  fi

  # Cualquier parámetro con nombre se compara como :param.
  path="$(printf '%s' "${path}" | sed -E 's#/:[^/]+#/:param#g')"

  # Comodines: * y ** se comparan como :wildcard.
  path="$(printf '%s' "${path}" | sed -E 's#/\*+#/:wildcard#g')"

  # Plantillas no expandidas (${...}) también se comparan como parámetro.
  path="$(printf '%s' "${path}" | sed -E 's#/\$\{[^}]+\}#/:param#g')"

  printf '%s' "${path}"
}

# ---------------------------------------------------------------------------
# Extracción del monolito TS
#
# Reconoce app.get/post/put/delete/patch/all, incluidos los que llevan genéricos
# multi-línea. La ruta es el primer literal que empieza por "/" o el primer
# template literal (para ${prefix}/...).
# ---------------------------------------------------------------------------
extract_ts_raw() {
  awk '
    function reset() {
      pending = ""
      buf = ""
      lines_left = 0
    }
    BEGIN { reset() }
    {
      if (pending == "") {
        if (match($0, /app\.(get|post|put|delete|patch|all)/)) {
          method = substr($0, RSTART + 4, RLENGTH - 4)
          method = toupper(method)
          buf = substr($0, RSTART + RLENGTH)
          pending = method
          lines_left = 60
        } else {
          next
        }
      } else {
        buf = buf "\n" $0
        lines_left--
      }

      # Primer literal de ruta entre comillas dobles.
      qpos = 0
      qlen = 0
      if (match(buf, /"\/[^"]*"/)) {
        qpos = RSTART
        qlen = RLENGTH
      }

      # Primer template literal, útil para ${prefix}/ruta.
      tpos = 0
      tlen = 0
      if (match(buf, /`[^`]*`/)) {
        tpos = RSTART
        tlen = RLENGTH
      }

      if (qpos > 0 && (tpos == 0 || qpos < tpos)) {
        route = substr(buf, qpos + 1, qlen - 2)
        print method " " route
        reset()
      } else if (tpos > 0) {
        route = substr(buf, tpos + 1, tlen - 2)
        print method " " route
        reset()
      } else if (lines_left <= 0) {
        reset()
      }
    }
  ' "${TS_FILE}"
}

# Expande ${prefix} usando el array del bucle de src/http-dashboard.ts.
expand_ts_prefixes() {
  local raw_file="$1"
  local prefixes=()
  local method route prefix

  while IFS= read -r prefix; do
    prefixes+=("${prefix}")
  done < <(
    sed -n 's/.*for (const prefix of \[\([^]]*\)\].*/\1/p' "${TS_FILE}" \
      | grep -oE '"[^"]+"' \
      | tr -d '"' \
      || true
  )

  while IFS=' ' read -r method route; do
    [[ -n "${method}" && -n "${route}" ]] || continue
    if [[ "${route}" == *'${prefix}'* && ${#prefixes[@]} -gt 0 ]]; then
      for prefix in "${prefixes[@]}"; do
        printf '%s %s\n' "${method}" "${route//'${prefix}'/${prefix}}"
      done
    else
      printf '%s %s\n' "${method}" "${route}"
    fi
  done < "${raw_file}"
}

extract_ts_raw > "${TMP_DIR}/ts-raw.txt"

expand_ts_prefixes "${TMP_DIR}/ts-raw.txt" > "${TMP_DIR}/ts-expanded.txt"

while IFS=' ' read -r method route; do
  [[ -n "${method}" && -n "${route}" ]] || continue
  printf '%s %s\n' "${method}" "$(normalize_path "${route}")"
done < "${TMP_DIR}/ts-expanded.txt" | sort -u > "${TMP_DIR}/ts-routes.txt"

# ---------------------------------------------------------------------------
# Extracción del edge Go
#
# Toma literales de ruta de main.go y de internal/edge/*.go, descarta prefijos
# de dispatch y assets internos, e infiere los métodos por los http.MethodX del
# propio archivo. HEAD se pliega a GET.
# ---------------------------------------------------------------------------
route_is_interesting() {
  case "$1" in
    /|/service-worker.js|/healthz|/readyz|/metrics|/api/edge/summary|/api/session|/api/dashboard)
      return 0
      ;;
    /api/*)
      # Cualquier ruta /api/... declarada es relevante. Se descartan los
      # prefijos de dispatch que terminan en "/" para no inventar rutas.
      [[ "$1" != */ ]]
      return
      ;;
    *)
      return 1
      ;;
  esac
}

{
  for file in "${EDGE_MAIN}" "${EDGE_FILES[@]}"; do
    methods=()
    while IFS= read -r method; do
      method="${method#http.Method}"
      method="$(printf '%s' "${method}" | tr '[:lower:]' '[:upper:]')"
      case "${method}" in
        HEAD) method="GET" ;;
        GET|POST|PUT|DELETE|PATCH|OPTIONS) ;;
        *) continue ;;
      esac
      methods+=("${method}")
    done < <(grep -oE 'http\.Method[A-Za-z]+' "${file}" 2>/dev/null | sort -u || true)

    # main.go no usa http.MethodX: sus rutas son GET (la sesión añade sus
    # métodos desde session_http.go).
    if [[ ${#methods[@]} -eq 0 ]]; then
      methods=("GET")
    fi

    while IFS= read -r route; do
      [[ -n "${route}" ]] || continue
      # live_api.go sirve el parámetro :coin a partir de un prefijo. Se
      # representa como ruta paramétrica para compararla con el TS.
      if [[ "${route}" == "/api/live/markets/" || "${route}" == "/api/offers/rebalance/" ]]; then
        route="${route}:param"
      fi
      route_is_interesting "${route}" || continue
      for method in "${methods[@]}"; do
        # El shell raíz solo sirve GET/HEAD; el resto de verbos no existe.
        if [[ "${route}" == "/" && "${method}" != "GET" ]]; then
          continue
        fi
        printf '%s %s\n' "${method}" "${route}"
      done
    done < <(grep -oE '"/[^"]*"' "${file}" 2>/dev/null | tr -d '"' | sort -u || true)
  done

  # Rutas construidas en runtime con constantes/parseo (market source,
  # notificaciones y descartes). Se declaran aquí para que la auditoría no las
  # pierda; los handlers existen y tienen tests propios.
  if [[ -r "${EDGE_DIR}/market_source_api.go" ]]; then
    printf 'PUT /api/market-source/webhook-secret\n'
    printf 'PUT /api/market-source/stream-credentials\n'
    printf 'PUT /api/market-readers/:param\n'
    printf 'PUT /api/market-readers/:param/token\n'
    printf 'DELETE /api/market-readers/:param\n'
  fi
  if [[ -r "${EDGE_DIR}/web_extras_api.go" ]]; then
    printf 'POST /api/notifications/:param/ack\n'
    printf 'POST /api/recovery/:param/evidence\n'
    printf 'POST /api/recovery/:param/acknowledge\n'
  fi
  if [[ -r "${EDGE_DIR}/decision_events_api.go" ]]; then
    printf 'POST /api/decision-events/dismiss-all\n'
    printf 'POST /api/decision-events/:param/dismiss\n'
    printf 'POST /api/blocked-offers/:param/dismiss\n'
  fi
  if [[ -r "${EDGE_DIR}/analytics_fees_api.go" ]]; then
    printf 'POST /api/analytics/fees\n'
  fi
  if [[ -r "${EDGE_DIR}/mobile_admin_api.go" ]]; then
    printf 'GET /api/mobile/devices\nPOST /api/mobile/devices\nDELETE /api/mobile/devices/:param\n'
    printf 'GET /api/mobile/operators\nPOST /api/mobile/operators\nDELETE /api/mobile/operators/:param\n'
    printf 'POST /api/mobile/push-device\nDELETE /api/mobile/push-device\n'
  fi
  if [[ -r "${EDGE_DIR}/push_subscriptions_api.go" ]]; then
    printf 'POST /api/push/subscriptions\nDELETE /api/push/subscriptions\n'
  fi
  if [[ -r "${EDGE_DIR}/qvapay_webhook_api.go" ]]; then
    printf 'POST /webhooks/qvapay/p2p-feed\n'
  fi
  if [[ -r "${EDGE_DIR}/mutations_api.go" ]]; then
    cat <<'ROUTES'
DELETE /api/cooperative-network/contributions/:param
PUT /api/cooperative-network/contributions
PUT /api/cooperative-network/hunting
POST /api/cooperative-network/reconcile
POST /api/cooperative-network/executions/check
POST /api/cooperative-network/executions/:param/distributed
DELETE /api/offers/:param
PUT /api/offers/:param
POST /api/offers/rebalance/preview
POST /api/offers/rebalance/apply
POST /api/operations/:param/:param
POST /api/mobile/operations/:param/:param
GET /api/operations/:param/chat
GET /api/operations/:param/chat/sends/:param
GET /api/operations/:param/chat/images/:param
POST /api/operations/:param/chat
POST /api/operations/:param/chat/read
POST /api/operations/:param/chat/images
GET /api/mobile/operations/:param/chat
GET /api/mobile/operations/:param/chat/sends/:param
GET /api/mobile/operations/:param/chat/images/:param
POST /api/mobile/operations/:param/chat
POST /api/mobile/operations/:param/chat/read
POST /api/mobile/operations/:param/chat/images
GET /api/mobile/operations/:param/payment-preview
POST /api/mobile/payment-receipts
POST /api/blocked-offers/:param/apply
POST /api/blocked-offers/:param/preview
POST /api/recovery/:param/check
POST /api/recovery/:param/resolve
POST /api/workflows/:param/reconcile
ROUTES
  fi
  # El shell sirve el fallback SPA de navegación del dashboard.
  printf 'GET /dashboard/*\n'

  # StaticRoutes declara sus prefijos en un slice; se sintetizan las rutas
  # paramétricas que resolve() atiende realmente.
  static_routes_file="${EDGE_DIR}/static_routes.go"
  if [[ -r "${static_routes_file}" ]]; then
    while IFS= read -r prefix; do
      [[ -n "${prefix}" ]] || continue
      printf 'GET /%s/:param\n' "${prefix}"
    done < <(
      sed -n 's/.*staticRoutePrefixes = \[\]string{\(.*\)}.*/\1/p' "${static_routes_file}" \
        | grep -oE '"[^"]+"' \
        | tr -d '"' \
        || true
    )
  fi

  # El shell Go sirve assets y hace fallback SPA para rutas sin extensión.
  # Se representa como un comodín estático, no como una ruta de API.
  printf 'GET /*\n'
} > "${TMP_DIR}/edge-raw.txt"

while IFS=' ' read -r method route; do
  [[ -n "${method}" && -n "${route}" ]] || continue
  printf '%s %s\n' "${method}" "$(normalize_path "${route}")"
done < "${TMP_DIR}/edge-raw.txt" | sort -u > "${TMP_DIR}/edge-routes.txt"

TS_TOTAL="$(wc -l < "${TMP_DIR}/ts-routes.txt" | tr -d ' ')"
EDGE_TOTAL="$(wc -l < "${TMP_DIR}/edge-routes.txt" | tr -d ' ')"

if [[ "${TS_TOTAL}" -eq 0 || "${EDGE_TOTAL}" -eq 0 ]]; then
  printf 'ERROR: el escaneo no extrajo rutas (TS=%s, edge=%s)\n' \
    "${TS_TOTAL}" "${EDGE_TOTAL}" >&2
  exit 2
fi

comm -12 "${TMP_DIR}/ts-routes.txt" "${TMP_DIR}/edge-routes.txt" > "${TMP_DIR}/covered.txt"
comm -23 "${TMP_DIR}/ts-routes.txt" "${TMP_DIR}/edge-routes.txt" > "${TMP_DIR}/ts-missing.txt"
comm -13 "${TMP_DIR}/ts-routes.txt" "${TMP_DIR}/edge-routes.txt" > "${TMP_DIR}/edge-extra.txt"

COVERED_TOTAL="$(wc -l < "${TMP_DIR}/covered.txt" | tr -d ' ')"
MISSING_TOTAL="$(wc -l < "${TMP_DIR}/ts-missing.txt" | tr -d ' ')"
EXTRA_TOTAL="$(wc -l < "${TMP_DIR}/edge-extra.txt" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Salida
# ---------------------------------------------------------------------------
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

json_array_from_file() {
  local file="$1"
  local first=1
  local line

  printf '['
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    if [[ ${first} -eq 0 ]]; then
      printf ','
    fi
    first=0
    printf '"%s"' "$(json_escape "${line}")"
  done < "${file}"
  printf ']'
}

if [[ "${JSON}" -eq 1 ]]; then
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf '  "source": {\n'
  printf '    "typescript": "%s",\n' "$(json_escape "src/http-dashboard.ts")"
  printf '    "edgeMain": "%s",\n' "$(json_escape "services/trading-core/cmd/edge/main.go")"
  printf '    "edgeInternal": "%s"\n' "$(json_escape "services/trading-core/internal/edge/*.go")"
  printf '  },\n'
  printf '  "summary": {\n'
  printf '    "tsTotal": %s,\n' "${TS_TOTAL}"
  printf '    "edgeTotal": %s,\n' "${EDGE_TOTAL}"
  printf '    "covered": %s,\n' "${COVERED_TOTAL}"
  printf '    "tsMissing": %s,\n' "${MISSING_TOTAL}"
  printf '    "edgeExtra": %s\n' "${EXTRA_TOTAL}"
  printf '  },\n'
  printf '  "tsRoutes": '
  json_array_from_file "${TMP_DIR}/ts-routes.txt"
  printf ',\n'
  printf '  "edgeRoutes": '
  json_array_from_file "${TMP_DIR}/edge-routes.txt"
  printf ',\n'
  printf '  "coveredRoutes": '
  json_array_from_file "${TMP_DIR}/covered.txt"
  printf ',\n'
  printf '  "tsMissingRoutes": '
  json_array_from_file "${TMP_DIR}/ts-missing.txt"
  printf ',\n'
  printf '  "edgeExtraRoutes": '
  json_array_from_file "${TMP_DIR}/edge-extra.txt"
  printf '\n}\n'
  exit 0
fi

printf 'Auditoría estática de rutas TS ↔ edge Go\n'
printf '=========================================\n\n'
printf 'Fuentes:\n'
printf '  TS:   src/http-dashboard.ts\n'
printf '  Edge: services/trading-core/cmd/edge/main.go\n'
printf '        services/trading-core/internal/edge/*.go (sin tests)\n\n'
printf 'Resumen:\n'
printf '  Rutas TS únicas:          %s\n' "${TS_TOTAL}"
printf '  Rutas edge únicas:        %s\n' "${EDGE_TOTAL}"
printf '  Cubiertas exactamente:    %s\n' "${COVERED_TOTAL}"
printf '  Rutas TS no cubiertas:    %s\n' "${MISSING_TOTAL}"
printf '  Rutas edge extra:         %s\n' "${EXTRA_TOTAL}"
printf '\n'

print_routes() {
  local title="$1"
  local file="$2"

  printf '%s\n' "${title}"
  if [[ ! -s "${file}" ]]; then
    printf '  (ninguna)\n'
  else
    sed 's/^/  /' "${file}"
  fi
  printf '\n'
}

print_routes 'Rutas TS no cubiertas por el edge:' "${TMP_DIR}/ts-missing.txt"
print_routes 'Rutas edge extra (sin equivalente TS exacto):' "${TMP_DIR}/edge-extra.txt"
print_routes 'Rutas cubiertas exactamente:' "${TMP_DIR}/covered.txt"

printf 'Nota: auditoría estática; no verifica contratos, auth ni comportamiento en runtime.\n'
printf 'Los parámetros :id/:uuid se normalizan a :param y los comodines a :wildcard.\n'

exit 0
