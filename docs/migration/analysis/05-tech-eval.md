# 05 — Evaluación técnica: Rust vs Go para los nuevos servicios

> Documento de decisión para el dueño del proyecto. Responde una sola pregunta: **si QvaApply
> se reescribe como servicios en un lenguaje compilado, ¿Rust o Go?** La recomendación se basa en
> benchmarks ejecutados localmente sobre el mismo hardware, en el dominio real del sistema y en
> las prioridades declaradas: velocidad de desarrollo/ejecución, mantenibilidad, escalabilidad y
> uso de memoria. Las cifras de la sección 2 son medidas, no estimadas.

---

## 0. Resumen ejecutivo

**Recomendación: Go como lenguaje principal para los nuevos servicios. No hacer un híbrido Rust+Go
en esta etapa.**

Con los pesos declarados por el dueño, la matriz de decisión da **Go 4.25 / Rust 3.50 (escala 1–5)**.
La ventaja de Rust es real pero se concentra en criterios que este sistema casi no ejercita:
en los microbenchmarks equivalentes Rust fue **2.9×–3.9× más rápido** y usó **3–4× menos memoria**,
pero la carga real es de decenas de peticiones por minuto acotadas por QvaPay (~25 listados/min):
el pipeline completo de decisión de una página de 100 ofertas cuesta **~1.4 ms en Go** y **~0.37 ms
en Rust**; incluso a 100× la carga actual, sería menos del 0.5% de un core. La latencia dominante es
la red hacia QvaPay (cientos de ms), no el CPU local.

Donde la diferencia sí muerde a diario es en el **ciclo de trabajo de una sola persona**: compilación
incremental medida de **59 ms en Go frente a 10.4 s en Rust** (build de release con `lto=thin`,
`codegen-units=1`), y un modelo de concurrencia (goroutines/channels/`context`) mucho más barato de
razonar para el perfil real del sistema: polling multi-cuenta, colas con backpressure, timeouts,
cancelación y reconciliación. Rust aportaría garantías de tipos y ausencia de GC que son valiosas
para dinero, pero a cambio de una curva de aprendizaje y una velocidad de entrega que, con un único
administrador, es el recurso más escaso del proyecto.

La recomendación es **condicional y reversible**: si el dueño ya domina Rust, o si el presupuesto de
memoria del VPS baja de ~250–300 MB para todo el stack, o si la carga deja de estar limitada por
QvaPay, la matriz se invierte (sección 3.3 y 7). Por eso el documento incluye qué haría cambiar la
recomendación y qué decisiones solo puede tomar el dueño.

---

## 1. Alcance, método y limitaciones

### 1.1 Qué se midió

Tres rutinas representativas del núcleo de QvaApply, implementadas dos veces (Go y Rust) con la
misma semántica, compiladas en `/tmp` y ejecutadas en la misma máquina:

1. **Decode de una página P2P** (`GET /p2p`): parsear el JSON de 100 ofertas con la forma de
   `P2pOffer` (`src/types.ts`) y validar UUID, tipo, moneda, importes positivos y estado.
2. **Pipeline de decisión completo** por página:
   - mediana de tasas (`median()` de `src/market-math.ts`),
   - coste efectivo y tasa efectiva con aritmética decimal (`outgoingFiatCost`),
   - redondeo conservador según índice configurado (`roundRateForIndex`: compras hacia arriba,
     ventas hacia abajo),
   - la política de riesgo de `src/core/risk-policy.ts` (`evaluateRisk`) con sus límites
     conservadores: importe por operación, exposición, volumen diario, operaciones simultáneas,
     antigüedad de cotización, margen mínimo, slippage, errores consecutivos, cooldowns y capital.
3. **Servicio HTTP mínimo** equivalente a un microservicio de lectura: `GET /health`,
   `GET /api/offers` (serializa la página de 100 ofertas en cada request) y `GET /api/decision`
   (ejecuta el pipeline de decisión y responde un resumen). Medido con un generador de carga en
   Go, loopback, HTTP/1.1 keep-alive, sin TLS.

Para cada binario se reporta: tiempo por página, bytes y número de allocations por página,
RSS pico del proceso (`VmHWM`), RSS en reposo y bajo carga del servidor, latencia p50/p99,
throughput, CPU consumida por request, tamaño de binario, tiempo de compilación en frío y
tiempo de recompilación incremental.

### 1.2 Hardware y toolchains

| Elemento | Valor medido |
|---|---|
| CPU | 12 cores, x86_64 (CachyOS) |
| RAM | 31 GB |
| Kernel | 7.2.9-2-cachyos |
| Rust | `rustc 1.99.0` / `cargo 1.99.0`, edition 2024 |
| Go | `go 1.27.1 linux/amd64` |
| Node (solo referencia) | `v25.9.0` |
| Docker | 29.9.0 disponible (no usado en las mediciones) |

Configuración de build de Rust: `opt-level=3`, `lto="thin"`, `codegen-units=1`, `panic="abort"`,
`strip="symbols"`. Configuración de build de Go: `-trimpath -ldflags "-s -w"`, `CGO_ENABLED=0`,
`GOGC` por defecto.

### 1.3 Fixture y definición exacta del workload

Fixture sintético determinista (semilla `20261112`) que imita una página real de QvaPay:
**100 ofertas, 61 132 bytes**, `sha256 = ea847bf0cd33f0deeb6a589c10ddd3ed787f1bcd32a848bc3ea8bb2faa20047a`.
Incluye `uuid`, `type` (`buy`/`sell`), `coin`, `amount`, `receive`, `status`, `offer_kind`,
`message` (a veces `null`), `tags`, `only_kyc`, `only_vip`, `owner_uuid`, `available_amount`
(número o string), `order_min`/`order_max` (string), `updated_at`/`created_at`, `User`, `Peer`,
`details` y `Orders` en algunas ofertas. Tasas alrededor de 538 CUP/QUSD con ±2% de ruido; importes
de 5 a 80 QUSD, de modo que los límites de riesgo producen una mezcla realista de aplicables y
bloqueadas.

Pseudo-código de la parte medida (idéntico en ambos lenguajes):

```text
warmup 500 iteraciones
medir 5000 iteraciones:
  page = json_decode(bytes)                     # W1 termina aquí
  ref  = median(receive/amount de las 100)      # W2 continúa
  por oferta:
    qusd        = amount (Decimal)
    fiatPerQusd = receive / qusd (Decimal)
    total       = qusd * fiatPerQusd + fee_fijo(5)
    effRate     = total / qusd
    escala      = effRate * 100
    redondeado  = buy ? ceil(escala) : floor(escala)
    rate        = redondeado / 100
    evaluar los límites de risk-policy (bloqueos) y slippage/errores/cooldowns (warnings)
    acumular contadores y un checksum de rate_cents
```

