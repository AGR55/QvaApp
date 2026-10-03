# Exclusión persistente tras cancelación manual

Diseño aprobado por el propietario el 2026-10-03. Prioridad: velocidad sin
reaplicar automáticamente a una oferta rechazada por el propietario.

## Causa verificada

El feed `p2p.reopened` omite la deduplicación `seen_offers`. La cancelación manual
no registra una exclusión persistente. Se comprobaron dos UUID con tres tomas por
la vía rápida y una cancelación manual entre ellas en la auditoría de producción.

## Comportamiento

- Registrar la exclusión por UUID antes de enviar la cancelación manual. Un
  resultado ambiguo de cancelación no debe reactivar automáticamente la oferta.
- Aplicarla en stream/webhook y escaneo, tanto compra como venta, y verificarla
  justo antes de enviar una aplicación automática. Mantenerla tras reinicios,
  reaperturas y cambios de precio. Una acción manual explícita puede aplicar,
  pero no elimina la exclusión automática.
- Recuperar exclusiones de cancelaciones manuales históricas sin consultas
  remotas ni cambiar operaciones, saldos o intenciones monetarias.
- Comprobar importes finitos positivos, rate efectivo/límites vigentes y capital
  local en el último punto antes de aplicar. No añadir GET a cada oferta.
- Ampliación aprobada explícitamente: bloquear precios sospechosamente bajos
  usando la mediana local de venta del mismo mercado y el porcentaje de protección
  configurado. La referencia caduca tras 5 minutos, no se renueva por lecturas de
  otros mercados y sin referencia vigente se requiere revisión manual.
  Preferir la mediana de QvaPay. Una estimación desde el listado necesita al
  menos tres UUID distintos con tasas válidas; una oferta no constituye su propia
  referencia. No incluir valores ya identificados como sospechosos frente a la
  referencia anterior en esa estimación.
- Registrar el motivo «Excluida por cancelación manual» en la auditoría.

## Plan y verificación

1. Crear un test que reproduzca aplicación → cancelación → reapertura repetida.
2. Persistir y verificar exclusión sin cambiar el protocolo de mutación incierta.
3. Cubrir reinicio, exclusiones antiguas, escaneo, cambio de límites durante una
   espera, cancelación fallida y continuidad de otras ofertas elegibles.
4. Revisión principal, tests completos, CI y despliegue con verificación de salud.

Las skills writing-plans y test-driven-development no están disponibles en el
catálogo; este plan y tests fallando antes del arreglo son la alternativa local.
No se promete ausencia absoluta de errores ni que un precio remoto no pueda
cambiar entre el evento recibido y la aplicación aceptada por QvaPay.
