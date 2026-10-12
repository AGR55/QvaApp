# Ofertas flexibles y conciliación accesible

Diseño aprobado por el propietario el 12 de octubre de 2026.

El motor toma el máximo importe financiable de una oferta flexible con cálculo local de coste constante, limitado por disponible, mínimo/máximo por orden, capital libre, comisiones y límites configurados. Se conserva la tasa original. No se añaden lecturas remotas para calcular el importe. El sondeo existente descubre ofertas flexibles, que QvaPay aún excluye del feed.

La respuesta de aplicación se conserva en la intención durable junto al importe solicitado. El ID de orden se persiste en la operación y acompaña pagos, recepción, cancelación y chat. La sincronización consulta la orden, nunca deduce su estado del padre. Una respuesta incierta no se reenvía automáticamente. Se mantiene la política existente de una toma automática por oferta.

Web y Telegram comparten la comprobación remota, el registro de evidencia y el reconocimiento del aviso. Reconocer silencia el aviso persistente, sin declarar resuelta la mutación; la comprobación continúa y la oferta afectada sigue protegida. La resolución manual conserva las comprobaciones de elegibilidad, versión y confirmación explícita. La evidencia puede registrarse incluso si aún no procede resolver.

Plan: (1) contrato y cálculo puro con pruebas de límites; (2) transporte y persistencia de órdenes; (3) integración de aplicación y conciliación; (4) acciones compartidas y adaptadores web/Telegram; (5) pruebas de aislamiento, reinicio y cuotas, más verificación del proyecto.

Referencias: https://www.qvapay.com/docs/p2p/range y https://www.qvapay.com/docs/p2p/webhooks.
