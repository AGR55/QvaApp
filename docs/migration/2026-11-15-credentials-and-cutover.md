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
**apagado**. El adaptador `internal/platform/qvapay/mutations.go` solo ejecuta
`Apply`/`Cancel` cuando un operador llama a `Enable()`. No se habilita desde una
ruta web ni desde una variable de entorno.

Para un cutover controlado:

1. Backup de `/opt/qvaapply/data` y del SQLite.
2. Congelar automatización y drenar operaciones.
3. Activar el adaptador de mutaciones en una release explícita.
4. Conmutar Nginx al edge.
5. Vigilar métricas y logs durante 14 días.
6. Rollback: devolver Nginx al TS y dejar el adaptador deshabilitado.

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
