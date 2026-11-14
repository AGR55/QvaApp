# F3 — despliegue shadow aislado (2026-11-13)

## Objetivo

Ejecutar `trading-core` en la VPS junto a producción, **sin tocar** el
contenedor Node `qvaapply`, su SQLite ni su configuración. El despliegue valida
las superficies de operación y deja listo el camino shadow: esquema
`shadow.*`, migración idempotente y replay manual del corpus.

## Aislamiento

- Raíz propia: `/opt/qvaapply-f3-shadow`.
- Proyecto Compose `qvaapply-f3-shadow`, red y volúmenes propios.
- Postgres 16 interno sin puerto publicado.
- `trading-core` escucha solo en `127.0.0.1:8090`; no se publica en Nginx.
- Imagen `scratch` con binarios estáticos; sin shell, sin root.
- `SHADOW_MODE=true`; no hay endpoints de negocio ni credenciales de QvaPay.
- Los servicios `shadow-migrate` y `shadow-replay` usan el perfil `tools` y
  solo se ejecutan explícitamente; nunca forman parte de `up`.

## Empaquetado

```bash
# Local: compila linux/amd64 (trading-core + shadow-replay) y empaqueta
scripts/package-f3-shadow.sh
```

El paquete incluye ambos binarios, `Dockerfile.binary`, la migración
`services/db/migrations/0004_shadow.sql`, el corpus
`parity/fixtures/replay/2026-11-12`, el Compose y los scripts de despliegue y
replay. Los binarios se eliminan del árbol de trabajo al terminar.

## Despliegue

```bash
# Copia a la VPS
scp -i ~/.ssh/qvaapply_codex \
  /tmp/qvaapply-f3-shadow-<sha>.tar.gz root@2.25.247.171:/tmp/

# En la VPS (root)
mkdir -p /tmp/f3-deploy
tar -xzf /tmp/qvaapply-f3-shadow-<sha>.tar.gz -C /tmp/f3-deploy \
  scripts/deploy-f3-shadow.sh
bash /tmp/f3-deploy/scripts/deploy-f3-shadow.sh \
  /tmp/qvaapply-f3-shadow-<sha>.tar.gz <sha>
```

El script crea una contraseña aleatoria en `/opt/qvaapply-f3-shadow/.env` la
primera vez, construye la imagen y, **antes de mover el symlink `current`**,
aplica la migración con:

```bash
docker compose --env-file /opt/qvaapply-f3-shadow/.env \
  -f <release>/deploy/compose.f3-shadow.yaml run --rm shadow-migrate
```

`shadow-migrate` es un contenedor one-shot con `postgres:16` que ejecuta
`psql -v ON_ERROR_STOP=1 -f /migrations/0004_shadow.sql`. La migración es
idempotente (`CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS`) y no cambia columnas ni
nombres. Si falla, el despliegue aborta conservando la release anterior: no se
mueve `current`, no se levantan contenedores nuevos y `/opt/qvaapply` no se
toca. Tras migrar y activar la release, verifica `/healthz` y `/readyz`; si no
responden, restaura la release previa.

## Replay manual

El replay **no** se ejecuta durante el despliegue. Para lanzarlo en la VPS:

```bash
/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-replay.sh [run-id]
```

Sin argumento usa `replay-<UTC timestamp>` (por ejemplo
`replay-20261113T211500Z`). El script toma `/opt/qvaapply-f3-shadow/.env` y la
release activa, y ejecuta:

```bash
docker compose run --rm shadow-replay -corpus /corpus -run-id <id>
```

El contenedor monta el corpus en `/corpus:ro`, es `read_only`, sin puertos y
con `cap_drop: ALL`. Al terminar consulta `shadow.runs` y `shadow.decisions`
mediante `docker compose exec -T postgres psql` y muestra el resumen. Si el
replay falla, el script sale con código 1.

## Verificación

```bash
ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 \
  'curl -sS http://127.0.0.1:8090/healthz; \
   curl -sS http://127.0.0.1:8090/readyz; \
   curl -sS http://127.0.0.1:8090/metrics | head'
```

Validación local del paquete y del Compose:

```bash
bash -n scripts/package-f3-shadow.sh
bash -n scripts/deploy-f3-shadow.sh
bash -n scripts/f3-shadow-replay.sh
F3_POSTGRES_PASSWORD=test F3_REVISION=test \
  docker compose -f deploy/compose.f3-shadow.yaml config -q
```

## Estado desplegado (2026-11-13)

- Release `cac53dc2f71968b0e8d58c0679294281252e7dba` en
  `/opt/qvaapply-f3-shadow`.
- `healthz` y `readyz` en verde; contenedores healthy.
- `127.0.0.1:8090` únicamente; Postgres sin puerto publicado.
- Producción sigue en `02bb5afc...` y `/api/session` responde 200.
- Evidencia: [evidence/2026-11-13-f3-shadow-bootstrap.md](evidence/2026-11-13-f3-shadow-bootstrap.md).

## Límites de esta entrega

- El replay se lanza manualmente; no hay scheduler ni ejecución automática.
- El servicio no consume datos de producción ni escribe en `core`.
- No se ha modificado Nginx, el contenedor Node ni `main`.
