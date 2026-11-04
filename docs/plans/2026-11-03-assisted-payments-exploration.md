# Pagos asistidos: exploración y propuesta pendiente de aprobación

Fecha: 2026-11-03. Estado original: investigación. El operador aprobó el enfoque
posteriormente; la entrega del simulador y sus límites están descritos en
`2026-11-03-assisted-payments-implementation.md` y
`2026-11-03-assisted-payments-verification.md`. Los pagos reales siguen sin habilitarse.

## Alcance y comprobaciones realizadas

El objetivo es preparar desde una operación de compra el pago fiat correspondiente,
dejando al operador la revisión y autorización final en el teléfono. La autorización
de esta investigación excluye transferencias, autenticaciones bancarias y envíos USSD.

Se inspeccionó por ADB el Redmi Note 8 Pro conectado, Android 16, y Transfermóvil
`cu.etecsa.cubacel.tr.tm`, versión 1.260416 (162). Solo se abrió la aplicación y
se recorrieron menús y formularios sin rellenarlos. No se pulsó ACEPTAR en ningún
formulario ni se introdujeron claves. Al terminar se regresó a Inicio y se retiró
el XML temporal del teléfono. No se instaló ninguna APK ni se modificó el código.

| Ruta inspeccionada | Campos y opciones visibles |
| --- | --- |
| BPA → Operaciones → Transferencia | Cuenta/tarjeta destino, monto, moneda, tipo de cuenta a operar, móvil a confirmar, omitir saldo en SMS |
| BANDEC → Operaciones → Transferencia | Cuenta/tarjeta destino, monto, tipo de cuenta a operar, móvil a confirmar, omitir saldo en SMS |
| Metropolitano → Operaciones → Transferir Efectivo | Cuenta/tarjeta destino, monto, moneda, tipo de cuenta a operar, móvil a confirmar, omitir saldo en SMS |
| MiTransfer → Operaciones → Transferir Efectivo → Clásica | Cuenta/tarjeta destino, monto, moneda, cuenta de origen, móvil a confirmar, compartir móvil, omitir saldo en SMS |
| Servicios → Operaciones → Transferir tu Saldo | Celular destino, clave, monto |

MiTransfer distingue transferencias de su monedero y transferencias Clásica.
No se comprobó la autenticación ni el número de dígitos exigido; los 4 dígitos
generales y 5 de BANDEC son información aportada por el operador, pendiente de
validar en el flujo correspondiente. No hacen falta claves reales para desarrollar
el simulador y las validaciones.

El paquete declara enlaces `transfermovil://tm_compra_en_linea/action`,
`https://transfermovil.app/action…` y recepción de texto compartido. Esto demuestra
que existen puntos de entrada, pero no acredita un contrato para transferencias
P2P ni permite inventar parámetros. No se invocaron estos enlaces.

## Hallazgos del proyecto

- Android es Kotlin/Compose. El detalle ya distingue compra como `side == "sell"`:
  ese campo expresa el lado de la oferta, no el rol financiero del operador.
- `MobileOperatorService.operations()` entrega importe QUSD, importe fiat (`receive`),
  mercado, estado, identidad oferta/orden y acciones; no entrega destino de pago.
- `P2pOffer.details` contiene datos remotos. La conciliación SMS ya consulta esos
  datos y exige identidad, estado, importe y contraparte coincidentes. Su extracción
  por nombres aproximados de campos no basta por sí sola para autorizar un destino
  saliente: ambigüedades deben bloquear la preparación.
- Hay conciliación para comprobantes bancarios y ETECSA saliente. ETECSA utiliza
  una referencia interna estable, no un ID bancario inventado.
- El manifiesto actual no pide CALL_PHONE ni declara un servicio de accesibilidad.
- Existen numerosos cambios previos en el checkout; esta investigación los conserva.

## Tres opciones

1. **App Android con adaptadores por banco/mercado (recomendada).** Revisión local,
   autenticación del dispositivo, datos frescos y entrega a un flujo verificado.
   Permite simulación aislada y control explícito del paso que envía a la red.
2. **Telegram como entrada a la app.** Botón con identificador opaco de operación;
   la app vuelve a consultar y validar. No transportar PIN, cuenta completa ni
   códigos ejecutables en enlaces. Útil como segunda fase, pero sigue necesitando
   el componente Android.
3. **Automatizar pantallas de Transfermóvil.** Puede reducir tecleo, pero depende de
   versión, banco, cuenta, permisos y cambios de interfaz. ADB sirve para laboratorio;
   no debe convertirse en dependencia del uso diario. Un servicio de accesibilidad
   permanente ampliaría mucho el acceso y requiere otra evaluación.

## Diseño propuesto

