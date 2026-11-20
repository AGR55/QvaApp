#!/usr/bin/env bash
# Planificador y guardia de cutover TS -> Go. NO ejecuta el corte.
#
# Solo comprueba precondiciones y muestra el checklist ordenado. Es de solo
# lectura sobre /opt/qvaapply: no escribe, no para contenedores, no cambia
# Nginx, no envía Telegram, no llama a QvaPay y no modifica bases de datos.
#
# Uso:
#   scripts/f3-cutover-plan.sh
#   scripts/f3-cutover-plan.sh --dry-run
#   scripts/f3-cutover-plan.sh --rehearsal     # ejecuta el ensayo completo
#   scripts/f3-cutover-plan.sh --help
#
# --execute se rechaza siempre: el corte real no está implementado.
#
# Variables:
#   F3_ROOT                 raíz shadow (defecto: /opt/qvaapply-f3-shadow)
#   PROD_ROOT               raíz de producción (defecto: /opt/qvaapply)
#   BACKUP_DIR              directorio de backups (defecto: $PROD_ROOT/data/backups)
#   TS_RELEASE              release TS de rollback (defecto: $PROD_ROOT/current)
#   BACKUP_MAX_AGE_HOURS    antigüedad máxima del backup (defecto: 48)
#   ROLLBACK_DOC            documento de rollback TS (si se omite, se busca en
#                           docs/migration/)
#   ROLLBACK_SEARCH_DIR     directorio de búsqueda del documento de rollback
#                           (defecto: <repo>/docs/migration)
#
# Códigos de salida:
#   0  Plan listo en dry-run (puede haber avisos que revisar).
#   1  Falta una precondición; el plan no está listo.
#   2  Error de uso, incluido cualquier intento de --execute.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

F3_ROOT=${F3_ROOT:-/opt/qvaapply-f3-shadow}
PROD_ROOT=${PROD_ROOT:-/opt/qvaapply}
BACKUP_DIR=${BACKUP_DIR:-}
TS_RELEASE=${TS_RELEASE:-}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-48}
ROLLBACK_DOC=${ROLLBACK_DOC:-}
ROLLBACK_SEARCH_DIR=${ROLLBACK_SEARCH_DIR:-$repo_root/docs/migration}
run_rehearsal=0

usage() {
  cat <<'EOF'
Planificador y guardia de cutover QvaApply TS -> Go (sin ejecutar el corte).

Uso:
  f3-cutover-plan.sh [--dry-run] [--rehearsal] [--help]

Comprueba, en modo lectura, las precondiciones del cutover, invoca las
herramientas de verificación disponibles y muestra el checklist ordenado.
No escribe en /opt/qvaapply, no para contenedores, no cambia Nginx, no envía
Telegram y no llama a QvaPay.

Opciones:
  --dry-run          Modo por defecto. Solo comprueba y muestra el plan.
  --rehearsal        Ejecuta el ensayo completo con scripts/f3-rehearsal.sh.
                     Sin esta opción solo se valida su ayuda (--help).
  --execute          Rechazado siempre: el corte real no está implementado.
  -h, --help         Muestra esta ayuda.

Variables de entorno:
  F3_ROOT                Raíz shadow (defecto: /opt/qvaapply-f3-shadow).
  PROD_ROOT              Raíz de producción (defecto: /opt/qvaapply).
  BACKUP_DIR             Directorio de backups (defecto: $PROD_ROOT/data/backups).
  TS_RELEASE             Release TS de rollback (defecto: $PROD_ROOT/current).
  BACKUP_MAX_AGE_HOURS   Edad máxima aceptada del backup (defecto: 48 h).
  ROLLBACK_DOC           Documento con el rollback TS. Si se omite, se busca un
                         encabezado de rollback a TypeScript en
                         ROLLBACK_SEARCH_DIR.
  ROLLBACK_SEARCH_DIR    Directorio de búsqueda (defecto: <repo>/docs/migration).

Comprobaciones:
  - Raíces F3/producción, releases activas y release TS de rollback.
  - SQLite de producción y puerto interno de producción.
  - Backup reciente .sqlite o .tar.gz (con aviso si falta .sha256).
  - Documento de rollback TS y mención de la retención de 14 días.
  - scripts/f3-cutover-check.sh y scripts/f3-rehearsal.sh --help.
  - La comprobación completa de f3-cutover-check.sh solo se ejecuta si hay
    root y Docker; si no, se valida su --help y se emite un aviso.

Códigos de salida:
  0  Plan listo en dry-run (puede haber avisos que revisar).
  1  Falta una precondición; el plan no está listo.
  2  Error de uso, incluido cualquier intento de --execute.

Este script no ejecuta el corte ni autoriza el cambio de autoridad.
EOF
}

