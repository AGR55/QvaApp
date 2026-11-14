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

## Auditoría de decisiones reales

La auditoría tampoco se ejecuta sola. Exporta `decision_events` de la SQLite de
producción en modo read-only, lo monta en el contenedor one-shot
`shadow-audit` y persiste la comparación:

```bash
/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-audit.sh [run-id]
```

El script nunca escribe en `/opt/qvaapply/data`; el JSON temporal se borra al
terminar. En la última ejecución de la VPS: **1138 eventos, 5 comparables,
5/5 coincidencias, 1133 sin checks históricos**. Localmente, con la copia v16:
**237 eventos, 221 comparables, 221/221**. Evidencia:
[decision-audit](evidence/2026-11-13-f3-decision-audit.md).

## Soak continuo

Los timers se instalan una sola vez en la VPS:

```bash
/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh install
```

- `qvaapply-f3-tail.timer`: cada 5 minutos; solo decisiones nuevas.
- `qvaapply-f3-audit.timer`: cada hora; auditoría completa.
- `qvaapply-f3-replay.timer`: diario; corpus replay.
- `qvaapply-f3-invariants.timer`: diario; invariantes SQLite read-only.
- `Persistent=true`; sobreviven reinicios.
- No tocan `/opt/qvaapply`; se desinstalan con `... uninstall`.

`/metrics` expone `trading_core_shadow_runs_total`,
`trading_core_shadow_decisions_total`,
`trading_core_shadow_mismatches_total`,
`trading_core_shadow_last_run_timestamp_seconds` y
`trading_core_shadow_stats_error`,
`trading_core_shadow_invariant_violations_total` y
`trading_core_shadow_last_invariant_timestamp_seconds`. El cursor incremental está en
`/opt/qvaapply-f3-shadow/data/decision-events.cursor` (permisos 600) y solo
avanza tras persistir correctamente. Evidencia:
[soak-start](evidence/2026-11-13-f3-soak-start.md).

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

- Release activa `2ace88f58d69f3e05bb3d8536f7c590c78f0c251` en
  `/opt/qvaapply-f3-shadow`.
- Migración `0004_shadow.sql` aplicada; replay y auditoría persistentes.
- Run `f3-vps-20261114T021952Z`: **4/4 casos, 14/14 pasos, 14/14 JSON
  idénticos**, 0 divergencias.
- Auditoría real `f3-decisions-20261114T024256Z`: **5/5 comparables**, 0
  divergencias (1133 históricos sin checks).
- `healthz` y `readyz` en verde; contenedores healthy.
- `127.0.0.1:8090` únicamente; Postgres sin puerto publicado.
- Producción sigue en `02bb5afc...` y `/api/session` responde 200.
- Evidencias:
  [bootstrap](evidence/2026-11-13-f3-shadow-bootstrap.md) ·
  [replay](evidence/2026-11-13-f3-shadow-replay.md) ·
  [decision-audit](evidence/2026-11-13-f3-decision-audit.md) ·
  [soak-start](evidence/2026-11-13-f3-soak-start.md) ·
  [gate-controls](evidence/2026-11-13-f3-gate-controls.md).

## Límites de esta entrega

- Replay y auditoría se lanzan manualmente; no hay scheduler continuo.
- Sigue siendo replay/auditoría batch, no ingesta shadow en vivo.
- El servicio no escribe en `core` ni en la SQLite de producción.
- No se ha modificado Nginx, el contenedor Node ni `main`.
