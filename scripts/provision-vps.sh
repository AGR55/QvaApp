#!/usr/bin/env bash
set -Eeuo pipefail

domain=${1:-honux.tech}
host_port=${2:-8782}
app_root="/opt/qvaapply"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release_root=$(cd -- "$script_dir/.." && pwd)

if (( EUID != 0 )); then
  echo "Ejecuta este asistente como root." >&2
  exit 2
fi
if [[ ! $domain =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "Dominio no válido: $domain" >&2
  exit 2
fi
if [[ ! $host_port =~ ^[0-9]+$ ]] || (( host_port < 1024 || host_port > 65535 )); then
  echo "El puerto debe estar entre 1024 y 65535." >&2
  exit 2
fi
if [[ ! -r /etc/os-release ]]; then
  echo "No se pudo identificar el sistema operativo." >&2
  exit 2
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu && ${ID:-} != debian ]]; then
  echo "Este asistente admite Ubuntu y Debian; se detectó ${ID:-desconocido}." >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx \
  ufw fail2ban sqlite3 unattended-upgrades

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  architecture=$(dpkg --print-architecture)
  codename=${VERSION_CODENAME:?Falta VERSION_CODENAME en /etc/os-release}
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$architecture" "$ID" "$codename" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker nginx fail2ban unattended-upgrades
printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' \
  > /etc/fail2ban/jail.d/qvaapply.local
systemctl restart fail2ban
umask 077
install -d -m 0700 "$app_root/config" "$app_root/uploads"
install -d -m 0750 "$app_root/releases"
install -d -o 1000 -g 1000 -m 0700 "$app_root/data" "$app_root/data/backups"
printf '%s\n' "$host_port" > "$app_root/config/host-port"
chmod 600 "$app_root/config/host-port"

sed -e "s/server_name honux\.tech;/server_name $domain;/" \
    -e "s/127\.0\.0\.1:8782/127.0.0.1:$host_port/" \
    "$release_root/deploy/nginx-qvaapply.conf" \
    > /etc/nginx/sites-available/qvaapply.conf
ln -sfn /etc/nginx/sites-available/qvaapply.conf /etc/nginx/sites-enabled/qvaapply.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

install -m 0755 "$release_root/scripts/backup-vps.sh" /usr/local/sbin/qvaapply-backup
install -m 0644 "$release_root/deploy/qvaapply-backup.service" /etc/systemd/system/qvaapply-backup.service
install -m 0644 "$release_root/deploy/qvaapply-backup.timer" /etc/systemd/system/qvaapply-backup.timer
systemctl daemon-reload
systemctl enable --now qvaapply-backup.timer

printf '\nVPS preparada para QvaApply.\n'
printf 'Dominio pendiente de TLS: %s\n' "$domain"
printf 'Aplicación interna: 127.0.0.1:%s\n' "$host_port"
printf 'Siguiente paso: ejecuta %s/scripts/bootstrap-vps.sh para crear los secretos.\n' "$release_root"
