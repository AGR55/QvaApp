# Implementación: vía rápida para eventos P2P

## 1. Contrato de eventos y persistencia

- Ampliar el contrato del feed para aceptar los seis eventos P2P documentados.
- Normalizar campos de ofertas fijas y flexibles sin exigir estado `open` a los
  eventos terminales.
- Versionar la clave de entrega con `event`, `uuid` y `updated_at` o `sent_at`.
- Añadir al almacenamiento operaciones para drenar lotes, cancelar eventos
  obsoletos y registrar hitos de latencia.
- Migrar SQLite de forma compatible con las bandejas existentes.

Pruebas: payloads de cada evento, duplicado stream/webhook, dos reaperturas del
mismo UUID, orden durable y migración desde el esquema anterior.

## 2. Coordinador híbrido y drenaje

- Separar recepción de eventos, proyección del libro y evaluación de
  oportunidades detrás de una interfaz profunda del coordinador.
- Procesar primero `applied` y `cancelled`, después oportunidades urgentes y por
  último estados de operaciones.
- Drenar todos los eventos listos sin esperar un tick por cada uno y evitar
  carreras cuando stream, webhook y scheduler despiertan el drenador a la vez.
- Mantener el webhook con respuesta inmediata tras la persistencia.

Pruebas: ráfagas, prioridad de invalidaciones, un único drenador, pausa y
recuperación de errores con backoff.

## 3. Política rápida y aplicación

- Incorporar una evaluación explícita de vía rápida para precio efectivo,
  capital disponible, elegibilidad técnica y estado operativo.
- Convertir los demás controles de riesgo en advertencias auditables.
- Eliminar la consulta QUSD del camino de compra con fiat.
- Usar saldo QUSD cacheado y reservas locales en el camino de venta; refrescar
  solo cuando la copia sea demasiado antigua.
- Conservar la intención monetaria y serializar la mutación final.
- Revalidar precio, reserva, cacería y emergencia inmediatamente antes de
  `apply`.

Pruebas: precio límite con comisión, capital comprometido, advertencias que no
bloquean, emergencia, mutación incierta, doble evento y dos oportunidades que
compiten por el mismo saldo.

## 4. Proyección de estados

- `created` y `reopened`: insertar o reemplazar la oferta y activar evaluación.
- `applied` y `cancelled`: retirar la oferta y resolver alertas/trabajo no
  enviado.
- `paid` y `completed`: actualizar operaciones conocidas y solicitar
  conciliación selectiva cuando falten datos contables.
- Conservar las tareas periódicas actuales como reparación de discrepancias.

Pruebas: transición por cada evento, eventos ajenos que solo actualizan el
libro, eventos propios que actualizan Operación y llegada fuera de orden.

## 5. Recuperación y diagnóstico

- Registrar tiempos por oferta: recibido, persistido, evaluado, `apply`
  iniciado y respuesta.
- Clasificar pérdidas por tomada, precio, saldo, elegibilidad, límite, red o
  fallo interno.
- Disparar reconciliación acotada al reconectar el stream y ante una brecha.
- Exponer salud, retrasos, profundidad de cola y entregas fallidas en el estado
  operativo sin revelar credenciales.

Pruebas: métricas deterministas con reloj inyectado, reconexión, datos sensibles
y clasificación de rechazos QvaPay.

## 6. Validación y publicación

- Ejecutar pruebas focalizadas después de cada capa.
- Ejecutar `pnpm check` y el smoke test de interfaz al terminar.
- Publicar en `main`, esperar CI y despliegue de producción.
- Verificar HTTPS, conexión del stream, recepción de webhook y métricas del
  primer ciclo sin exponer secretos.
