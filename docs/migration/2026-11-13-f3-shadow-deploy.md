# F3 — despliegue shadow aislado (2026-11-13)

## Objetivo

Ejecutar `trading-core` en la VPS junto a producción, **sin tocar** el
contenedor Node `qvaapply`, su SQLite ni su configuración. Esta primera entrega
solo valida el camino de despliegue y las superficies de operación; todavía no
toma decisiones ni muta nada.

## Aislamiento

- Raíz propia: `/opt/qvaapply-f3-shadow`.
- Proyecto Compose `qvaapply-f3-shadow`, red y volúmenes propios.
- Postgres 16 interno sin puerto publicado.
- `trading-core` escucha solo en `127.0.0.1:8090`; no se publica en Nginx.
- Imagen `scratch` con binario estático; sin shell, sin root.
- `SHADOW_MODE=true`; no hay endpoints de negocio ni credenciales de QvaPay.

## Empaquetado y despliegue

```bash
# Local: compila linux/amd64 y empaqueta
scripts/package-f3-shadow.sh

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
primera vez, construye la imagen, levanta Compose y verifica `/healthz` y
`/readyz`. Si falla, restaura la release anterior y nunca toca `/opt/qvaapply`.

## Verificación

```bash
ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 \
  'curl -sS http://127.0.0.1:8090/healthz; \
   curl -sS http://127.0.0.1:8090/readyz; \
   curl -sS http://127.0.0.1:8090/metrics | head'
```

## Límites de esta entrega

- No hay comparador de decisiones ni tablas shadow todavía.
- El servicio no consume datos de producción ni escribe en `core`.
- No se ha modificado Nginx, el contenedor Node ni `main`.
