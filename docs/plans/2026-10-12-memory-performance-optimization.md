# Optimización de memoria y respuesta del panel

## Diagnóstico

En la VPS, QvaApply tenía un RSS de unos 259 MiB y un máximo histórico de
1.603 MiB. Docker mostraba unos 201 MiB de uso activo; la memoria total usada
por la VPS era aproximadamente 1.072 MiB, incluyendo los otros servicios.
Estos valores se refieren a medidas distintas y no deben confundirse con la
caché de archivos recuperable del sistema.

La base contenía 146.625 revisiones de configuración, con 336.329.748 bytes de
JSON. `localSnapshot()` verificaba toda esa cadena mediante `.all()` en cada
lectura, materializando todos los textos y realizando los hashes en el hilo de
las cacerías. Además, `syncFiatFromQva()` llamaba a `updateBalance()` por cada
mercado, y este guardaba una revisión aun cuando el saldo no cambiaba.

La ruta de archivos del panel usaba lectura síncrona del archivo completo y
calculaba su hash incluso para respuestas 304. Los recursos JavaScript no tenían
versiones comprimidas preparadas, y Nginx solo tenía activada la compresión
predeterminada de HTML.

## Cambios

- Evitar revisiones y reescrituras por sincronizaciones con saldos idénticos.
  Comparar con la configuración persistida, conservando los cambios reales del
  libro fiat y la trazabilidad de las acciones del operador.
- Leer la cadena por filas y verificarla en un worker con conexión SQLite de solo
  lectura. La primera verificación recorre toda la cadena; después comprueba solo
  las revisiones añadidas. Una generación actualizada por triggers invalida el
  prefijo ante cambios, borrados o reemplazos históricos.
- Mantener una sola comprobación concurrente, mostrar el estado pendiente sin
  declarar una alteración y reintentar cada 30 segundos. Cerrar el worker al cerrar
  Store. El motor mantiene sus intervalos y rutas de aplicación.
- Servir los recursos estáticos por streaming y con ETags débiles basados en los
  metadatos del archivo. Resolver 304 y HEAD sin cargar el cuerpo.
- Generar Brotli y gzip en la compilación, negociar la codificación y conservar
  `Vary`, caché y sus versiones por contenido. CSS con nombre versionado usa
  también caché inmutable.
- Reutilizar la lectura de intenciones sin resolver dentro del snapshot.
- Migrar a v27 con backup previo. Conservar toda la historia; no compactar ni
  eliminar registros operativos en producción.

## Mediciones y verificación

La reproducción local usa 146.625 revisiones sintéticas de unos 2,3 KiB cada una.
No contiene credenciales ni operaciones reales.

| Medida | Antes | Después |
| --- | ---: | ---: |
| RSS máximo del proceso de prueba | 670,5 MiB | 104,2 MiB |
| Retraso del temporizador del hilo principal | 1.267,9 ms | 2,5 ms |
| Primera verificación completa | 1.267,4 ms | 1.118,7 ms, en worker |
| Verificación siguiente sin cambios | recorrido completo | 0,25 ms, cero filas |

Estas son medidas del historial sintético, no del proceso completo en producción.
El script reproducible es `node --expose-gc scripts/benchmark-config-integrity.mjs`
tras `pnpm build:server`.

El archivo principal del panel ocupa 378.408 bytes sin comprimir, 116.919 bytes
con Brotli y 122.994 bytes con gzip. Las gráficas bajan de 458.514 a 120.267 bytes
con Brotli. La compresión se realiza en CI; no consume CPU de las cacerías.

Las pruebas cubren sincronizaciones sin cambios, cambios reales de saldo,
verificación incremental, alteraciones, reemplazos y borrados históricos,
negociación de compresión, `q=0`, ETags, 304 y HEAD. Se mantienen las pruebas
existentes de latencia y de ofertas flexibles.

`pnpm check` pasó los 65 archivos de pruebas, tipos, análisis estático,
compilación y comprobación de secretos. La verificación en Chromium pasó para
escritorio y móvil, con los recursos comprimidos.
