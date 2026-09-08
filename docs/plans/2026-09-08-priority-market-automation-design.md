# Automatización priorizada del mercado P2P

## Objetivo

Detectar y aplicar automáticamente a oportunidades de compra y venta dentro de la política aprobada, usando capital fiat libre, QUSD libre y QUSD recuperable de ofertas propias, sin exceder las cuotas documentadas de QvaPay.

El pago fiat y la confirmación de recepción continúan siendo acciones humanas.

## Problemas confirmados

- El escáner consulta únicamente 20 ofertas ordenadas por actualización, no las mejores tasas.
- La configuración inicial no puede aprobarse sin modificar un campo, por lo que `risk.reviewedAt` permanece vacío y obliga a revisión manual.
- El refresco recorre todas las ofertas seguidas aunque QvaPay admite una edición cada 20 segundos.
- El límite de dos aplicaciones por minuto no está modelado como presupuesto persistente.

## Decisión

### Descubrimiento

- Ejecutar una ronda cada 15 segundos.
- Consultar cada mercado activo con `take=100`, un lado explícito y `orderBy=best_rate&orderType=desc`.
- Dar prioridad al lado `sell`, donde el bot compra QUSD con fiat.
- Distribuir las consultas del lado `buy`, donde vende QUSD, mediante una planificación justa que no exceda 30 lecturas por minuto.
- Centralizar el presupuesto de lectura para que escáner, sincronización y panel no compitan sin control.

### Ejecución

- Ordenar globalmente las oportunidades elegibles y ejecutar como máximo una por ronda.
- Reservar de forma persistente un cupo antes de `apply`; permitir como máximo dos intentos de aplicación en una ventana móvil de 60 segundos.
- Para una oferta externa `sell`, exigir fiat libre y evaluar margen contra el mínimo de venta configurado.
- Para una oferta externa `buy`, usar QUSD libre después de reserva y, si falta, seleccionar ofertas propias `sell` del mismo mercado con peor tasa.

### Compensación

- Persistir workflow, reserva e instantáneas antes de cancelar.
- Separar cancelaciones por al menos 20 segundos.
- Ante rechazo concluyente de `apply`, recrear exactamente las ofertas canceladas usando claves idempotentes.
- Ante resultado incierto, no repetir ni restaurar hasta conciliar el estado remoto.

### Refresco de ofertas propias

- Mantener una cola justa y durable por fecha de vencimiento.
- Una oferta vence cinco minutos después de su última edición conocida.
- Editar como máximo una oferta por ejecución y nunca antes de 20 segundos desde la edición global anterior.
- El scheduler comprobará la cola con frecuencia corta sin mantener un `sleep` bloqueante.

### Panel y auditoría

- Permitir aprobar una configuración con cero cambios cuando aún no ha sido revisada.
- Mostrar última ronda, cobertura por lado/mercado, cuota disponible, oportunidades elegibles y razones de bloqueo.
- Reutilizar los datos persistidos del escáner en el panel siempre que sea posible.

## Verificación

- Pruebas de consulta `take=100`, `best_rate`, prioridad y alternancia justa.
- Pruebas de ventana móvil de aplicaciones.
- Pruebas de refresco: una edición por turno, separación de 20 segundos y recuperación tras reinicio.
- Pruebas de cancelación, aplicación, rechazo, restauración e incertidumbre.
- Suite completa, build, secretos y recorrido Chromium.

## Referencias oficiales

- https://www.qvapay.com/docs/p2p/list
- https://www.qvapay.com/docs/p2p/apply
- https://www.qvapay.com/docs/p2p/edit
- https://www.qvapay.com/docs/p2p/cancel
