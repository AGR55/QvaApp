# Paid / received: seguridad y medición backend

Auditoría inicial: 2026-10-28. Integración: 2026-10-29. Implementación en Trading,
servicio móvil, protocolo de intención monetaria, transporte, rutas HTTP y Android.
Sin transacciones reales ni consultas a la cuenta QvaPay para medir.

## Cambios y garantías

- Exclusión fail-fast por UUID antes del primer `await`, compartida por motores
  que usan el mismo objeto repositorio. Abarca preflight, POST y persistencia
  local. `cancel` participa para impedir que compita con pago/liberación.
- Se conserva el GET remoto, la selección exacta de orden flexible, el modo real,
  la referencia obligatoria y la intención durable antes del POST.
- Tras el GET se revalidan modo, estado local, identidad de orden e intenciones
  pendientes. No hay un `await` entre esa comprobación y persistir la intención.
- Recepción admite estados locales `applied`, `acknowledged`, `paid` y remotos
  `processing`, `paid`; rechaza terminales, abiertos y revisión.
- Duplicados concurrentes producen conflicto local 409, sin esperar cola ni
  consultar QvaPay otra vez. No se añade ningún reintento monetario.
- Una intención incierta sigue bloqueando envíos al reabrir SQLite. La
  conciliación existente solo resuelve recepción con remoto `completed`, y
  pago con `paid/completed`; `processing` no demuestra ausencia de efecto.
- Fallar la telemetría o la auditoría móvil posterior a confirmación no convierte
  el éxito en error. La auditoría previa y la persistencia durable siguen
  siendo barreras obligatorias.

### Límites de exclusión

La API de Trading identifica la operación por UUID y obtiene `orderUuid` de
SQLite. Por ello el bloqueo es conservador por oferta/operación, no permite
concurrencia entre órdenes hermanas del mismo UUID. No interpreta un ID de
presentación `uuid:order` como identificador remoto.

El bloqueo NO es un lease multiproceso ni protege dos objetos Store distintos
durante el preflight. La protección durable de intenciones sí sobrevive al
reinicio, una vez persistida. Para varios escritores simultáneos haría falta
adquisición atómica en SQLite antes del GET, con recuperación de leases; queda
fuera de los archivos asignados. No desplegar múltiples escritores suponiendo
que este bloqueo de memoria ofrece exclusión distribuida.

## Eventos y significado

`operation_action_timing` registra UUID como metadato del audit, acción,
`outcome` (`confirmed` / `not_confirmed`), `totalMs` y fases alcanzadas:

| Campo | Qué incluye |
| --- | --- |
| `preflightMs` | GET del gateway, cola/retries que éste aplique y selección de orden |
| `intentPersistMs` | Persistencia síncrona de la intención antes del POST |
| `mutationMs` | Invocación completa al gateway de mutación: cola/throttle, transporte y decodificación |
| `resultPersistMs` | Escrituras del resultado de intención, acumuladas si se intentan varias |
| `operationPersistMs` | Actualización de operación, contabilidad flexible y audit de negocio |
| `totalMs` | Validaciones y ejecución backend antes del audit de timing |

`mobile_action_timing` registra acción, resultado y tiempo de delegación del
servicio móvil. Excluye autenticación HTTP, auditorías móvil previa/posterior,
serialización y tránsito de la respuesta. No representa tiempo clic-a-render.
No agrega referencias, tokens, cuerpos ni errores remotos a estos eventos.

Las duraciones usan `performance.now()` monotónico. Fases no alcanzadas se
omiten, no se inventan como cero. `not_confirmed` no distingue rechazo de
incertidumbre: consultar el estado durable de intención. Una negativa por
exclusión ocurre antes de iniciar el timing de Trading.

## Medición simulada observada

Comando reproducible:

```sh
node --import tsx test/operation-actions.test.ts
```

Entorno de esta ejecución: Linux, Node v25.9.0 disponible en el equipo (el
proyecto declara Node >=24.22.1 <25). SQLite real en directorio temporal,
gateway simulado sin fetch ni credenciales, ejecución secuencial, 20 muestras
por acción. Inyección configurada: temporizador de 8 ms en preflight y 12 ms
en mutación. Sin latencia de cola inyectada en esta corrida. Los temporizadores
pueden resolverse más tarde; no se usan umbrales temporales frágiles en tests.

Valores observados en una corrida controlada, milisegundos, p50 / p95 por
nearest-rank (muestras ordenadas, posiciones 10 y 19):

