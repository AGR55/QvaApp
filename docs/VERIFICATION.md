# Evidencia de verificación

Última ejecución completa: 2026-09-07. Entorno local, Node.js 25.9.0 y pnpm 11.26.0.

## Puertas automáticas

| Puerta | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript estricto | Correcto | `pnpm typecheck`; sin errores |
| Pruebas | Correcto | 80 ejecutadas, 80 aprobadas, 0 omitidas |
| Servidor | Correcto | `tsc -p tsconfig.build.json` |
| Panel | Correcto | Vite; JS principal 231.57 kB (72.63 kB gzip), gráficas diferidas 377.68 kB (110.42 kB gzip), CSS 21.50 kB (5.12 kB gzip) |
| Secretos literales | Correcto | `pnpm check:secrets`; ninguno detectado |
| Dependencias de producción | Correcto | `pnpm audit --prod`; ninguna vulnerabilidad conocida |
| Accesibilidad automática | Correcto | axe-core: 0 violaciones en el cockpit autenticado |
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

## Cobertura financiera relevante

La suite cubre política de riesgo y números no finitos, reserva QUSD, límites por operación/día/exposición/concurrencia, cooldown persistente por mercado y contraparte, pausa por errores, serialización de mutaciones, idempotencia, resultado remoto incierto, compensación, migraciones con backup, reinicio y conciliación. También comprueba el flujo TOTP, los timeouts de autenticación, la verificación previa del token y que el pago fiat queda como acción humana.

## Decisiones de herramientas

El plan inicial mencionaba Vitest, Testing Library, Playwright y ESLint. La implementación final usa el runner nativo de Node con `tsx`, pruebas de integración Fastify, TypeScript con todas las opciones estrictas, pruebas de fronteras arquitectónicas y Chromium/WebDriver con axe-core. Esta combinación reduce dependencias y cubre los mismos riesgos relevantes para esta aplicación local. Prettier y ESLint no forman parte del gate; formato, código no usado, tipos y límites entre módulos se verifican mediante TypeScript y las pruebas de arquitectura.

## Validación humana antes del modo real

No se ejecutó ninguna mutación real contra QvaPay. Antes de activar dinero real, el propietario debe seguir la lista de `docs/OPERATIONS.md`, iniciar sesión con `pnpm login`, confirmar que el panel muestra la integridad correcta y hacer primero una ronda completa en simulación. La primera operación real debe ser de importe mínimo y supervisada; el pago continúa siendo exclusivamente manual.
