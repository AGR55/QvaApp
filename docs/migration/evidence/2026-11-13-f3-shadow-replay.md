# Evidencia F3 — replay shadow persistente en VPS (2026-11-13)

## Resultado

- Release activa: `a86654695ea7cf10515e7e89bb2405670c361cba` en
  `/opt/qvaapply-f3-shadow`.
- Migración `0004_shadow.sql` aplicada en el Postgres shadow.
- Replay ejecutado en la VPS con `scripts/f3-shadow-replay.sh`.
- Run: `f3-vps-20261114T021952Z`.
- **4/4 casos · 14/14 pasos · 0 divergencias · 14 decisiones persistidas**.
- Los 14 registros tienen `expected_json == actual_json`.
- Producción intacta: release `02bb5afc...`, `/api/session` 200.
- `trading-core` healthy, solo en `127.0.0.1:8090`.
- Imagen `scratch` con usuario `65532:65532`; Postgres sin puerto publicado.

## Consulta persistida

```text
 total | matched | same_json
-------+---------+-----------
    14 |      14 |        14
```

```json
{"runId":"f3-vps-20261114T021952Z","cases":4,"steps":14,"matched":14,"mismatches":0,"persisted":14}
```

## Flujo validado

1. El paquete incluye `trading-core`, `shadow-replay`, la migración, el corpus
   y los scripts.
2. El despliegue construye la imagen, aplica `shadow-migrate` antes de mover
   `current` y levanta el servicio.
3. El replay manual ejecuta el corpus dentro de la red shadow, persiste el run
   y las decisiones de forma atómica y consulta el resumen.
4. El runner normaliza resultado, upstream y digest; la igualdad semántica se
   refleja también en el JSON almacenado.

## Límites

- Sigue siendo replay del corpus, no ingesta shadow de producción en vivo.
- No hay scheduler ni comparación continua todavía.
- No se ha tocado Nginx, el contenedor Node, `core` de producción ni `main`.
