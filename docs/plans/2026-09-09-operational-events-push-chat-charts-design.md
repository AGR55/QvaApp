# Diseño: decisiones operativas, Push, chat seguro y gráficas resilientes

## Objetivo

Convertir cada evaluación relevante del mercado en un evento persistente y explicable, usar ese mismo registro para Auditoría, Telegram y Web Push, reducir bloqueos que no protegen capital y evitar cancelaciones automáticas cuando el usuario ya manifestó que pagará. Las gráficas deben alimentarse desde el escáner y funcionar aunque ninguna página haya consultado QvaPay.

## Arquitectura de decisiones

- SQLite será la fuente de verdad de los eventos operativos. Cada versión de una oferta candidata conservará mercado, lado, importes, tasa, referencia, resultado, todas las comprobaciones y su resolución.
- Una nueva observación de la misma oferta actualizará la versión vigente si su precio y decisión no cambian. Un cambio material de precio o razones creará una versión distinta.
- Descartar resuelve solamente esa versión. Otras ofertas, y futuras versiones de la misma oferta, permanecen consultables.
- Auditoría consultará estos eventos mediante un endpoint paginado y filtrable; no dependerá de la pequeña lista mixta incluida en la instantánea general.
- Telegram y Web Push serán consumidores independientes. Un fallo de entrega nunca hará fallar el escaneo ni ocultará el evento persistido.

## Política automática

1. Una oferta recibida en una lectura actual de la lista P2P tendrá como instante de cotización el momento de observación. Su fecha original de creación no la convierte en una cotización antigua.
2. Los rangos configurados de compra y venta son obligatorios. La desviación extrema respecto a la mediana sigue protegida por el límite configurable del mercado.
3. La comprobación de `maxSlippagePercent` se conserva como advertencia explicable, pero deja de duplicar el guardarraíl de mediana como bloqueo duro.
4. Los tiempos de espera de mercado y contraparte dejan de bloquear ofertas. La cuota de aplicación, los límites de exposición, concurrencia y capital siguen siendo obligatorios.
5. Permanecen como bloqueos duros: oferta propia, estado remoto incompatible, automatización desactivada, saldo o liquidez insuficientes, reserva mínima, máximo por operación, máximo diario, exposición global, concurrencia, mutación no resuelta y parada de emergencia.
6. Una candidata bloqueada se registra con todas sus comprobaciones y el escáner continúa inmediatamente con la siguiente candidata aplicable.
7. Las ofertas fuera del rango definido se contabilizan para analítica, pero no llenan la cola de revisión manual.

## Chat y cancelación segura

- Tras una aplicación automática para comprar QUSD, QvaApply enviará el saludo configurado y conservará la identidad del mensaje automático para excluirlo.
- Mientras una operación automática tenga cancelación pendiente, se leerá periódicamente su chat. Cualquier mensaje posterior escrito por la cuenta autenticada se interpretará como intervención del usuario y moverá la operación a `acknowledged`, eliminando `cancelAt`.
- El UUID del usuario se obtendrá del perfil autenticado y se almacenará solo en memoria caché. No se persistirá el texto del chat; únicamente la evidencia mínima de reconocimiento.
- Antes de cancelar por vencimiento se hará una comprobación final. Si el chat no puede comprobarse por mala conexión, se aplazará la cancelación y se emitirá un aviso, en vez de cancelar a ciegas.
- Telegram mantendrá el botón «Voy a pagar». La acción web equivalente estará disponible desde Operaciones; una notificación nativa abrirá esa vista, pero no ejecutará una mutación directamente.

## Notificaciones

- La cabecera tendrá un centro de notificaciones con estado de permiso y alta/baja explícita.
- Un service worker de alcance raíz entregará el evento a la página cuando esté visible y mostrará una notificación del sistema cuando no haya un cliente visible.
- Se notificarán ofertas bloqueadas revisables, aplicaciones automáticas confirmadas y operaciones cuya reconciliación sea incierta.
- El payload será mínimo y no contendrá credenciales, datos bancarios, referencias de pago ni texto de chat.
- Cada notificación enlazará a Auditoría u Operaciones mediante parámetros de URL. La aplicación respetará esos parámetros al cargar.
- Las suscripciones expiradas se retirarán y cada entrega tendrá deduplicación por evento y canal.

## Auditoría y experiencia web

- La cola tendrá contadores y filtros para pendientes, aplicadas, bloqueadas, descartadas y resueltas, además de paginación estable.
- Cada elemento mostrará motivos breves y un detalle con todas las comprobaciones, su valor observado, límite y carácter bloqueante o informativo.
- La pantalla diferenciará claramente carga inicial, actualización en segundo plano, error con datos locales y ausencia real de datos.
- Las acciones financieras volverán a validar el estado remoto y todas las protecciones duras antes de mutar.

## Gráficas

- El escáner guardará observaciones de mercado con una cadencia limitada, independientemente de que el panel esté abierto.
- La consulta mostrará una ventana móvil de 24 horas para evitar una gráfica vacía al cambiar de día.
- Los errores de lectura se mostrarán sin sustituirlos silenciosamente por una serie vacía. Un reintento no borrará la última serie válida.
- La prueba visual verificará que existe una serie SVG real tanto en escritorio como en móvil cuando el histórico contiene datos.

## Seguridad y verificación

- Todas las rutas de mutación Push y financieras requieren sesión, origen permitido, JSON y CSRF.
- Las pruebas cubrirán persistencia y paginación, aislamiento al descartar, advertencias no bloqueantes, protecciones duras, exclusión del saludo automático, reconocimiento por mensaje propio, aplazamiento ante fallo del chat, aislamiento de canales, service worker y alimentación del histórico por el escáner.
- La verificación se realizará con dobles de QvaPay y bases temporales. No se iniciará el proceso real ni se aplicarán ofertas reales.

## Referencias oficiales

- Lista P2P: https://www.qvapay.com/docs/p2p/list
- Aplicación a oferta y cuota: https://www.qvapay.com/docs/p2p/apply
- Chat P2P: https://www.qvapay.com/docs/p2p/chat