La aritmética es decimal en ambos casos (`shopspring/decimal` en Go, `rust_decimal` en Rust); no se
usa `float64` para el cálculo monetario, solo para el transporte del JSON de entrada, igual que hace
hoy el código TypeScript con `positiveNumber` + `market-math`.

### 1.4 Paridad de las implementaciones (control de validez)

Las dos implementaciones producen resultados idénticos:

| Comprobación | Rust | Go |
|---|---|---|
| Decode: checksum | `550000550000` | `550000550000` |
| Decide: checksum | `44506470112500` | `44506470112500` |
| Payload `/api/decision` | `applied=8, blocked=92, warnings=85, rate_cents=5380475` | idéntico |

Esto no demuestra que el benchmark sea la lógica de producción, pero sí que **ambos lenguajes
ejecutan exactamente el mismo algoritmo y los mismos datos**; las diferencias de tiempo y memoria
son atribuibles al lenguaje/runtime, no a una implementación distinta.

### 1.5 Limitaciones (lo que estos números no dicen)

- **Fixture sintético**, no una cassette real de QvaPay. La forma de los datos es fiel a
  `P2pOffer`, pero el coste de parseo de una respuesta real puede variar con campos adicionales.
- **Sin I/O real**: no hay TLS, ni latencia de red, ni Postgres, ni NATS, ni Telegram, ni web push.
  La parte medida es solo la fracción de CPU del sistema (la que un lenguaje puede mejorar).
- **Una sola máquina, loopback**, sin contención de red ni virtualización. Las cifras absolutas de
  latencia no son extrapolables a un VPS, aunque las **proporciones entre lenguajes** sí son
  indicativas.
- **Microbench de un solo hilo** para el pipeline; los servidores usan los 12 cores disponibles
  (Go: `GOMAXPROCS` por defecto; Rust: worker threads de tokio por defecto). No se probó con
  `GOMAXPROCS=1` ni con cargas de 10⁶ requests; el objetivo era medir el orden de magnitud, no
  encontrar el techo.
- **No se midió** `cargo check` (el comando del loop de desarrollo habitual, más rápido que
  `cargo build --release`), ni `go vet`, ni `go test -race`, ni el arranque en frío de un contenedor,
  ni imágenes Docker. Se indica explícitamente cuando un dato no fue medido.
- **Varianza**: se hicieron 3 corridas por workload y se reporta la mediana; el rango se incluye en
  la tabla. La máquina no estaba aislada (12 cores compartidos); las diferencias de menos del 10%
  no deben interpretarse como significativas.
- Los artefactos de benchmark se escribieron en `/tmp/qvaapply-tech-eval/` (fuera del repo). El
  `/tmp` del entorno de ejecución es efímero entre invocaciones; el fixture se puede regenerar con
  la semilla y los campos documentados en 1.3, y el hash permite verificar que es el mismo.

---

## 2. Evidencia empírica local

### 2.1 Microbenchmark del pipeline (5000 iteraciones medidas, mediana de 3 corridas)

| Métrica | Rust | Go | Ratio Rust/Go |
|---|---|---|---|
| W1 decode: tiempo por página | **231 µs** (214–236) | **671 µs** (635–671) | 2.90× más rápido |
| W1 decode: por oferta | 2.31 µs | 6.71 µs | |
| W2 decode + decisión: tiempo por página | **373 µs** (355–373) | **1 441 µs** (1 361–1 500) | 3.86× más rápido |
| W2: por oferta (100 ofertas) | 3.73 µs | 14.41 µs | |
| W1 allocations por página | 2 258 | 3 175 | |
| W1 bytes asignados por página | 248 148 (242 KB) | 171 774 (168 KB) | Go asigna ~30% menos bytes |
| W2 allocations por página | 2 264 | 18 907 | Go asigna 8.4× más objetos |
| W2 bytes asignados por página | 252 180 (246 KB) | 651 351 (636 KB) | Rust ~2.6× menos bytes |
| RSS pico del proceso (W2) | **3.0 MB** | **12.3–12.4 MB** | ~4.1× |
| Checksum de control | igual | igual | — |

Lectura: Rust gana en CPU y memoria pico de forma consistente, y el ratio crece con el trabajo
(2.9× en parseo puro, 3.9× cuando se añade aritmética decimal y política de riesgo). Go compensa
parte de la desventaja de CPU con un parser que asigna menos bytes totales, pero asigna muchos más
objetos (cada `decimal.Decimal` de `shopspring` envuelve un `big.Int`), lo que se traduce en más
trabajo del GC y más RSS pico.

**Contexto de escala**: 25 listados/min × 1.44 ms (Go) = **36 ms de CPU por minuto** (≈0.06% de un
core); en Rust serían ≈9 ms/min. Con 100× la carga actual, Go seguiría por debajo del 6% de un core.
El CPU no es el cuello de botella del sistema; el rate limit de QvaPay y la red sí.

### 2.2 Servicio HTTP mínimo: latencia, CPU y RSS (2000 requests medidas por escenario)

Escenario secuencial: 1 conexión keep-alive, 100 warmups + 2000 requests.
Escenario concurrente: 8 conexiones keep-alive, 100 warmups + 2000 requests (250 por worker).

| Métrica | Rust (axum + tokio) | Go (`net/http`) | Ratio |
|---|---|---|---|
| RSS en reposo (tras arrancar y una request) | **4 160 KB** | **10 104 KB** | 2.4× |
| RSS pico durante toda la prueba (`VmHWM`) | **5 348 KB** | **17 152 KB** | 3.2× |
| RSS después de carga secuencial | 4 336 KB | 14 036 KB | |
| `GET /api/offers` secuencial: p50 | **171 µs** | **598 µs** | 3.5× |
| `GET /api/offers` secuencial: p99 | **275 µs** | **878 µs** | 3.2× |
| `GET /api/offers` secuencial: throughput | 5 712 req/s | 1 658 req/s | 3.4× |
| `GET /api/offers` 8 conexiones: p50 | 244 µs | 1 071 µs | 4.4× |
| `GET /api/offers` 8 conexiones: p99 | 746 µs | 2 215 µs | 3.0× |
| `GET /api/offers` 8 conexiones: throughput | **28 459 req/s** | **7 235 req/s** | 3.9× |
| CPU por request (`/api/offers`, secuencial) | **0.12 ms** | **0.61 ms** | 5.0× |
| `GET /api/decision` secuencial: p50 / p99 | 263 µs / 451 µs | 1 067 µs / 1 654 µs | 4.1× / 3.7× |
| CPU por request (`/api/decision`) | **0.22 ms** | **1.28 ms** | 5.8× |
| Errores de carga | 0 | 0 | — |

