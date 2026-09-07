# Lenguaje de dominio de QvaApply

## Oferta externa

Oferta P2P publicada por otra persona en QvaPay que QvaApply observa y puede considerar para aplicar.

## Oferta propia

Oferta P2P creada por el propietario. Puede inmovilizar QUSD y, bajo una operación compensable, cancelarse y restaurarse.

## Oportunidad

Oferta externa junto con los precios, saldos y contexto necesarios para evaluar si conviene operar.

## Decisión

Resultado explicable de evaluar una oportunidad: aplicar, revisión manual, bloqueada o ignorada.

## Política de riesgo

Conjunto versionado de reglas que limita una decisión aunque el precio sea favorable.

## Exposición

Capital comprometido en operaciones no terminales y reservas activas.

## Reserva de capital

Asignación local exclusiva que impide que dos operaciones utilicen el mismo saldo disponible.

## Operación

Proceso durable que lleva una oportunidad desde su validación hasta un estado terminal o hasta una acción humana.

## Intención monetaria

Registro durable creado antes de solicitar a QvaPay una mutación que puede cambiar saldo, oferta o estado.

## Resultado incierto

Mutación enviada a QvaPay cuyo efecto no puede inferirse de la respuesta recibida. Exige conciliación y bloquea reintentos o compensaciones relacionados.

## Conciliación

Comparación del estado local y remoto para resolver una intención incierta sin duplicar exposición.

## Compensación

Acción que restaura una oferta propia después de confirmar que la aplicación externa no ocurrió.

## Pago fiat

Transferencia fuera de QvaApply que realiza manualmente el propietario. El sistema puede registrar su referencia, pero nunca ejecutarla automáticamente.

## Configuración activa

Revisión validada de mercados, estrategia y riesgo que gobierna nuevas decisiones. Las operaciones existentes conservan las reglas con las que fueron iniciadas.
