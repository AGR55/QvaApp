# Entrega móvil 0.6.0 y protección de cacerías

Autorización: el operador pidió desplegar lo terminado, revisar cambios previos y
limpiar ramas obsoletas. El diagnóstico cifrado de producción y su artefacto en
GitHub se autorizaron explícitamente después de una primera denegación automática.

## Alcance revisado

La entrega parte de `4f3ea6ec9c686847b38813921d774a9065ae59ad`, producción actual,
en un worktree aislado. No promueve el historial divergente del workspace.
Incluye interfaz nativa pendiente, logos locales y avisos, imágenes de chat con
límites y bloqueo de envíos inciertos, exclusión de acciones manuales por UUID,
trazas sin referencias bancarias, corrección de estados y revisión actualizada
de datos para pagar. Conserva los contratos de clientes anteriores.

El rellenado de Transfermóvil no se considera terminado: su prueba completa
sigue pendiente. La APK release elimina PaymentFormService y compila
`PAYMENT_FORM_ENABLED=false`; solo permite revisar datos y pagar manualmente.
Debug conserva el asistente experimental, lab conserva la simulación sin red.
La release firmada usa la misma clave privada existente, versión 0.6.0 / código 8.

Se incorporan diagnósticos de conectividad y tres consultas de insights que
habían quedado en ramas anteriores. Se conserva `cup.svg` de producción, aunque
el workspace lo había eliminado: todavía es un recurso público válido para otros
clientes. Los bocetos de marca de octubre permanecen locales, sin efecto runtime.
No se publica caché Python ni material privado de firma/vinculación.

La propuesta de priorizar capital propio (PR #24) sigue pendiente y se conserva:
modificaría el comportamiento cooperativo y no es necesaria para esta entrega.
Las otras ramas solo se retiran después de comprobar su integración o archivar
su historial. El bundle local de respaldo conserva referencias antes de limpiar.

## Cacerías y despliegue

Los lectores, presupuesto de listados, feed, saldo QUSD, scheduler de cacerías,
coordinador cooperativo y registros de arranque/cierre coinciden con producción.
No se cambian límites, precios, mercados, pausas ni credenciales. Los cambios de
TradingEngine se limitan a acciones manuales y refresco acotado del catálogo.
Las colas y throttles upstream permanecen iguales; el transporte de aplicación
no recibe la instrumentación destinada a acciones manuales.

Compose conserva el mismo servicio y volumen. Se amplía el plazo de cierre
ordenado de 10 a 90 segundos para que el handler existente pueda drenar trabajo
en vuelo. El despliegue hace backup antes del cambio y conserva su rollback.
Hay una interrupción breve del único proceso durante el reinicio; no se promete
ausencia de oportunidades perdidas durante esa ventana ni mejora de latencia.
Los servicios de Sync y los demás contenedores no se despliegan con esta entrega.

Diagnóstico previo: workflow `41747814527`, release `4f3ea6e`, contenedor saludable;
compra y venta activas, modo hybrid, paused=false, refresh_enabled=true. Se
conserva una copia cifrada en GitHub y el detalle descifrado solo en temporal
privado local. La comparación posterior debe comprobar configuración, salud,
progreso del feed y errores nuevos, sin ejecutar transacciones de prueba.

## Validación

- Node 24.22.1: `pnpm check` correcto, 95 archivos de pruebas, TypeScript, knip,
  builds servidor/web, compresión y comprobación de secretos. La sesión anterior
  contó 718 casos individuales bajo Node 25; esta entrega se valida en Node 24.
- Nueve pruebas Python de recursos correctas. Se quitó un recuento fijo de iconos
  que había quedado desactualizado al agregar el adjunto; se conservan las
  comprobaciones de contenido, origen local y formato de todos los iconos.
- Pruebas de despliegue y sintaxis Bash correctas después del plazo de cierre.
- Android: 45 pruebas debug y 45 lab correctas; lint sin errores (31 advertencias
  por variante); compilaciones debug, lab y release firmada correctas. Se verificó
  el manifest combinado: PaymentFormService existe solo en debug, y la constante
  de release es false. La compilación terminó correctamente en 3 min 5 s.

La evidencia posterior al despliegue se añadirá tras completarlo. No se envían
pagos, mensajes a contrapartes ni aplicaciones de prueba a ofertas reales.
