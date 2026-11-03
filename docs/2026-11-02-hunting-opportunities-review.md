# Cacerías: oportunidades para llegar antes — 2 de noviembre de 2026

Revisión del árbol de trabajo actual por el agente principal y tres subagentes GPT-6.1 Terra: detección, ejecución y arquitectura/cooperación. Se revisó también el código relevante de `qvapay-bot-sync`. No se modificó código ejecutable, no se enviaron operaciones ni se midió producción. Los cambios previamente pendientes permanecen intactos. Esto es una propuesta, no un diseño aprobado ni una garantía de rendimiento.

## Qué sabemos

La auditoría del 29 de octubre documenta 79 aplicaciones en una ventana de 48 horas: cola del cliente p50/p95 1/2 ms; despacho a respuesta remota 1015/1557 ms; espera de presupuesto de esos despachos 0/0 ms. También documenta un benchmark local con SQLite y red simulada: recepción a POST p50/p95 3,22/7,02 ms. Son muestras distintas, históricas y no comparables como un antes/después. No permiten calcular un porcentaje exacto de tiempo atribuible al servidor, ni saber cuándo adjudicó la oferta. Fuente: `docs/2026-10-29-hunting-performance-review.md`.

La latencia importante para competir es publicación → recepción → decisión/reserva → despacho → llegada/adjudicación remota. La respuesta completa y la notificación vienen después. Una respuesta de un segundo no demuestra que QvaPay tarde un segundo en adjudicar: podría haber adjudicado antes de completar el resto de su trabajo.

El feed ya despierta por microtarea (`src/market-feed.ts:359`); los 250 ms del scheduler son respaldo, no una espera fija por cada evento. El cliente de aplicación ya libera su puerta de despacho sin esperar la respuesta (`src/qvapay.ts:696`). Los avisos ya se difieren (`src/trading.ts:1267`). Estas mejoras no deben proponerse como si faltaran.

## Propuestas, por valor y dependencia

### 1. Medir dónde perdemos la carrera

Registrar por UUID, versión de oferta y origen: primera recepción de SSE/webhook/polling, espera de feed, espera del carril del motor, decisión, reserva/intención durable, despacho, conexión reutilizada o nueva, DNS/TCP/TLS cuando aplique, primer byte y respuesta completa. Usar reloj monotónico para tramos locales. Comparar tiempos remotos solo con semántica de timestamps y desfase de relojes conocidos.

Separar resultados: confirmación, oferta ya tomada, `OFFER_CONTENDED`, cuota local/remota, capital insuficiente, requisito no cumplido, pausa y resultado incierto. Medir p50/p95/p99, tasa de captura entre oportunidades elegibles observadas y valor capturado; también fallos de cobertura, pues las ofertas nunca observadas no entran en ese denominador. El p95 histórico de recepción menos `sent_at` mezcla eventos y entregas tardías: no equivale al p95 de SSE.

Objetivo inicial de validación, no resultado observado: recepción → despacho p95 <10 ms en una oportunidad con saldo, cupo y conexión preparados, sin consulta remota previa. Medir colas bajo ráfagas aparte.

### 2. Desacoplar adquisición y evaluación del polling

`src/application/market-hunting-loops.ts:14` espera consulta y evaluación antes de terminar; `src/scheduler.ts:78` añade después otros 250 ms. `src/market-source.ts:95` impone una sola lectura en vuelo entre todas las cuentas. Una aplicación lenta desde una página o una lectura con reintentos retrasa los demás turnos. El cliente permite tres intentos de lectura de 5 s con pausas de 800 y 1600 ms: aproximadamente 17,4 s, más cola y decodificación, en ese escenario configurado; no es una demora observada.

Separar lector de evaluador mediante cola acotada por mercado/lado y versión. Planificar por próximo vencimiento; estudiar una lectura en vuelo por cuenta independiente, conservando presupuesto compartido por propietario y `Retry-After`. Evitar acumular páginas obsoletas y no perder invalidaciones. No lanzar una promesa sin seguimiento ni una cola ilimitada.

La cadencia mostrada en `src/market-source.ts:158` es teórica agregada. Añadir edad real y cobertura por mercado/lado, páginas truncadas y tiempo entre respuestas útiles.

