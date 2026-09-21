#!/usr/bin/env bash
set -Eeuo pipefail

host_port=${1:?Uso: scripts/bootstrap-vps.sh PUERTO ORIGEN_HTTPS}
trusted_origin=${2:?Uso: scripts/bootstrap-vps.sh PUERTO ORIGEN_HTTPS}
app_root="/root/Adriano/QvaApply"

if (( EUID != 0 )); then
  echo "Ejecuta este asistente como root." >&2
  exit 2
fi
for command_name in docker curl openssl ss; do
  if ! command -v "$command_name" >/dev/null; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "Falta Docker Compose v2." >&2
  exit 2
fi
if [[ ! $host_port =~ ^[0-9]+$ ]] || (( host_port < 1024 || host_port > 65535 )); then
  echo "El puerto debe estar entre 1024 y 65535." >&2
  exit 2
fi
if [[ ! $trusted_origin =~ ^https:// ]]; then
  echo "El origen público debe comenzar con https://" >&2
  exit 2
fi
if ss -ltnH | awk '{print $4}' | grep -Eq "[:.]${host_port}$"; then
  echo "El puerto $host_port ya está ocupado." >&2
  exit 2
fi

read -rsp "Contraseña nueva del panel (mínimo 14 caracteres): " dashboard_password
printf '\n'
if (( ${#dashboard_password} < 14 )); then
  echo "La contraseña es demasiado corta." >&2
  exit 2
fi
read -rsp "Token de Telegram: " telegram_token
printf '\n'
read -rp "Chat ID de Telegram: " telegram_chat_id
if [[ -z $telegram_token || -z $telegram_chat_id ]]; then
  echo "El token y el Chat ID de Telegram son obligatorios." >&2
  exit 2
fi

encryption_key=$(openssl rand -hex 32)

umask 077
mkdir -p "$app_root/config" "$app_root/data" "$app_root/releases" "$app_root/uploads"
{
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$telegram_token"
  printf 'TELEGRAM_ADMIN_CHAT_ID=%s\n' "$telegram_chat_id"
  printf 'LOCAL_ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'DASHBOARD_ADMIN_PASSWORD=%s\n' "$dashboard_password"
  printf 'DASHBOARD_PORT=3000\n'
  printf 'DASHBOARD_TRUSTED_ORIGIN=%s\n' "$trusted_origin"
  printf 'DASHBOARD_SECURE_COOKIES=true\n'
  printf 'CONFIRM_REAL_TRADING=false\n'
} > "$app_root/config/env"
printf '%s\n' "$host_port" > "$app_root/config/host-port"
chmod 600 "$app_root/config/env" "$app_root/config/host-port"
chown -R 1000:1000 "$app_root/data"

printf '\nPreparación inicial completa.\n'
printf 'Proyecto: %s\n' "$app_root"
printf 'Puerto interno del host: 127.0.0.1:%s\n' "$host_port"
printf 'Origen público: %s\n' "$trusted_origin"
printf 'El primer push a main construirá y arrancará el contenedor.\n'
