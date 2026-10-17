# Captura de ofertas y latencia — diseño aprobado

El usuario aprobó las cuatro mejoras propuestas: feed por rango, solicitudes independientes simultáneas con reservas, preparación de QUSD libre y filtrado local de requisitos.

## Diseño

- Reconocer `p2p.range_created`, `p2p.range_updated` y `p2p.range_closed`. Las dos primeras llevan una oportunidad dimensionada por disponible, mínimo, máximo y capital. La última invalida el padre sin convertir sus órdenes en operaciones terminadas. Versionar cambios por su momento de emisión y estado disponible para no perder reaperturas ni repetir una aplicación activa. Activar los eventos en la suscripción existente conservando los demás.
- Separar la cola de envío HTTP de la espera por la respuesta. Reservar el cupo de forma síncrona después de revalidar y antes de enviar. Mantener el máximo oficial de dos intentos por ventana y `Retry-After`. Una respuesta ambigua mantiene el capital reservado.
- Persistir reservas de capital de aplicaciones antes del envío y retirarlas al rechazar, conciliar o proyectar la operación. La reserva confirmada sigue viva hasta que exista su operación, evitando un hueco entre ambas escrituras.
- Procesar compras con fiat independientes simultáneamente y mantener serializadas las rutas que comparten QUSD, cancelación de garantías o flujos de restauración. El feed puede continuar con fiat mientras espera una ruta QUSD. No duplicar aplicaciones al mismo padre.
- Refrescar saldo y perfil en segundo plano, fuera de la decisión crítica. Preparar liquidez para una operación de venta usando el límite por operación ya configurado y conservando reservas, deuda cooperativa y operaciones pendientes. Reducir ofertas propias fijas abiertas a su misma tasa; no tocar órdenes o ventas ya tomadas, ni reponer liquidez preparada automáticamente. Registrar cada mutación durable y conservar evidencia de resultados inciertos.
- Conservar una proyección local del perfil P2P y comprobar únicamente requisitos conocidos y verificables (operaciones, rating, antigüedad, confianza, KYC). No inventar datos faltantes ni consultar el detalle de cada candidato. QvaPay sigue siendo la validación final.

## Alternativas consideradas

Mantener toda la ejecución serial no resuelve las ráfagas. Paralelizar todos los flujos de cancelación y reposición exigiría coordinar las mismas garantías y añade riesgo financiero. Se eligen compras fiat concurrentes protegidas por reservas, compartiendo el mismo cupo oficial, y una ruta QUSD serial independiente.

## Verificación

Pruebas de feed por rango y cierre del padre, cambios de disponible, deduplicación, saldo compartido, reserva durable durante timeout/reinicio, segunda solicitud mientras la primera respuesta está retenida, agotamiento de cupo, `429`, capital en comisiones, prioridad propia, preparación sin interferir con operaciones en curso y requisitos sin lecturas por candidato. Ejecutar la suite completa y desplegar mediante CI; verificar salud, eventos habilitados y cacerías activas sin aplicaciones financieras de prueba.
