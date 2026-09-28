# Despliegue continuo en Hostinger

QvaApply se publica automáticamente desde `main` mediante
`.github/workflows/ci-deploy.yml`. Los pushes y pull requests de `main` y
`develop` ejecutan todas las verificaciones, pero únicamente un commit de `main`
puede actualizar producción.

## Arquitectura

```text
GitHub main → Actions → SSH → /opt/qvaapply/releases/<sha>
                                      ↓
                              Docker (Node 24)
                                      ↓
Nginx HTTPS → 127.0.0.1:8782 → contenedor:3000 → SQLite persistente
```

Docker aísla la versión de Node del resto de la VPS. Solo existe una instancia,
porque la base SQLite no debe compartirse entre réplicas.

Toda la instalación propia queda agrupada dentro de:

```text
/opt/qvaapply/
├── config/       # entorno y puerto; permisos 600
├── data/         # SQLite y archivos persistentes
├── releases/     # una carpeta por commit
├── uploads/      # artefactos entrantes de Actions
└── current       # enlace a la release activa
```

## Preparación inicial

La VPS parte de cero. Copia el repositorio de preparación a una carpeta temporal
y ejecuta el asistente como `root`; instalará Docker Compose, Nginx, Certbot,
UFW, Fail2ban, actualizaciones automáticas y backups rotativos:

```bash
tar -czf /tmp/qvaapply-provision.tar.gz deploy scripts/provision-vps.sh scripts/bootstrap-vps.sh scripts/backup-vps.sh
scp /tmp/qvaapply-provision.tar.gz root@2.25.247.171:/tmp/
ssh root@2.25.247.171
mkdir -p /tmp/qvaapply-release
tar -xzf /tmp/qvaapply-provision.tar.gz -C /tmp/qvaapply-release
/tmp/qvaapply-release/scripts/provision-vps.sh honux.tech 8782
```

Después, `scripts/bootstrap-vps.sh 8782 https://honux.tech` solicita la
contraseña del panel y las credenciales de Telegram sin incluirlas en el
historial. Genera automáticamente la clave local de cifrado.
`CONFIRM_REAL_TRADING` queda en `false`; la aplicación no arranca hasta que el
propietario lo cambie deliberadamente después de revisar la configuración.

## Configuración de GitHub

Crea un entorno `production` y añade:

| Nombre | Valor |
| --- | --- |
| `VPS_HOST` | `2.25.247.171` |
| `VPS_USER` | `root` |
| `VPS_SSH_PRIVATE_KEY` | clave Ed25519 privada exclusiva del despliegue |
| `VPS_KNOWN_HOSTS` | claves verificadas del host SSH |

La variable `VPS_SSH_PORT` puede omitirse porque el servidor utiliza el puerto 22.
La clave privada no se guarda en el repositorio ni dentro de la VPS.

## Nginx y TLS

El sitio debe tener un virtual host explícito para no caer en el proxy comodín ya
existente:

```nginx
server {
    listen 80;
    server_name honux.tech;

    location / {
        proxy_pass http://127.0.0.1:8782;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Cuando el registro A de `honux.tech` apunte a `2.25.247.171`, emite el
certificado y verifica la renovación:

```bash
/opt/qvaapply/current/scripts/enable-vps-tls.sh honux.tech correo@example.com
```

El puerto 8782 nunca se abre en el firewall de Hostinger ni en UFW.

## Despliegue y rollback

Actions compila y valida la aplicación, transmite un archivo versionado, construye
una imagen Node 24 y cambia atómicamente el enlace `current`. El contenedor utiliza
`restart: unless-stopped`, filesystem de solo lectura, capacidades eliminadas y un
volumen persistente exclusivo para los datos.

Tras cada actualización se consulta `/api/session`. Si no responde correctamente,
el script restaura la release anterior y Actions termina en error.

El mismo virtual host publica el receptor firmado del feed P2P en
`/webhooks/qvapay/p2p-feed`. No requiere una regla Nginx separada: la ubicación
`/` existente lo entrega al proceso Node. No añadas autenticación básica ni una
redirección específica sobre esa ruta, porque QvaPay autentica cada entrega con
HMAC.

Comandos útiles:

```bash
docker ps --filter name=qvaapply
docker logs -f qvaapply
curl http://127.0.0.1:8782/api/session
```

El timer `qvaapply-backup.timer` conserva 14 días de copias SQLite consistentes
en `/opt/qvaapply/data/backups`. También deben existir backups externos cifrados
de `/opt/qvaapply/data` y `/opt/qvaapply/config`, con restauraciones probadas.

## Sync Core y NATS en la misma VPS

El archivo de entorno de QvaApply admite estas variables sin fijar la topología:

```dotenv
SYNC_ENABLED=true
SYNC_BASE_URL=http://caceria-sync-server:8080
SYNC_NATS_URL=nats://caceria-sync-server:4222
SYNC_EMAIL=cuenta-precreada@example.com
SYNC_PASSWORD=una-clave-exclusiva
```

Compose conecta QvaApply a la red Docker privada externa `caceria-net` y usa el
nombre del contenedor de Sync Core. Mantén los puertos HTTP y NATS cerrados al
Internet: solo Nginx debe publicar el panel y NATS debe ser accesible únicamente
desde la propia VPS o su red privada.

Tras reiniciar, abre **Red cooperativa** y comprueba por separado los indicadores
HTTP y NATS. Un snapshot guardado ayuda a diagnosticar, pero no debe interpretarse
como capacidad disponible en tiempo real. La reconciliación HTTP corre cada 60
segundos y corrige eliminaciones que Sync Core todavía no emite por NATS.