### 3. Preparar liquidez y perfil antes del candidato

La caché QUSD dura 15 s; si está vencida, `src/trading.ts:1334` consulta saldo en el camino crítico. Ya existe preparación de liquidez (`src/trading.ts:1285`): medir su cobertura y ajustar el refresco previo, con margen para fallos y cuota compartida. Preparar capital disponible, elegibilidad y tamaño de orden antes de la llegada, sin gastar capital reservado o cooperativo.

La versión más rápida usa un presupuesto local preasignado y reservado de forma durable. Su disponibilidad debe reflejar todas las mutaciones y resultados inciertos; aumentar la duración de una caché por sí solo no lo consigue. Si existen operaciones externas a QvaApply, reconciliar e imponer límites conservadores.

### 4. Optimizar ubicación y transporte con una comparación real

`src/qvapay.ts:141` usa `globalThis.fetch` sin dispatcher explícito. Esto no significa que abra una conexión nueva por solicitud. Medir reutilización y colas de conexiones; comparar un pool dedicado a aplicaciones frente al comportamiento actual. SSE y tráfico de panel/chat no deben consumir capacidad crítica accidentalmente.

Comparar regiones/proveedores candidatos con el mismo método, horarios y rutas de lectura autorizadas, sin usar aplicaciones financieras como benchmark. Una buena región para lecturas no prueba por sí sola mejor adjudicación en escritura. Cambiar ubicación solo con evidencia; co-localizar QvaApply y Sync reduce el RTT de reserva cooperativa. Validar HTTP/2 u otras opciones solo si el endpoint y el cliente usados lo soportan y la medición los favorece.

### 5. Reducir bloqueo entre oportunidades en ráfagas

El feed admite una oportunidad tipo `buy` y dos tipo `sell` (`src/market-feed.ts:201`). Los carriles de decisión esperan el procesamiento completo (`src/trading.ts:812`, `:838`, `:858`), incluida la respuesta de aplicación (`:1222`). Puede haber cupo para una segunda venta QUSD mientras la primera retiene el carril.

Diseñar dos fases: decisión/reserva/intención/despacho y resolución asíncrona. Liberar el carril de decisión tras el despacho, conservando exclusión por oferta y capital reservado hasta resolución. Esto sirve cuando queda cupo y capital; no crea capacidad de aplicación adicional.

Antes debe resolverse la contabilidad QUSD ante respuestas invertidas: `src/trading.ts:1261` reconstruye caché desde un saldo previo. La auditoría del 29 de octubre ya documenta este riesgo. Usar ledger de reservas y versiones, transacciones y pruebas de confirmación fuera de orden, timeout, reinicio, cancelación y conciliación. No basta aumentar el número de workers.

### 6. Preasignar capital cooperativo: el mayor cambio propio de arquitectura

Hoy se espera `sync.reserve` antes de aplicar (`src/cooperative-hunter.ts:117`). Propuesta: Sync asigna previamente un cupo exclusivo de capital a un ejecutor/mercado; ese ejecutor consume local y duraderamente el cupo y envía el POST sin otra reserva remota por candidato. Después registra el resultado por un outbox durable e idempotente.

Así se puede eliminar un viaje a Sync por oportunidad. Su magnitud depende del RTT y espera real de reserva, todavía no medidos aquí. El coste es capital temporalmente inmovilizado y mayor complejidad: identidad de asignación, epoch, fencing, retirada segura, caídas y resultados inciertos. No reasignar automáticamente el mismo dinero solo porque venció un temporizador si una aplicación puede seguir pendiente. Debe existir exclusión efectiva del escritor anterior o una confirmación de cierre del cupo.

Paso intermedio: co-localización, medir reserva/SQLite/commit por separado y snapshots con revisión monotónica. HTTP y NATS sobrescriben actualmente la misma proyección (`src/hunting-sync.ts:564`, `:628`); probar regresión por entregas fuera de orden. `aggregate` también exige HTTP reciente aunque NATS funcione (`:338`). La reserva autoritativa conserva su función de seguridad. Sync usa una conexión SQLite (`../qvapay-bot-sync/internal/core/database/database.go:25`); no cambiar de base ni aumentar conexiones sin demostrar contención y conservar atomicidad.

