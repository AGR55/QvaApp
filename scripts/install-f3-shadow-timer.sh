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
      || [[ ! -x "$app_root/current/scripts/f3-shadow-tail.sh" ]]; then
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
    systemctl daemon-reload
    systemctl enable --now "$audit_timer" "$replay_timer" "$tail_timer"
    systemctl list-timers --all 'qvaapply-f3-*' --no-pager
    ;;
  uninstall)
    systemctl disable --now "$audit_timer" "$replay_timer" "$tail_timer" 2>/dev/null || true
    rm -f "$unit_dir/$audit_service" "$unit_dir/$audit_timer" \
      "$unit_dir/$replay_service" "$unit_dir/$replay_timer" \
      "$unit_dir/$tail_service" "$unit_dir/$tail_timer"
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
