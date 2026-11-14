# Evidencia F3 — bootstrap shadow en VPS (2026-11-13)

## Resultado

- Servicio `trading-core` shadow desplegado en la VPS por SSH.
- Release: `/opt/qvaapply-f3-shadow/releases/cac53dc2f71968b0e8d58c0679294281252e7dba`.
- Imagen `scratch` con binario estático linux/amd64, usuario no root.
- Postgres 16 propio, sin puerto publicado.
- `trading-core` escucha solo en `127.0.0.1:8090`.
- Producción intacta: `qvaapply` sigue en
  `/opt/qvaapply/releases/02bb5afc04b5eb95f5ac3996ef7634dedf073d02` y
  `/api/session` responde 200.

## Verificación

```text
f3 health: {"status":"ok"} / {"status":"ok"}
qvaapply-f3-shadow-trading-core Up (healthy) 127.0.0.1:8090->8090/tcp
qvaapply-f3-shadow-postgres Up (healthy) 5432/tcp
ss: LISTEN 127.0.0.1:8090
/opt/qvaapply-f3-shadow/.env 600 root:root
prod current: /opt/qvaapply/releases/02bb5afc...
prod api: 200
```

Log del servicio:

```json
{"level":"INFO","msg":"trading-core iniciado","service":"trading-core-shadow","port":"8090","shadow_mode":true,"database_configured":true}
```

## Aislamiento

- Proyecto Compose, red y volúmenes `qvaapply-f3-shadow` propios.
- Sin Nginx, sin firewall y sin puerto público para F3.
- Sin credenciales de QvaPay ni acceso a la SQLite de producción.
- Sin endpoints de negocio ni mutaciones.
- Rollback del deploy limitado a `/opt/qvaapply-f3-shadow`.

## Trabajo delegado y verificado

- Subagente 1: esqueleto HTTP (`healthz`, `readyz`, `metrics`, apagado
  ordenado), tests y Dockerfile.
- Subagente 2: compose aislado, empaquetador y script de despliegue/rollback.
- Flujo principal: revisión de código, tests `-race`, lint, build local,
  empaquetado, despliegue SSH y verificación de producción.

## Siguiente

1. Añadir esquema y escritura de decisiones shadow.
2. Comparador contra el oráculo TS y reporte de divergencias.
3. Ingesta shadow de datos reales sin permiso de mutación.
