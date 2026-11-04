# Rediseño móvil QvaApply 0.5.0

Integración: 29 de octubre de 2026. VersionCode 7. Sin commits, despliegues,
credenciales leídas ni transacciones financieras reales. Se utilizó la
aplicación Kotlin/Compose existente, sin nuevas dependencias de producción.

## Resumen por fase

### 1. Sistema visual — implementado
- Escala 4/8 dp, padding compacto, radios 8/12/16, superficies sin degradados.
- Tema claro/oscuro; Android 12+ usa color dinámico en modo Sistema.
- 35 pictogramas y la máscara de notificaciones redibujados outline.
  Volver, comprar, vender, operaciones y enviar usan chevrons abiertos.
- Logos originales CUP, Tropical, Clásica, QUSD, ETECSA y Zelle se empaquetan
  desde public durante el build. Los dos SVG contienen PNG; se extraen completos,
  sin red, cambios de color o recorte. Los códigos desconocidos usan banco outline.
- Nueve pruebas Python verifican assets, ausencia de fuentes remotas, outline,
  contorno de chat y geometría de chevrons. Se revisaron iconos renderizados.
- Pendiente: contraste, tipografía ampliada y composición de pantallas en teléfono.

### 2. Navegación, listas, avisos y ajustes — implementado
- Barra principal con búsqueda local y campana, sin logo, sección, spinner de
  conexión ni textos conectado/desconectado/conectando.
- Operaciones: filas consecutivas, divisor fino, logo, importes, estado y fecha.
  El detalle conserva acciones y copia de ID en sheet wrap-content.
- Avisos: swipe con salida y colapso animados, deshacer agrupado y botón accesible.
  Ocultación local persistente por vinculación, compartida con contador e Inicio.
  No acusa recepción en servidor ni suprime otros canales.
- Ajustes: interruptor Notificaciones, persistido entre reinicios. Desactivar
  silencia inmediatamente y elimina notificaciones visibles de QvaApply; un
  worker solicita la baja del registro push con red y backoff. Reactivar registra
  nuevamente y respeta el permiso y canal Android. QvaPay y SMS no se modifican.
  La preferencia inicial permanece activada; el usuario puede desactivarla.
- Pendiente: comprobar gesto, animación, accesibilidad y switch con FCM real.

### 3. Operación y conversación — implementado con límites de contrato
- Sin pestaña independiente de Mensajes en producción. La conversación se abre
  desde la operación; las notificaciones conservan la identidad oferta/orden.
  Al volver se recuperan detalle y estado guardado de la lista.
- Adjuntos recibidos conservan su referencia, muestran placeholder outline local
  y cargan de forma asíncrona mediante proxy autenticado. Caché privada cifrada.
- Envío multipart: selector, corrección EXIF, compresión previa, límite local
  1 MiB, máximo 1000×1000 y objetivo 512 KiB. GIF seleccionado se vuelve imagen
  estática JPEG. Progreso Android-servidor y espera upstream separados.
- Borrador/adjunto se conservan; intentos durables deduplican reintentos
  confirmados. Un envío incierto no se repite automáticamente.
- La API oficial SÍ permite enviar imágenes. No documenta un ejemplo no nulo
  de image ni su autenticación/origen. La descarga restringe host/ruta/tipo,
  bloquea redirects y URLs arbitrarias. Referencias privadas, CDN no verificados,
  relativas, firmadas o GIF entrante quedan con placeholder. No se promete
  compatibilidad con orígenes no documentados sin un ejemplo autorizado.
- Pendiente: verificar imágenes reales y selección/compresión/progreso en móvil.
  Backend y APK deben actualizarse juntos. Detalle en [chat-images.md](chat-images.md).

### 4. Red, acciones y medición — implementado; medición real pendiente
- Sin red, las acciones manuales muestran snackbar Sin conexión y conservan
  datos y borradores. El polling evita red ausente y aplica backoff hasta 80 s.
- Las operaciones se publican sin esperar resultados de avisos/overview/SMS.
- Estado local por acción: pendiente, confirmada o fallida; no se falsifican
  pagos, liberaciones ni saldos. Se conserva bloqueo durable ante incertidumbre.
- Exclusión antes del primer await, revalidación tras preflight y guards de
  recepción. Sin reintentos automáticos monetarios. El bloqueo en memoria no
  sustituye un lease distribuido para varios procesos escritores.
- Android: conexión 10 s, lectura monetaria 55 s. Fastify mantiene inactividad
  general 10 s; acciones autorizadas/validadas y subida autorizada tienen socket
  60 s. Recepción total 60 s, sin ampliar JSON de 10 KB. Nginx ya usa 60 s.
- Trazas correlacionadas separan cola, throttle y upstream completo, además de
  preflight/persistencia y transporte Android. Los observadores no cambian el
  resultado y no guardan tokens, cuerpos, referencias ni URLs.
