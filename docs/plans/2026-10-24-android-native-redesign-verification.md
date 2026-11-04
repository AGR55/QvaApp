# Verificación del rediseño Android 0.4.0

Fecha: 24 de octubre de 2026. Diseño aprobado: Preciso azul y menta.

## Entrega

- APK privada firmada, versión 0.4.0, versionCode 6, instalada con `adb install -r` en el Redmi Note 8 Pro conectado (Android 16). Android confirmó instalación correcta y versión 6 / 0.4.0.
- Preferencias y datos conservados. Se observó el historial real de fiat después de actualizar; no se ejecutaron acciones financieras ni se enviaron mensajes a contrapartes.
- Artefacto local: `artifacts/android/QvaApply-0.4.0.apk` (ignorado por Git).
- Cambios limitados a Android y documentación. No se cambian ni despliegan servidor, motor de cacerías ni colas.

## Comprobaciones

- Gradle: testDebugUnitTest, lintDebug, assembleDebug y assembleRelease completados correctamente.
- 17 pruebas unitarias: cero fallos y cero errores.
- Lint: cero errores y 29 advertencias (dependencias, sugerencias KTX, persistencia y complejidad de algunos vectores, entre otras). No se actualizaron dependencias como parte del rediseño.
- Emulador Android 16: Inicio, Operaciones, Mensajes, Ajustes, Avisos y cuadrícula de Herramientas.
- Se abrieron Capital, Cacerías, Salud, Rentabilidad, Historial, Diagnóstico y Simular; cada utilidad abrió su vista propia sin navegación inferior y volvió a la cuadrícula con Atrás.
- Conversación completa con datos sintéticos: cabecera con vuelta, burbujas, borrador multilínea y envío a la derecha. Teclado comprobado tras corregir adjustResize y consumo de márgenes del sistema.
- Modo oscuro y tamaño de texto al 130 %: operaciones, conversación y herramientas. Se habilitaron dos líneas para las etiquetas de navegación ampliadas.
- Las capturas de revisión con datos sintéticos se conservan en `artifacts/android/redesign-review/` (ignoradas por Git).

## Límite de verificación física

La APK quedó instalada y se confirmó su versión. La última inspección física mostró el historial de la cuenta. Tras una interrupción, la ruta del SDK y ADB dejó de estar disponible en la sesión; no se completó una última apertura manual del chat en el teléfono. El chat y el teclado sí fueron comprobados en el emulador. No se volvió a probar una entrega FCM real en este rediseño; se conserva la implementación previamente verificada.

Tamaño APK: 2002986 bytes.
SHA-256: `b27ff66d7cf84f517c1d3f4c150753117b83aa6562e55c746a393d6a708b156e`.
