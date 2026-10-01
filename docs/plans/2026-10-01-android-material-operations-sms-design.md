# Android: Material 3, operaciones y SMS de pago

Fecha: 2026-10-01. Diseño aprobado por el propietario.

## Objetivo

Convertir la APK privada de relay SMS en una app móvil operativa, con una interfaz
Material 3, consulta y acciones sobre operaciones, avisos prioritarios y
comprobación fiable de pagos por SMS. La app debe seguir siendo utilizable con
una conexión limitada y no debe repetir mutaciones monetarias inciertas.

## Alternativas valoradas

1. **Compose Material 3 estable (elegida).** Interfaz nativa actual y extensible.
   Medir tamaño de APK release frente a la versión actual; si el aumento resulta
   excesivo para la conexión, reconsiderar la biblioteca antes de instalarla.
2. Material Components para Views. Menor migración inicial, pero Google mantiene
   esta biblioteca sin nuevas funciones.
3. WebView de la web. APK potencialmente menor, pero peor experiencia en Android,
   conectividad intermitente y avisos nativos.

## Interfaz y datos

- Tres destinos: **Operaciones**, **Avisos** y **Ajustes/SMS**. Densidad compacta,
  estados y acciones inequívocos, indicadores de conexión y última actualización.
- Los mercados y sus nombres proceden de la configuración del servidor; no se
  limitan a BPA, Metropolitano y Clásica. Incluyen Bandec y nuevos mercados sin
  introducir una lista de tarjetas en la app.
- La lista de operaciones y avisos se alimenta de endpoints móviles limitados a
  los datos necesarios. Se conserva una copia local de lectura para mostrar el
  último estado sin conexión, claramente señalada como no actualizada.
- La app ofrece marcar pagado, confirmar recepción y cancelar, con confirmación
  explícita y protección local del dispositivo para acciones sensibles. Se usan
  credenciales de operador separadas de la credencial de recepción SMS, con
  revocación y registro de auditoría. Nunca se guarda la contraseña web en la app.
- Actualización rápida mientras está abierta. Los avisos con la app cerrada
  requieren un canal push nativo verificado en el Redmi; no se prometerá entrega
  instantánea hasta que ese canal exista y se pruebe.

## Recorrido SMS

- Quitar los tres campos de emisor. Los remitentes aceptados son `PAGOxMOVIL`
  para bancos y `ETECSA` para telefonía. Distinguir BPA, Metropolitano, Bandec,
  FINCIMEX y otros formatos conocidos por su encabezado; formatos desconocidos
  no provocan una acción automática.
- Comprobantes bancarios salientes: conservar el ID real de transacción,
  beneficiario enmascarado, importe, moneda, momento y remitente.
- SMS ETECSA saliente: extraer importe CUP y teléfono destinatario. No contiene
  ID de transacción. Generar una referencia interna estable, rotulada
  `SMS-ETECSA`, para cumplir el contrato `tx_id` de QvaPay; no representarla
  como referencia emitida por ETECSA.
- El servidor solo marca pagada una **única** operación elegible al comprobar
  importe, moneda, mercado ETECSA, teléfono de destino exacto en los detalles
  remotos, contraparte, estado remoto y ventana temporal. Las coincidencias
  ambiguas, incompletas, antiguas o fallidas pasan a revisión sin mutación.
- El SMS entrante «Usted ha recibido» es un evento distinto: no demuestra que
  se haya enviado un pago y nunca marca `paid`. Confirmar recepción/liberar
  escrow automáticamente queda fuera de esta fase.
- La cola local y la deduplicación del servidor persisten; la UI distingue
  «pendiente de envío», «aceptado por servidor», «asociado» y «revisión».

## Seguridad y errores

- HTTPS obligatorio; tokens cifrados en Android, con alcance mínimo y revocación.
- La fuente SMS no es prueba criptográfica: se exige emisor esperado, formato
  válido y comprobación de la oferta remota. No se envía texto bruto ni saldo.
- Una mutación incierta queda registrada para conciliación, sin reintento ciego.
  Las acciones manuales y automáticas comparten la misma disciplina de
  intención monetaria durable.
- Red caída: cola de SMS con reintentos; consultas con estado obsoleto visible;
  acciones explícitas nunca se confirman visualmente sin respuesta verificable.

## Verificación y despliegue

Añadir pruebas Android con los ejemplos reales y variantes negativas, pruebas
de contrato y emparejamiento en el servidor, pruebas de deduplicación y de
resultados inciertos. Ejecutar tests de ambas plataformas, build de APK debug y
release, medición de tamaño y prueba controlada en el Redmi. Desplegar el
backend compatible antes de actualizar la APK; no activar auto marcado ETECSA
en producción hasta validar una transacción pequeña end-to-end.
