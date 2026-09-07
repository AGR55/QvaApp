# Plan de implementación: QvaApply seguro y modular

## Estado de ejecución (2026-09-07)

Las fases 0–6 están implementadas para operación local de una sola instancia: toolchain reproducible, dominio/riesgo, persistencia y workflows durables, conciliación de arranque, adaptador QvaPay validado, Fastify autenticado, panel analítico y manuales operativos. La promoción a VPS no se ejecuta ahora por decisión del propietario; queda documentada en `docs/VPS.md`. Las pruebas automáticas no realizan mutaciones reales. Los resultados y las sustituciones justificadas del stack de pruebas original están en `docs/VERIFICATION.md`.

Diseño de referencia: `docs/plans/2026-09-05-qvaapply-financial-operations-design.md`

## Regla de entrega

Cada fase debe dejar el proyecto compilable y con sus pruebas verdes. El modo real no se habilita por defecto ni se valida mediante mutaciones automáticas contra QvaPay.

## Fase 0 — Recuperar una línea base ejecutable

- Reconstruir `package.json`, lockfile, configuración TypeScript, Vite, Vitest, ESLint y scripts.
- Corregir únicamente defectos de recuperación que impidan compilar.
- Ejecutar pruebas existentes y registrar la línea base.
- Crear documentación de dominio (`CONTEXT.md`) y decisiones (`docs/adr`).
- Añadir comprobación para impedir que secretos y datos locales entren en artefactos.

Verificación: instalación reproducible, typecheck, build y suite existente.

## Fase 1 — Profundizar configuración, riesgo y contabilidad

- Definir esquemas compartidos para configuración y límites globales.
- Migrar la persistencia a revisiones de configuración inmutables con activación transaccional.
- Implementar política de riesgo pura y decisiones explicables.
- Implementar reservas de capital y cálculo de exposición/volumen diario.
- Añadir interruptor de emergencia y pausas automáticas persistentes.
- Mantener migración desde la configuración recuperada.

Verificación: pruebas de dominio, propiedades, concurrencia lógica, migraciones y rollback.

## Fase 2 — Integración QvaPay resiliente

- Separar transporte, autenticación, rate limits y contratos.
- Validar respuestas remotas antes de convertirlas al dominio.
- Clasificar errores confirmados, conflictos, límites, autenticación y resultados inciertos.
- Persistir intenciones antes de mutaciones.
- Implementar idempotencia donde la documentación oficial la admite.
- Añadir conciliación de operaciones no terminales.

Verificación: pruebas contractuales con fixtures para éxito, `400`, `401`, `403`, `404`, `409`, `429`, `500`, timeout y respuesta inválida.

## Fase 3 — Orquestador compensable

- Implementar la máquina de estados durable.
- Guardar instantáneas restaurables de ofertas propias.
- Reservar capital antes de cancelar o aplicar.
- Cancelar oferta propia solo cuando sea necesario y suficiente.
- Aplicar a la oferta externa y esperar acción humana para pago.
- Restaurar solo tras fallo confirmado; conciliar resultados ambiguos.
- Recuperar trabajo pendiente al arrancar.
- Bloquear ejecuciones solapadas y competencia por capital.

Verificación: pruebas con reinicio e inyección de fallo en cada transición.

## Fase 4 — HTTP local seguro y comandos consistentes

- Sustituir el servidor HTTP manual por Fastify.
- Crear endpoints versionados por recursos y comandos explícitos.
- Añadir validación, límites de cuerpo, rate limiting, cabeceras y protección CSRF.
- Enlazar exclusivamente a `127.0.0.1`.
- Preparar autenticación de administrador para VPS sin exponerla por defecto.
- Mover handlers de Telegram y scheduler a los mismos casos de uso que consume HTTP.
- Generar especificación OpenAPI para el contrato local.

Verificación: pruebas de autorización, validación, idempotencia, concurrencia y cabeceras.

## Fase 5 — Panel de operaciones

- Crear shell accesible y navegación adaptable.
- Implementar centro de control, operaciones, radar, ofertas, estrategia/riesgo, capital, auditoría y salud.
- Sustituir `prompt()`/`confirm()` por diálogos accesibles con vista previa de impacto.
- Mostrar decisiones explicables y consumo de límites.
- Añadir comparación, confirmación e historial de configuración.
- Añadir tablas equivalentes a gráficos y estados vacíos/error/obsoleto.
- Dividir carga por rutas o vistas y mantener presupuesto de rendimiento.

Verificación: Testing Library, axe, navegación por teclado, zoom, reduced motion, Playwright y build con presupuesto.

## Fase 6 — Operación y evidencia

- Añadir manual de instalación local y futuro despliegue VPS.
- Documentar backup, restauración, rotación de claves, conciliación e incidentes.
- Añadir verificación de salud y exportación segura de auditoría.
- Definir gates de modo real y procedimiento manual de smoke test.
- Ejecutar typecheck, lint, unitarias, integración, E2E, auditoría de dependencias y revisión de secretos.

Verificación: checklist de lanzamiento firmado por resultados reproducibles.

## Orden de migración

La aplicación recuperada seguirá funcionando durante la sustitución. Las rutas antiguas se conectarán temporalmente a los nuevos casos de uso y se eliminarán cuando sus pruebas equivalentes estén verdes. No se realizará una reescritura simultánea del dominio, persistencia, transporte y panel.

## Condiciones de bloqueo

- Contrato de QvaPay no documentado o contradictorio para una mutación.
- Migración de datos sin backup verificable.
- Resultado remoto incierto sin método de conciliación.
- Suite crítica roja.
- Secretos detectados en código, artefactos o respuestas HTTP.
- Falta de confirmación humana para un pago fiat.