El botón se llamaría **Preparar pago** y aparecería solo en compras fiat elegibles.
No equivale a **Marcar pagado**. Primero se vuelve a consultar la operación exacta
(oferta y orden), confirmando rol pagador, contraparte, mercado, moneda, importe fiat,
destino único y estado. El banco/cuenta de origen se elige explícitamente: el mercado
CUP no determina de qué banco sale el dinero.

Una hoja muestra destino completo, importe y moneda, origen, móvil de confirmación
si corresponde y comisión únicamente si está verificada. La clave bancaria o ETECSA
se introduce localmente cuando haga falta: nunca pasa por Telegram, backend, logs,
portapapeles o enlaces. No guardar claves en la primera versión.

Después de la revisión y autenticación del dispositivo, el adaptador prepara el
flujo del proveedor. La meta de llegar directamente al modal USSD queda condicionada
a verificar que la solicitud previa no ejecuta el débito y deja una confirmación
manual real. Una confirmación creada por QvaApply no acredita esa garantía del banco.
Cada adaptador permanece deshabilitado para dinero real mientras falte esa evidencia.

Android documenta que ACTION_DIAL abre el marcador y requiere tocar Llamar;
ACTION_CALL inicia directamente la llamada. `sendUssdRequest` envía a la red,
requiere CALL_PHONE y entrega una respuesta mediante callback: su contrato no
promete mostrar un diálogo interactivo de confirmación. No elegirlo suponiendo
que garantiza el cartel final del operador.

El backend mantiene un intento durable por identidad exacta de operación. Una sola
preparación activa, vencimiento antes del envío y bloqueo ante cambios de destino,
importe o estado. Tras entregar una solicitud al flujo externo, cierre, timeout o
respuesta incierta dejan el intento pendiente de conciliación; nunca provocan
reenvío automático. Incluso si se informa cancelación, no asumir ausencia de débito
sin conocer en qué fase ocurrió. Coordinar dispositivos para evitar intentos
concurrentes y advertir que pagos manuales externos no pueden bloquearse desde aquí.

Abrir el marcador, regresar de Transfermóvil o aceptar una revisión local no marca
pagado. La evidencia de éxito procede de conciliación SMS compatible y no ambigua,
o del procedimiento manual existente con referencia. El estado del intento y el
estado comercial son independientes. Toda extensión conserva las garantías
existentes de conciliación; órdenes por rango requieren soporte explícito.

## Pruebas y fases propuestas

1. Prototipo debug con datos sintéticos y adaptador falso, sin permisos de llamada,
   sin Intents de telefonía y sin acceso a operaciones reales. Aceptar simula;
   cancelar cancela localmente. Probar todos los formularios y estados.
2. Pruebas de destino ambiguo/inválido, caracteres USSD inyectados, moneda incorrecta,
   decimales y unidades menores exactas, rol invertido, orden equivocada, datos
   desactualizados, doble toque, dos dispositivos, rotación, muerte del proceso,
   offline, timeout y SMS duplicado o de otra operación. Ningún caso debe enviar
   ni marcar pagado por inferencia. No asumir que SIM bancaria y SIM de datos son
   la misma; probar selección/cancelación de SIM y dispositivo sin telefonía.
3. Verificar el contrato de cada proveedor y la separación preparar/enviar/confirmar
   con documentación o infraestructura de prueba que no permita débitos. Si no hay
   sandbox, mantener simulación y entrega manual; no probar con códigos reales
   suponiendo que cancelar después evita un pago.
4. Cualquier prueba con dinero real, aunque sea de importe pequeño, requiere una
   autorización posterior específica: está fuera del alcance actual.

## Incertidumbres que siguen abiertas

- Secuencia USSD exacta y vigente por BPA, BANDEC, Metropolitano y Clásica.
- Punto exacto de débito y existencia de una confirmación cancelable por ruta.
- Contrato público de integración para transferencias personales en Transfermóvil.
- Sesión/autenticación, duración, SIM y comportamiento de diálogos en Android 16.
- Destino y moneda exactos de cada mercado y tratamiento de órdenes por rango.
- Condiciones y confirmación vigentes de transferencia de saldo ETECSA; no se
  ejecutó ningún código para verificarlas.

## Fuentes técnicas

- Android, intents de telefonía: https://developer.android.com/guide/components/intents-common#Phone
- Android, TelephonyManager.sendUssdRequest: https://developer.android.com/reference/android/telephony/TelephonyManager#sendUssdRequest(java.lang.String,%20android.telephony.TelephonyManager.UssdResponseCallback,%20android.os.Handler)
- Portal oficial de Transfermóvil: https://www.etecsa.cu/es/aplicaciones/transfermovil
- Evidencia local: menús y formularios de la versión instalada, inspeccionados sin envío.

Pendiente: aprobación del enfoque antes de implementar. Este documento es una
propuesta de investigación, no una garantía de integración ni un diseño aprobado.
