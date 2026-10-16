# Corrección fiat y sincronización cooperativa — 2026-10-16

## Causas reproducidas

- La proyección del feed conservaba el estado local `cancelled`, pero seguía contabilizando `p2p.paid` y `p2p.completed` de ese UUID. Una oferta fija puede reabrirse y completarse con otro peer: esos eventos no justifican un movimiento de esta cuenta. En producción se encontraron movimientos del feed ligados a operaciones locales canceladas.
- El registro del pago conjunto sustituía la base cooperativa por el saldo actual. Eso absorbía también movimientos personales todavía pendientes de publicar. La base ahora resta únicamente la parte del propietario ya reservada en Sync Core; la comisión sigue siendo un gasto local nuevo.
- Una respuesta HTTP de capacidad podía sobrescribir ajustes hechos durante su espera, o borrar una nueva declaración manual. Ahora confirma únicamente el delta enviado y conserva ajustes concurrentes. Cada declaración manual tiene una versión distinta; se acepta también el marcador heredado `true`.

## Límites y contabilidad

Los eventos públicos de una operación cancelada o con otro peer explícito no alteran su estado financiero local. La reconciliación autenticada con QvaPay continúa importando movimientos cuya participación está verificada. Se conservan los movimientos legítimos y la deduplicación por operación y sentido.

No se revierten automáticamente apuntes históricos a partir del mero estado `cancelled`: podría existir un pago previo real o una declaración posterior que ya corrigió el saldo. El diagnóstico histórico es de solo lectura y no altera los importes declarados. Se confirmó que todos los apuntes del feed asociados a operaciones canceladas encontrados en BANK_CUP, CLASICA y ETECSA son anteriores a la última declaración manual de su mercado; revertirlos ahora alteraría de nuevo saldos ya redeclarados.

No se cambió el sincronizador externo ni se añadieron peticiones al evaluar ofertas. Las comparaciones y el ajuste de bases son locales y constantes; la sincronización HTTP conserva su tarea independiente de las cacerías.

## Sentido de compra/venta

El usuario pidió dejar pendiente el caso antiguo al no conservar una oferta de ejemplo. El servidor disponible no recibe un campo de sentido en la reserva. La ruta cooperativa actual selecciona ofertas `sell` para comprar QUSD como peer, conforme al [contrato de QvaPay](https://www.qvapay.com/docs/p2p/apply). No se invierten las cacerías personales sin un caso que identifique el recorrido incorrecto.

## Verificación

Pruebas fallidas antes de cada corrección y aprobadas después: ambos sentidos de ofertas canceladas, peer distinto, gastos e ingresos personales pendientes al registrar un pago conjunto, pago durante respuesta HTTP, declaración y redeclaración durante respuesta HTTP. `pnpm check` verifica tipos, dependencias, suite completa, compilaciones y ausencia de credenciales literales. No se aplicaron ofertas ni se hicieron pagos reales de prueba.
