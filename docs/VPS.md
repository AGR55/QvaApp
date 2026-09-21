# Despliegue continuo en la VPS compartida

QvaApply se publica automáticamente desde `main` mediante
`.github/workflows/ci-deploy.yml`. Los pushes y pull requests de `main` y
`develop` ejecutan todas las verificaciones, pero únicamente un commit de `main`
puede actualizar producción.

## Arquitectura

```text
GitHub main → Actions → SSH → /root/Adriano/QvaApply/releases/<sha>
                                      ↓
                              Docker (Node 24)
                                      ↓
Nginx HTTPS → 127.0.0.1:8782 → contenedor:3000 → SQLite persistente
```

Docker aísla la versión de Node del resto de la VPS. Solo existe una instancia,
porque la base SQLite no debe compartirse entre réplicas.

Toda la instalación propia queda agrupada dentro de:

```text
/root/Adriano/QvaApply/
├── config/       # entorno y puerto; permisos 600
├── data/         # SQLite y archivos persistentes
├── releases/     # una carpeta por commit
├── uploads/      # artefactos entrantes de Actions
└── current       # enlace a la release activa
```

## Preparación inicial

El servidor ya dispone de Docker Compose y Nginx. El puerto reservado es `8782`,
escuchando únicamente en loopback. Copia el asistente y ejecútalo como `root`:

```bash
scp scripts/bootstrap-vps.sh root@inventory.cloudns.be:/tmp/qvaapply-bootstrap-vps.sh
ssh root@inventory.cloudns.be
chmod 700 /tmp/qvaapply-bootstrap-vps.sh
/tmp/qvaapply-bootstrap-vps.sh 8782 https://qvaapply.inventory.cloudns.be
```

El asistente solicita la contraseña del panel y las credenciales de Telegram sin
incluirlas en el historial. Genera automáticamente la clave local de
cifrado. `CONFIRM_REAL_TRADING` queda en `false` hasta revisar producción.

## Configuración de GitHub

Crea un entorno `production` y añade:

| Nombre | Valor |
| --- | --- |
| `VPS_HOST` | `inventory.cloudns.be` |
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
    server_name qvaapply.inventory.cloudns.be;

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

Después se emite el certificado con Certbot y se deja que este añada el bloque
HTTPS. El puerto 8782 nunca se abre en el firewall de DigitalOcean.

## Despliegue y rollback

Actions compila y valida la aplicación, transmite un archivo versionado, construye
una imagen Node 24 y cambia atómicamente el enlace `current`. El contenedor utiliza
`restart: unless-stopped`, filesystem de solo lectura, capacidades eliminadas y un
volumen persistente exclusivo para los datos.

Tras cada actualización se consulta `/api/session`. Si no responde correctamente,
el script restaura la release anterior y Actions termina en error.

Comandos útiles:

```bash
docker ps --filter name=qvaapply-adriano
docker logs -f qvaapply-adriano
curl http://127.0.0.1:8782/api/session
```

Los backups deben incluir `/root/Adriano/QvaApply/data` y
`/root/Adriano/QvaApply/config`, cifrados y con restauraciones probadas.

## Sync Core y NATS en la misma VPS

El archivo de entorno de QvaApply admite estas variables sin fijar la topología:

```dotenv
SYNC_ENABLED=true
SYNC_BASE_URL=http://host.docker.internal:8080
SYNC_NATS_URL=nats://host.docker.internal:4222
SYNC_EMAIL=cuenta-precreada@example.com
SYNC_PASSWORD=una-clave-exclusiva
```

Compose registra `host.docker.internal` contra el gateway del host. Si Sync Core
se ejecuta en otro contenedor dentro de una red Docker compartida, sustituye el
host por el nombre del servicio. Mantén los puertos HTTP y NATS cerrados al
Internet: solo Nginx debe publicar el panel y NATS debe ser accesible únicamente
desde la propia VPS o su red privada.

Tras reiniciar, abre **Red cooperativa** y comprueba por separado los indicadores
HTTP y NATS. Un snapshot guardado ayuda a diagnosticar, pero no debe interpretarse
como capacidad disponible en tiempo real. La reconciliación HTTP corre cada 60
segundos y corrige eliminaciones que Sync Core todavía no emite por NATS.