| Tramo | paid | received |
| --- | --- | --- |
| Preflight | 8.467 / 9.019 | 8.403 / 8.609 |
| Persistir intención | 0.231 / 0.320 | 0.310 / 0.505 |
| Gateway mutación | 12.431 / 12.826 | 12.445 / 12.690 |
| Persistir resultado | 0.735 / 0.980 | 0.824 / 1.278 |
| Persistir operación | 0.222 / 0.382 | 0.263 / 0.420 |
| Total backend | 23.327 / 25.122 | 23.689 / 26.968 |

Estos números NO son de producción ni un antes/después. No prueban una mejora
de latencia de red. Los percentiles por fase no deben sumarse como si fueran el
percentil del total. No se midieron DNS, TLS, red móvil, nginx ni render Android.
Repetir bajo Node 24 soportado antes de tomar esta corrida como referencia CI.

## Configuración, separada de las observaciones

La auditoría de partida encontró conexión/lectura Android de 12 s, lectura
QvaPay de 5 s por intento (hasta tres con backoff), mutación de 25 s por intento,
separación general de 1.667 s y políticas `paid` 10 s / `received` 5 s.
Son valores de configuración, no mediciones. Android ahora usa conexión 10 s
y lectura 55 s para acciones monetarias, manteniendo un solo POST. Fastify conserva
inactividad general de socket de 10 s; solo después de autorizar y validar una
acción extiende su socket a 60 s. La recepción total pasa de 15 a 60 s para
permitir imágenes comprimidas con subida lenta, sin ampliar el límite JSON de
10 KB. El multipart de imagen autorizado tiene socket 60 s y límite propio
de 1 MiB + 16 KiB. Nginx ya limita lectura/envío a 60 s.

No se alteraron prioridades de colas, throttles ni reintentos upstream. No se eliminó validación
para obtener una mejora aparente. La mejora de rendimiento implementada es
rechazar duplicados sin consultas adicionales, y mantener independencia entre
UUID distintos; no se promete acelerar una mutación remota legítima.

## Coordinación Android / transporte

- Mostrar pendiente inmediatamente y no simular `paid/completed`, saldo o
  liberación confirmados. Persistir bloqueo antes de I/O y conservarlo ante
  pérdida de respuesta. Evitar depender de una bandera busy global.
- Publicar operaciones cuando llegue su consulta, sin esperar avisos/overview.
  Forzar actualización tras una acción sin quedar atado al intervalo periódico.
- Presupuesto síncrono debe incluir colas + preflight/retries + mutación +
  persistencias + transporte. No basta con subir Android de 12 a 25 s; la cola
  no tiene un límite global demostrado. Alternativa futura: aceptación durable
  asíncrona y consulta de resultado, sin reenvío automático del POST.
- Fastify `requestTimeout` limita recepción de request, no el handler. Revisar
  separadamente inactividad de socket, nginx y deadline del cliente.
- `operation-trace.ts` propaga contexto mediante AsyncLocalStorage. Cada lectura
  preflight y POST alcanzado dentro de una acción registra un evento
  `qva_action_request_timing`, correlacionado por `traceId` y `requestId`:
  `queueMs` espera la cola; `throttleMs` incluye separación, comprobación previa
  y persistencia del throttle; `upstreamMs` va desde despacho hasta lectura y
  decodificación completas, incluyendo reintentos/backoff de lectura si los hay.
  No representa tiempo de cómputo puro de QvaPay ni separa DNS/TLS del servidor.
  Un fallo antes de despachar omite upstream; los observadores no alteran el
  resultado. No se registran tokens, referencias, cuerpos ni URLs.
- En Android `QvaActionTiming` mide transporte monotónico sin datos sensibles.
  La UI publica operaciones en cuanto responde su consulta, sin esperar avisos,
  overview o SMS, y separa el estado por acción de la actualización general.
  El polling evita solicitudes sin red y usa backoff hasta 80 s. El estado
  pendiente no se convierte en saldo/pago/liberación confirmados por optimismo.

## Validación

Pruebas dedicadas cubren duplicados entre motores, selección de orden flexible,
exclusión durante GET y POST, independencia entre UUID, guards locales/remotos,
revalidación tras GET, fallo de persistencia inicial, reapertura SQLite,
conciliación sin reenvío y fallos de telemetría. Se ejecutaron también regresiones
de intenciones, cancelación manual, operadores móviles y recuperación.

Las pruebas de transporte incluyen una cola bloqueada, throttle demorado y
cuerpo remoto lento (20 ms inyectados por tramo), pérdida de conexión sin
reenvío y contextos concurrentes aislados. La prueba HTTP verifica que una acción
sin autorización o inválida no obtiene el presupuesto ampliado. Son simulaciones.
No se midió una transacción de producción. No puede asignarse un porcentaje
real a app, backend y QvaPay sin capturar una acción autorizada desplegada.
La validación integrada de Android y criterios visuales está en
`mobile-redesign-report.md`. No se creó ningún commit.
