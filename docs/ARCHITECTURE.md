# Arquitectura

QvaApply es un monolito modular de una sola instancia. Esta forma reduce coordinación distribuida y es adecuada para un propietario y SQLite, sin mezclar responsabilidades.

## Dependencias

```text
web / Telegram / scheduler
            │
            ▼
     casos de uso
 TradingEngine · OpportunityOrchestrator
       │                    │
       ▼                    ▼
 políticas puras        puertos
 riesgo · liquidez      QvaPay · Store
       │                    │
       └──────────┬─────────┘
                  ▼
       SQLite + adaptador QvaPay
```

- `src/core`: reglas puras y tipos de puertos. No conoce HTTP, Telegram, SQLite ni `fetch`.
- `src/application`: workflows durables; decide el orden de reservar, cancelar, aplicar, compensar y conciliar.
- `src/trading.ts`: fachada de casos de uso compartida por web, Telegram y scheduler.
- `src/qvapay.ts`: transporte, rate limits, idempotencia disponible, decodificación y clasificación de errores.
- `src/store.ts`: única frontera SQLite, migraciones, configuración normalizada, caché remota por recurso, transacciones y reconstrucción de modelos.
- `src/web-push.ts`: claves VAPID, suscripciones locales y entregas deduplicadas por evento y navegador.
- `src/http-dashboard.ts`: adaptador Fastify; autenticación, CSRF, límites, schemas y OpenAPI.
- `src/dashboard.ts`: modelo de lectura local-first; compone el estado SQLite y actualiza balance, ofertas, transacciones o un mercado por separado.
- `web`: interfaz React dividida por feature; carga solo los recursos de la vista activa y las gráficas de forma diferida.

## Lectura con conexión inestable

```text
abrir vista ──► GET /api/dashboard ──► SQLite ──► render inmediato
                     │
                     └─► cola remota secuencial de la vista
                            balance | ofertas | mercado concreto
                                  │
                         éxito ───┴─── fallo
                           │             │
                    persiste caché   conserva caché
                           └──────┬──────┘
                            fecha y estado UI
```

`/api/dashboard` no realiza I/O de red. Los endpoints `/api/live/*` tienen destinos de fallo independientes y devuelven la copia persistida como `stale` cuando existe. El navegador pausa el polling si está oculto o sin conexión y reintenta con espera creciente. El escáner, y no una visita a la página, alimenta las observaciones que forman las gráficas de 24 horas.

## Decisiones y avisos

Cada candidata que alcanza la política de decisión genera una versión durable en `decision_events`. Su versión depende de la oferta, tasa, decisión y razones; las mediciones variables actualizan la evidencia sin inundar la cola. Una versión nueva resuelve la anterior y un descarte afecta solo a la versión seleccionada.

Auditoría consulta estos eventos directamente con paginación. Telegram y Web Push consumen el mismo resultado, pero fallan de manera independiente. El service worker entrega una tarjeta dentro del panel visible o una notificación del sistema cuando el panel está en segundo plano.

Las operaciones automáticas con autocancelación vigilan el chat cada 15 segundos. El ID del saludo automático queda excluido y cualquier otro mensaje propio posterior reconoce la operación. La comprobación se repite antes de cancelar; un fallo de lectura aplaza la cancelación.

## Presupuesto de mercado y mutaciones

El scheduler inicia una ronda de mercado cada 15 segundos sin solaparlas. Cada ronda consulta primero `sell` para todos los mercados activos con `take=100` y `best_rate`; `buy` se consulta en rondas alternas. La cola única del adaptador mantiene como máximo 30 listados por minuto aunque sincronización y panel coincidan con el escáner.

El escáner compara márgenes porcentuales entre mercados, prueba candidatas ordenadas hasta encontrar una que pase toda la política y ejecuta como máximo una aplicación por ronda. Las marcas temporales de `apply`, `edit` y `cancel` se escriben antes de enviar la petición, por lo que un reinicio no reinicia el presupuesto remoto. El refresco comprueba la cola cada cinco segundos, pero edita una sola oferta vencida por turno y deja al menos 20 segundos entre ediciones.

## Cómo añadir una feature

1. Añade vocabulario estable a `CONTEXT.md` si introduce un concepto de dominio.
2. Implementa reglas deterministas en `src/core` con pruebas.
3. Implementa un caso de uso en `src/application` si coordina pasos o mutaciones.
4. Extiende un puerto en vez de importar directamente el adaptador desde el dominio.
5. Persiste la intención antes de cualquier mutación financiera.
6. Expón el caso de uso mediante la fachada y luego en los adaptadores necesarios.
7. Añade schema HTTP, estado accesible en UI y evidencia en Auditoría.
8. Ejecuta `pnpm check` y actualiza un ADR si cambia una decisión estructural.

## Invariantes

- Una sola reserva QUSD: `risk.minQusdReserve`; el campo heredado se sincroniza automáticamente.
- Una aplicación incierta no se repite automáticamente.
- Una compensación solo sigue a un rechazo confirmado o a una conciliación que descarte la aplicación.
- La oferta propia se repone con la misma instantánea y clave idempotente.
- No se inicia una operación si existe una mutación sin resolver.
- Reanudar desde Telegram o desde la web valida primero que la sesión de QvaPay siga activa.
- Si el panel autenticado no puede arrancar, el proceso completo falla antes de iniciar scheduler o bot.
- Los cooldowns y el slippage se muestran como advertencias; los rangos, capital, reservas, exposición, concurrencia, volumen y estado remoto continúan siendo bloqueos duros.
- Al alcanzar el límite configurado de errores consecutivos, la automatización se pausa de forma persistente.
- El mínimo de venta neto por mercado debe superar el máximo de compra.
- Una lectura remota fallida nunca borra ni presenta como actual la última lectura válida.
- Ninguna ronda aplica a más de una oportunidad y una candidata bloqueada no impide evaluar la siguiente.
- El refresco automático nunca edita más de una oferta por ejecución.
- Secretos e interruptores de despliegue no son configuración operativa editable.