Lectura: el orden se mantiene (Rust ~3–5× más rápido y ~3× menos memoria), pero todas las
magnitudes son irrelevantes para la carga real: la peor p99 medida en Go (2.2 ms) sería
despreciable frente a los cientos de milisegundos de una llamada a QvaPay. La diferencia de RSS
(≈10 MB por servicio) sí importa si se despliegan 5–8 servicios en un VPS pequeño, pero no en el
hardware actual de 31 GB. Para referencia: un proceso Node vacío (sin framework) medido en la misma
máquina ocupó **45.7 MB** de RSS en reposo; esto no es el monolito real (que además carga SQLite,
Telegram, scheduler, etc.), solo el piso del runtime actual.

### 2.3 Tamaño de binario y compilación

| Métrica | Rust | Go | Comentario |
|---|---|---|---|
| Binario del microbench (release, stripped) | **534 248 B (522 KiB)** | **3 109 024 B (3.0 MiB)** | 5.8× |
| Binario del servicio HTTP (release, stripped) | **1 121 984 B (1.07 MiB)** | **6 660 256 B (6.35 MiB)** | 5.9× |
| Descarga inicial de dependencias (una vez) | **57.8 s** (axum+tokio+serde+decimal; ~95 MB de registry) | ~1–2 s (proxy Go, `shopspring/decimal`) | red, no CPU |
| Compilación en frío del servicio HTTP | **24.6 s** | **9.1 s** (con `GOCACHE` vacía, recompilando stdlib) | 2.7× |
| Recompilación incremental del servicio HTTP | **10.4 s** | **59 ms** | **~176×** |
| Compilación en frío del microbench | 17.4 s | 4.9 s | |
| Recompilación incremental del microbench | 6.4 s | 47 ms | ~137× |

Notas de honestidad:

- La "compilación en frío" de Rust se midió con el registry de crates ya descargado (`cargo fetch`
  aparte, 57.8 s la primera vez). Un checkout nuevo del repo pagaría `fetch` + build: ~82 s en Rust
  frente a ~11 s en Go (9.1 s de build + descarga de módulos de segundos), siempre en esta máquina y
  con estas dependencias.
- Los 10.4 s de recompilación incremental de Rust corresponden a `cargo build --release` con
  `lto="thin"` y `codegen-units=1`. El loop de desarrollo con `cargo check` es más rápido, pero **no
  fue medido**; aun así, el orden de magnitud (segundos vs decenas de milisegundos) se mantiene.
- Con árboles de dependencias más cercanos al servicio real (por ejemplo `sqlx` con macros,
  `async-nats`, `teloxide`, `web-push` en Rust, frente a `pgx`, `nats.go`, `gotgbot`, `webpush-go` en
  Go), el tiempo de Rust crece más rápido que el de Go. **No se midió** ese escenario extendido; se
  menciona como riesgo cualitativo en la sección 5.
- Las cifras de binario son con `strip`/`-s -w`. Sin strip, Rust quedaría en unos pocos MB y Go en
  ~8–10 MB; la conclusión relativa no cambia.

### 2.4 Qué importa y qué no de estos resultados

| Diferencia medida | ¿Importa para QvaApply? | Por qué |
|---|---|---|
| Rust 2.9–3.9× más rápido en CPU | **Poco** | La carga está limitada por QvaPay (~25 listados/min); el CPU local es <0.1% de un core. |
| Rust p99 0.28 ms vs Go 0.88 ms | **Nada** | La latencia de red a QvaPay es de cientos de ms. |
| Rust ~3× menos RSS | **Algo** | 10 MB/servicio vs 4 MB/servicio suma en un VPS pequeño; en 31 GB es irrelevante. El monolito Node actual ocupa más que cualquiera de las dos opciones. |
| Rust ~6× menos bytes de binario | **Poco** | Ambas caben en una imagen `scratch`/distroless; no es un criterio operativo aquí. |
| Go ~176× más rápida la recompilación incremental | **Mucho** | Un solo administrador, 24/7, cambios frecuentes: es el coste que se paga todos los días. |
| Go ~6 meses menos de curva de aprendizaje | **Mucho** | El recurso escaso es el tiempo del dueño, no el CPU. |

---

## 3. Matriz de decisión

### 3.1 Pesos, notas y justificación

Escala de notas: 1 = muy desfavorable, 3 = aceptable, 5 = muy favorable. Pesos declarados por el
dueño (prioridad: velocidad y mantenibilidad por encima de rendimiento y memoria); suman 1.00.

| # | Criterio | Peso | Rust | Go | Justificación de la nota |
|---|---|---|---|---|---|
| 1 | Velocidad de entrega (time-to-service y flujo de cambio) | 0.25 | 2 | 5 | Go: sintaxis pequeña, concurrencia trivial para I/O, compilación incremental de 59 ms, sin curva de ownership. Rust: borrow checker y async con lifetimes añaden fricción en cada cambio; 10.4 s por rebuild incremental medido. |
| 2 | Mantenibilidad (un operador, 24/7, evolución) | 0.25 | 3 | 5 | Go: código explícito y aburrido, fácil de retomar meses después, tooling único (`go vet`, `gofmt`, `-race`, `pprof`). Rust: excelente para equipos con experiencia, pero más conceptos (ownership, Pin, Send/Sync, error crates) que una sola persona debe sostener durante años. |
| 3 | Seguridad de tipos / correctitud (dinero, invariantes) | 0.15 | 5 | 3 | Rust: enums exhaustivos, newtypes sin coste, ausencia de nils, `Result` obligatorio, imposibilidad de data races en safe Rust. Go: tipos nominales y `gofmt`, pero nils, `error` ignorable, ausencia de sum types y `float64` por defecto en JSON; la seguridad depende de disciplina y tests. |
| 4 | Rendimiento / latencia | 0.10 | 5 | 3 | Medido: 2.9–3.9× en pipeline y 3–5× en HTTP; irrelevante para la carga real, pero es la ventaja objetiva de Rust. |
| 5 | Memoria | 0.10 | 5 | 3 | Medido: 4.2 MB vs 10.1 MB en reposo; 5.3 MB vs 17.2 MB pico. Go tiene GC y slack de heap; Rust es determinista. A la escala del VPS actual, ambos son holgados. |
| 6 | Escalabilidad operativa (despliegue, observabilidad, concurrencia) | 0.05 | 4 | 4 | Empate: binario único y estático en ambos; Go gana en cross-compile, pprof y OpenTelemetry; Rust gana en footprint y arranque predecible. La escalabilidad real está limitada por QvaPay, no por el lenguaje. |
| 7 | Ecosistema (librerías críticas) | 0.05 | 4 | 5 | Ambos cubren todo lo necesario (tabla en 5.4), pero en Go las librerías son más estables y "de una sola manera"; en Rust algunas (JetStream, Telegram) son igual de capaces pero con más superficie async y churn de versiones. |
| 8 | Curva de aprendizaje | 0.05 | 2 | 5 | Go se aprende en días para este dominio; Rust exige semanas/meses para escribir async idiomático con confianza. |

### 3.2 Cálculo

