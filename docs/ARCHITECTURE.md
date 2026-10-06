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

En modo híbrido, stream y webhook persisten y deduplican eventos e inician su evaluación inmediatamente. Las oportunidades y los cambios de estado se drenan por separado, de modo que una aplicación esperando cuota o respuesta no retrasa pagos, cancelaciones y avisos. El polling se utiliza para recuperar una desconexión; cada página se evalúa con referencias locales, sin esperar una ronda completa de todos los mercados.

Las decisiones financieras siguen serializadas para no comprometer dos veces el mismo capital. La preparación remota del escaneo, los avisos y el chat posterior quedan fuera de ese turno. El transporte mantiene colas independientes para aplicaciones, lecturas críticas y tareas normales. `apply` usa una ventana durable de dos intentos por 60 segundos; cada intento pasa una comprobación final antes de gastar cuota. Las marcas de `edit` y `cancel` conservan 20 segundos entre envíos. El listado mantiene como máximo 25 consultas por minuto, siguiendo la sección de límites vigente, más conservadora que la tabla de errores que aún indica 30.

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
