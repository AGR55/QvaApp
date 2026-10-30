# Auditoría de cacerías — 29 de octubre de 2026

## Alcance y control de calidad

Tres subagentes GPT-6.1 Terra auditaron ruta crítica, transporte y contención; el agente principal contrastó hallazgos, consultó documentación oficial y verificó un árbol aislado basado en producción. Los cambios Android y de acciones manuales pendientes permanecen fuera de esta entrega. No se enviaron aplicaciones financieras de prueba ni se inspeccionó el bot del colega.

## Muestra de producción

Lecturas de SQLite en modo readOnly, ventana móvil de 48 horas durante la inspección:

| Tramo | Muestras | p50 | p95 | Máximo |
| --- | ---: | ---: | ---: | ---: |
| Cola interna del cliente para aplicar | 79 | 1 ms | 2 ms | 3 ms |
| Despacho HTTP a respuesta QvaPay | 79 | 1015 ms | 1557 ms | 1882 ms |
| Espera del presupuesto antes de esos despachos | 79 | 0 ms | 0 ms | 0 ms |

Resultados: 41 confirmaciones, 23 HTTP_409, 11 OFFER_CONTENDED, 2 HTTP_400 y 2 OFFER_PAUSED. Un 409 genérico no demuestra por sí solo que otro bot ganó la carrera. Las métricas de cola del cliente no incluyen la espera previa en el motor; se añadió una métrica específica para ese tramo.

25.080 eventos persistidos: recepción menos sent_at p50 21 ms, p95 48.865 ms, máximo 765.545 ms. Esta medición mezcla tipos de evento, canales y entregas tardías; depende del reloj remoto y no es una medición de latencia pura del SSE. La cola persistida no tenía pendientes durante la inspección. QvaApply consumía unos 134,5 MiB y 0,60 % de CPU en una muestra puntual; no prueba ausencia de picos.

La correlación retrospectiva de última oportunidad por UUID con cada aplicación da p50 11 ms, pero puede asociar aplicaciones manuales o por sondeo a eventos antiguos. Sus máximos no se usan como evidencia de bloqueo del feed. La nueva métrica mide directamente la espera de cada evento.

## Cambios

1. **Pausas y reanudaciones.** QvaPay ahora conserva status open en ofertas pausadas y publica p2p.paused/p2p.resumed. Se conservan los campos pause en el transporte, se clasifican las reanudaciones como oportunidades y las pausas como invalidaciones. Una oferta pausada o con pause no interpretable se rechaza localmente antes de red y reserva. Se revalida tras una consulta de saldo que pudo ceder el hilo. Una reanudación válida permite reevaluar una oferta vista sin levantar la exclusión por cancelación manual ni duplicar una operación existente. Pausar no completa ni cancela operaciones.
2. **Búsqueda indexada de intenciones pendientes.** Índice parcial idempotente por oferta e ID para submitted/uncertain. Benchmark sintético en Node 24.22.1, 100.000 intenciones y 500 búsquedas ausentes: 1456,49 ms antes / 0,25 ms después; SCAN pasa a SEARCH. No equivale a ese ahorro por oferta en producción: el histórico real tenía 983 intenciones y solo tres inciertas. La creación inicial del índice tiene coste de arranque.
3. **Espera del feed observable.** market_feed_queue_timing registra UUID, lado, queueMs y reloj al comenzar ingest, y se persiste al terminar. Las marcas monotónicas tienen cota de 1024 oportunidades; el resto usa el tiempo durable y lo indica. La telemetría no altera el resultado si falla ni cambia la deduplicación.
4. **Reconexión SSE.** Se respeta retry del servidor sin recortarlo a 60 segundos y Retry-After en 429. Solo si el servidor omite retry, un cierre limpio usa un segundo; errores mantienen al menos diez segundos y backoff. El ejemplo oficial manda retry:10000: no se promete reducir esa espera a un segundo.

El operador confirmó que activó paused y resumed tanto en webhook como en stream.

## Decisiones de calidad

- No se difirió el snapshot visual: medirlo dio p50 0,072 ms y p95 0,121 ms en un fixture de hasta 50 ofertas. Diferirlo introduce carreras de proyección con eventos de estado; el ahorro no justificó el riesgo.
- No se quitaron las exclusiones que protegen el mismo capital. Un análisis de concurrencia identificó que respuestas invertidas pueden reconstruir una caché QUSD con saldo neto anterior y un epoch nuevo; ampliar carriles exige primero resolver ese modelo y su interacción con cancelación/restauración. No se hizo un cambio de concurrencia sin esas pruebas.
- No se repiten aplicaciones inciertas ni se aumentó la cuota de QvaPay. No hay evidencia que atribuya a Go o a ser VIP la diferencia observada. El tiempo remoto no desaparece reescribiendo una decisión local de pocos milisegundos.

## Validación

Árbol aislado basado en b08e374, únicamente con este alcance. Node 24.22.1: comprobación de tipos, knip, suite completa de 75 archivos, build servidor, build web, compresión y escáner de secretos aprobados. Benchmark recepción directa a POST con SQLite real, red/cuota simuladas y lectura de panel retenida: 50 ofertas, p50 3,22 ms / p95 7,02 ms. Es una referencia local, no una promesa de mejora de red ni una medición antes/después comparable entre máquinas.

Pruebas nuevas cubren pausa malformada/vencida, reanudación y cancelación manual, pausa durante cola y durante consulta de saldo, estado de operaciones intacto, clasificación de colas y empates, índice y reapertura, cota de telemetría, retry SSE y Retry-After.

## Fuentes oficiales

- https://www.qvapay.com/docs/p2p/webhooks
- https://www.qvapay.com/docs/p2p/stream
- https://www.qvapay.com/docs/p2p/apply

La documentación vigente confirma pause en los eventos, reanudación, OFFER_CONTENDED y límite de dos aplicaciones cada sesenta segundos.
