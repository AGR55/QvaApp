# Cacerías: aislamiento de lectoras e informe de resultados

Segunda entrega autorizada por «Puedes continuar», sobre la primera fase de adquisición independiente. Implementación y revisión con los mismos tres subagentes GPT-6.1 Terra. No incluye cambios de capital ni mutaciones financieras nuevas.

## Diseño

El tick de sondeo despacha como máximo una lectura y retorna sin esperar su respuesta. Cada resultado llega al consumidor acotado de la primera fase de forma independiente. Hay como máximo cuatro lecturas en vuelo; el cierre espera todas. Se conservan las comprobaciones de generación, modo y pausa al recibir y evaluar una página.

Las lectoras con identidades autenticadas distintas pueden trabajar simultáneamente, con una consulta por cuenta y por propietario en vuelo. Las identidades conocidas que comparten propietario comparten el calendario de solicitudes y el cooldown remoto. Una credencial desconocida mantiene la serialización con cualquier otra lectura: no se presume independencia por tener otro token. Sus intervalos configurados siguen vigentes; la serialización de credenciales desconocidas no demuestra que sus cuotas pertenezcan a usuarios distintos.

Además del calendario del sondeo, todos los clientes de listado creados por la aplicación comparten `ListingReadBudget`, incluidas las consultas del panel, tareas de fondo y validaciones de lectoras. Antes de cada intento HTTP, incluidos reintentos de red, se reserva una separación de 2401 ms para el propietario. Las identidades distintas no esperan unas por otras; una credencial desconocida espera al presupuesto de todas y deja una barrera para las demás. Un 429 desconocido enfría todas; uno conocido enfría su propietario y las consultas desconocidas. Por ello las lectoras sin identidad pueden reducir su cadencia agregada respecto al intercalado anterior. No se presupone independencia para acelerar.

El presupuesto se persiste como un único objeto versionado en una escritura SQLite y poda los propietarios cuyos plazos vencieron. No es un lock distribuido ni autoriza varios procesos escritores. Fallar la reserva impide el envío; fallar al persistir un 429 bloquea nuevos despachos del componente en ese proceso. La identidad primaria del presupuesto se vincula al hash del token verificado mediante `/user`, sin reutilizar un UUID analítico de una sesión anterior. La espera usa el token capturado para la petición; una sesión primaria sustituida antes del despacho rechaza el listado pendiente.

La identidad se obtiene exclusivamente del perfil autenticado, cuando el token permite consultarlo. Nunca se deduce del dueño de una oferta del listado. Al agregar o rotar una credencial se intenta leer el perfil después de validar acceso a P2P. Si el perfil no está permitido, la lectora continúa siendo válida con identidad desconocida. Una tarea de fondo comprueba una lectora antigua por turno de 60 segundos y no repite el mismo token fallido durante una hora en el mismo proceso. No se amplían los permisos de ninguna credencial. La [documentación de tokens](https://www.qvapay.com/docs/auth/tokens) distingue `p2p:read` de `read`, que habilita las consultas de perfil.

Las respuestas de cuentas eliminadas, deshabilitadas o rotadas durante la consulta no deben restaurar salud ni proyecciones antiguas. Los bloqueos de consultas sobreviven a la reconstrucción del roster mientras haya red pendiente. Una secuencia asignada al despacho ordena las respuestas por mercado/lado y evita que una consulta anterior sustituya una posterior. Esta secuencia no demuestra frescura del contenido cacheado por QvaPay.

El servicio cuenta cambios de habilitación y rotación para detectar también una deshabilitación y rehabilitación completas durante la consulta. Si una lectora desconocida espera su turno, se permite drenar las lecturas conocidas en curso antes de despachar otras posteriores, evitando relegarla indefinidamente. Las respuestas descartadas por cambio de credencial o por secuencia anterior tienen su propio resultado y motivo en la auditoría de polling.

La auditoría de evaluación también cuenta páginas sustituidas, expulsadas por capacidad y descartadas por cambio de control o cierre. Antes esas páginas pendientes desaparecían sin una métrica específica.

## Informe local

Usar Node 24.22.1 desde el repositorio:

```sh
pnpm report:hunting --db /ruta/absoluta/qvaapply.sqlite \
  --since 2026-11-01T00:00:00Z --until 2026-11-02T00:00:00Z
```

Añadir `--json` para salida estructurada. La ruta es obligatoria: el script nunca busca ni abre por defecto la base de la aplicación. `--since` es obligatorio y `--until` toma por defecto el instante actual UTC. La ventana incluye `since` y excluye `until`.

El informe abre SQLite con `readOnly: true`, sin crear Store, ejecutar migraciones ni inicializar el servicio. Puede leer la auditoría visible en WAL. Agrega percentiles exactos nearest-rank p50/p95/p99 y máximo; cuenta muestras, campos omitidos o inválidos y JSON malformado. Solo imprime fases y dimensiones permitidas, sin identificadores, cuentas, cuerpos o mensajes libres. Mercados fuera de la lista conocida aparecen como `unknown`.

Series disponibles: lectura por mercado/lado, cobertura entre respuestas, cola/evaluación y motivos de descarte, listados del cliente principal, cola del feed separada por tipo de reloj y tiempos de aplicación. Los contadores separan descartes de polling y de evaluación. No correlaciona eventos únicamente por UUID ni inventa canal/mercado cuando faltan. No sumar `qva_list_timing` con transporte anidado de polling: se solapan.

Interpretación: `coverageGapMs` no es edad de la oferta; `evaluationMs` puede incluir confirmación remota; `responseMs` de listado incluye reintentos, sus esperas de presupuesto, backoff y JSON; `queueMs` de transporte incluye throttle y la primera espera de presupuesto. El éxito de una evaluación no significa captura. Los descartes de evaluación contados son los de páginas que alcanzaron la cola/evaluación; una respuesta invalidada antes de encolarse puede no producir ese evento. La cadencia del estado sigue siendo una estimación teórica; medir intervalos de respuestas útiles para evaluar cobertura real.

## Verificación

Pruebas con Node 24, SQLite temporal y gateways controlados: lector lento con otro propietario progresando, ausencia de solapamiento por propietario, identidades desconocidas, 429 compartido, rotación/baja/desactivación durante red y respuestas fuera de orden. Comprobar además límites de trabajos en vuelo, espera de cierre, perfil opcional, refresh sin escrituras obsoletas y aislamiento de errores.

El informe se prueba con percentiles conocidos, WAL con escritor vivo, ventanas, JSON inválido, valores no finitos, fechas imposibles, ausencia de secretos en salida y una base ausente que no se crea. También se ejecutó el comando real con una base sintética temporal, con salida correcta.

Node 24.22.1: `pnpm check` aprobado, incluidos tipos, knip, suite completa de 88 archivos, builds servidor/web, compresión y comprobación de secretos. Las pruebas adicionales cubren cuota compartida entre clientes, reintentos con reserva por intento, identidad vinculada al token y escritura atómica del presupuesto. Knip mantiene su sugerencia informativa previa sobre `.css`.

No se consultó producción ni se enviaron operaciones reales. La entrega permanece local, sin despliegue. Se demuestra progreso de una lectora verificada mientras otra está retenida; no se afirma todavía una reducción medida de latencia de adjudicación real.
