# Evidencia F3 — invariantes, caos, benchmark y runbook (2026-11-13)

## Invariantes

- SQL adaptado a SQLite: `services/db/audit-invariants.sqlite.sql`.
- Ejecución local sobre copia v31: **0 violaciones**.
- Ejecución en producción read-only: **0 violaciones**.
- Persistencia: `shadow.invariant_runs`.
- Run VPS: `inv-vps-20261114T032428Z`, `violations=0`.
- Timer diario `qvaapply-f3-invariants.timer` activo.

## Workflows reales

- Exportación read-only de `trade_workflows`.
- Run VPS `wf-vps-20261114T033756Z`: **17/17 workflows comparables**, 0
  divergencias.
- El comparador reutiliza la reconstrucción de riesgo desde
  `risk_decision_json.checks`.
- Local (copia antigua): **11/11**.

## Caos

`services/f3/chaos.sh` en verde con 6 escenarios:

1. JSON malformado: falla antes de escribir.
2. Evidencia vacía (`checks_json=[]`): se omite sin crear decisiones.
3. Run duplicado: falla y conserva el original con 14 decisiones.
4. Dos auditorías concurrentes con el mismo run: gana exactamente una.
5. `kill -9` durante auditoría: o no hay run o queda completo, nunca parcial.
6. Postgres inaccesible: falla sin dejar run.

```text
f3-chaos: OK (6 escenarios, sin runs parciales)
```

## Benchmark local

```text
replay: n=10 min=17ms avg=18.5ms p95=20ms
audit:  n=5  min=56ms avg=62.0ms p95=70ms
audit RSS: 20504 KB
service idle: rss=16952 KB cpu=0.0%
```

## Consumo en VPS

```text
trading-core: cpu=7.21%  mem=6.379MiB / 7.75GiB
postgres:     cpu=0.00%  mem=29.06MiB / 7.75GiB
imagen:       43,675,692 bytes, user=65532:65532
audit unit:   CPU 1.169478 s
replay unit:  CPU 1.01957 s
```

El CPU del servicio es una muestra puntual; el soak de 72 h sigue pendiente.

## Estado de jobs

- 6 timers activos: tail (5 min), soak (5 min), audit (1 h), replay (diario),
  invariants (diario), workflows (diario).
- Muestras iniciales de soak:
  `rss=2352 KB`, luego `rss=2259 KB`; Postgres ~29.2-29.6 MB; 0 divergencias;
  0 violaciones.
- Métricas: runs, decisiones, divergencias, último run, violaciones de
  invariantes, último invariantes y error de estadísticas.
- Runbook: `docs/migration/f3-shadow-runbook.md`.
- Producción intacta: `02bb5af...`, API 200.

## Gate F3

| Gate | Estado |
| --- | --- |
| 7 días de decisiones idénticas | En curso |
| Invariantes limpios diarios | Mecanismo listo; 1 día limpio |
| Caos documentado | ✅ |
| RSS/CPU medidos | ✅; muestreador activo, falta confirmar 72 h sin fugas |
| Runbook | ✅ |
