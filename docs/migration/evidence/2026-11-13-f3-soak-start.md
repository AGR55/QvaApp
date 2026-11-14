# Evidencia F3 — inicio de soak continuo (2026-11-13)

## Timers instalados en la VPS

```text
NEXT                         LEFT LAST PASSED UNIT                     ACTIVATES
Sat 2026-11-14 03:01:30 UTC  ~11min -        - qvaapply-f3-audit.timer  qvaapply-f3-audit.service
Sun 2026-11-15 00:05:32 UTC   ~21h  -        - qvaapply-f3-replay.timer qvaapply-f3-replay.service
```

- `qvaapply-f3-audit.timer`: cada hora; exporta `decision_events` en read-only,
  audita con Go y persiste en `shadow.*`.
- `qvaapply-f3-replay.timer`: diario; ejecuta el corpus replay completo.
- Ambos usan `Persistent=true` y retardo aleatorio; sobreviven reinicios.
- Solo administran unidades `qvaapply-f3-*`; no tocan `/opt/qvaapply`.
- Desinstalación:
  `/opt/qvaapply-f3-shadow/current/scripts/install-f3-shadow-timer.sh uninstall`.

## Ejecución de prueba

Arranque manual de ambas unidades con éxito:

```text
qvaapply-f3-audit.service   status=0/SUCCESS  5/5 comparables, 0 divergencias
qvaapply-f3-replay.service  status=0/SUCCESS  14/14 pasos, 0 divergencias
```

Métricas tras las ejecuciones:

```text
trading_core_shadow_runs_total 4
trading_core_shadow_decisions_total 38
trading_core_shadow_mismatches_total 0
trading_core_shadow_stats_error 0
```

## Estado

- Release activa: `ad99fac9c17ea047a10d45afa41bd41004c6b1b2`.
- `trading-core` healthy, solo `127.0.0.1:8090`.
- Producción sigue en `02bb5afc...`; `/api/session` 200.
- La release incorpora `shadow-audit` y las métricas agregadas de `shadow.*`.
- El soak empieza con estos timers; falta acumular 72 h y revisar memoria,
  divergencias y crecimiento de runs.

## Límites

- La auditoría depende de que `decision_events` guarde `checks_json`; los
  históricos sin checks se omiten.
- No hay lectura de más tablas de producción ni mutaciones.
- El soak todavía no ha completado 72 h.