Puntuación = Σ (peso × nota).

| Criterio | Peso | Rust | Go |
|---|---|---|---|
| Velocidad de entrega | 0.25 | 0.50 | 1.25 |
| Mantenibilidad | 0.25 | 0.75 | 1.25 |
| Seguridad de tipos/correctitud | 0.15 | 0.75 | 0.45 |
| Rendimiento/latencia | 0.10 | 0.50 | 0.30 |
| Memoria | 0.10 | 0.50 | 0.30 |
| Escalabilidad operativa | 0.05 | 0.20 | 0.20 |
| Ecosistema | 0.05 | 0.20 | 0.25 |
| Curva de aprendizaje | 0.05 | 0.10 | 0.25 |
| **Total** | **1.00** | **3.50** | **4.25** |

### 3.3 Sensibilidad: qué pesos cambiarían el resultado

La ventaja de Go no es un dogma: depende de los pesos. Dos variantes calculadas con las mismas notas:

| Variante | Pesos (entrega/mant./tipos/perf/memoria/ops/eco/aprend.) | Rust | Go | Ganador |
|---|---|---|---|---|
| Base (la de arriba) | 25/25/15/10/10/5/5/5 | 3.50 | **4.25** | Go |
| VPS con poca RAM (< ~1 GB para todo el stack, prioridad a memoria y perf) | 15/20/15/15/25/5/2.5/2.5 | **4.00** | 3.85 | Rust (muy ajustado) |
| Dueño con experiencia real en Rust (curva y fricción dejan de penalizar) | 25/25/15/10/10/5/5/5, notas Rust ajustadas a 4/4/5/5/5/4/4/5 y Go a 4/4/3/3/3/4/5/3 | **4.40** | 3.65 | Rust |
| Sin restricción de memoria y con plazo amplio | 25/25/15/10/10/5/5/5 (idéntica a base) | 3.50 | **4.25** | Go |

Conclusiones de sensibilidad:

1. **Con el perfil declarado (prioridad velocidad y mantenibilidad, VPS actual de 31 GB), Go gana con
   margen.** Rust necesitaría que la memoria/peso pase de 20% a ~40–50% del total para empatar.
2. **Si el dueño ya sabe Rust, la recomendación se invierte.** La curva de aprendizaje y la fricción
   de build son los dos criterios donde Rust pierde más puntos; eliminados, sus ventajas de tipos,
   memoria y CPU lo ponen por delante.
3. Si el VPS se reduce a ~1 GB o menos para todo el stack, Rust vuelve a ser competitivo, aunque el
   ahorro (≈6–10 MB por servicio) rara vez justifica por sí solo la pérdida de velocidad de entrega.

---

## 4. Comparación por categoría

### 4.1 Concurrencia y backpressure

Contexto QvaApply: polling multi-cuenta con colas independientes por política (listas, lecturas
críticas, apply, edit, cancel, chat), ventanas durables de 20 s/60 s, una sola aplicación por ronda,
decisión financiera serializada, y chat de autocancelación cada 15 s.

- **Go**: goroutines baratas, `context` con cancelación/deadline propagada, `chan` bufferizado como
  cola con backpressure natural (bloquea al productor), `errgroup`, `sync.Mutex` simple. El
  scheduler de Go multiplexa goroutines sobre threads sin que el código lo note. Es exactamente el
  modelo mental de "N tareas I/O concurrentes con límites".
- **Rust**: `tokio` con `spawn`, `JoinSet`, `mpsc`/`watch`/`broadcast`, `Semaphore` para límites,
  `select!` para carreras (timeout vs respuesta). Es igual de capaz y más determinista, pero exige
  gestionar `Send + 'static`, no retener locks a través de `await`, y ser consciente de
  **cancellation safety** (un `select!` o un timeout puede dropear un future de mutación a mitad de
  camino; en dinero eso hay que diseñarlo explícitamente con `tokio::spawn` + join o estados
  durables, igual que el actual "intención monetaria antes de mutar").

Veredicto: **empate técnico en capacidad, Go más simple de mantener.** Para QvaApply, los patrones
ya están resueltos en TypeScript (colas por política, chequeos antes de dispatch); trasladarlos a
Go es casi mecánico. En Rust requieren más atención, y un error de cancellation safety en `apply`
es exactamente el tipo de bug que este sistema no puede permitirse.

### 4.2 HTTP y gRPC

- **Go**: `net/http` de stdlib, routers ligeros (`chi`, `echo`), middleware trivial; `grpc-go`
  oficial, estable, con generación de código sencilla. `httptest` para tests de contrato sin abrir
  puertos.
- **Rust**: `axum` (sobre `hyper`/`tower`), `actix-web`, `poem`; `tonic` para gRPC (muy maduro,
  codegen con `prost`/`tonic-build`). En los benchmarks `axum` se comportó muy bien (5.7k–28.5k
  req/s loopback) y el código fue corto, pero el ecosistema `tower`/`tower-http` añade capas de
  tipos que ralentizan la iteración.

Veredicto: **Go favorito**, no por capacidad sino por simplicidad operativa y de mantenimiento.

### 4.3 SQL (Postgres + SQLite)

- **Go**: `pgx` es el mejor cliente Postgres que existe en cualquier lenguaje (batch, `COPY`,
  tipos ricos, `pgtype.Numeric` para dinero); `database/sql` como abstracción si se quiere. SQLite:
  `modernc.org/sqlite` es **puro Go, sin CGO**, lo que simplifica builds y cross-compile; `mattn/go-sqlite3`
  existe si se acepta CGO. Transacciones y `journal_mode=WAL` se dominan igual que en Node.
- **Rust**: `sqlx` (async, sin ORM, con macros que verifican queries en compilación contra una DB
  real o un cache `.sqlx`; también `query_as` en runtime sin macros), `tokio-postgres` directo,
  `diesel` (sync, ORM). SQLite: `rusqlite` con `bundled` (compila SQLite en C, añade segundos al
  build) o el driver de `sqlx`.

Para QvaApply, el riesgo no es el driver sino la **pérdida de transaccionalidad monolítica** al
repartir la base en servicios (ver `02-persistence.md`). Ambos lenguajes ofrecen transacciones
`SERIALIZABLE`/`REPEATABLE READ`, `FOR UPDATE` y reintentos; Go tiene más ejemplos canónicos de
patrones de outbox/idempotencia. La ventaja de `sqlx` (queries verificadas en compilación) es real
para dinero, pero exige `DATABASE_URL` en build o mantenimiento del cache offline, lo que complica
CI y el flujo de un solo operador.

Veredicto: **Go ligeramente favorito** (pgx + SQLite puro Go); Rust perfectamente capaz.

### 4.4 NATS / JetStream

QvaApply ya usa JetStream (`@nats-io/jetstream`) para sincronización de hunting.

