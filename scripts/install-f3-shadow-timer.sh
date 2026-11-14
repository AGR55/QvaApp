#!/usr/bin/env bash
# Instala/desinstala los timers de F3 shadow en la VPS.
#
# Uso (como root, en la VPS):
#   install-f3-shadow-timer.sh install
#   install-f3-shadow-timer.sh uninstall
#   install-f3-shadow-timer.sh status
#
# Solo administra unidades systemd de qvaapply-f3-*; no toca /opt/qvaapply ni
# los servicios de producción.
set -Eeuo pipefail

readonly app_root="/opt/qvaapply-f3-shadow"
readonly prod_root="/opt/qvaapply"
readonly unit_dir="/etc/systemd/system"
readonly audit_service="qvaapply-f3-audit.service"
readonly audit_timer="qvaapply-f3-audit.timer"
readonly replay_service="qvaapply-f3-replay.service"
readonly replay_timer="qvaapply-f3-replay.timer"
readonly tail_service="qvaapply-f3-tail.service"
readonly tail_timer="qvaapply-f3-tail.timer"
readonly invariants_service="qvaapply-f3-invariants.service"
readonly invariants_timer="qvaapply-f3-invariants.timer"
readonly soak_service="qvaapply-f3-soak.service"
readonly soak_timer="qvaapply-f3-soak.timer"
readonly workflows_service="qvaapply-f3-workflows.service"
readonly workflows_timer="qvaapply-f3-workflows.timer"
readonly qvapay_service="qvaapply-f3-qvapay.service"
readonly qvapay_timer="qvaapply-f3-qvapay.timer"

if (( EUID != 0 )); then
  echo "Ejecuta este script como root." >&2
  exit 2
fi
if [[ $app_root == "$prod_root" || $app_root == "$prod_root/"* ]]; then
  echo "Ruta de instalación insegura: $app_root" >&2
  exit 2
fi

action=${1:-status}
case "$action" in
  install)
    if [[ ! -x "$app_root/current/scripts/f3-shadow-audit.sh" ]] \
      || [[ ! -x "$app_root/current/scripts/f3-shadow-tail.sh" ]] \
      || [[ ! -x "$app_root/current/scripts/f3-shadow-invariants.sh" ]] \
      || [[ ! -x "$app_root/current/scripts/f3-shadow-soak.sh" ]] \
      || [[ ! -x "$app_root/current/scripts/f3-shadow-workflows.sh" ]] \
      || [[ ! -x "$app_root/current/scripts/f3-shadow-qvapay.sh" ]]; then
      echo "Falta la release shadow activa; ejecuta antes deploy-f3-shadow.sh." >&2
      exit 2
    fi
    cat > "$unit_dir/$audit_service" <<'UNIT'
[Unit]
Description=QvaApply F3 shadow decision audit
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-audit.sh
UNIT
    cat > "$unit_dir/$audit_timer" <<'UNIT'
[Unit]
Description=Hourly QvaApply F3 shadow decision audit

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$replay_service" <<'UNIT'
[Unit]
Description=QvaApply F3 shadow corpus replay
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-replay.sh
UNIT
    cat > "$unit_dir/$replay_timer" <<'UNIT'
[Unit]
Description=Daily QvaApply F3 shadow corpus replay

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$tail_service" <<'UNIT'
[Unit]
Description=QvaApply F3 shadow incremental decision tail
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-tail.sh
UNIT
    cat > "$unit_dir/$tail_timer" <<'UNIT'
[Unit]
Description=Every 5 minutes QvaApply F3 shadow incremental decision tail

[Timer]
OnCalendar=*:0/5
Persistent=true
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$invariants_service" <<'UNIT'
[Unit]
Description=Daily QvaApply F3 shadow SQLite invariants audit
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-invariants.sh
UNIT
    cat > "$unit_dir/$invariants_timer" <<'UNIT'
[Unit]
Description=Daily QvaApply F3 shadow SQLite invariants audit

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$soak_service" <<'UNIT'
[Unit]
Description=Every 5 minutes QvaApply F3 shadow soak sample
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-soak.sh
UNIT
    cat > "$unit_dir/$soak_timer" <<'UNIT'
[Unit]
Description=Every 5 minutes QvaApply F3 shadow soak sample

[Timer]
OnCalendar=*:0/5
Persistent=true
RandomizedDelaySec=20s

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$workflows_service" <<'UNIT'
[Unit]
Description=Daily QvaApply F3 shadow workflow risk audit
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-workflows.sh
UNIT
    cat > "$unit_dir/$workflows_timer" <<'UNIT'
[Unit]
Description=Daily QvaApply F3 shadow workflow risk audit

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=12m

[Install]
WantedBy=timers.target
UNIT
    cat > "$unit_dir/$qvapay_service" <<'UNIT'
[Unit]
Description=Hourly QvaApply F3 shadow read-only QvaPay snapshot
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=idle
ExecStart=/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-qvapay.sh
UNIT
    cat > "$unit_dir/$qvapay_timer" <<'UNIT'
[Unit]
Description=Hourly QvaApply F3 shadow read-only QvaPay snapshot

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable --now "$audit_timer" "$replay_timer" "$tail_timer" "$invariants_timer" "$soak_timer" "$workflows_timer" "$qvapay_timer"
    systemctl list-timers --all 'qvaapply-f3-*' --no-pager
    ;;
  uninstall)
    systemctl disable --now "$audit_timer" "$replay_timer" "$tail_timer" "$invariants_timer" "$soak_timer" "$workflows_timer" "$qvapay_timer" 2>/dev/null || true
    rm -f "$unit_dir/$audit_service" "$unit_dir/$audit_timer" \
      "$unit_dir/$replay_service" "$unit_dir/$replay_timer" \
      "$unit_dir/$tail_service" "$unit_dir/$tail_timer" \
      "$unit_dir/$invariants_service" "$unit_dir/$invariants_timer" \
      "$unit_dir/$soak_service" "$unit_dir/$soak_timer" \
      "$unit_dir/$workflows_service" "$unit_dir/$workflows_timer" \
      "$unit_dir/$qvapay_service" "$unit_dir/$qvapay_timer"
    systemctl daemon-reload
    echo "Timers F3 shadow desinstalados."
    ;;
  status)
    systemctl list-timers --all 'qvaapply-f3-*' --no-pager || true
    ;;
  *)
    echo "Uso: $0 {install|uninstall|status}" >&2
    exit 2
    ;;
esac
