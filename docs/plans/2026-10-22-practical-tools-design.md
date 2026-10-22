# Rentabilidad, avisos y simulación de precios

El usuario aprobó el diseño completo: distinguir resultados documentados de estimaciones, registrar evidencia de comisiones faltantes, agrupar solo avisos informativos y simular precios localmente sin modificar límites.

## Decisiones

1. Rentabilidad: ampliar el FIFO existente con coste fiat registrado y QUSD netos documentados por compra. La comisión manual se valida contra una compra completada de la cuenta y se guarda con evidencia y versión; no modifica dinero ni operaciones. El beneficio documentado exige evidencia de compra y cobro de venta; el resto mantiene una etiqueta de estimación. No se presume exención GOLD ni se aplican comisiones actuales al pasado. Las operaciones con coste desconocido no se presentan como ganancias.
2. Avisos: mantener pagos, operaciones, conciliación y salud de forma individual. Agrupar avisos informativos repetidos de reajustes completados en una ventana corta por canal y conservar sus referencias. El resumen usa la cola durable y sus reintentos; no elimina la auditoría. Priorizar las operaciones que necesitan atención y limitar la cola visual de mensajes repetidos.
3. Simulación: comparar límites actuales y propuestos con observaciones locales de ofertas. Deduplificar actualizaciones por UUID, usar comisiones fiat actuales indicadas en pantalla y respetar mínimos/máximos flexibles para el importe de prueba. Excluir ofertas propias y observaciones antiguas al recibirse. Leer por lotes con cobertura y límite explícitos; no supone saldo histórico ni captura posible. Herramienta bajo demanda en Cacería y Telegram.

## Alternativas

Consultar QvaPay para cada informe añadiría carga remota. Inferir comisiones históricas con las tasas actuales produciría cifras no comprobables. Se reutilizan datos locales y se pide evidencia únicamente cuando falta información real.

## Plan

- Migración compatible para evidencia versionada de comisiones; ampliar el FIFO y su cobertura en una sola pasada.
- Formularios y resumen de rentabilidad en Gráficas; comandos de consulta en Telegram.
- Resúmenes durables de avisos informativos con pruebas de prioridad, reintento y conservación de operaciones urgentes.
- Simulación por lotes, API autenticada y controles de web/Telegram, con pruebas de rangos, comisiones y límites.
- Verificación completa y visual; despliegue y comprobación de producción.

La skill auxiliar writing-plans no está instalada; este documento contiene el plan para el diseño ya aprobado.

Fuente del contrato de importes: https://www.qvapay.com/docs/p2p/received (importe bruto, neto y comisión). La implementación no supone que una transacción agregada sea evidencia inequívoca del neto recibido.