- **Go**: `nats.go` es el cliente **oficial y de referencia** de NATS, con JetStream completo
  (`js.Publish`, consumers durables, ack policy, deduplicación por `Nats-Msg-Id`), reconexión
  integrada. Es el que usa el propio servidor NATS en sus tests.
- **Rust**: `async-nats` es oficial, cubre JetStream y reconexión, pero es más joven, con API async
  y algunas operaciones de administración menos ergonómicas. Funciona en producción, pero no tiene
  la veteranía de `nats.go`.

Veredicto: **Go favorito**; Rust es viable con más trabajo de integración.

### 4.5 SSE y webhooks

QvaApply consume SSE de QvaPay y webhooks firmados (deduplicación persistente, evaluación
inmediata, drenaje separado de oportunidades y cambios de estado).

- **Go**: `bufio.Scanner` + `context` para SSE; `http.Client` para webhooks entrantes; lectura de
  streams con timeouts y backoff es estándar. Verificación HMAC con `crypto/hmac`.
- **Rust**: axum soporta SSE de primera (`axum::response::Sse` con `futures::Stream`); parsers con
  `eventsource-stream` o manual; `hmac`/`subtle` para firmas. La tipificación del parser es una
  ventaja real, pero manejar streams con cancelación y reconexión es más código.

Veredicto: **empate funcional**, Go algo más simple.

### 4.6 Telegram

- **Go**: `telebot` v4 o `gotgbot`, mantenidos, con soporte de inline keyboards, long polling y
  webhooks. El bot actual usa `grammy` (TS); el traslado conceptual es directo.
- **Rust**: `teloxide` es maduro, fuertemente tipado (dispatcher, `Dialogue`), con excelente
  documentación; probablemente el mejor bot de Telegram en Rust. A cambio, async y tipos complejos.

Veredicto: **empate**, con ventaja de simplicidad para Go y de seguridad de tipos para Rust.

### 4.7 Web push y criptografía (AES-GCM, VAPID)

- **Go**: stdlib `crypto/ecdsa`, `crypto/aes`, `cipher.NewGCM`; `webpush-go` (de la organización
  `web-push-libs`, la misma del ecosistema actual) implementa VAPID y payload cifrado. Cero CGO.
- **Rust**: crate `web-push` (misma organización), `aes-gcm` (RustCrypto) o `ring`, `p256` para
  VAPID. Criptografía de altísima calidad y sin GC; más dependencias que resolver.

Veredicto: **empate**; ambos cubren el caso sin riesgo de bloqueo.

### 4.8 Dinero y decimales (evitar floats)

- **Go**: `github.com/shopspring/decimal` (arbitrario, sobre `big.Int`; división con precisión 16
  por defecto, `DivRound` explícito; JSON marshal como string). Alternativas: `govalues/decimal`
  (más rápido, sin alloc), o modelar **minor units como enteros** (`int64` céntimos/micro-CUP), que
  es la opción más estricta. Riesgo específico de Go: si el struct de transporte usa `float64` (lo
  más natural), la conversión a decimal reintroduce error binario; hay que decodificar con
  `json.Number` o strings, o definir un tipo `Money`.
- **Rust**: `rust_decimal` (96 bits, 28–29 dígitos significativos, aritmética sin allocations,
  `checked_*` disponibles); `bigdecimal` o `apd` si se necesita precisión arbitraria; `Decimal`
  implementa `Ord` y serde con features. Patrón recomendado: `struct Money(Decimal)` con
  operaciones checked y prohibición de `f64` en el módulo.

Veredicto: **Rust tiene mejores mimbres** (sin GC, sin alloc en la aritmética, newtypes baratos,
enums para estados), pero **Go es suficiente** si se prohíbe `float64` en el dominio y se cubre con
tests de redondeo (los tests actuales de `market-math` y `rate-rounding` son el patrón a portar).
La seguridad del dinero depende más de un buen harness de paridad y de modelar minor units con
disciplina que del lenguaje.

### 4.9 Migraciones de esquema

- **Go**: `golang-migrate`, `atlas`, `goose`; migraciones SQL embebidas con `embed.FS`; muy
  integrado con pgx.
- **Rust**: `sqlx migrate` (embebidas y ejecutadas al arrancar), `refinery`; también SQL plano.

Veredicto: **empate**; Go tiene más herramientas y ejemplos para el patrón "migración al arrancar,
checksum y bloqueo".

### 4.10 Observabilidad

- **Go**: `pprof` en stdlib (CPU, heap, goroutine, mutex, block), `expvar`, `prometheus/client_golang`,
  `otel-go` (estado estable), logs con `slog`. Es el mejor perfil de diagnóstico por defecto de los
  dos.
- **Rust**: `tracing` + `tracing-subscriber` (excelente, estructurado), `metrics` +
  `metrics-exporter-prometheus`, `opentelemetry-rust` (avanzando), `tokio-console` (muy útil para
  async). El profiling requiere `perf`/`flamegraph`/`pprof` y es menos "un comando".

Veredicto: **Go favorito** para un operador único: `pprof` y `-race` son difíciles de sustituir.

### 4.11 Testing (tablas, fuzz, property-based)

Los 718 tests actuales (95 archivos) son el activo más valioso a preservar; ver `04-tests.md`.

- **Go**: `testing` con table-driven tests idiomáticos, `httptest`, `testing.F` (fuzzing nativo
  desde 1.18), `go test -race` (detector de data races de primera clase), `rapid`/`gopter` para
  property-based, `testcontainers-go` para Postgres real.
- **Rust**: `#[test]`, `cargo nextest`, `proptest`/`quickcheck` (property testing más maduro y
  expresivo que Go), `cargo-fuzz` (libFuzzer), `insta` (snapshots), `loom` para modelos de
  concurrencia. El compilador ya elimina clases enteras de test (nils, data races).

Veredicto: **paridad con matices**: Rust mejor en property-based/fuzz; Go mucho mejor en detector
de races y en simplicidad de tests de integración HTTP.

### 4.12 Despliegue, binarios y Docker

- Ambos producen **un binario estático** fácil de meter en `scratch`/distroless. Medido: 1.07 MiB
  (Rust) vs 6.35 MiB (Go) para el servicio HTTP.
- **Go**: cross-compile trivial (`GOOS=linux GOARCH=arm64 go build`) sin toolchain extra; `CGO_ENABLED=0`
  garantiza binario estático. Ideal para VPS x86_64 y para builds en CI sin sorpresas.
- **Rust**: binario estático requiere target `x86_64-unknown-linux-musl` (o imagen glibc); con
  `rusqlite`/`openssl` puede necesitar C toolchain. Más control, más configuración.

Veredicto: **Go favorito** para operación de un solo administrador; Rust perfectamente desplegable
con `FROM scratch` y `strip`.

### 4.13 Estabilidad del ecosistema

