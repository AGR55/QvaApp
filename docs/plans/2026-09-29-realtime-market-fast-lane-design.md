# Diseño: vía rápida para eventos P2P en tiempo real

## Objetivo

Reducir el tiempo entre la publicación o reapertura de una oferta P2P y el
intento de aplicación. Una oportunidad debe entrar en la vía rápida cuando el
capital correspondiente esté disponible y su tasa efectiva cumpla la
configuración del mercado. Las protecciones de consistencia monetaria siguen
siendo obligatorias; los límites conservadores pasan a ser advertencias.

## Fuentes y eventos

El stream SSE será la fuente de menor latencia y el webhook firmado continuará
como respaldo durable. El modo híbrido mantendrá además una reconciliación por
listado de baja frecuencia al reconectar, detectar una brecha o encontrar
entregas fallidas.

Los seis eventos documentados se incorporarán a una única bandeja durable:

- `p2p.created` y `p2p.reopened` añaden o actualizan una oferta y activan la
  evaluación urgente;
- `p2p.applied` y `p2p.cancelled` retiran inmediatamente la oferta del libro
  local y anulan trabajo local que todavía no haya enviado una mutación;
- `p2p.paid` y `p2p.completed` actualizan operaciones conocidas, el libro fiat,
  conciliaciones y notificaciones sin esperar al sondeo periódico.

La identidad durable incluirá evento, UUID y versión temporal del payload. Así
se deduplicará la misma entrega entre stream y webhook sin descartar una nueva
reapertura legítima del mismo UUID.

## Vía rápida

La recepción valida y persiste el evento antes de responder o programar trabajo.
Un drenador consume todos los eventos listos, aplica primero los eventos de
estado que invalidan ofertas y entrega las oportunidades vigentes al motor.

El camino urgente no esperará a un escaneo completo ni hará consultas remotas
que no sean necesarias para esa operación. Una compra de QUSD usará el fiat
declarado menos los compromisos locales; una venta de QUSD usará un saldo QUSD
reciente menos reservas. Si el saldo necesario no tiene una copia suficientemente
reciente, se refrescará una vez antes de aplicar.

Las evaluaciones pueden prepararse en paralelo, pero las mutaciones financieras
permanecen serializadas. Antes de llamar a QvaPay se crea una intención monetaria
durable y se vuelve a comprobar el capital reservado, el interruptor de
emergencia y el estado de la cacería.

## Política de velocidad

Una oferta queda bloqueada únicamente por condiciones necesarias para una
aplicación coherente:

- mercado y lado habilitados;
- oferta abierta, compatible y accesible para la cuenta;
- tasa efectiva dentro del máximo o mínimo configurado, incluida la comisión;
- fiat o QUSD suficiente después de compromisos y reservas;
- automatización activa e interruptor de emergencia apagado;
- ausencia de una mutación incierta que pueda duplicar exposición;
- idempotencia e intención monetaria durable.

Mediana, slippage, margen adicional, cooldowns, volumen diario, tamaño máximo,
número de operaciones simultáneas, revisión manual de límites y contador de
errores se conservarán como evidencia y advertencias, pero no impedirán una
aplicación que cumpla precio y capital.

Una entrega muy reciente usa la vía rápida. Una entrega antigua no consume a
ciegas el cupo limitado de `apply`: se valida mediante detalle o reconciliación
antes de intentar la mutación.

## Recuperación y observabilidad

El coordinador registrará por oferta los tiempos de recepción, persistencia,
inicio de evaluación, llamada a QvaPay y respuesta. Los resultados distinguirán
aplicada, ya tomada, precio, capital, elegibilidad, límite remoto, desconexión y
error interno.

Al conectar o reconectar el stream se solicitará una reconciliación acotada de
los mercados activos. Las entregas fallidas del webhook quedarán visibles y se
consultarán con credenciales de app para diagnosticar brechas sin convertir el
polling en la fuente principal.

## Compatibilidad y despliegue

Las operaciones existentes, las intenciones monetarias y la conciliación
conservan sus invariantes. Las tareas periódicas permanecen como red de
seguridad, pero los eventos actualizan primero el estado que ya transportan.

Las pruebas cubrirán deduplicación multicanal, reaperturas repetidas, los seis
eventos, drenaje de ráfagas, prioridad de invalidaciones, ausencia de lecturas
remotas innecesarias, serialización monetaria, política rápida, recuperación
tras desconexión y métricas de latencia. Antes de desplegar se ejecutará la
validación completa y después se comprobarán el stream, webhook y salud pública.
