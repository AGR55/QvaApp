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

`/api/dashboard` no realiza I/O de red. Los endpoints `/api/live/*` tienen destinos de fallo independientes y devuelven la copia persistida como `stale` cuando existe. El navegador pausa el polling si está oculto o sin conexión y reintenta con espera creciente.

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
- Los cooldowns por mercado y contraparte se calculan desde operaciones persistidas, incluso tras reiniciar.
- Al alcanzar el límite configurado de errores consecutivos, la automatización se pausa de forma persistente.
- El mínimo de venta neto por mercado debe superar el máximo de compra.
- Una lectura remota fallida nunca borra ni presenta como actual la última lectura válida.
- Secretos e interruptores de despliegue no son configuración operativa editable.
