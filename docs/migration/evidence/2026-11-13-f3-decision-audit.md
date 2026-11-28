# Evidencia F3 — auditoría de decisiones reales (2026-11-13)

## Resultado local (copia v16)

Exportación read-only de `decision_events`:

```text
237 eventos · 221 con checks_json · 16 con checks_json="[]"
```

Auditoría con el dominio Go:

```json
{"runId":"audit-local-e2e","events":237,"comparable":221,"matched":221,"mismatches":0,"skipped":16,"persisted":221}
```

Los 221 comparables tienen `expected_json == actual_json`; las 16 filas
restantes no tienen evidencia (`checks_json="[]"`) y se omiten, no se cuentan
como divergencia.

## Resultado en la VPS

- Release `2df77638e149e7acab12bd196b4a3a29e6e0f03b` en
  `/opt/qvaapply-f3-shadow`.
- Exportación directa en modo read-only:
  `/opt/qvaapply/data/qvaapply.sqlite?mode=ro`.
- Run `f3-decisions-20261114T024256Z`:

```json
{"events":1138,"comparable":5,"matched":5,"mismatches":0,"skipped":1133,"persisted":5}
```

```text
cases | steps | matched | mismatches
    5 |     5 |       5 |          0
```

- La base de producción solo conserva 5 eventos con `checks_json`; los 1133
  restantes son históricos sin evidencia. La cobertura crecerá con las
  decisiones nuevas que guarden checks.
- El JSON temporal se elimina al terminar; `data/` quedó vacío.
- Producción sigue en `02bb5afc...` y `/api/session` responde 200.
- `trading-core` healthy, solo en `127.0.0.1:8090`; imagen con usuario
  `65532:65532`.

## Cómo funciona

1. `sqlite3 -readonly` exporta `decision_events` a JSON temporal.
2. `shadow-audit` reconstruye el contexto de riesgo desde `checks_json` y
   ejecuta `riskpolicy.Evaluate` (Go).
3. Compara tipo, estados de checks y razones; para `applied` no compara el
   texto de confirmación de TS.
4. Persiste run y decisiones de forma atómica en `shadow.runs` y
   `shadow.decisions`.

## Límites

- No hay scheduler continuo; la auditoría se lanza manualmente.
- No se leen tablas de producción distintas de `decision_events`.
- No se ha modificado SQLite, el monolito Node, Nginx ni `main`.
- Sigue pendiente la ingesta shadow en vivo y el soak de 72 h.
