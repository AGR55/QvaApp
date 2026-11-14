# Runbook F3 — `trading-core` shadow

## Alcance

Este runbook cubre el servicio F3 desplegado en la VPS, **aislado de
producción**:

- Raíz: `/opt/qvaapply-f3-shadow`.
- Compose: `qvaapply-f3-shadow`.
- Servicio HTTP: `trading-core`, solo `127.0.0.1:8090`.
- Postgres: `qvaapply-f3-shadow-postgres`, sin puerto publicado.
- Jobs: replay, auditoría de decisiones, tail incremental e invariantes.
- Nunca escribe en `/opt/qvaapply`, en la SQLite de producción ni en QvaPay.

## Arquitectura

```text
/opt/qvaapply/data/qvaapply.sqlite  (producción, solo lectura)
          │
          ├── f3-shadow-tail.sh       cada 5 min, solo filas nuevas
          ├── f3-shadow-audit.sh      cada hora, histórico completo
          └── f3-shadow-invariants.sh diario, SQL de invariantes
                    │
                    ▼
       Postgres shadow (shadow.runs / shadow.decisions /
                        shadow.invariant_runs)
                    │
                    ▼
       trading-core :8090 (/healthz /readyz /metrics)
```

El replay del corpus no lee producción; usa
`parity/fixtures/replay/2026-11-12`.

## Despliegue

```bash
# Local
scripts/package-f3-shadow.sh <sha>
scp -i ~/.ssh/qvaapply_codex \
  /tmp/qvaapply-f3-shadow-<sha>.tar.gz root@2.25.247.171:/tmp/

# VPS
rm -rf /tmp/f3-deploy && mkdir -p /tmp/f3-deploy
tar -xzf /tmp/qvaapply-f3-shadow-<sha>.tar.gz -C /tmp/f3-deploy \
  scripts/deploy-f3-shadow.sh
bash /tmp/f3-deploy/scripts/deploy-f3-shadow.sh \
  /tmp/qvaapply-f3-shadow-<sha>.tar.gz <sha>
```

El script:

1. Extrae la release.
2. Construye la imagen `scratch`.
3. Aplica `0004_shadow.sql` y `0005_invariants.sql` antes de mover `current`.
4. Levanta el Compose aislado.
5. Verifica `/healthz` y `/readyz`.
6. Si falla, restaura la release anterior sin borrar el volumen Postgres.

## Timers

```bash
/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh install
/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh status
/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh uninstall
```

| Timer | Frecuencia | Acción |
| --- | --- | --- |
| `qvaapply-f3-tail.timer` | 5 min | decisiones nuevas (`id > cursor`) |
| `qvaapply-f3-audit.timer` | 1 h | auditoría completa de `decision_events` |
| `qvaapply-f3-replay.timer` | 1 día | corpus replay |
| `qvaapply-f3-invariants.timer` | 1 día | invariantes SQLite |
| `qvaapply-f3-soak.timer` | 5 min | muestra RSS/CPU y contadores |

Todos son `Persistent=true`, con `Nice=10` e IO idle. Solo administran
unidades `qvaapply-f3-*`.

## Cursor incremental

Archivo: `/opt/qvaapply-f3-shadow/data/decision-events.cursor` (permisos 600).

- La primera ejecución lo inicializa al máximo `id`.
- Solo avanza tras persistir el run correctamente.
- El límite superior se fija antes de exportar; las filas nuevas durante la
  ejecución quedan para la siguiente.
- Si el contenedor o la base fallan, el cursor no avanza y se reintenta.

## Soak

`qvaapply-f3-soak.timer` guarda cada 5 min en `shadow.soak_samples`:
RSS del servicio y de Postgres, CPU del servicio, runs, decisiones,
divergencias y violaciones de invariantes. El informe:

```bash
/opt/qvaapply-f3-shadow/current/scripts/f3-shadow-soak-report.sh
```

Falla si hay divergencias o violaciones. La tabla permite comparar el RSS
inicial y final para detectar fugas durante las 72 h.

## Métricas

```bash
curl -sS http://127.0.0.1:8090/metrics
```