- **Go**: promesa de compatibilidad de Go 1.x, stdlib estable, módulos con proxy y sumdb; el código
  de hace 5 años sigue compilando. Para un proyecto que debe vivir años con mantenimiento mínimo,
  es una ventaja estructural.
- **Rust**: ediciones y `cargo` estables, pero el ecosistema async evoluciona rápido (aunque `tokio`
  1.x y `axum` son estables); churn de crates y MSRV variables. `rustc` tiene releases cada 6
  semanas; en la práctica es estable, pero exige más disciplina de versiones.

Veredicto: **Go favorito**.

### 4.14 Tiempos de compilación (resumen medido)

| | Rust | Go |
|---|---|---|
| Cold build servicio HTTP | 24.6 s (+57.8 s de fetch la primera vez) | 9.1 s (con cache vacío) |
| Incremental servicio HTTP | 10.4 s | 59 ms |
| Cold build microbench | 17.4 s | 4.9 s |
| Incremental microbench | 6.4 s | 47 ms |

Con `sqlx` macros, `async-nats` y `teloxide`, el cold build de Rust crecería de forma notable
(no medido); el de Go también crecería, pero desde una base mucho menor. **Ventaja clara de Go**,
y es el criterio con más impacto diario para una sola persona.

### 4.15 Uso de memoria típico por servicio (medido)

| Estado | Rust (axum+tokio+serde+rust_decimal) | Go (`net/http`+encoding/json+shopspring) |
|---|---|---|
| En reposo, tras arrancar | 4.2 MB | 10.1 MB |
| Pico bajo carga (2000 requests) | 5.3 MB | 17.2 MB |
| Microbench (pipeline 100 ofertas) | 3.0 MB | 12.3 MB |
| Node vacío (referencia, sin framework) | — | 45.7 MB |

Para 6 servicios nuevos: ~25–32 MB idle en Rust, ~60–103 MB pico en Go. Ambos son mucho menores que
el monolito Node actual (que además de runtime carga SQLite, Telegram y scheduler). En un VPS de
2 GB, cualquiera de los dos deja margen; en uno de 512 MB, Rust es más cómodo.

### 4.16 Tabla resumen por categoría

| Categoría | Ventaja | Comentario |
|---|---|---|
| Concurrencia/backpressure | Go (simplicidad) | Rust más determinista pero con cancellation safety a mano. |
| HTTP/gRPC | Go | Ambos capaces; Go más simple de mantener. |
| SQL (Postgres/SQLite) | Go (leve) | pgx y SQLite puro Go; sqlx aporta checks en compilación. |
| NATS/JetStream | Go (leve) | `nats.go` es el cliente de referencia; `async-nats` es oficial y viable. |
| SSE/webhooks | Empate | Go algo más simple. |
| Telegram | Empate | `teloxide` muy bueno; Go más directo. |
| Web push/VAPID/crypto | Empate | Ambos con librerías de la organización web-push-libs. |
| Decimales/dinero | Rust | rust_decimal sin alloc y newtypes; Go suficiente con disciplina. |
| Migraciones | Empate | Ecosistema Go más amplio. |
| Observabilidad | Go | pprof + `-race` difíciles de igualar para un operador único. |
| Testing | Empate (matices) | Rust mejor property-based; Go mejor races e integración. |
| Despliegue/binarios | Go | Cross-compile trivial; Rust también con musl. |
| Estabilidad de ecosistema | Go | Compatibilidad 1.x y stdlib. |
| Compilación | Go | 176× en incremental; 2.7× en frío. |
| Memoria | Rust | 2.4–3.2× menos RSS medido. |

---

## 5. Riesgos por lenguaje para ESTE sistema

### 5.1 Riesgos compartidos (independientes del lenguaje)

1. **Reescribir un sistema que mueve dinero real.** El riesgo principal no es Go vs Rust, sino la
   migración en sí: doble ejecución, doble gasto, reservas huérfanas, mutaciones inciertas mal
   reconciliadas. Mitigación: arnés de paridad con golden fixtures (`04-tests.md`), shadow mode,
   corte con kill switch, y no reescribir todo de una vez.
2. **No existe SDK oficial de QvaPay en Go ni en Rust.** El cliente HTTP, el manejo de 429/timeout,
   la clasificación de errores, la idempotencia disponible y el rate limit (~25 listados/min, 20 s
   entre `edit`/`cancel`, ventana de 2 `apply`/60 s) hay que reimplementarlos en cualquiera de los
   dos. Es el mismo esfuerzo en ambos; el código TypeScript de `src/qvapay.ts` es la especificación.
3. **Pérdida de la transaccionalidad de SQLite**: al separar servicios, las garantías que hoy da una
   única base se convierten en sagas/outbox/idempotency keys. Es un problema de diseño, no de
   lenguaje.
4. **Paridad de tests**: 718 tests y 15.8k LOC de tests son el contrato; cualquier lenguaje debe
   pasar el harness antes de producción.

### 5.2 Riesgos específicos de Go

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `float64` accidental en dinero (JSON por defecto, literales) | Pérdida de céntimos, redondeos distintos | Prohibir `float64` en paquetes de dominio; decodificar con `json.Number`/strings; tests de redondeo con golden fixtures; lint que detecte `float64` en `internal/money`. |
| Nil pointer / nil map / interfaz nil | Pánico en runtime, potencialmente en un handler financiero | `go vet`, `staticcheck`, tests de caminos tristes, revisión de `if x != nil`; evitar punteros innecesarios. |
| Errores ignorados (`_ =`, `err` sombreado) | Mutación perdida o reintento incorrecto | `errcheck`/`golangci-lint` con `errcheck`, patrones explícitos, tests de fallo. |
| Ausencia de sum types (`RiskDecisionKind` como string) | Estados inválidos representables | Tipo enumerado + `switch` exhaustivo por convención + tests de tabla; no confiar en strings sueltos. |
| Goroutine leaks / bloqueos sin `context` | Servicio que se degrada en silencio | `context` en toda llamada, `errgroup`, tests con `goleak`, pprof de goroutines. |
| Data races | Corrupción de estado concurrente | `go test -race` obligatorio en CI. |
| `decimal.Div` con precisión por defecto (16 dígitos) | Diferencias de último dígito vs TS | Usar `DivRound` con escala explícita y comparar contra fixtures generados desde TS. |
| Orden no determinista de mapas | Firmas/idempotency keys inconsistentes | Ordenar claves antes de serializar; tests. |

