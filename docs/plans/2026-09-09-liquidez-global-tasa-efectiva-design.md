# Liquidez QUSD global y tasa efectiva de compra

## Objetivo

Permitir que una oportunidad rentable use QUSD retenidos en ventas propias de cualquier mercado, sin perder la configuración de esas ofertas ni aceptar compras cuyo costo real supere el máximo configurado. La comisión fija de transferencia debe formar parte de la decisión antes de aplicar, especialmente en operaciones pequeñas de Clásica.

## Decisiones aprobadas

- Los QUSD son liquidez global: una venta propia abierta puede cancelarse para financiar una oportunidad en otro mercado.
- No se compararán directamente tasas expresadas en monedas distintas. La prioridad de cancelación usará rentabilidad porcentual normalizada con la configuración del mercado de cada oferta.
- Se favorecerán las ofertas propias de menor rentabilidad; los desempates reducirán el número de cancelaciones y el excedente liberado.
- Todos los snapshots se persistirán antes de la primera cancelación.
- Una aplicación rechazada restaurará las ofertas canceladas completas.
- Una aplicación confirmada consumirá solamente los QUSD necesarios y recreará el excedente proporcionalmente con mercado, tasa, datos de pago, mensaje y restricciones originales.
- Una mutación incierta detendrá la compensación automática y quedará pendiente de conciliación.
- La comisión fija saliente continuará siendo configurable por mercado en SQLite.

## Tasa efectiva

Para toda compra de QUSD se calculará:

`tasa efectiva = (fiat nominal + comisión fija saliente) / QUSD`

La tasa efectiva será el valor que se compare con `buyMaxRate`. La tasa nominal se conservará para representar la oferta remota y calcular referencias de mercado, pero no podrá autorizar por sí sola una compra. Para `2 QUSD` por `2.12 USD` en Clásica con comisión `0.08 USD`, la tasa nominal es `1.06` y la efectiva `1.10`; con un máximo de compra de `1.06`, la oferta debe quedar bloqueada.

El mismo criterio se aplicará a clasificación automática, reevaluación de riesgo, aplicación manual, revisión de ofertas bloqueadas, orden de oportunidades y mensajes de auditoría. La interfaz y Telegram mostrarán tasa nominal, comisión y tasa efectiva cuando exista una comisión saliente.

## Plan de liquidez

El plan calculará la liberación requerida como `objetivo + reserva - saldo`, con mínimo cero. Así también se repone una reserva que ya estuviera parcialmente consumida.

Serán candidatas todas las ventas propias abiertas con importe positivo. Cada una tendrá una puntuación porcentual comparable basada en su ingreso neto y el costo de adquisición configurado para su mercado, incluyendo la comisión fija cuando corresponda. Solo se sacrificará volumen de ofertas menos rentables que la oportunidad externa.

El plan guardará el orden de consumo y el importe total liberado. Si ninguna combinación segura cubre objetivo y reserva, no cancelará nada. La previsualización expondrá el total disponible, el requerido, cada cancelación y el excedente que se repondría.

## Aplicación y reposición

El workflow seguirá esta secuencia:

1. consultar saldo y ventas propias actuales;
2. construir y persistir el plan completo con snapshots;
3. reservar el importe objetivo localmente;
4. cancelar en serie las ofertas seleccionadas;
5. aplicar a la oportunidad externa;
6. tras confirmación remota, calcular el volumen no consumido;
7. recrear únicamente ese remanente, repartido según el orden inverso de consumo y manteniendo la tasa original;
8. cerrar el workflow solo cuando aplicación y reposición estén confirmadas.

Un remanente inferior al mínimo documentado de `0.1 QUSD` no se recreará y quedará registrado. Las creaciones usarán claves idempotentes. Si falla una reposición después de una aplicación confirmada, la operación aplicada se conserva y el workflow queda visible para conciliación; nunca se intenta deshacer la operación externa.

## Seguridad y observabilidad

- Las protecciones de pausa, parada de emergencia, exposición, volumen diario, operaciones simultáneas, antigüedad y mutaciones inciertas permanecen obligatorias.
- La auditoría distinguirá tasa nominal, tasa efectiva, comisión, liquidez libre, liberación prevista, excedente repuesto y cualquier remanente no recreable.
- Los mensajes de bloqueo no duplicarán síntomas: la falta de capital explicará cuánto QUSD libre, cancelable y requerido se observó.
- No se harán cancelaciones parciales si el plan completo no es viable.
- Las llamadas respetarán los límites de QvaPay y cada mutación conservará su intención persistida.

## Verificación

- Regresión de Clásica: `2 QUSD`, `2.12 USD`, comisión `0.08`, tasa efectiva `1.10` y bloqueo contra máximo `1.06`.
- Compra sin comisión y compra de mayor importe para verificar que el costo fijo se prorratea correctamente.
- Liberación combinada desde varios mercados.
- Rechazo cuando las ofertas propias globales no alcanzan o son más rentables que la oportunidad.
- Persistencia previa de todos los snapshots.
- Aplicación confirmada con reposición proporcional del excedente.
- Rechazo confirmado con restauración completa.
- Fallos e incertidumbre durante cancelación, aplicación y reposición.
- Typecheck, suite completa, builds de servidor y web, comprobación de secretos y revisión de cambios.
