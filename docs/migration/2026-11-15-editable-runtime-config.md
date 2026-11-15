# Configuración editable y cuentas lectoras — 2026-11-15

## Qué quedó activo

El panel web completo (`public/dashboard`) se sirve desde el edge y ahora puede
leer y guardar la configuración que antes vivía sólo en el monolito TS:

| Área | Endpoint | Persistencia |
| --- | --- | --- |
| Configuración completa | `GET /api/config` | `shadow.runtime_config` |
| Guardar configuración | `PUT /api/config` | nueva revisión + versión |
| Historial | `GET /api/config-revisions` | `shadow.runtime_config_revisions` |
| Cacería | `PUT /api/hunting` | mismas tablas, merge parcial |
| Estrategia | `PUT /api/strategy` | mercados BANK_CUP/BANDECPREPAGO + reserva |
| Control | `PUT /api/control` | `shadow.runtime_settings` |
| Fuente de mercado | `GET/PUT /api/market-source` | modo `polling`/`hybrid` |
| Secretos del feed | `PUT /api/market-source/webhook-secret` | cifrado AES-GCM |
| Credenciales del stream | `PUT /api/market-source/stream-credentials` | cifrado AES-GCM |
| Cuentas lectoras | `POST/PUT/DELETE /api/market-readers` | `shadow.market_readers` |
| Rotar token | `PUT /api/market-readers/:id/token` | token cifrado + fingerprint |

Todas las mutaciones exigen cookie de sesión, `X-CSRF-Token` y `Origin`
coincidente (configurado o same-origin). Los secretos nunca se devuelven.

## Consumo en caliente

- `hunter` recarga `shadow.runtime_config` cada 5 s y lee
  `market_source.mode`, `control.paused` y `control.emergency_stop`.
- En modo `polling`, el intervalo efectivo es
  `max(3000 ms, automation.scanIntervalSeconds * 1000)`.
- En modo `hybrid`, se conserva `HUNTER_POLL_MS` (0 = SSE-only).
- `hunter` rota los lectores habilitados para `Offers`/`Averages`; el cliente
  principal queda como fallback.
- `trading-core` recarga riesgo, mercados y saldos fiat cada 10 s y aplica el
  snapshot antes de decidir.
- Métricas de verificación:
  - `hunter_runtime_config_version`
  - `hunter_runtime_paused`
  - `hunter_poll_interval_ms`
  - `trading_core_runtime_config_version`

## Evidencia en VPS

```text
login web                     = 200, data.csrfToken presente
GET /api/config               = 200, 5 mercados, version 3
PUT /api/config               = 204
PUT /api/hunting              = 204
PUT /api/control {"paused":true} = 204
hunter_runtime_paused         = 1
hunter_runtime_config_version = 4 → 5
trading_core_runtime_config_version = 4
UI “Configuración activa y auditada.”
UI Cacería: controles, precios y salud renderizados sin errores
UI Mercados/Operaciones/Capital/Gráficas/Auditoría/Logs/Red renderizadas
```

Guardar desde el navegador cambió `automation.scanIntervalSeconds` de 3 a 4 y
luego se restauró a 3; ambas revisiones quedaron auditadas y el hunter aplicó
las versiones.

## Logs, notificaciones, recuperación e iconos

También quedaron activas estas superficies que no mueven dinero:

| Ruta | Estado |
| --- | --- |
| `GET /api/logs` | 5.000 eventos reales con filtros de nivel, componente, texto y período |
| `GET /api/notifications` | Notificaciones pendientes reales; excluye las reconocidas |
| `POST /api/notifications/:id/ack` | Persiste el reconocimiento en `shadow.notification_acks` |
| `GET /api/recovery` | Intenciones `submitted`/`uncertain` con evidencia y avisos |
| `POST /api/market-icons` | Icono validado, escrito de forma atómica y servido |

Los iconos se guardan en `/opt/qvaapply-f3-shadow/market-icons` (volumen
escribible, UID 65532) y se sirven en `/market-icons/:name`; si no existe en el
volumen se usa el asset público del repositorio. SVG con scripts/eventos se
rechaza.

La consola muestra los logs reales (120 eventos, niveles y componentes) y la
notificación “Aplicación confirmada” de producción. El panel de recuperación
lee las 3 intenciones reales; las acciones de conciliación siguen en TS.

## Lo que falta y requiere tu intervención

1. **Cuentas lectoras**: pulsa “Añadir cuenta lectora” y pega un token QvaPay
   con permiso `p2p:read`. El token se cifra en la sombra; no se muestra de
   nuevo. Para rotarlo usa el mismo diálogo.
2. **Modo híbrido real**: pega el `App ID`, `App Secret` y el secreto del feed.
   El webhook público del edge todavía no está expuesto en Nginx; hoy la URL
   visible apunta al monolito TS. Activar el webhook en el edge requiere una
   ventana para retirar el long-polling/webhook de TS.
3. **Push real**: configura `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`,
   `WEB_PUSH_SUBJECT` y `PUSH_SEND_ENABLED=true` en el notifier, más el
   `EDGE_PUSH_PUBLIC_KEY` para que `/api/push/public-key` deje de responder 503.
4. **Mutaciones de dinero**: crear/editar/cancelar ofertas, aplicar operaciones,
   rebalanceos y acciones cooperativas siguen deshabilitadas. Requieren
   autorización explícita, revisión de riesgo y ventana de corte.
5. **Cutover TS→Go**: sigue siendo manual, con backup, congelación, drenaje y
   rollback de 14 días.

## Variables nuevas

| Variable | Servicio | Uso |
| --- | --- | --- |
| `EDGE_TRUSTED_ORIGIN` | edge | origen del panel |
| `LOCAL_ENCRYPTION_KEY` | edge | cifrar tokens de lectores |
| `EDGE_DASHBOARD_SNAPSHOT_FILE` | edge | snapshot de lectura |
| `EDGE_OPERATIONAL_HEALTH_FILE` | edge | salud del bot |
| `PUSH_SEND_ENABLED` | notifier | habilitar envío push |
| `WEB_PUSH_*` | notifier | claves VAPID |

Los valores sensibles se generan en `/opt/qvaapply-f3-shadow/edge.env` (600) y
no se imprimen en logs.
