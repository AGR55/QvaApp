# Pago desde la operación: datos verificados y rellenado de Transfermóvil

Continuación autorizada por el operador el 2026-11-03. La meta sigue siendo
iniciar el pago desde la propia compra y conservar su autorización final.

## Recorrido implementado

1. **Realizar pago** aparece en el detalle de compras tomadas elegibles de
   BANK_CUP, CLASICA y ETECSA. No equivale a marcar pagado.
2. `GET /api/mobile/operations/:uuid/payment-preview?order=…` exige Bearer de
   operador con alcance de acciones. Consulta perfil y oferta actuales; comprueba
   identidad, rol pagador, contraparte, mercado, moneda, estado processing,
   importe QUSD e importe fiat exactos. Una orden por rango usa sus propios
   importe, estado y tomador, nunca los del padre. No ejecuta mutaciones.
3. Se reconocen tarjeta y móvil solo en campos estructurados de la oferta,
   mediante nombres identificables. Se admite una tarjeta completa de 16 dígitos
   y un móvil cubano de 8 dígitos, con normalización de espacios, guiones y +53.
   Campos ambiguos, incompletos, enmascarados o con caracteres de control USSD
   impiden la preparación. No se extraen números de mensajes libres.
4. La hoja muestra importe fiat, moneda, tarjeta y móvil. El usuario elige banco
   de origen para CUP; la tarjeta de destino no selecciona el banco emisor.
5. Después de autorizar con el bloqueo de Android se vuelve a consultar la oferta.
   Una huella sobre identidad, contraparte, mercado, importe y destino detecta
   cambios y exige otra revisión. La preparación vence en dos minutos.
6. El usuario puede activar explícitamente **QvaApply · Rellenar Transfermóvil**
   en Accesibilidad. El servicio solo atiende ventanas del paquete Transfermóvil
   y la versión 1.260416. Navega al banco/formulario elegido y rellena destino,
   importe y móvil. Selecciona la moneda del importe donde existe ese selector.
   La cuenta de origen sigue requiriendo revisión/selección en Transfermóvil.
7. El operador confirmó posteriormente que el primer ACEPTAR del formulario
   bancario abre una confirmación separada. Para BPA, BANDEC, Metropolitano y
   Clásica, el asistente puede pedir esa primera revisión una sola vez, después
   de verificar los campos rellenados, título y ventana activos y ausencia de
   otro diálogo. Persiste el punto de parada antes de pulsar. Nunca acepta la
   confirmación siguiente. Si falta origen o clave, quedan para el usuario.
   ETECSA conserva el corte **antes de ACEPTAR**, porque la respuesta del operador
   se refería a bancos/Clásica. No introduce PIN, autentica bancos ni construye
   códigos USSD. Volver de la app no implica éxito del pago.

La autenticación bancaria se mantiene manual en esta fase. Según el operador,
la desconexión queda completada al terminar su USSD y el SMS de autenticación
puede demorarse pese a que la sesión ya esté abierta. No se interpretan timers
ni ausencia de SMS como prueba de conexión/desconexión. Automatizar esos códigos
y alcanzar un modal posterior requiere verificar primero qué paso envía a la red.

## Protección del recorrido

- Compras creadas por el propio usuario quedan excluidas hasta disponer de
  datos del vendedor propios de la orden: la tarjeta publicada por el creador
  podría ser la del propio pagador.
- La hoja no guarda tarjeta en caché de listados ni en el estado restaurable.
  Protege la ventana real frente a capturas. El traspaso al servicio se persiste
  cifrado, con vencimiento, y no lleva datos bancarios en extras del Intent.
- Antes de abrir Transfermóvil se guarda un bloqueo durable por oferta/orden.
  Un fallo, retorno o vencimiento no libera automáticamente un intento que pudo
  llegar a un formulario. Solo se libera tras declaración explícita de no pago
  y confirmación con Android. La falta de SMS no es evidencia de no débito.
- Cambiar servidor o token elimina el formulario pendiente. El servicio limita
  sus acciones a navegación, SET_TEXT y una única solicitud de revisión local
  bancaria; no reintenta esa solicitud ni acepta la confirmación posterior.
