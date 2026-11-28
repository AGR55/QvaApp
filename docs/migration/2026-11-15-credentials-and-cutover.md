# Credenciales, claves y cutover — guía práctica

Este documento responde a una pregunta concreta: **de dónde sale cada valor que
el edge/notifier necesitan y dónde se coloca**. La mayoría ya existe en el
proyecto TS; no hay que inventarla.

## 1. Claves Web Push (VAPID)

**No tienes que crear nada.** Producción ya las tiene en el SQLite:

```text
settings.web_push:vapid_keys = {"publicKey":"...","privateKey":"..."}
```

Ruta real: `/opt/qvaapply/data/qvaapply.sqlite`.

El deploy del shadow las lee y escribe `/opt/qvaapply-f3-shadow/push.env`
(permisos `600`). Ese archivo alimenta:

- `notifier`: `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`,
  `WEB_PUSH_SUBJECT`, `PUSH_SEND_ENABLED=true`.
- `edge`: `EDGE_PUSH_PUBLIC_KEY` (misma clave pública).

Verificado: el `publicKey` de producción y el del shadow tienen el mismo
SHA-256; `/api/push/public-key` responde 200 y `/push/send` ya no está
deshabilitado. No se imprimen las claves en logs.

Si algún día quieres rotarlas, borra `push.env` y el deploy generará un par
nuevo con `scripts/f3-generate-vapid.py`. Las suscripciones antiguas dejarían de
servir.

## 2. Push de chat/FCM

Producción declara la ruta del JSON de servicio FCM en:

```text
/opt/qvaapply/config/env  ->  QVAAPPLY_FCM_CREDENTIALS_FILE=/ruta/al/json
```

Para activar FCM en el notifier:

1. Copia ese JSON a `/opt/qvaapply-f3-shadow/fcm.json` con permisos `600`.
2. Añade a `/opt/qvaapply-f3-shadow/push.env`:
   `QVAAPPLY_FCM_CREDENTIALS_FILE=/data/fcm.json`.
3. Monta el archivo en el contenedor notifier (`/data/fcm.json:ro`).

El Web Push del navegador ya funciona sin FCM. FCM solo hace falta para push de
la app móvil.

## 3. Telegram

Producción ya tiene:

```text
/opt/qvaapply/config/env -> TELEGRAM_BOT_TOKEN=...
                           TELEGRAM_ADMIN_CHAT_ID=...
```

Para activar el webhook del edge:

1. Elegir una URL pública, por ejemplo
   `https://qvapply.honux.tech/webhooks/telegram`.
2. Definir un secreto `NOTIFIER_TELEGRAM_SECRET` y la URL
   `TELEGRAM_WEBHOOK_URL`.
3. Activar `TELEGRAM_WEBHOOK_ENABLED=true` y aplicar el deploy.
4. **Ventana obligatoria:** Telegram solo admite un modo de entrega. Hay que
   retirar el long-polling del TS antes de registrar el webhook. Si se hace en
   paralelo se pierden mensajes.

## 4. Cuentas lectoras QvaPay

Producción guarda las cuentas en `market_reader_accounts` del SQLite. El deploy
importa automáticamente esas filas a `shadow.market_readers`, incluida la cuenta
**“Cuenta Eric”** con intervalo de 3 s. Los tokens siguen cifrados con la misma
`LOCAL_ENCRYPTION_KEY`; no se muestran.

Para añadir otra:

1. Entra en la cuenta QvaPay y crea un token con permiso **`p2p:read`**.
2. En el panel: **Estrategia → Fuente de mercado → Añadir cuenta lectora**.
3. Pega etiqueta, token e intervalo (3–3600 s). El edge lo cifra y lo guarda.
4. En modo `polling`, hunter rota las cuentas habilitadas.
5. Para quitar una cuenta: botón de eliminar; el token deja de usarse.

## 5. Credenciales del feed/stream

Producción ya tiene:

```text
settings.market_feed_app_id
settings.market_feed_app_secret
settings.market_feed_secret
```

