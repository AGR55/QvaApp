# Plan de implementación: fuente de mercado multicuentas

## 1. Contratos de lectura y escritura

- Crear en `src/core/ports.ts` un puerto de solo lectura para listar el mercado
  y mantener `QvaPayGateway` como gateway operativo principal.
- Añadir tipos de instantánea, estado de fuente y cuenta en un módulo dedicado
  `src/market-source.ts`.
- Incorporar una prueba de arquitectura que impida pasar métodos de mutación a
  una cuenta secundaria.

## 2. Persistencia versionada de cuentas

- Elevar el esquema de SQLite y crear `market_reader_accounts` con metadatos,
  secreto cifrado, huella única, intervalo, habilitación y estado sanitario.
- Añadir métodos de repositorio para crear, listar públicamente, actualizar
  salud, rotar secreto, habilitar/deshabilitar y eliminar.
- Reutilizar el respaldo previo a migraciones y probar actualización desde v14,
  restricciones, persistencia y ausencia del secreto en DTO públicos.

## 3. Clientes acotados y registro seguro

- Permitir construir un cliente QvaPay de listado con un token secundario sin
  exponer el resto del gateway al coordinador.
- Crear `MarketAccountService` para validar un token mediante un listado mínimo,
  cifrarlo con `Vault`, calcular su huella y sanitizar errores.
- Rechazar tokens duplicados e intervalos inferiores a tres segundos.
- Cubrir alta, rotación fallida sin perder el token anterior y eliminación.

## 4. Planificador multicuentas

- Implementar `PollingMarketSource` con reloj y espera inyectables.
- Mantener disponibilidad independiente por cuenta y seleccionar de forma justa
  la próxima cuenta habilitada.
- Construir una cola ponderada de mercado/lado a partir de la configuración
  activa, conservando la prioridad actual de compra sobre venta.
- Implementar `Retry-After`, backoff para red/5xx y estado de atención para
  401/403 sin frenar otras cuentas.
- Probar marcas temporales exactas con una, dos y varias cuentas, justicia,
  ausencia de solapamiento y recuperación.

## 5. Caché de instantáneas y evaluación incremental

- Extraer del escaneo actual la clasificación de una página y la evaluación del
  conjunto de instantáneas recientes.
- Actualizar una sola combinación mercado/lado por turno y combinar únicamente
  snapshots dentro de `maxQuoteAgeSeconds`.
- Exigir calentamiento suficiente antes de habilitar mutaciones.
- Deduplicar ofertas por UUID y serializar evaluación/aplicación para conservar
  una sola mutación por oportunidad.
- Mantener toda consulta privada y mutación en el gateway principal.
- Cubrir selección rentable, snapshot obsoleto, duplicados y principal caída.

## 6. Integración con el runtime

- Construir el registro de la principal y las lectoras persistidas en
  `src/index.ts`.
- Sustituir la tarea monolítica `scan` por el ciclo de `MarketDataSource`, sin
  afectar expiración, chat, conciliación, refresco, balance ni notificaciones.
- Reiniciar/reconfigurar de forma segura el plan de consultas cuando cambien
  cuentas, intervalos o mercados.
- Exponer salud y cadencia efectiva en el estado operativo y dashboard.

## 7. API HTTP protegida

- Añadir endpoints autenticados para listar cuentas públicas, crear/validar,
  rotar token, actualizar etiqueta/intervalo/habilitación y eliminar.
- Aplicar esquemas estrictos, CSRF a cada mutación, límites de longitud y errores
  sin secretos.
- Añadir al contrato de configuración el modo de fuente `polling`, dejando el
  discriminante preparado para `stream` sin mostrar una opción no implementada.
- Extender OpenAPI y las pruebas Fastify de autorización y flujos completos.

## 8. Interfaz de Fuente de mercado

- Crear un componente dedicado dentro de Estrategia para la tarjeta principal,
  resumen de cadencia y tarjetas secundarias.
- Implementar diálogos de alta, rotación y eliminación; el token será un campo
  de contraseña que se limpia después de enviar.
- Mostrar salud, última lectura, próxima disponibilidad, consultas recientes,
  errores y estimación por minuto sin mostrar secretos.
- Añadir estados vacíos, carga, errores accesibles, navegación por teclado y
  diseño responsive coherente con el panel existente.

## 9. Preparación del adaptador stream

- Mantener el runtime dependiente solo de `MarketDataSource`.
- Documentar el contrato de eventos que deberá implementar
  `StreamMarketSource` y probar un fake basado en eventos para demostrar que el
  evaluador no depende del polling.
- No incluir credenciales ni controles SSE inactivos en esta entrega.

## 10. Verificación y entrega

- Ejecutar pruebas focalizadas tras cada capa y luego `pnpm check`.
- Ejecutar smoke visual de escritorio y móvil para la nueva sección.
- Revisar el diff por secretos, confirmar que los cambios locales de la rama
  NATS siguen intactos y registrar commits atómicos en `develop`.
- Fusionar `develop` en `main` después de la verificación y solicitar
  autorización explícita antes de publicar ambas ramas en `origin`.
