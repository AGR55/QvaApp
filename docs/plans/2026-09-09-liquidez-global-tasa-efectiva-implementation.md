# Implementación: liquidez QUSD global y tasa efectiva

## 1. Pruebas de dominio

- Extender `test/liquidity-plan.test.ts` con ofertas de varios mercados, reserva parcialmente descubierta y un plan de excedente.
- Añadir casos para puntuar rentabilidad entre monedas sin comparar tasas crudas.
- Extender las pruebas de automatización con el caso Clásica `2 / 2.12 + 0.08`.

## 2. Cálculos monetarios

- Reutilizar `outgoingFiatCost` como única fuente de tasa efectiva.
- Hacer que la clasificación, la aplicación manual y la política de compra comparen `effectiveRate` con `buyMaxRate`.
- Mantener la tasa nominal para mediana y representación de la oferta.

## 3. Plan global

- Enriquecer la entrada del plan con la configuración económica de cada mercado.
- Calcular margen normalizado de oportunidad y de ventas propias.
- Seleccionar ventas abiertas globales menos rentables hasta cubrir objetivo y reserva.
- Exponer liberación real y excedente restaurable sin ocultarlos en planes inviables.

## 4. Workflow compensable

- Persistir snapshots antes de cancelar, como ya hace `createTradeWorkflow`.
- Después de una aplicación confirmada, reponer el volumen no consumido con importes proporcionales y claves idempotentes distintas.
- Añadir estados persistentes para reposición posterior al éxito y conciliación de fallos.
- Mantener restauración completa para rechazos confirmados e inmovilización para resultados inciertos.

## 5. Presentación y auditoría

- Incluir tasa efectiva y comisión en motivos, eventos y mensajes de compra.
- Ampliar la previsualización de liquidez con mercado y excedente a reponer.
- Evitar el doble mensaje de capital cuando el plan ya explica la insuficiencia.

## 6. Validación

- Ejecutar pruebas focalizadas después de cada cambio de dominio.
- Ejecutar `pnpm check`, `git diff --check` y una revisión de los workflows persistidos.
- No iniciar el bot real ni efectuar mutaciones contra QvaPay durante la verificación.