### 5.3 Riesgos específicos de Rust

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Cancellation safety** en `select!`/timeouts (dropear un future a mitad de una mutación) | Mutación enviada sin intención durable → doble gasto | Mutaciones en tareas `spawn` con join y estado durable; prohibir `select!` alrededor de llamadas que mutan dinero. |
| `Decimal` con overflow/underflow (96 bits) | Pánico o valor erróneo | `checked_mul`/`checked_div`, `overflow-checks=true` también en release para rutas de dinero, tests de límites. |
| Async con lifetimes/`Send`/`Pin` | Fricción diaria, código difícil de revisar | Mantener el núcleo puro y síncrono; async solo en adaptadores; `tracing` para diagnóstico. |
| `sqlx` macros exigen DB o cache `.sqlx` en build | CI/build más complejo para un solo operador | `SQLX_OFFLINE=true` con cache versionado, o `query_as` en runtime. |
| Churn de crates / MSRV / dependencias transitivas | Mantenimiento a años vista | Fijar versiones, `cargo-deny`/`cargo-audit`, pocas dependencias. |
| Compilación lenta e incremental de 10 s | Coste diario de iteración | `cargo check` en el loop, perfiles de dev más rápidos (`lto=off`, `codegen-units=16`), workspace dividido. |
| Pánicos en tareas async se pierden | Fallo silencioso | `JoinHandle` monitoreado, `panic=abort` solo si el proceso entero debe reiniciarse, `tracing` en panic hook. |
| Ecosistema async menos uniforme | Integración de NATS/Telegram/web push con más código | Elegir crates oficiales, encapsular tras traits propios. |

### 5.4 Disponibilidad de librerías críticas

| Necesidad | Go | Rust | ¿Bloqueo? |
|---|---|---|---|
| Cliente HTTP/JSON | stdlib `net/http`, `encoding/json` | `reqwest`/`hyper`, `serde_json` | No |
| Postgres | `pgx` (excelente) | `sqlx`/`tokio-postgres` | No |
| SQLite | `modernc.org/sqlite` (puro Go) | `rusqlite` (bundled) / `sqlx` | No |
| NATS/JetStream | `nats.go` (oficial) | `async-nats` (oficial) | No |
| Telegram | `telebot`, `gotgbot` | `teloxide` | No |
| Web push/VAPID | `webpush-go` | `web-push` | No |
| AES-GCM/cripto | stdlib | `aes-gcm`, `ring` | No |
| Decimal | `shopspring/decimal`, `govalues` | `rust_decimal`, `bigdecimal` | No |
| Migraciones | `golang-migrate`, `atlas`, `goose` | `sqlx migrate`, `refinery` | No |
| Observabilidad | `pprof`, `otel-go`, `prometheus` | `tracing`, `opentelemetry-rust` | No |
| Property-based/fuzz | `rapid`, `testing.F` | `proptest`, `cargo-fuzz` | No |

No hay una librería crítica **ausente** en ninguno de los dos. La diferencia es de madurez y de
"cantidad de código que hay que escribir para integrarla".

---

## 6. Recomendación

### 6.1 Lenguaje principal: **Go 1.27**

Justificación en una frase: **Go obtiene 4.25/5 con los pesos del dueño porque el sistema está
limitado por QvaPay y por el tiempo de una sola persona, no por el CPU; Rust gana los criterios que
este sistema casi no ejerce.**

Refuerzos concretos:

- Carga real: ~25 listados/min ⇒ el pipeline completo cuesta ~36 ms de CPU por minuto en Go
  (medido). La ventaja de CPU de Rust no cambia ningún SLA.
- Memoria: ~10–17 MB por servicio en Go es mucho menos que el monolito Node actual y cabe de sobra
  en el VPS; Rust ahorraría ~6–12 MB por servicio, un ahorro real pero no decisivo.
- Mantenibilidad: recompilación incremental de 59 ms frente a 10.4 s; un solo toolchain, un solo
  `go.mod`, `gofmt`, `go vet`, `-race`, `pprof`.
- Concurrencia: el modelo de goroutines/channels/`context` mapea directamente a los patrones que ya
  existen (colas por política, backpressure, timeouts, cancelación, serialización de decisiones).
- Ecosistema: `pgx`, `nats.go`, `webpush-go`, `telebot`/`gotgbot`, `shopspring/decimal`,
  `modernc.org/sqlite`, `golang-migrate`; todo lo necesario, de forma estable.
- Riesgo controlable: los peligros de Go (float, nils, errores ignorados) se neutralizan con
  disciplina, linters y el arnés de paridad; los peligros de Rust (cancellation safety, async
  lifetimes, compile times) afectan más al día a día de esta persona.

### 6.2 ¿Conviene un componente híbrido (núcleo en Rust y resto en Go)?

**No en esta etapa.** Razones:

1. El "núcleo" que se beneficiaría de Rust es pequeño y puro: `risk-policy.ts` (401 LOC) +
   `market-math.ts` (114 LOC) + decimales. Portarlo es barato en cualquiera de los dos lenguajes;
   el valor de tipos de Rust no compensa el coste de una frontera extra.
2. Un híbrido implica: dos toolchains en CI, dos runtimes en el VPS, un contrato gRPC/JSON que
   versionar y testear, observabilidad doble y cambio de contexto para una sola persona. Es el tipo
   de complejidad que este proyecto no necesita con la carga actual.
3. La seguridad de tipos del núcleo se puede aproximar en Go con `Money` como tipo propio, enums
   para `DecisionKind`, prohibición de `float64` y tests de paridad. No es equivalente a Rust, pero
   cubre el 90% del riesgo real.
4. Si en el futuro el perfil cambia (sección 7), el camino **sin reescritura** es extraer el núcleo a
   un sidecar Rust con gRPC y golden tests. Eso solo tiene sentido cuando el resto esté en Go y
   exista el arnés de paridad.

### 6.3 Orden de migración sugerido (coherente con 01–04)

1. Arnés de paridad cross-language y fixtures dorados (`04-tests.md`), incluida la cassette de
   QvaPay con 429/timeout/respuesta ambigua.
2. Portar primero lo **puro y determinista** a Go: `market-math`, `risk-policy`, `apply-budget`,
   `liquidity-plan`, tipos y redondeos. Property-based tests + golden fixtures.
3. Persistencia a Postgres por servicio (`02-persistence.md`) manteniendo el outbox/idempotencia;
   migración de datos ensayada en staging.
4. Adaptadores: QvaPay (HTTP, rate limits, idempotencia), Telegram, NATS/JetStream, web push.
5. Shadow mode con replay de eventos reales antes de cualquier corte; luego corte con kill switch.
6. El dashboard React/Vite puede quedarse en Node/TS durante toda la migración; no es necesario
   reescribirlo para validar el backend.

### 6.4 Sobre "migrar a microservicios"

La recomendación de lenguaje no debe arrastrar una decisión de arquitectura. Para un operador único
y esta carga, un **monolito modular en Go** (paquetes `internal/` con fronteras claras y puertos,
uno o dos procesos) obtiene casi todo el beneficio de una migración a Go con una fracción del coste
operativo de k8s/múltiples servicios/Postgres por servicio. Los microservicios se justifican aquí
solo si hay necesidad de aislar fallos o escalar un componente concreto; el rate limit de QvaPay y
la operación de una sola persona son límites más duros que cualquier ventaja de escalado.

