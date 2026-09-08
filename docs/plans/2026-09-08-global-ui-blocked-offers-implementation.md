# Plan de implementación: UI global y ofertas bloqueadas

## 1. Persistencia de revisiones bloqueadas

- Ampliar `TradingAlert` en `src/store.ts` con decisión `blocked`, referencia de mercado y estado de resolución.
- Crear migración de esquema para los nuevos campos y métodos explícitos de descarte/resolución.
- Sincronizar las decisiones bloqueadas desde `src/trading.ts` sin perder cards descartadas ni reabrirlas mientras la misma instantánea siga vigente.
- Añadir pruebas de migración, persistencia, actualización y descarte.

## 2. Previsualización y ejecución segura

- Añadir en `src/trading.ts` una previsualización no mutante que recupere la oferta, calcule mediana/desviación y describa liquidez y cancelaciones previstas.
- Añadir una aplicación revisada que solo transforme el bloqueo de precio/mediana en una decisión elegible y vuelva a ejecutar todas las demás reglas.
- Reutilizar `OpportunityOrchestrator` para ventas de QUSD y su flujo cancelar/aplicar/restaurar; mantener el flujo existente de compra de QUSD con validación íntegra de fiat y riesgo.
- Auditar descarte, revisión, override solicitado, bloqueo seguro y resultado final.
- Cubrir con pruebas el éxito, oferta expirada, doble envío y cada protección no anulable.

## 3. API local

- Exponer en `src/dashboard.ts` los métodos de previsualización, aplicación y descarte.
- Añadir endpoints autenticados y CSRF en `src/http-dashboard.ts`, con esquemas estrictos y errores de cliente legibles.
- Probar contratos HTTP y ausencia de mutación en la previsualización.

## 4. Sistema visual compartido

- Consolidar tokens y fundamentos globales en `web/styles.css` y `web/layout.css`.
- Evolucionar `web/components/common.jsx` con superficies, badges, botones, mensajes y diálogo accesible.
- Renovar shell, navegación, cabecera, conectividad, login y responsive global en `web/main.jsx`.
- Mantener dependencias actuales y usar iconos ya instalados.

## 5. Migración de pantallas

- Ajustar Cockpit, Mercados, Capital, Cacería, Operaciones, Gráficas, Estrategia y Auditoría al nuevo sistema.
- Corregir ritmo vertical, márgenes, jerarquía, densidad de tablas, estados vacíos y acciones en móvil.
- Conservar los cálculos de comisión, mediana y dominio de gráficas ya implementados.

## 6. Bandeja de revisión en Auditoría

- Crear cards activas a un lado del registro con tasa, mediana, desviación, motivo y antigüedad.
- Implementar descarte confirmado y diálogo de revisión/aplicación con previsualización remota.
- Mostrar progreso, cancelaciones previstas, resultado y errores dentro de la UI; bloquear envíos repetidos.
- Recargar el snapshot local tras cada mutación.

## 7. Verificación

- Ejecutar pruebas focalizadas después de cada capa.
- Ejecutar `pnpm check` y `pnpm check:ui` al finalizar.
- Inspeccionar capturas de escritorio y móvil y corregir desbordes, contraste, foco y densidad.
- Confirmar que `design/` permanece sin modificar y fuera de los commits.
