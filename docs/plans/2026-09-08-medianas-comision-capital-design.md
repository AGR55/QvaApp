# Medianas, comisión de Clásica y flujos de capital

## Objetivo

Hacer que QvaApply represente con precisión el costo de las transferencias salientes de Clásica, use medianas como referencia operativa y sustituya los controles nativos del navegador por flujos de capital y estrategia coherentes con la interfaz.

## Decisiones aprobadas

- Clásica descuenta una comisión fija de 0.08 USD únicamente cuando sale fiat. Los ingresos no pagan comisión.
- La comisión se configura por mercado para mantener la regla en el dominio y no dispersarla como un caso especial de interfaz.
- La disponibilidad y el capital comprometido incluyen una comisión por cada compra abierta que implique una futura salida de fiat.
- La conciliación registra cada débito una sola vez con su comisión incluida. No se modifica retroactivamente el historial ya conciliado.
- Las decisiones de compra y venta usan la mediana de las tasas abiertas del lado correspondiente. El promedio de la API deja de gobernar la protección de precios.
- El histórico conserva promedio y mediana para compatibilidad, pero la gráfica principal muestra medianas.

## Modelo y datos

`MarketConfig` incorpora `outgoingTransferFee`, con valor 0.08 para `CLASICA` y 0 para los demás mercados. La configuración persistida y los JSON heredados se migran con esos valores cuando el campo todavía no existe.

Las funciones monetarias del dominio calcularán:

- fiat nominal: `QUSD × tasa`;
- comisión de salida: la configurada cuando el flujo paga fiat;
- débito total: fiat nominal más comisión;
- tasa efectiva: débito total dividido entre QUSD.

El cálculo se reutiliza en creación, edición, validación de saldo, capital comprometido, evaluación de riesgo, oportunidades y conciliación. La deduplicación continúa ligada a la operación y dirección del movimiento.

La mediana se obtiene de las tasas válidas de las ofertas abiertas del mismo mercado y lado. Para una cantidad par se usa el promedio de los dos valores centrales. Si no existen muestras válidas, la acción queda sin referencia y conserva el bloqueo seguro actual.

## Gráficas

La visualización principal tendrá dos series: mediana de compra y mediana de venta. El dominio vertical se calculará desde el mínimo y máximo visibles:

- con variación, el margen será una fracción pequeña del rango observado;
- con una serie plana, se usará un margen mínimo relativo al valor y a la precisión de la moneda;
- nunca se usará un porcentaje grande del valor absoluto cuando ya existe variación, porque aplasta diferencias pequeñas en monedas de precio alto.

El tooltip mostrará los valores con precisión suficiente y el estado vacío explicará cuando aún no haya observaciones con mediana.

## Capital

Crear y editar usarán un componente de formulario dedicado dentro de un panel de trabajo. Incluirá mercado, lado, QUSD y tasa, además de una vista previa reactiva con fiat nominal, comisión, débito o ingreso total, tasa efectiva, mediana relevante y distancia porcentual frente al mercado.

El formulario validará importes, saldo y disponibilidad antes de habilitar la acción. Los errores se mostrarán dentro del componente y no mediante `alert`.

Cancelar abrirá un diálogo accesible propio con resumen de la oferta y una acción destructiva explícita. Se eliminarán todos los usos de `prompt`, `confirm` y `alert` de la gestión de ofertas. Crear y editar tendrán confirmación contextual dentro del mismo flujo, sin diálogos nativos.

## Estrategia y espaciado

Los campos se agruparán por riesgo, automatización y mercado. Cada control tendrá etiqueta, unidad integrada, ayuda cuando aporte contexto y estados consistentes de foco, error y deshabilitado. Los mercados usarán una cabecera clara y una cuadrícula adaptable, con separación entre identidad, precios, capital, comisiones y datos de cobro.

Se normalizará el ritmo vertical de paneles, formularios, acciones y vistas móviles sin alterar la navegación ni la identidad editorial existente.

## Errores y seguridad

- Las mutaciones remotas mantienen el mecanismo actual de intención e idempotencia.
- Un fallo al crear, editar o cancelar permanece visible en el flujo que lo originó.
- No se permite confirmar un formulario inválido o una oferta que exceda el fiat disponible incluyendo la comisión.
- La comisión solo se aplica a débitos y nunca a créditos.

## Verificación

- Pruebas unitarias de mediana para listas impares, pares, vacías e inválidas.
- Pruebas de comisión de Clásica para débito, crédito, conciliación repetida y saldo insuficiente.
- Pruebas de creación y edición con capital comprometido incluyendo una comisión por oferta.
- Pruebas del dominio vertical de la gráfica con precios altos y variaciones pequeñas.
- Pruebas de regresión de API y arquitectura.
- `pnpm typecheck`, `pnpm test`, builds de servidor y web, comprobación de secretos y smoke visual.

## Plan técnico

1. Extender y migrar la configuración por mercado con la comisión fija de salida.
2. Centralizar cálculos de transferencia y mediana en funciones puras con pruebas.
3. Sustituir referencias promedio por medianas en inspección, riesgo, persistencia y presentación.
4. Incluir la comisión en conciliación, disponibilidad, presupuestos y rentabilidad.
5. Crear los componentes dedicados para alta, edición y cancelación de ofertas.
6. Rediseñar los campos de Estrategia y corregir el espaciado responsivo.
7. Ajustar el dominio y las series de la gráfica.
8. Ejecutar la verificación completa y corregir regresiones.
