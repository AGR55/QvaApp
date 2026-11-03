# Cacerías: preparación y coherencia del saldo QUSD

Tercera entrega autorizada por «Puedes continuar», implementada y revisada con tres subagentes GPT-6.1 Terra. El objetivo es reducir consultas de saldo en la decisión de venta sin ampliar concurrencia de aplicaciones ni cambiar cuotas, reservas o requisitos.

## Comportamiento implementado

`refreshHuntingQusdBalance()` hace únicamente una lectura de saldo. Un trabajo independiente lo considera cada cinco segundos cuando las ventas están habilitadas, hay mercado activo y el motor opera en real sin pausa ni parada de emergencia. Si la entrada vigente tiene menos de diez segundos, no consulta. La vigencia máxima sigue siendo quince segundos; el refresco anticipado no la amplía y un error no la renueva. No se garantiza tener saldo caliente si la cola o la red se demoran.

La preparación que puede reducir una oferta propia sigue siendo un trabajo separado cada diez segundos. Conserva su consulta explícita, cálculo de objetivo, reservas, mínimo de oferta, limitación de ediciones, intención durable y validación antes de enviar. Vuelve a comprobar el saldo después de editar. Un error monetario conserva su clase y no se oculta por un cambio de control.

La caché centralizada almacena saldo **bruto**. Cada consumidor descuenta la deuda cooperativa y las reservas vigentes al usarlo; los consumidores no comparten una cifra neta calculada para otro intento. Las lecturas de la misma prioridad, versión contable y revisión local comparten una consulta en curso. Una consulta urgente no espera una lectura normal pendiente en la cola general.

Las solicitudes llevan secuencia de inicio y revisión de la proyección. Una respuesta anterior no reemplaza una posterior publicada, y una respuesta posterior puede prevalecer aunque la anterior termine primero. `replace` e `invalidate` invalidan lecturas iniciadas antes de una actualización local. Si un refresco forzado fue superado por una lectura remota posterior y vigente de la misma versión, utiliza esa respuesta sin generar un GET redundante; una proyección derivada localmente no sustituye una lectura forzada.

La versión combina el epoch monetario y la generación de controles del motor, que cambia por configuración, pausa y parada. El consumidor vuelve a comprobar vigencia después de esperar; una lectura descartada por control no inicia otra consulta para insistir. Se permiten como máximo cuatro consultas físicas de saldo pendientes y tres intentos de resolver invalidaciones de versión, rechazando de forma segura al superar esos límites. Esto no aumenta el número de POST ni el cupo remoto de aplicación.

## Confirmación y contabilidad

Tras confirmar una aplicación fija o flexible, el motor solo deriva la nueva proyección del saldo bruto capturado si la versión de caché y contabilidad sigue siendo la misma que antes del POST. Si hubo otra actualización durante la espera, invalida la caché y exige lectura posterior, conservando siempre la operación confirmada.

Se eliminó la reconstrucción del bruto a partir de disponible neto más deuda cooperativa actual. Esa fórmula podía inflar el saldo si la deuda cambiaba durante el POST. Ahora la proyección usa el bruto capturado menos el importe confirmado; las reservas y deuda se descuentan al consumirla.

## Medición y cierre

`qusd_read_timing` registra prioridad normal/urgente, resultado y tiempos de cola, respuesta y total. Cola incluye throttle; respuesta incluye reintentos, backoff y JSON. El total termina después de validar la respuesta de saldo. Los campos no alcanzados son nulos; no se inventan DNS/TLS ni tiempo exclusivo del proveedor.

`qusd_cache_timing` registra contexto, acierto, tipo de fallo de caché, lectura fresca o descartada y duración. No registra saldo, importes, epoch, UUID, tokens ni errores remotos. La edad de una entrada no equivale necesariamente a la edad de una lectura remota, porque puede derivarse de una aplicación. Los observadores no alteran el resultado ni el error original.

`pnpm report:hunting` agrega ambas series con dimensiones permitidas y contadores por contexto/resultado. Los contadores son eventos: una consulta puede producir un fallo de caché y después una lectura fresca o un descarte. No sumar esos eventos como si fuesen consultas independientes ni sumar latencias de muestras distintas.

El cierre espera los trabajos completos de refresco y preparación, incluidos sus guards y persistencias posteriores, y después cierra la caché y sus consultas físicas antes de cerrar SQLite. Una aplicación ya enviada mantiene su resolución y conciliación existentes.

## Validación

Node 24.22.1. Pruebas con SQLite temporal y gateways controlados, sin producción:

- Caché: prioridades independientes, consultas compartidas, TTL, cambios de epoch/revisión, ambos órdenes de respuesta, lectura forzada superada, errores originales, callbacks fallidos, límites y cierre.
- Integración: calentamiento sin mutaciones; venta caliente sin otro GET; urgente progresa con fondo retenido; respuesta vieja no sobrescribe; cambios de epoch, pausa/reanudación y desactivación; lectura fallida sin renovar vigencia.
- Aplicaciones fijas y flexibles: un saldo actualizado durante el POST no se sobrescribe y la operación confirmada se conserva.
- Deuda cooperativa durante el POST: bruto 100, aplicación 10 y deuda nueva 50 dejan disponible 40; una segunda venta de 50 se rechaza sin otro POST.
- Transporte, informe y cierre de ambos trabajos probados con respuestas y relojes controlados.

La suite completa incluye 92 archivos. No se ha desplegado ni se han realizado operaciones o lecturas en producción. La mejora demostrada es que una venta puede usar el saldo preparado sin un GET adicional y que una consulta de fondo no retiene la urgente. Falta medir la mejora real de adjudicación con las nuevas métricas.