| Métrica | Uso |
| --- | --- |
| `trading_core_shadow_runs_total` | runs persistidos |
| `trading_core_shadow_decisions_total` | decisiones evaluadas |
| `trading_core_shadow_mismatches_total` | divergencias acumuladas |
| `trading_core_shadow_last_run_timestamp_seconds` | frescura |
| `trading_core_shadow_invariant_violations_total` | violaciones |
| `trading_core_shadow_last_invariant_timestamp_seconds` | frescura de invariantes |
| `trading_core_shadow_stats_error` | error consultando shadow.* |

Alertas recomendadas: `mismatches > 0`, `invariant_violations > 0`,
`last_run` con más de 15 min, `stats_error = 1`.

## Verificación diaria

```bash
curl -fsS http://127.0.0.1:8090/healthz
curl -fsS http://127.0.0.1:8090/readyz
curl -fsS http://127.0.0.1:8090/metrics | grep -E 'shadow_|stats_error'
systemctl list-timers --all 'qvaapply-f3-*' --no-pager
systemctl --failed 'qvaapply-f3-*'

docker exec qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -c \
  "select source, count(*), sum(steps), sum(matched), sum(steps-matched)
   from shadow.runs group by source;"
```

## Fallos y respuesta

### El servicio no está healthy

```bash
docker ps --filter name=qvaapply-f3-shadow
docker logs --tail=100 qvaapply-f3-shadow-trading-core
curl -v http://127.0.0.1:8090/readyz
```

Si Postgres está caído, no borrar el volumen. Reiniciar el servicio y volver a
comprobar `readyz`.

### Auditoría o tail fallan

```bash
systemctl status qvaapply-f3-audit.service --no-pager -n 50
journalctl -u qvaapply-f3-audit.service -n 80 --no-pager
journalctl -u qvaapply-f3-tail.service -n 80 --no-pager
```

- Si falla por SQLite bloqueada, el cursor no avanza; se reintenta.
- Si falla por `shadow.*`, aplicar migraciones con
  `docker compose ... run --rm shadow-migrate`.
- Si hay divergencias, el run queda persistido y `/metrics` lo refleja.

### Invariantes con violaciones

El script sale con código 1, imprime las filas y persiste el run. No mutar
producción desde el shadow. Abrir incidencia y contrastar con el auditor de F1
sobre una copia importada.

### Disco

El volumen shadow contiene runs históricos. Antes de purgar, exportar evidencia.
Purga conservadora (ejemplo, > 30 días), ejecutada manualmente:

```sql
DELETE FROM shadow.runs
WHERE created_at < extract(epoch FROM now()) - 30 * 86400;
-- ON DELETE CASCADE elimina shadow.decisions.
```

No purgar `shadow.invariant_runs` sin conservar el informe diario.

### Rollback

```bash
# Desactivar jobs de F3
/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh uninstall

# Volver a la release anterior: ejecutar deploy con el SHA previo empaquetado
# o restaurar el symlink:
readlink -f /opt/qvaapply-f3-shadow/current
```

El deploy ya revierte automáticamente si falla la salud. `/opt/qvaapply` no se
toca.

## Caos y benchmark

```bash
# Caos local; usa Postgres temporal y SQLite read-only
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=... PGADMIN_DB=qvaapply bash services/f3/chaos.sh

# Benchmark local
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply \
PGPASSWORD=... PGADMIN_DB=qvaapply bash services/f3/bench.sh
```

Escenarios de caos cubiertos: JSON malformado, evidencia vacía, run duplicado,
concurrencia por el mismo run, kill -9 y Postgres inaccesible. Se verifica que
no queden runs parciales.

## Seguridad

- SQLite se abre con `sqlite3 -readonly` y URI `mode=ro`.
- El JSON temporal solo existe durante el job, se monta read-only en el
  contenedor y se borra al terminar.
- La imagen es `scratch`, usuario `65532`, `read_only`, `cap_drop: ALL`,
  `no-new-privileges`.
- No hay puerto público ni Nginx para F3.
- No se guardan secretos en el repositorio.

## Estado del gate F3

| Gate | Estado |
| --- | --- |
| Decisiones idénticas 7 días | En curso con tail cada 5 min |
| Invariantes limpios diarios | Mecanismo listo; 1 ejecución limpia registrada |
| Caos documentado | ✅ 6 escenarios |
| RSS/CPU medidos; 72 h sin fugas | Muestreador activo; soak pendiente |
| Runbook | ✅ este documento |

Siguiente fase: completar 7 días/72 h, conectar la ingesta shadow en vivo y
portar los casos de uso restantes.
