# Plan de implementación: decisiones operativas, Push, chat y gráficas

## 1. Contratos y persistencia

- Añadir pruebas de migración y consultas para eventos versionados, filtros, paginación y resolución aislada.
- Crear el esquema SQLite y los tipos de comprobaciones/decisiones.
- Mantener compatibilidad de lectura con las alertas existentes durante la transición.

## 2. Política de decisión

- Reproducir mediante pruebas el bloqueo incorrecto por antigüedad de la oferta y por `maxSlippagePercent`.
- Usar el instante de observación de la lista, convertir slippage y cooldowns en advertencias y conservar los límites financieros duros.
- Persistir la explicación completa de cada candidata y continuar con la siguiente si una queda bloqueada.

## 3. Chat y vencimientos

- Ampliar el gateway para devolver la identidad del mensaje enviado y leer el chat tipado.
- Persistir la exclusión del saludo automático y la evidencia mínima de intervención.
- Consultar chats de operaciones con vencimiento y reconocer cualquier mensaje propio posterior.
- Hacer una comprobación final antes de cancelar y aplazar de forma segura ante errores de red.

## 4. Distribución de notificaciones

- Reemplazar la deduplicación global de Push por eventos identificables y destinos aislados.
- Exponer clave pública, alta y baja mediante rutas autenticadas y CSRF.
- Servir el service worker en raíz e integrar registro, permiso, mensajes visibles y notificación nativa.
- Mantener el botón «Voy a pagar» para aplicaciones automáticas relevantes y añadir navegación web contextual.

## 5. Auditoría web

- Añadir endpoint paginado con filtros y conteos.
- Implementar cola, estados, detalle de comprobaciones y resolución por versión de evento.
- Incorporar skeletons, datos locales conservados, error recuperable y reintento.

## 6. Histórico y gráficas

- Guardar observaciones desde cada ciclo del escáner con deduplicación temporal en SQLite.
- Consultar las últimas 24 horas.
- Conservar la última serie válida durante reintentos y mostrar estados de carga, error y vacío por separado.

## 7. Verificación integral

- Ejecutar pruebas focalizadas después de cada capa.
- Ejecutar typecheck, suite completa, builds, escaneo de secretos y `git diff --check`.
- Ejecutar smoke visual únicamente contra datos simulados/locales y no iniciar el bot conectado a QvaPay.