usage_error() {
  printf 'f3-cutover-plan: %s\n' "$*" >&2
  printf 'Usa --help para ver la ayuda.\n' >&2
  exit 2
}

reject_execute() {
  printf 'f3-cutover-plan: --execute rechazado: el corte real no está implementado.\n' >&2
  printf 'Este planificador solo comprueba precondiciones y muestra pasos.\n' >&2
  exit 2
}

# Rechaza --execute incluso si aparece junto a --help o tras "--".
for arg in "$@"; do
  case "$arg" in
    --execute | --execute=*)
      reject_execute
      ;;
  esac
done

while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      ;;
    --rehearsal)
      run_rehearsal=1
      ;;
    --execute | --execute=*)
      reject_execute
      ;;
    --)
      shift
      if (($# > 0)); then
        usage_error "No se aceptan argumentos posicionales: $*"
      fi
      break
      ;;
    -*)
      usage_error "Opción no reconocida: $1"
      ;;
    *)
      usage_error "Argumento no reconocido: $1"
      ;;
  esac
  shift
done

if [[ -z $F3_ROOT || -z $PROD_ROOT ]]; then
  usage_error "F3_ROOT y PROD_ROOT no pueden estar vacíos."
fi

# Normaliza barras finales sin tocar la raíz "/".
[[ $F3_ROOT == / ]] || F3_ROOT=${F3_ROOT%/}
[[ $PROD_ROOT == / ]] || PROD_ROOT=${PROD_ROOT%/}
if [[ -z $BACKUP_DIR ]]; then
  BACKUP_DIR="$PROD_ROOT/data/backups"
fi
[[ $BACKUP_DIR == / ]] || BACKUP_DIR=${BACKUP_DIR%/}

if [[ -z $TS_RELEASE ]]; then
  ts_resolved=$(readlink -f "$PROD_ROOT/current" 2>/dev/null || true)
  if [[ -n $ts_resolved ]]; then
    TS_RELEASE=$ts_resolved
  else
    TS_RELEASE="$PROD_ROOT/current"
  fi
fi
[[ $TS_RELEASE == / ]] || TS_RELEASE=${TS_RELEASE%/}

if [[ ! $BACKUP_MAX_AGE_HOURS =~ ^[0-9]+$ ]] || ((BACKUP_MAX_AGE_HOURS < 1)); then
  usage_error "BACKUP_MAX_AGE_HOURS debe ser un entero positivo."
fi

readonly F3_ROOT PROD_ROOT BACKUP_DIR TS_RELEASE BACKUP_MAX_AGE_HOURS
readonly ROLLBACK_DOC ROLLBACK_SEARCH_DIR

for command_name in awk basename bash cut date find grep head mktemp readlink sed sort tail tr; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'f3-cutover-plan: falta el comando requerido: %s\n' "$command_name" >&2
    exit 2
  fi
done

