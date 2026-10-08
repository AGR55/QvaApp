# Latencia y trazas de ofertas

> Actualización: las trazas de ofertas ocupadas por Telegram se retiraron a
> petición del operador. Sigue vigente la optimización de cola; el cierre
> automático por falta de ACK también quedó desactivado.

## Diagnóstico

La muestra de producción del 7 de octubre mostró una decisión local reciente de
3 ms frente a 1218 ms de respuesta de QvaPay. También hubo rechazos explícitos
por el límite de 10 operaciones y descartes de Clásica por comisión: una tasa
nominal de 1.09 puede superar un máximo efectivo de 1.09. Ninguna de estas dos
causas demuestra que un competidor se adelantó.

## Cambios

- Una aplicación automática sin cuota retorna un rechazo local inmediato, sin
  POST, sin dormir dentro de la cola y sin consumir un intento adicional.
  Conserva la ventana durable y Retry-After. Las aplicaciones manuales conservan
  su espera; no se paralelizan mutaciones sobre el mismo saldo.
- Cotizaciones mayores de cinco segundos no provocan consultas bloqueantes. Una
  nueva observación permite reevaluar; la cancelación manual sigue excluida.
- Se registra recepción, cola, despacho, respuesta y resultado por UUID.
- Telegram recibe trazas de `p2p.applied` de mercados vigilados explícitamente no
  VIP. No se atribuye la aplicación a un bot porque el evento no lo demuestra.
  Se excluyen operaciones propias, intenciones propias inciertas y reservas
  cooperativas. Un 404 por sí solo no se convierte en «carrera perdida».
- Las trazas se deduplican por ciclo, tienen reintentos durables y prioridad menor
  que los avisos operativos. No generan Web Push ni llenan la bandeja operativa.
- Los motivos de descarte muestran seis decimales para no ocultar comisiones.

## Verificación

Pruebas de cuota sin espera, revalidación antes del despacho, cotizaciones
caducadas y nuevas, clasificación de eventos, carreras entre feed y respuesta,
deduplicación, prioridad de notificaciones y fallo aislado de telemetría.
Benchmark local con SQLite e intención durable, 50 ofertas sin red ni cuota:
p50 3.63 ms / p95 7.80 ms. No es una garantía de latencia de producción.

## Alcance

Las cuentas adicionales existentes siguen siendo lectoras. Operar fondos desde
varias cuentas requiere aislar credenciales, saldos, cuotas e intenciones por
cuenta; esta mejora no las convierte implícitamente en cuentas operadoras.
No se cambian tasas, fiat, comisiones, exclusiones ni reglas del bot del compañero.
