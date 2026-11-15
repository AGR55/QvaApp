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

## Tareas posteriores a la vigilancia

1. Confirmar 14 días sin fallos críticos.
2. Borrar el contenedor y la imagen de TS, y retirar su compose/systemd.
3. Archivar `/opt/qvaapply` y conservar el backup SQLite.
4. Portar el refresco automático de ofertas propias (hoy se gestionan desde el
   panel) y la cancelación automática por vencimiento.
5. Validar un ciclo pagado completo (`paid` + `received`) con el ledger fiat.
6. Telegram/FCM: no estaban configurados en producción (`TELEGRAM_BOT_TOKEN`
   vacío, sin credenciales FCM), así que no hay regresión respecto a TS.