tmp_files=()
cleanup() {
  local file
  if ((${#tmp_files[@]} > 0)); then
    for file in "${tmp_files[@]}"; do
      rm -f -- "$file"
    done
  fi
}
trap cleanup EXIT

checks=0
failures=0
warnings=0

section() {
  printf '\n== %s ==\n' "$*"
}

pass() {
  checks=$((checks + 1))
  printf '[ OK ] %s\n' "$*"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf '[FAIL] %s\n' "$*"
}

warn() {
  warnings=$((warnings + 1))
  printf '[WARN] %s\n' "$*"
}

info() {
  printf '[info] %s\n' "$*"
}

format_age() {
  local seconds=${1:-0}
  if ((seconds < 0)); then
    seconds=0
  fi
  if ((seconds < 3600)); then
    printf '%dm' "$((seconds / 60))"
  else
    printf '%dh%02dm' "$((seconds / 3600))" "$(((seconds % 3600) / 60))"
  fi
}

require_dir() {
  local label=$1 path=$2
  if [[ -d $path ]]; then
    pass "$label: $path"
    return 0
  fi
  fail "$label no existe o no es un directorio: $path"
  return 1
}

release_from_current() {
  local root=$1 label=$2 resolved
  resolved=$(readlink -f "$root/current" 2>/dev/null || true)
  if [[ -z $resolved || ! -d $resolved ]]; then
    fail "$label/current no apunta a una release existente"
    return 1
  fi
  if [[ $resolved != "$root/releases/"* ]]; then
    fail "$label/current no está bajo $root/releases: $resolved"
    return 1
  fi
  pass "$label/current -> $(basename "$resolved")"
  return 0
}

rollback_doc_has_ts() {
  local doc=$1
  grep -Eiq \
    -e '^#{1,6}[[:space:]]+.*rollback.*(^|[^[:alnum:]_])(typescript|ts)([^[:alnum:]_]|$)' \
    -e '^#{1,6}[[:space:]]+.*(^|[^[:alnum:]_])(typescript|ts)([^[:alnum:]_]|$).*rollback' \
    "$doc"
}

printf 'QvaApply — planificador de cutover TS -> Go (sin ejecutar el corte)\n'
printf 'Fecha UTC:  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'Shadow:     %s\n' "$F3_ROOT"
printf 'Producción: %s\n' "$PROD_ROOT"
printf 'Backups:    %s\n' "$BACKUP_DIR"
printf 'TS release: %s\n' "$TS_RELEASE"
printf 'Modo:       %s\n' "$([[ $run_rehearsal == 1 ]] && printf 'dry-run + ensayo completo' || printf 'dry-run')"
info "Este planificador no escribe en /opt/qvaapply ni ejecuta el corte."

# ---------------------------------------------------------------------------
section "1. Rutas y releases"
# ---------------------------------------------------------------------------

if [[ $F3_ROOT == "$PROD_ROOT" || $F3_ROOT == "$PROD_ROOT/"* ]]; then
  fail "F3_ROOT no puede estar dentro de PROD_ROOT: $F3_ROOT"
else
  pass "separación shadow/producción"
fi

f3_root_ok=0
prod_root_ok=0
if require_dir "raíz shadow" "$F3_ROOT"; then
  f3_root_ok=1
fi
if require_dir "raíz de producción" "$PROD_ROOT"; then
  prod_root_ok=1
fi

f3_release=""
if ((f3_root_ok == 1)); then
  if release_from_current "$F3_ROOT" "shadow"; then
    f3_release=$(readlink -f "$F3_ROOT/current" 2>/dev/null || true)
  fi
fi

if ((prod_root_ok == 1)); then
  release_from_current "$PROD_ROOT" "producción" || true
fi

if [[ $TS_RELEASE != /* ]]; then
  fail "TS_RELEASE debe ser una ruta absoluta: $TS_RELEASE"
elif [[ -d $TS_RELEASE ]]; then
  pass "release TS de rollback: $(basename "$TS_RELEASE")"
else
  fail "la release TS de rollback no existe: $TS_RELEASE"
fi

if [[ -n $f3_release && -f $f3_release/deploy/compose.f3-shadow.yaml ]]; then
  pass "compose shadow presente en la release activa"
elif [[ -n $f3_release ]]; then
  fail "falta deploy/compose.f3-shadow.yaml en $f3_release"
fi

if [[ -r $PROD_ROOT/config/host-port ]]; then
  prod_port=$(tr -d '[:space:]' <"$PROD_ROOT/config/host-port")
  if [[ $prod_port =~ ^[0-9]+$ ]] && ((prod_port >= 1 && prod_port <= 65535)); then
    pass "puerto interno de producción: $prod_port"
  else
    fail "puerto interno de producción inválido: ${prod_port:-vacío}"
  fi
elif ((prod_root_ok == 1)); then
  fail "no se puede leer $PROD_ROOT/config/host-port"
fi

if ((prod_root_ok == 1)); then
  if [[ -r $PROD_ROOT/data/qvaapply.sqlite ]]; then
    pass "SQLite de producción legible: $PROD_ROOT/data/qvaapply.sqlite"
  else
    fail "no se puede leer la SQLite de producción: $PROD_ROOT/data/qvaapply.sqlite"
  fi
fi

# ---------------------------------------------------------------------------
section "2. Backup reciente"
# ---------------------------------------------------------------------------

if [[ ! -d $BACKUP_DIR ]]; then
  fail "BACKUP_DIR no existe: $BACKUP_DIR"
else
  latest_backup=$(find "$BACKUP_DIR" -maxdepth 1 -type f -not -name '.*' \
    \( -name '*.sqlite' -o -name '*.tar.gz' \) -printf '%T@\t%p\n' 2>/dev/null |
    sort -nr | head -n 1 || true)
  if [[ -z $latest_backup ]]; then
    fail "no hay backups .sqlite ni .tar.gz en $BACKUP_DIR"
  else
    backup_epoch=$(printf '%s\n' "$latest_backup" | cut -f1)
    backup_file=$(printf '%s\n' "$latest_backup" | cut -f2-)
    if [[ -z $backup_file || ! -s $backup_file ]]; then
      fail "el backup más reciente está vacío o no es legible: ${backup_file:-desconocido}"
    elif [[ ! $backup_epoch =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      fail "no se pudo interpretar la fecha del backup: $backup_file"
    else
      backup_epoch=${backup_epoch%.*}
      now_epoch=$(date +%s)
      backup_age=$((now_epoch - backup_epoch))
      if ((backup_age < 0)); then
        backup_age=0
      fi
      max_age=$((BACKUP_MAX_AGE_HOURS * 3600))
      if ((backup_age > max_age)); then
        fail "backup demasiado antiguo: $backup_file ($(format_age "$backup_age"); máximo $(format_age "$max_age"))"
      else
        pass "backup reciente: $backup_file ($(format_age "$backup_age"))"
      fi
      if [[ -f "$backup_file.sha256" ]]; then
        pass "hash .sha256 presente para el backup"
      else
        warn "el backup no tiene sidecar .sha256: $backup_file.sha256"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
section "3. Rollback TS documentado"
# ---------------------------------------------------------------------------

rollback_doc=""
rollback_failure_reported=0
if [[ -n $ROLLBACK_DOC ]]; then
  if [[ -r $ROLLBACK_DOC ]]; then
    if rollback_doc_has_ts "$ROLLBACK_DOC"; then
      rollback_doc=$ROLLBACK_DOC
    else
      fail "el documento no contiene un encabezado de rollback a TypeScript/TS: $ROLLBACK_DOC"
      rollback_failure_reported=1
    fi
  else
    fail "ROLLBACK_DOC no es legible: $ROLLBACK_DOC"
    rollback_failure_reported=1
  fi
elif [[ ! -d $ROLLBACK_SEARCH_DIR ]]; then
  fail "no existe el directorio de documentos de rollback: $ROLLBACK_SEARCH_DIR"
  rollback_failure_reported=1
else
  while IFS= read -r candidate; do
    if rollback_doc_has_ts "$candidate"; then
      rollback_doc=$candidate
      break
    fi
  done < <(find "$ROLLBACK_SEARCH_DIR" -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)
fi

if [[ -n $rollback_doc ]]; then
  pass "rollback TS documentado: $rollback_doc"
  if grep -Eiq '(14|catorce)[[:space:]]*(días|dias|days)' "$rollback_doc"; then
    pass "retención de rollback de 14 días documentada"
  else
    warn "el documento de rollback no menciona explícitamente la retención de 14 días"
  fi
  release_name=$(basename "$TS_RELEASE")
  if [[ $release_name == current || ! $release_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
    warn "TS_RELEASE no identifica una release concreta; no se comprueba su mención en el rollback"
  elif grep -Fq "$release_name" "$rollback_doc"; then
    pass "la release TS de rollback aparece en el documento"
  else
    warn "el documento no menciona la release TS configurada: $release_name"
  fi
elif ((rollback_failure_reported == 0)); then
  fail "no se encontró un documento con rollback TS en $ROLLBACK_SEARCH_DIR"
fi

# ---------------------------------------------------------------------------
section "4. Herramientas de verificación"
# ---------------------------------------------------------------------------

cutover_check="$repo_root/scripts/f3-cutover-check.sh"
rehearsal_script="$repo_root/scripts/f3-rehearsal.sh"

if [[ ! -f $cutover_check ]]; then
  fail "falta scripts/f3-cutover-check.sh"
else
  if bash -n "$cutover_check" 2>/dev/null; then
    pass "sintaxis de f3-cutover-check.sh"
  else
    fail "error de sintaxis en scripts/f3-cutover-check.sh"
  fi
  if bash "$cutover_check" --help >/dev/null 2>&1; then
    pass "f3-cutover-check.sh --help"
  else
    fail "f3-cutover-check.sh --help falló"
  fi

  if ((EUID == 0)) && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    check_log=$(mktemp "${TMPDIR:-/tmp}/qva-f3-plan-check-XXXXXX")
    tmp_files+=("$check_log")
    if bash "$cutover_check" >"$check_log" 2>&1; then
      check_summary=$(grep -E '^Resumen:' "$check_log" | tail -n 1 || true)
      pass "f3-cutover-check.sh completo: ${check_summary:-OK}"
    else
      fail "f3-cutover-check.sh completo falló; revisa sus [FAIL]"
      tail -n 20 "$check_log" | sed 's/^/       /' || true
    fi
  else
    warn "f3-cutover-check.sh completo no ejecutado: requiere root y Docker; se validó --help"
  fi
fi

if [[ ! -f $rehearsal_script ]]; then
  if ((run_rehearsal == 1)); then
    fail "falta scripts/f3-rehearsal.sh y se pidió --rehearsal"
  else
    warn "no existe scripts/f3-rehearsal.sh; no se puede validar el ensayo"
  fi
else
  if bash -n "$rehearsal_script" 2>/dev/null; then
    pass "sintaxis de f3-rehearsal.sh"
  else
    fail "error de sintaxis en scripts/f3-rehearsal.sh"
  fi
  if bash "$rehearsal_script" --help >/dev/null 2>&1; then
    pass "f3-rehearsal.sh --help"
  else
    fail "f3-rehearsal.sh --help falló"
  fi

  if ((run_rehearsal == 1)); then
    rehearsal_log=$(mktemp "${TMPDIR:-/tmp}/qva-f3-plan-rehearsal-XXXXXX")
    tmp_files+=("$rehearsal_log")
    info "ejecutando el ensayo completo (puede tardar y crear una base temporal)..."
    if bash "$rehearsal_script" >"$rehearsal_log" 2>&1; then
      pass "ensayo completo OK: migración, auditoría, importes y conteos"
    else
      fail "el ensayo completo falló; revisa la salida"
      tail -n 30 "$rehearsal_log" | sed 's/^/       /' || true
    fi
  else
    info "ensayo completo no ejecutado; usa --rehearsal para lanzarlo"
  fi
fi

# ---------------------------------------------------------------------------
section "5. Checklist ordenado (no ejecutado por este script)"
# ---------------------------------------------------------------------------

cat <<'EOF'
  1. [ ] Backup
         Backup final de SQLite con TS parado, copia de configuración cifrada,
         fuera de la VPS, con sha256 y restauración probada.
  2. [ ] Freeze
         Congelar código, configuración, mercados, límites y tarifas; solo se
         admiten correcciones de rollback.
  3. [ ] Drenar
         Pausar automatización, dejar de aceptar operaciones, esperar las que
         están en curso y reconciliar mutation_intents submitted/uncertain.
  4. [ ] Snapshot
         PRAGMA integrity_check, manifiesto de conteos/sumas/ofertas abiertas/
         operaciones no terminales y hashes de configuración.
  5. [ ] Import staging
         Mínimo dos dry-runs con snapshot de producción, manifiesto firmado y
         diferencias explicadas antes de importar en producción.
  6. [ ] Verificación
         Invariantes, verify-money, paridad, smoke de lectura/sesión/panel y
         firma del verificador independiente.
  7. [ ] Ventana
         Ventana de bajo tráfico confirmada en UTC y hora local, con canal de
         incidentes, observación intensiva y criterio «ante duda, rollback».
  8. [ ] Rollback 14 días
         Release TS, SQLite, snapshot, dump de Postgres, manifiestos y logs
         conservados 14 días; reconciliación de intenciones antes de reabrir.
  9. [ ] Responsables
         Operador-ejecutor, verificador independiente, observador y aprobador
         de rollback asignados y firmados.
EOF

printf '\nResumen: %d comprobaciones, %d fallos, %d avisos\n' \
  "$checks" "$failures" "$warnings"

if ((failures > 0)); then
  printf 'Resultado: NO LISTO — falta al menos una precondición. El corte NO se ha ejecutado.\n'
  exit 1
fi

printf 'Resultado: PLAN LISTO en dry-run. El corte real NO se ha ejecutado ni se ha autorizado.\n'
if ((warnings > 0)); then
  printf 'Revisa los %d avisos antes de solicitar la ventana de corte.\n' "$warnings"
fi
exit 0
