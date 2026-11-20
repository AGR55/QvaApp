# Cutover ejecutado y vigilancia — 2026-11-15

## Estado

El corte se ejecutó el **2026-11-15 a las 20:28 UTC**.

```text
Nginx              qvapply.honux.tech -> 127.0.0.1:8093 (edge Go)
TS                 contenedor qvaapply detenido (exited)
CORE_AUTOTRADE     true
CORE_AUTOTRADE_DRY_RUN  false
EDGE_MUTATIONS_LIVE     true
EDGE_LIVE_DASHBOARD     true
```

El contenedor de TS **no se ha borrado**: queda detenido como rollback durante
la vigilancia. Su política es `unless-stopped`, así que no vuelve a arrancar
solo tras un reinicio.

## Verificación del corte

```text
dominio /            200
login + CSRF         OK
/api/config          200 · 5 mercados
/api/dashboard       200 · balance 120.57 · 4 ownOffers · 50 operaciones
/api/operations/.../chat 200
edge health          200
TS                   exited
watch check          0 fallos, 0 avisos
```

Navegador real sobre `https://qvapply.honux.tech`:

- login correcto;
- dashboard con capital y mercados;
- página de Operaciones con estados `Applied`, `Completed` y `Dry Run`;
- configuración por mercado accesible.

## Primera aplicación autónoma real

El motor Go aplicó solo, después del corte:

```text
oferta      f0612b27-fdf0-42ba-a87f-4939cab1f89c
mercado     CLASICA · fija · sell
importe     14.28 QUSD
fiat        15.00 USD (tasa 1.0504)
estado      processing / applied=true
hasDetails  true
```

Aparece en el panel como **Applied** con las acciones «Registrar pago» y
«Cancelar». El pago debe hacerse o cancelarse dentro de la ventana de 60
minutos de las ofertas fijas.

`trading_core_autotrade_applied_total = 1`.

### Cierre de la primera operación autónoma

QvaPay pasó la oferta a `paid` y luego `completed`. El conciliador actualizó el
panel y el ledger fiat:

```text
saldo QUSD QvaPay     120.57 -> 134.85  (+14.28)
fiat CLASICA          44.437 -> 29.357  (-15.08 = 15.00 + 0.08 fee)
local_operations      applied -> paid -> completed
fiat_ledger           1 débito de 15.08 CLASICA
```

La transición `paid` ocurrió antes de desplegar el registro fiat; el débito se
corrigió con el mismo método idempotente (`RecordOperationFiat`). Las
transiciones posteriores ya lo registran automáticamente: el conciliador
consulta `paid`/`completed` y aplica el movimiento antes de actualizar el
estado local.

### TS definitivamente parado

```text
docker stop qvaapply
docker update --restart=no qvaapply
estado   exited
restart  no
```

No vuelve a arrancar ni con un reinicio del host. Para rollback:
`docker update --restart=unless-stopped qvaapply && docker start qvaapply`.

## Validaciones previas al corte

- Aplicación y cancelación real de una oferta **fija** (10 QUSD).
- Aplicación y cancelación real de una oferta **flexible** (5 QUSD) con
  `order_uuid = c0d9fab1-53ab-409f-b8db-55959b9c3812`; QvaPay pasó de 195 a 200
  disponibles al cancelar.
- Operación publicada en `shadow.local_operations` con estado `applied` y luego
  `cancelled`.
- Ledger fiat probado en vivo: crédito de 0.01, reintento idempotente
  (`applied=false`), reversión y saldo restaurado.

## Vigilancia

```text
inicio   2026-11-15T20:28:49Z
fin      2026-11-29T20:28:49Z (14 días)
```

Comprobación diaria automática:

```text
timer    qvaapply-watch.timer
hora     08:00 UTC
script   /usr/local/sbin/qvaapply-watch
fuente   scripts/f3-watch-check.sh
log      journalctl -u qvaapply-watch.service
```

La comprobación verifica: TS detenido, Nginx al edge, banderas live,
contenedores sanos, dominio/login/config/dashboard, operaciones inciertas o a
medias, eventos pendientes, backup reciente y disco.

## Rollback

```bash
cp -a /tmp/qvaapply.conf.cutover.20261115T202630Z \
  /etc/nginx/sites-available/qvaapply.conf
nginx -t && systemctl reload nginx
# restaurar flags seguras en core.env/edge.env
docker start qvaapply
```

## Bucles de mantenimiento portados

El edge ejecuta desde `a2958f9`:

- **Refresco de ofertas propias**: cada `offerRefreshIntervalMinutes` (4 min),
  una edición como máximo cada `offerRefreshSpacingSeconds` (10 s), priorizando
  la oferta más antigua. Evidencia real:

  ```text
  oferta propia refrescada 52b3c773-e5ac-4cde-8487-70359f8ced20
  oferta propia refrescada 22549487-33a4-420f-8397-21727bc4b3f5
  oferta propia refrescada aff332d6-6fe5-4226-b056-17495ae46396
  ```

- **Autocancelación por vencimiento**: cada 30 s revisa operaciones
  `applied`/`acknowledged` con antigüedad mayor a `autoCancelMinutes` (60 min).
  Antes de cancelar exige que QvaPay siga en `processing`; si ya está
  `paid`/`completed`, no la toca. Usa el mismo `order_uuid` de la operación.

Tests puros: `NextOfferToRefresh`, `DueForCancel`, `ShouldAutoCancel`.

## Retirada de TS

Script listo: `scripts/f3-remove-ts.sh`. Exige `F3_CONFIRM_REMOVE=yes` y que
haya pasado `2026-11-29T20:28:49Z` (o `F3_FORCE=yes` con autorización). Antes de
borrar ejecuta la comprobación completa de vigilancia; archiva config y SQLite
en `/opt/qvaapply-archive` y retira el contenedor/imagen. Los backups y la
auditoría se conservan.

Validación en seco ejecutada el 2026-11-15:

```text
F3_DRY_RUN=yes /usr/local/sbin/qvaapply-remove-ts
  watch check        0 fallos, 0 avisos
  contenedor         /qvaapply exited
  imagen             sha256:ab97bb11...
  archivo previsto   /opt/qvaapply-archive/qvaapply-ts-<timestamp>.tar.gz
  dry-run            no se archivó ni se borró nada
```

El timer `qvaapply-remove-ts.timer` está armado para el **2026-11-30 08:00 UTC**
y ejecutará el mismo camino con `F3_CONFIRM_REMOVE=yes`. Si la vigilancia falla,
el servicio termina en error y no borra nada.

## Tareas posteriores a la vigilancia

1. Confirmar 14 días sin fallos críticos.
2. Ejecutar `scripts/f3-remove-ts.sh` con `F3_CONFIRM_REMOVE=yes`.
3. Validar un ciclo pagado manual completo (`paid` + `received`) con el ledger
   fiat; el automático ya se validó en `f0612b27`.
4. Telegram/FCM: no estaban configurados en producción (`TELEGRAM_BOT_TOKEN`
   vacío, sin credenciales FCM), así que no hay regresión respecto a TS.
