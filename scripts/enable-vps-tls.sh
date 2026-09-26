#!/usr/bin/env bash
set -Eeuo pipefail

domain=${1:-honux.tech}
email=${2:?Uso: scripts/enable-vps-tls.sh DOMINIO EMAIL}

if (( EUID != 0 )); then
  echo "Ejecuta este asistente como root." >&2
  exit 2
fi
resolved=$(getent ahostsv4 "$domain" | awk 'NR == 1 { print $1 }')
public_ip=$(curl -4fsS https://api.ipify.org)
if [[ -z $resolved || $resolved != "$public_ip" ]]; then
  echo "$domain resuelve a ${resolved:-ninguna IP}, pero esta VPS publica $public_ip." >&2
  exit 1
fi
certbot --nginx --non-interactive --agree-tos --redirect --keep-until-expiring \
  --email "$email" -d "$domain"
nginx -t
systemctl reload nginx
certbot renew --dry-run
echo "TLS habilitado y renovación verificada para https://$domain"