- El servicio comprueba todos los campos esperados antes de editar; una versión,
  formulario, diálogo o selector no reconocido detiene el asistente. Una selección
  de moneda no verificable detiene el recorrido antes de rellenar.
- No usa coordenadas, acciones globales, PIN guardados ni acceso a otras apps.
  Los diálogos de USSD/sistema no forman parte de sus ventanas permitidas.
- El cierre del formulario y el pago comercial conservan estados separados;
  se mantienen los comprobantes y acciones manuales existentes para conciliar.
- Solicitar la revisión local no prueba que un pago haya sucedido. El recorrido
  final del proveedor sigue pendiente de comprobar en un entorno sin débitos;
  la garantía del primer diálogo procede de la descripción del operador, no de
  haber pulsado botones financieros durante esta investigación.

## Evidencia y límites

Se inspeccionó el APK instalado de Transfermóvil y su entrada pública. Sus enlaces
`transfermovil://tm_compra_en_linea/action` y `https://transfermovil.app/action`
procesan pagos comerciales; no se usaron como contrato de transferencia personal.
El APK muestra además empaquetado de parámetros de servicios, por lo que no se
fabricaron secuencias USSD a partir de tablas parciales encontradas en Internet.
No se incorpora código de Transfermóvil al repositorio.

Se contrastaron en teléfono las etiquetas del menú, el formulario BPA y sus
IDs `input_cuenta`, `input_monto`, `input_phone_confirm` y
`spinnerTipoMonedaImporte`. ETECSA utiliza `input_gnumero` e `input_gmonto`, con
`input_gclave` reservado al usuario. Los restantes formularios se habían recorrido
sin enviar en la exploración inicial. No se introdujeron datos ni se pulsó
ACEPTAR. El selector de moneda puede ser una ventana emergente independiente;
el servicio consulta únicamente sus ventanas pertenecientes a Transfermóvil.

Durante la inspección el teléfono cambió a Telegram y se detuvo la navegación ADB
para no interferir. El asistente de accesibilidad real no se activó en el teléfono;
su recorrido completo sobre Transfermóvil está pendiente de una prueba controlada
de rellenado y primera revisión, sin aceptar la confirmación final.

El laboratorio incorpora **Probar pago desde una operación**, con las mismas
vistas de detalle y revisión y una salida ficticia. Su manifest elimina el servicio
de accesibilidad además de los permisos de red y SMS. No abre Transfermóvil al
simular; la variante sirve para revisar el recorrido sin afectar una cuenta.

El backend y la APK habitual siguen sin desplegarse/actualizarse. La instalación
separada del laboratorio permite probar los cambios sin activar pagos reales.

## Validación automatizada

### Decisión para la entrega 0.6.0

El usuario autorizó desplegar lo terminado tras revisar los cambios anteriores.
La release permite verificar los datos actuales de pago, pero no ejecutar el
rellenado pendiente de prueba real. El manifest release elimina PaymentFormService
y `PAYMENT_FORM_ENABLED=false` bloquea también el código. Debug mantiene el
asistente para validación controlada y lab sigue siendo una simulación aislada.
No se presenta este recorrido como probado de extremo a extremo.

- Servidor: 718 pruebas correctas, comprobación TypeScript y compilación correctas.
  Se ejecutó Node 25.9.0, fuera del rango declarado del proyecto; la validación
  sobre la versión Node 24 admitida sigue correspondiendo al entorno de CI.
- Android: 45 pruebas por variante debug/lab, lint debug/lab y compilaciones
  debug, lab y release. La salida release es unsigned; no se instaló en la app
  habitual ni se activó el servicio de accesibilidad real. Lint no reportó errores;
  conserva 31 advertencias por variante, ninguna en los archivos nuevos del
  asistente. La compilación final terminó correctamente en 2 min 31 s.
- Se instaló únicamente `com.qvaapply.sms.lab`, sin abrirla ni cambiar la app
  que el usuario estaba utilizando. El manifest lab carece de Internet, SMS y
  PaymentFormService; release no incluye las actividades del laboratorio.
- Estas comprobaciones no sustituyen la prueba controlada pendiente del servicio
  sobre el formulario y la primera confirmación del proveedor.
