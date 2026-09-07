# Despliegue futuro en VPS

Este despliegue sigue siendo para un solo administrador y una sola instancia. SQLite no debe compartirse entre réplicas.

## Modelo recomendado

```text
Internet → firewall → Caddy/Nginx (TLS + autenticación adicional opcional)
                         → 127.0.0.1:3000 QvaApply
                         → SQLite local en volumen cifrado/respaldado
```

1. Crea un usuario de sistema sin privilegios para QvaApply.
2. Instala Node 24 LTS y pnpm 11; usa `pnpm install --frozen-lockfile` y `pnpm build`.
3. Guarda `.env` fuera del repositorio con permisos `600`.
4. Mantén `DASHBOARD_PORT=3000`; la aplicación escucha deliberadamente solo en loopback.
5. Configura `DASHBOARD_TRUSTED_ORIGIN=https://panel.tu-dominio` y `DASHBOARD_SECURE_COOKIES=true`.
6. Expón únicamente 22/80/443 según necesidad; nunca el puerto 3000.
7. Termina TLS en Caddy/Nginx y limita el acceso por VPN, Tailscale o allowlist cuando sea posible.
8. Ejecuta exactamente una instancia con reinicio controlado. No uses balanceo horizontal con esta base.
9. Automatiza backups cifrados y prueba restauraciones fuera de producción.
10. Mantén el modo real pausado después de cada despliegue hasta revisar Salud e integridad.

## Unidad systemd de referencia

```ini
[Unit]
Description=QvaApply
After=network-online.target

[Service]
Type=simple
User=qvaapply
WorkingDirectory=/opt/qvaapply
EnvironmentFile=/etc/qvaapply.env
ExecStart=/usr/bin/node --enable-source-maps dist/index.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/qvaapply

[Install]
WantedBy=multi-user.target
```

Ajusta `DATA_DIR=/var/lib/qvaapply`. Verifica en una copia de la VPS que `ProtectSystem` y las rutas coinciden antes de habilitar el servicio.

## Cuándo migrar a PostgreSQL

Solo si aparecen múltiples instancias, múltiples administradores concurrentes o reporting externo que compita con el proceso financiero. Esa migración exige un nuevo ADR, bloqueo distribuido y pruebas de aislamiento; cambiar de base por anticipación añade riesgo sin beneficio local.