- Medición simulada local, 20 muestras por acción, con 8 ms de preflight y 12 ms
  de gateway inyectados: total paid p50 23.327 / p95 25.122 ms; received p50
  23.689 / p95 26.968 ms. NO son cifras QvaPay ni una mejora antes/después.
- Pruebas adicionales separan cola bloqueada, throttle y cuerpo demorado (20 ms
  inyectados cada uno), pérdida de conexión y contextos concurrentes.
- Pendiente: atribuir latencias reales entre app, backend y QvaPay durante una
  acción legítima autorizada. Nunca se ejecutó una operación para obtener datos.
  Más detalle en [backend-operation-actions-measurements.md](backend-operation-actions-measurements.md).

## Validación integrada

- Typecheck y compilación servidor/web: aprobados.
- Suite completa Node: 79 archivos aprobados, incluida la prueba de
  presupuesto HTTP y las regresiones de chat, pagos y órdenes flexibles.
- JVM Android: 28 pruebas aprobadas, cero fallos y cero errores.
- Assets Python: 9 pruebas aprobadas.
- Compilación Android y APK de depuración: aprobadas con SDK 35 recuperado.
  Lint: cero errores y 28 avisos, incluyendo APIs deprecadas y barreras de
  persistencia síncrona. Se verificaron dentro de la APK los seis logos locales.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`, versión 0.5.0 / 7.
  SHA-256: `41061660c3cd31da391b7322d55ed51642204620365f89e4f4261a3c243a8312`.
- Runtime disponible Node 25.9.0; el proyecto exige Node 24. Repetir en CI Node 24.
- No hay teléfono ni emulador conectado. NO se declara pasada una prueba visual
  o de red throttled/offline de extremo a extremo en Android. Las simulaciones
  de transporte y del clasificador no sustituyen esa verificación.

## Criterios de aceptación

| Criterio | Estado y evidencia |
| --- | --- |
| Mercados y QUSD locales, sin DB/red visual | Implementado; generación y tests de recursos |
| Sin triángulos de flecha, degradados o pictogramas rellenos | Implementado; XML/tests y revisión de iconos |
| Icono de avisos completo | Contorno/padding corregidos; pendiente revisar dispositivo |
| Escala y padding simétricos | Implementado; pendiente auditoría visual/fuente ampliada |
| Barra sin logo/sección con búsqueda | Implementado, incluida pantalla Avisos |
| Sin textos conectado/desconectado/conectando | Comprobación estática de fuentes principales |
| Acción offline con aviso coherente | Guard y snackbar implementados; falta prueba real Android |
| Filas con divisor y chat contextual | Implementado; navegación compilada |
| Sheet de alto de contenido | Implementado; falta comprobar teléfono pequeño/teclado |
| Imágenes visibles y envío | Implementado para contrato local; orígenes reales sin verificar |
| Chat vacío sin logo | Icono outline y texto breve |
| Avisos por swipe | Implementado con animación/deshacer; pendiente gesto real |
| Informe pagado/liberar | Incluido, simulación y trazas; cifras de producción pendientes |
| Red lenta y sin conexión | Pruebas simuladas; verificación móvil E2E pendiente |

## Decisiones y despliegue

- Se evolucionó Compose; no se reescribió la app ni se rediseñó el portal web.
- No hay swipes financieros. Descartar aviso no significa resolver conciliación.
- Un estado incierto necesita verificación; no hay botón de reenvío ciego.
- No se descargan logos/iconos al ejecutar; faltantes desconocidos usan fallback.
- Los seis logos conocidos están presentes. ETECSA/Zelle ya eran archivos sin
  seguimiento al iniciar; deben incluirse al preparar un commit o checkout limpio.
- Se conservó la eliminación previa de public/icons/cup.svg y las carpetas de
  marca preexistentes. No se leyó ni cambió la firma privada.
- La APK de depuración no se debe instalar sobre una release de firma distinta.
  Para actualizar la instalación privada se requiere generar la release con
  su misma clave. No se instaló ni publicó ningún APK.

## Prueba manual pendiente en teléfono

1. Abrir con datos cacheados, activar modo avión y buscar/filtrar: no deben
   borrarse filas ni aparecer indicadores permanentes.
2. Intentar actualizar, enviar o confirmar: snackbar Sin conexión; referencia,
   texto, adjunto y selección deben conservarse.
3. Con backend sintético y red limitada, validar chat con imágenes, subida,
   progreso, interrupción y consulta de envío sin duplicarlo.
4. Deslizar varios avisos y deshacer; comprobar contador/Inicio y reinicio.
5. Desactivar Notificaciones, reiniciar y enviar push de prueba: no mostrarlo.
   Reactivar con permiso denegado/canal bloqueado y con permiso concedido.
6. Revisar claro/oscuro, fuente grande, teléfono pequeño y sheet con teclado.
   Las pruebas de red/acciones no deben usar operaciones financieras reales.

## Archivos modificados o añadidos

Se excluyen los cambios previos del usuario y salidas generadas/ignoradas.

```text
.github/workflows/android-build.yml
.gitignore
android/README.md
android/THIRD-PARTY-NOTICES.md
android/app/build.gradle.kts
android/app/src/debug/java/com/qvaapply/sms/PreviewActivity.kt
android/app/src/main/AndroidManifest.xml
android/app/src/main/java/com/qvaapply/sms/ChatImages.kt
android/app/src/main/java/com/qvaapply/sms/ChatMessagingService.kt
android/app/src/main/java/com/qvaapply/sms/ChatScreens.kt
android/app/src/main/java/com/qvaapply/sms/MainActivity.kt
android/app/src/main/java/com/qvaapply/sms/MobileApi.kt
android/app/src/main/java/com/qvaapply/sms/NetworkStatus.kt
android/app/src/main/java/com/qvaapply/sms/PrecisoScreens.kt
android/app/src/main/java/com/qvaapply/sms/PrecisoTheme.kt
android/app/src/main/java/com/qvaapply/sms/SecureSettings.kt
android/app/src/main/java/com/qvaapply/sms/ToolsScreen.kt
android/app/src/main/res/drawable/ic_chat_notification.xml
android/app/src/main/res/drawable/ph_arrow_clockwise.xml
android/app/src/main/res/drawable/ph_arrow_down_left.xml
android/app/src/main/res/drawable/ph_arrow_left.xml
android/app/src/main/res/drawable/ph_arrow_up_right.xml
android/app/src/main/res/drawable/ph_arrows_left_right.xml
android/app/src/main/res/drawable/ph_bank.xml
android/app/src/main/res/drawable/ph_bell.xml
android/app/src/main/res/drawable/ph_caret_right.xml
android/app/src/main/res/drawable/ph_chart_bar.xml
android/app/src/main/res/drawable/ph_chat_circle_dots.xml
android/app/src/main/res/drawable/ph_check_circle.xml
android/app/src/main/res/drawable/ph_clock_counter_clockwise.xml
android/app/src/main/res/drawable/ph_coins.xml
android/app/src/main/res/drawable/ph_copy.xml
android/app/src/main/res/drawable/ph_credit_card.xml
android/app/src/main/res/drawable/ph_crosshair.xml
android/app/src/main/res/drawable/ph_device_mobile.xml
android/app/src/main/res/drawable/ph_dots_three_vertical.xml
android/app/src/main/res/drawable/ph_eye.xml
android/app/src/main/res/drawable/ph_eye_slash.xml
android/app/src/main/res/drawable/ph_gear_six.xml
android/app/src/main/res/drawable/ph_heartbeat.xml
android/app/src/main/res/drawable/ph_house.xml
android/app/src/main/res/drawable/ph_info.xml
android/app/src/main/res/drawable/ph_magnifying_glass.xml
android/app/src/main/res/drawable/ph_moon.xml
android/app/src/main/res/drawable/ph_paper_plane_right.xml
android/app/src/main/res/drawable/ph_receipt.xml
android/app/src/main/res/drawable/ph_shield_check.xml
android/app/src/main/res/drawable/ph_sliders_horizontal.xml
android/app/src/main/res/drawable/ph_squares_four.xml
android/app/src/main/res/drawable/ph_sun.xml
android/app/src/main/res/drawable/ph_wallet.xml
android/app/src/main/res/drawable/ph_warning_circle.xml
android/app/src/main/res/drawable/ph_x.xml
android/app/src/test/java/com/qvaapply/sms/MobileApiChatTest.kt
android/app/src/test/java/com/qvaapply/sms/PrecisoScreensStateTest.kt
android/scripts/generate_market_logos.py
android/scripts/test_generate_market_logos.py
docs/backend-operation-actions-measurements.md
docs/chat-images.md
docs/mobile-redesign-report.md
docs/plans/2026-10-28-compact-mobile-redesign-design.md
src/application/monetary-intents.ts
src/chat-images.ts
src/dashboard.ts
src/http-dashboard.ts
src/mobile-operator.ts
src/operation-chat.ts
src/operation-trace.ts
src/qvapay.ts
src/trading.ts
test/chat-images.test.ts
test/flexible-order.test.ts
test/mobile-action-http-budget.test.ts
test/mobile-operator.test.ts
test/monetary-intents.test.ts
test/operation-actions.test.ts
test/operation-chat-http.test.ts
test/operation-chat.test.ts
test/qvapay-operation-timing.test.ts
```
