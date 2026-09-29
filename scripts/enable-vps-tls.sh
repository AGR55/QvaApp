#!/usr/bin/env bash
set -Eeuo pipefail

domain=${1:-qvapply.honux.tech}
email=${2:?Uso: scripts/enable-vps-tls.sh DOMINIO EMAIL}
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
if [[ ! $email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Correo de Let's Encrypt no válido." >&2
  exit 2
fi
for command_name in certbot curl docker getent nginx systemctl; do
  if ! command -v "$command_name" >/dev/null; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 2
  fi
done

environment_file="$app_root/config/env"
host_port_file="$app_root/config/host-port"
if [[ ! -f $environment_file || ! -f $host_port_file || ! -L $app_root/current ]]; then
  echo "Falta una instalación activa de QvaApply en $app_root." >&2
  exit 2
fi
host_port=$(tr -d '[:space:]' < "$host_port_file")
if [[ ! $host_port =~ ^[0-9]+$ ]] || (( host_port < 1024 || host_port > 65535 )); then
  echo "El puerto interno no es válido en $host_port_file." >&2
  exit 2
fi

# Restauramos la plantilla HTTP antes de que Certbot genere el bloque TLS. Esto
# elimina asociaciones anteriores con otros dominios y conserva un host por defecto neutro.
sed -e "s/server_name qvapply\.honux\.tech;/server_name $domain;/" \
    -e "s/127\.0\.0\.1:8782/127.0.0.1:$host_port/" \
    "$release_root/deploy/nginx-qvaapply.conf" \
    > /etc/nginx/sites-available/qvaapply.conf
rm -f /etc/nginx/sites-enabled/qvaapply-reject.conf
nginx -t
systemctl reload nginx

public_ip=$(curl -4fsS https://api.ipify.org)
resolved=$(getent ahostsv4 "$domain" | awk 'NR == 1 { print $1 }')
if [[ -z $resolved || $resolved != "$public_ip" ]]; then
  echo "$domain resuelve a ${resolved:-ninguna IP}, pero esta VPS publica $public_ip." >&2
  exit 1
fi

certbot --nginx --non-interactive --agree-tos --redirect --keep-until-expiring \
  --email "$email" --cert-name "$domain" -d "$domain"

# El servidor TLS por defecto nunca entrega QvaApply a otro hostname. Usa el
# certificado del subdominio únicamente para completar el handshake y responder 404.
{
  printf 'server {\n'
  printf '    listen 443 ssl default_server;\n'
  printf '    listen [::]:443 ssl default_server;\n'
  printf '    server_name _;\n'
  printf '    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;\n' "$domain"
  printf '    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;\n' "$domain"
  printf '    return 404;\n'
  printf '}\n'
} > /etc/nginx/sites-available/qvaapply-reject.conf
ln -sfn /etc/nginx/sites-available/qvaapply-reject.conf \
  /etc/nginx/sites-enabled/qvaapply-reject.conf
nginx -t
systemctl reload nginx

update_environment() {
  local key=$1 value=$2
  if grep -q "^${key}=" "$environment_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$environment_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$environment_file"
  fi
}
update_environment DASHBOARD_TRUSTED_ORIGIN "https://$domain"
update_environment DASHBOARD_SECURE_COOKIES true
chmod 600 "$environment_file"

export QVAAPPLY_HOST_PORT
QVAAPPLY_HOST_PORT=$host_port
export QVAAPPLY_REVISION
QVAAPPLY_REVISION=$(basename "$(readlink -f "$app_root/current")")
docker compose -f "$app_root/current/deploy/compose.yaml" up -d --force-recreate app
for _ in {1..30}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${QVAAPPLY_HOST_PORT}/api/session" >/dev/null; then
    break
  fi
  sleep 2
done
curl --fail --silent --show-error "http://127.0.0.1:${QVAAPPLY_HOST_PORT}/api/session" >/dev/null
certbot renew --cert-name "$domain" --dry-run
echo "TLS, cookies seguras y renovación verificados para https://$domain"