### 7. Ganar la carrera de información y elegir mejor el intento

Medir qué canal ve primero cada versión de oferta, conservando invalidaciones y deduplicación. Si se justifica, distribuir receptores de solo lectura y converger al primer evento válido en un único ejecutor por cuenta. Más receptores no garantizan eventos antes: pueden compartir el mismo origen y cacheado. El salto de red al ejecutor también cuesta.

Con dos aplicaciones cada 60 s, la calidad del intento importa. Precalcular reglas deterministas por margen, capital, requisitos y prioridad; cuando varias oportunidades ya están esperando, priorizar las de mayor valor esperado y frescura. No introducir un modelo de IA ni una espera artificial para clasificar un candidato único en el camino crítico.

Revisar `OFFER_CONTENDED`: QvaPay documenta un conflicto temporal reintentable, mientras `src/trading.ts:1233` marca vistos los rechazos remotos de esa ruta. Podría justificarse una política específica con revalidación local, cupo libre y oportunidad vigente. Cada reintento consume cupo y puede empeorar capturas posteriores; no reintentar un resultado incierto ni tratar todo 409 como contención.

### 8. Máximo techo: ejecución condicional dentro de QvaPay

Proponer al proveedor órdenes permanentes o reglas de autoaplicación del lado servidor: mercado, tasa límite, tamaño, requisitos, capital y presupuesto. Una operación atómica del proveedor puede evitar publicación → transporte → decisión del cliente → POST de retorno. Es una propuesta de integración nueva; no se encontró como capacidad documentada existente.

También pedir timestamp de aceptación/asignación, identificador/versionado del evento e idempotencia documentada. Eso permitiría distinguir llegada tardía de adjudicación lenta y gestionar resultados ambiguos con mayor precisión.

## Lenguaje y límites

Mantener TypeScript/Node inicialmente. Go o Rust no eliminan la entrega del evento, el viaje de reserva ni el trabajo remoto. Si se demuestra pausa del event loop por panel, imágenes o tareas de fondo, separar un ejecutor mínimo del proceso de presentación puede resolverla sin reescribir todo. Solo después comparar ese ejecutor contra un prototipo Go/Rust con replay idéntico y p99, incluidos persistencia y fallos. Go ofrece una opción para un servicio pequeño de red; Rust aporta control de memoria y pausas, a mayor coste de desarrollo. No se midió superioridad de ninguno aquí.

No ejecutar varios escritores con la misma cuenta basándose en locks de memoria: hace falta adquisición atómica, presupuesto durable compartido, líder con fencing efectivo y conciliación. NATS no sustituye la exclusión del dinero. No eliminar la intención durable previa al POST para ahorrar milisegundos.

## Orden recomendado

1. Trazas por oportunidad y comparación por canal; preparar y medir saldo; observar `X-Cache` y cobertura por mercado.
2. Desacoplar adquisición/evaluación y probar aislamiento de lecturas por cuenta; medir transporte/región y reserva cooperativa.
3. Según evidencia, ledger QUSD + despacho independiente o cupos cooperativos preasignados. Son cambios de alto impacto que necesitan pruebas de fallos.
4. Explorar integración de ejecución condicional con QvaPay. Reescribir únicamente un componente si una medición reproducible lo justifica.

## Fuentes oficiales consultadas

- [Aplicación P2P](https://www.qvapay.com/docs/p2p/apply): dos intentos por 60 s, `OFFER_CONTENDED`, pausas y requisitos.
- [Stream](https://www.qvapay.com/docs/p2p/stream): SSE sin replay durante desconexión, reconexiones y uso simultáneo con webhook.
- [Webhooks](https://www.qvapay.com/docs/p2p/webhooks): eventos, invalidaciones, selección por canal y datos para filtrar localmente.
- [Listado](https://www.qvapay.com/docs/p2p/list): caché de varios segundos y `X-Cache`; texto de 25 consultas/minuto por cuenta, aunque la tabla de errores aún dice 30. Credenciales de app comparten bucket del propietario. Más polling no garantiza más frescura.
- [Node fetch](https://nodejs.org/api/globals.html#fetch): dispatcher configurable; verificar en la versión soportada por el proyecto antes de implementar.
