# Hito MVP — módulos Go y pre-cutover (2026-11-14)

## Resultado del checklist

`scripts/f3-cutover-check.sh` ejecutado por SSH:

```text
Resumen: 35 comprobaciones, 0 fallos, 0 avisos
Resultado: comprobaciones OK. Este script no ejecuta el cutover.
```

Incluye:

- 5 contenedores shadow healthy (`trading-core`, `hunter`, `notifier`, `edge`,
  `postgres`);
- health/ready de 8090/8091/8092/8093;
- SSE conectado, **0 polls `/p2p`**, **0 errores SSE**;
- cola hunter 0 pendientes/fallidos;
- **19 decisiones core**, **18 ejecuciones ledger**, **12 operaciones
  confirmadas**;
- invariantes sin violaciones;
- producción TS intacta en `02bb5af`, API 200;
- API móvil autenticada: overview/markets/alerts/operations 200.

## Módulos integrados

| Módulo | Estado |
| --- | --- |
| `hunter` | SSE-only, 0 polling, eventos y candidatos durables |
| `trading-core` | intake, `riskpolicy`, ledger simulado y operaciones `reserved → confirmed` |
| `notifier` | webhook Telegram, comandos, menús inline, dry-run y dedupe |
| `edge` | shell, assets, sesión HMAC/CSRF, login/logout y summary |

## Verificación adicional

```text
login edge:        401 sin sesión / 200 login / 204 logout / 401 después
bot /status:       respuesta + menú inline, sin envío real
operación shadow:  reserved -> confirmed, version 3, timestamps monótonos
```

## Límites que siguen vigentes

- `core` no mueve dinero real ni llama a mutaciones QvaPay.
- `edge` no implementa todavía todas las rutas `/api/*` ni paridad visual.
- El bot no tiene long-polling/webhook registrado en Telegram ni push/FCM.
- No se ha ejecutado el cutover ni cambiado Nginx.
- El token QvaPay y la contraseña de Telegram no se han usado para mutar nada.
