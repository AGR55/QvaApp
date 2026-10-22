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

## Verificación y alcance entregado

- FIFO mantiene resultados documentados y estimados por moneda; solo el coste registrado, los netos respaldados y el cobro registrado habilitan la parte documentada. Los aportes parciales no crean inventario ficticio barato. La evidencia manual tiene control de versión y auditoría; no modifica saldos ni operaciones.
- Reajustes completados se agrupan por ventanas de 30 segundos en la cola durable. Se conservan las referencias y no se reenvían avisos ya entregados. Las operaciones mantienen avisos individuales y disponen de entrega independiente de resúmenes bloqueados. Telegram conserva los avisos informativos que ya estaban silenciados.
- Cola visual acotada a 32 avisos y 512 identidades; una operación urgente puede sustituir en pantalla a un aviso informativo, que conserva su lugar o permanece pendiente en el servidor.
- Simulación en Cacería y `/simular MONEDA MAX_COMPRA MIN_VENTA MAX_QUSD [1|24|168]`; informe de rentabilidad en Gráficas y `/rentabilidad [7|30|90]`. Registros locales, máximo 5.000 observaciones y lotes de 250 con cesión del turno; cobertura limitada visible.
- 539 pruebas aprobadas, verificación de tipos, código, secretos y construcción. Prueba visual y WCAG en escritorio/móvil aprobadas, incluyendo registro de evidencia y comparación de precios. Sin nuevas dependencias ni peticiones a QvaPay.
