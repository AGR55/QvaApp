# Evidencia de verificación

Última ejecución completa: 2026-09-09. Entorno local, Node.js 25.9.0 y pnpm 11.26.0.

## Puertas automáticas

| Puerta | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript estricto | Correcto | `pnpm typecheck`; sin errores |
| Pruebas | Correcto | 118 ejecutadas, 118 aprobadas, 0 omitidas |
| Servidor | Correcto | `tsc -p tsconfig.build.json` |
| Panel | Correcto | Vite; JS principal 268.92 kB (82.83 kB gzip), gráficas diferidas 3.78 kB (1.65 kB gzip), CSS 59.69 kB (12.08 kB gzip) |
| Secretos literales | Correcto | `pnpm check:secrets`; ninguno detectado |
| Dependencias de producción | Correcto | `pnpm audit --prod`; ninguna vulnerabilidad conocida |
| Accesibilidad automática | Correcto | axe-core: 0 violaciones serias en las ocho vistas, escritorio y móvil |
| Escritorio | Correcto | 1425 px de viewport y de documento; sin overflow horizontal |
| Móvil | Correcto | 375 px de viewport y de documento; sin overflow horizontal |
| Controles de icono | Correcto | 0 botones sin nombre accesible |

Los comandos reproducibles son:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm check:ui
```

`pnpm check:ui` compila, levanta un panel de demostración aislado, ejecuta Chromium mediante WebDriver, inyecta axe-core, guarda capturas en `/tmp` y termina los procesos temporales. No necesita credenciales ni toca QvaPay.

El panel de demostración fuerza además un fallo del saldo remoto. Chromium exige que aparezca **Dato guardado**, que el resto del cockpit continúe renderizado, que una política inicial pueda aprobarse sin cambios artificiales y que tanto Cockpit como Estrategia mantengan cero violaciones serias de axe-core.

El recorrido Chromium accede mediante `localhost` a un panel cuyo origen configurado es `127.0.0.1`; confirma que la equivalencia loopback funciona sin desactivar la validación CSRF. Las pruebas adicionales rechazan cambios de protocolo/puerto, IPs LAN y dominios externos.

## Cobertura financiera relevante

La suite cubre política de riesgo y números no finitos, reserva QUSD, límites por operación/día/exposición/concurrencia, advertencias de slippage/cooldown, pausa por errores, serialización de mutaciones, idempotencia, resultado remoto incierto, compensación, migraciones con backup, reinicio y conciliación. También comprueba el flujo TOTP, los timeouts de autenticación, la verificación previa del token y que el pago fiat queda como acción humana.

Las pruebas nuevas cubren eventos de decisión versionados y paginados, descarte aislado, rutas Push con sesión/CSRF, deduplicación por navegador, aplicaciones y conciliaciones notificables, normalización del chat oficial, exclusión del saludo automático y reconocimiento de cualquier mensaje propio posterior.

La automatización de mercado prueba consultas separadas `sell`/`buy` con `take=100` y `best_rate`, que una candidata bloqueada no oculta la siguiente, una sola edición de oferta propia por turno y la persistencia del intervalo de aplicaciones a través de una nueva instancia del cliente.

La cobertura local-first prueba que el arranque de `/api/dashboard` no llama a QvaPay, que cada recurso persiste en SQLite tras reiniciar y que un fallo remoto devuelve el último valor con `stale: true` y su fecha. La configuración operativa del bot también se reabre desde sus tablas SQLite.

La normalización decimal de `GET /p2p` también se comprobó mediante una lectura autenticada y no mutante de 50 ofertas reales: todas entregaron `amount` y `receive` como números positivos al dominio. No se imprimieron importes, UUID ni datos personales.

## Decisiones de herramientas

El plan inicial mencionaba Vitest, Testing Library, Playwright y ESLint. La implementación final usa el runner nativo de Node con `tsx`, pruebas de integración Fastify, TypeScript con todas las opciones estrictas, pruebas de fronteras arquitectónicas y Chromium/WebDriver con axe-core. Esta combinación reduce dependencias y cubre los mismos riesgos relevantes para esta aplicación local. Prettier y ESLint no forman parte del gate; formato, código no usado, tipos y límites entre módulos se verifican mediante TypeScript y las pruebas de arquitectura.

## Validación humana antes del modo real

No se ejecutó ninguna mutación real contra QvaPay. Antes de activar dinero real, el propietario debe seguir la lista de `docs/OPERATIONS.md`, iniciar sesión con `pnpm login`, confirmar que el panel muestra la integridad correcta y hacer primero una ronda completa en simulación. La primera operación real debe ser de importe mínimo y supervisada; el pago continúa siendo exclusivamente manual.