El deploy las importa cifradas a `shadow.runtime_settings`; la pantalla
Estrategia las muestra como configuradas sin revelarlas. No hace falta pegarlas
de nuevo. Para rotarlas, usa los formularios de la misma pantalla.

## 6. Variables que ya inyecta el deploy

| Variable | Origen | Destino |
| --- | --- | --- |
| `EDGE_ADMIN_PASSWORD` | `DASHBOARD_ADMIN_PASSWORD` | `edge.env` |
| `EDGE_SESSION_SECRET` | `LOCAL_ENCRYPTION_KEY` | `edge.env` |
| `EDGE_TRUSTED_ORIGIN` | `DASHBOARD_TRUSTED_ORIGIN` | `edge.env` |
| `LOCAL_ENCRYPTION_KEY` | `/opt/qvaapply/config/env` | `edge.env`, `hunter.env` |
| `WEB_PUSH_*` | `settings.web_push:vapid_keys` | `push.env` |
| App/feed secret | settings `market_feed_*` | `runtime_settings` cifrado |

No hay que copiar valores a mano. El deploy los lee del entorno de producción
en modo read-only.

## 7. Mutaciones de dinero y cutover

Todo lo que crea, edita o cancela ofertas, aplica operaciones, rebalancea
capital, publica contribuciones cooperativas o resuelve conciliaciones sigue
**apagado**. El adaptador `internal/platform/qvapay/mutations.go` ejecuta
`Apply`, `Cancel`, `CreateOffer`, `EditOffer`, `MarkPaid` y `ConfirmReceived`
cuando `EDGE_MUTATIONS_LIVE=true` y el token está disponible. No se habilita desde una
ruta web ni desde una variable de entorno.

### Qué es la ventana de congelamiento

Es el intervalo en que se detiene el bot TS para que no compita con Go por la
misma oferta. Si ambos motores ven la misma oferta, TS puede aplicarla primero
y Go recibiría un rechazo, o se podrían generar dos intentos sobre la misma
contraparte.

```bash
# 1. Sincronizar saldos fiat reales al panel Go
python3 scripts/f3-sync-fiat-balances.py

# 2. Backup
systemctl start qvaapply-backup.service

# 3. Abrir la ventana: TS deja de cazar y aplicar
docker stop qvaapply

# 4. Habilitar dinero real en Go (core y edge)
#    core.env:   CORE_AUTOTRADE_DRY_RUN=false
#    edge.env:   EDGE_MUTATIONS_LIVE=true
docker compose ... up -d trading-core edge

# 5. Aplicar la oferta/acción autorizada y verificar QvaPay

# 6. Rollback inmediato si algo falla
#    CORE_AUTOTRADE_DRY_RUN=true, EDGE_MUTATIONS_LIVE=false
docker start qvaapply
```

Duración recomendada: 2–5 minutos para una sola aplicación; 15–30 minutos si
además se conmuta Nginx para revisar la web. Durante la ventana la web solo
sigue disponible si Nginx apunta al edge.

### Procedimiento completo

1. Backup de `/opt/qvaapply/data` y del SQLite.
2. `scripts/f3-sync-fiat-balances.py` para que el dimensionado use saldos reales.
3. Congelar TS (`docker stop qvaapply`) y drenar operaciones.
4. Activar `CORE_AUTOTRADE_DRY_RUN=false` y `EDGE_MUTATIONS_LIVE=true`.
5. Conmutar Nginx al edge si se quiere mantener la web.
6. Vigilar métricas y logs durante 14 días.
7. Rollback: devolver Nginx al TS, `docker start qvaapply`, y dejar ambas
   banderas en modo seguro.

Sin ese procedimiento, las rutas financieras del edge no deben habilitarse.

## 8. Estado de paridad

```text
Auditoría estática: 109/109 rutas
```

Toda la superficie HTTP existe. Las mutaciones financieras están en modo
shadow (`EDGE_MUTATIONS_ENABLED=true`) y registran intenciones sin llamar a
QvaPay. Para ejecutar dinero real sigue haciendo falta la ventana de cutover y
habilitar el adaptador de mutaciones; el chat y `payment-preview` requieren el
servicio remoto en vivo.