---

## 7. Qué haría cambiar la recomendación

La recomendación es **Go por defecto**, pero se invierte total o parcialmente si ocurre alguna de
estas condiciones (ordenadas por probabilidad/impacto):

1. **El dueño ya domina Rust** (o está dispuesto a invertir 3–6 meses de rampa). Con las notas
   ajustadas de la sección 3.3, Rust pasa a 4.40 vs 3.65 de Go. Es el factor más determinante y no
   se puede evaluar sin preguntar al dueño (sección 8).
2. **Presupuesto de memoria del VPS < ~1 GB para todo el stack** o necesidad de ejecutar 8–10
   procesos en hardware muy ajustado. Rust ahorra ~6–12 MB por servicio (medido) y tiene arranque
   más predecible; con memoria como peso 25–30%, Rust gana por poco.
3. **La carga deja de estar limitada por QvaPay**: por ejemplo, si se abren muchas cuentas/monederos
   con rate limits propios, o aparece un componente CPU-bound (backtesting, simulación, cálculo
   intensivo de rutas de liquidez) con millones de operaciones. Ahora mismo no ocurre; medido, Go
   tiene ~4 órdenes de magnitud de headroom.
4. **Requisito duro de latencia determinista / sin pausas de GC** (por ejemplo, un componente que
   deba responder en <1 ms p99 bajo carga alta o con SLA contractual). No es el caso hoy: la red
   domina.
5. **Requisito de verificación formal o auditoría de invariantes** donde `Kani`/`Miri`/model checking
   de Rust aporten valor demostrable. No es requisito actual.
6. **Necesidad de reutilizar código Rust existente** o de una librería crítica que solo exista en
   Rust. No es el caso: la tabla 5.4 no muestra bloqueos.
7. **Cambio de mantenedor**: si el proyecto pasa a un equipo con experiencia Rust y procesos de
   revisión formales, Rust sube; si pasa a contratistas, Go gana por mercado laboral.
8. **Un incidente real de dinero causado por un bug que Rust habría detectado en compilación**
   (nil, tipo, estado inválido). Elevaría el peso de "seguridad de tipos" y podría justificar
   migrar el núcleo a Rust. Hoy no hay evidencia de tal incidente en el material revisado.

Si se invierte la recomendación, el camino es **Rust en todo el stack nuevo**, no híbrido, para no
pagar dos ecosistemas.

---

## 8. Checklist de decisiones que dependen del dueño

Estas preguntas no las puede responder este análisis; cada una mueve la recomendación.

| # | Pregunta | Por qué importa | Si la respuesta es… |
|---|---|---|---|
| 1 | ¿Conoces Rust o Go? ¿Cuánto? | Es el criterio con más peso real (curva + fricción diaria). | Rust con experiencia → reconsiderar Rust (3.3); ninguno de los dos → Go por curva y mercado. |
| 2 | ¿Quién mantiene esto en 12–24 meses? | Mantenibilidad y bus factor de una persona. | Tú mismo sin experiencia Rust → Go. Equipo con Rust → Rust. |
| 3 | ¿Cuánta RAM/CPU tiene el VPS y cuál es el presupuesto mensual? | Memoria y coste operativo; también si Docker/k8s es viable. | <1 GB para todo → Rust gana por poco; ≥2 GB → irrelevante, Go. |
| 4 | ¿Qué plazo hay para el corte? | Velocidad de entrega (25% del peso). | Plazo corto (<3 meses) → Go o no migrar aún; plazo amplio → Rust entra en juego. |
| 5 | ¿Se acepta un periodo de shadow mode con doble ejecución? | Es la única forma segura de migrar dinero; condiciona el calendario. | No → no migrar a microservicios todavía. |
| 6 | ¿El dashboard React se queda en Node/TS o también se reescribe? | Alcance real del port; el frontend no gana nada con Rust/Go. | Se queda Node → menos trabajo, Go más viable. |
| 7 | ¿Hay historial de bugs de dinero/estado? | Si los hubo, el peso de "correctitud" sube y Rust gana terreno. | Sí, repetidos → considerar Rust para el núcleo. |
| 8 | ¿Se necesitan varios procesos/servicios o basta un monolito modular? | Microservicios multiplican el coste operativo de una persona. | Monolito modular → Go (o incluso seguir en TS si no hay motivo fuerte). |
| 9 | ¿Hay requisitos de auditoría/regulatorios o de latencia dura? | Pueden justificar Rust (determinismo, trazabilidad de tipos). | Sí, estrictos → Rust. |
| 10 | ¿El objetivo es técnico o también aprender un lenguaje? | Un objetivo de aprendizaje personal puede justificar Rust aunque la matriz diga Go. | Aprender Rust → hazlo en un sidecar/herramienta, no en el camino del dinero. |
| 11 | ¿Se puede contratar soporte/mantenedor externo? | Disponibilidad de mercado laboral. | Go tiene más oferta; Rust más cara. |
| 12 | ¿Cuánto se valora el ahorro de RAM frente al tiempo de entrega? | Es exactamente el trade-off de la matriz. | Prioridad RAM → Rust; prioridad entrega → Go. |

---

## 9. Anexo: reproducción y trazabilidad

- Fixture: `offers.json` de 100 ofertas, 61 132 bytes, semilla `20261112`,
  `sha256 ea847bf0cd33f0deeb6a589c10ddd3ed787f1bcd32a848bc3ea8bb2faa20047a`. Se regenera con un
  script Python de ~30 líneas (campos documentados en 1.3).
- Bench Go: módulo con `github.com/shopspring/decimal v1.4.0`; bench Rust: crates `serde 1`,
  `serde_json 1`, `rust_decimal 1`; servidores: Go `net/http` y Rust `axum 0.8` + `tokio 1`.
- Comandos de build usados: Rust `cargo build --release` (perfil documentado en 1.2); Go
  `go build -trimpath -ldflags "-s -w"` con `CGO_ENABLED=0`; carga con un generador en Go
  (`2000` requests, `100` warmups, concurrencia `1` y `8`, keep-alive).
- Todas las cifras de la sección 2 son medianas de 3 corridas por workload, salvo las de
  compilación (una corrida, con caches recreadas) y las de RSS (pico de proceso, `VmHWM` leído de
  `/proc/<pid>/status`). Los checksums de paridad y el payload de `/api/decision` se verificaron
  contra ambas implementaciones.
- Los artefactos (código, binarios, salidas) se generaron en `/tmp/qvaapply-tech-eval/`, fuera del
  repositorio, conforme a la restricción de la tarea.

---

*Documento: `docs/migration/analysis/05-tech-eval.md`. Análisis realizado el 2026-11-12 sobre el
monorepo QvaApply (22.8k LOC src, 15.8k LOC tests) en la máquina de trabajo del dueño.*
