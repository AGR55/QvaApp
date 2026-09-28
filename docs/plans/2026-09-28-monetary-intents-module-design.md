# Diseño del Module de Intenciones monetarias

Fecha: 2026-09-28

## Objetivo

Concentrar en un único Module application-level el protocolo durable que rodea toda mutación monetaria contra QvaPay. El cambio debe preservar las decisiones económicas actuales y mejorar la seguridad ante errores ambiguos, reinicios y respuestas remotas incompletas.

La migración será incremental. Cada etapa debe mantener la suite completa en verde antes de pasar a la siguiente.

## Contexto

`TradingEngine.executeMutation` y `OpportunityOrchestrator.mutation` implementan por separado el mismo protocolo general:

1. crear una Intención monetaria en estado `submitted`;
2. invocar QvaPay;
3. marcarla como `confirmed`, `rejected` o `uncertain`;
4. actualizar posteriormente la Operación o el workflow correspondiente.

Esta duplicación reduce la Locality y permite divergencias. Actualmente existen, además, estos huecos de recuperación:

- `paid`, `received` y la cancelación de Operación no tienen conciliación completa tras reiniciar;
- una Intención puede quedar `confirmed` antes de que la proyección local de la Operación se haya actualizado;
- una respuesta HTTP 2xx con cuerpo inválido puede clasificarse como `rejected` o incluso `confirmed` sin evidencia suficiente;
- la recuperación solo examina las 500 Intenciones más recientes;
- la asociación de una Intención con un workflow se infiere desde `request_json`.

ADR-0003 continúa siendo vinculante: una mutación ambigua no se reintenta ni compensa hasta que exista evidencia de conciliación.

## Alternativas consideradas

### 1. Extraer solo el bloque duplicado

Una función común podría crear la Intención, invocar el callback y actualizar el estado. Es el cambio inicial más pequeño, pero deja la conciliación, las consultas y las reglas de transición repartidas. Aplicando el deletion test, eliminar esa función apenas redistribuiría unas pocas líneas; sería un Module Shallow.

### 2. Module profundo por etapas — seleccionado

Crear `MonetaryIntents` como Seam única para ejecución, conciliación y consulta. Su Interface pequeña ocultará persistencia, clasificación conservadora, transiciones, auditoría y selección de pendientes. La migración se divide en puertas verificables para no combinar refactor estructural y cambios de recuperación en un único salto.

### 3. Reescritura simultánea

Introducir a la vez un nuevo esquema, historial append-only, referencias normalizadas, migración de ambos consumidores y toda la recuperación. Es una arquitectura final atractiva, pero amplía demasiado la superficie de fallo para código financiero.

## Arquitectura seleccionada

El nuevo Module expondrá conceptualmente tres entry points:

```ts
interface MonetaryIntents {
  execute<T>(mutation: MonetaryMutation<T>): Promise<T>;
  reconcile(
    scope: IntentScope,
    observe: IntentObserver,
  ): Promise<ReconciliationReport>;
  snapshot(query?: IntentQuery): IntentSnapshot;
}
```

La Interface definitiva podrá ajustar nombres y tipos durante la implementación, pero conservará estas responsabilidades:

- `execute` gobierna el orden durable anterior y posterior a la llamada remota;
- `reconcile` selecciona Intenciones pendientes, valida veredictos y aplica transiciones concluyentes;
- `snapshot` ofrece a riesgo, dashboard y recuperación una vista coherente sin filtrar detalles de Store.

La Implementación ocultará:

- creación de identificadores y timestamps;
- serialización segura de evidencia;
- estados y transiciones permitidas;
- persistencia antes del despacho;
- clasificación uniforme de rechazo concluyente y resultado incierto;
- auditoría de rechazo, incertidumbre y conciliación;
- consultas de pendientes sin un límite arbitrario global;
- asociación explícita con una oferta, Operación o workflow.

Si este Module se eliminara, esas reglas reaparecerían en ambos consumidores, Store, riesgo y recuperación. Por tanto, supera el deletion test y aporta Depth, Leverage y Locality.

## Responsabilidades que permanecen fuera

`TradingEngine` y `OpportunityOrchestrator` conservarán:

- reserva y liberación de capital;
- transiciones de Operación y workflow;
- compensaciones y restauración de ofertas;
- notificaciones;
- interpretación económica del resultado remoto;
- decisión sobre qué observación remota constituye evidencia para cada clase de mutación.

El Module no reintentará, compensará ni creará Operaciones automáticamente.

## Flujo de ejecución

`execute` impondrá estas invariantes:

1. validar que la evidencia sea serializable antes de cualquier efecto remoto;
2. generar el identificador y persistir `submitted`;
3. no invocar QvaPay si falla la persistencia inicial;
4. invocar el callback remoto exactamente una vez;
5. marcar `confirmed` solo cuando exista una respuesta inequívoca;
6. marcar `rejected` solo ante un fallo remoto concluyente;
7. clasificar timeout, 5xx, error desconocido o 2xx sin evidencia suficiente como `uncertain`;
8. no devolver éxito si falla la persistencia posterior al despacho;
9. conservar el error original como causa, exponiendo a los consumidores un resultado estable del Module.

Las transiciones locales específicas de la Operación no se introducirán inicialmente dentro del callback del Module. El primer paso debe conservar exactamente el comportamiento actual. La ventana entre confirmación y proyección local se cerrará después mediante pruebas de recuperación y una estrategia explícita por clase de mutación.

## Conciliación

La conciliación solo observará estado remoto; nunca volverá a emitir la mutación original.

Un veredicto tendrá uno de estos resultados:

- `effect_present`: hay evidencia durable de que la mutación ocurrió;
- `effect_absent`: hay evidencia durable de que no ocurrió;
- `inconclusive`: no existe evidencia suficiente y la Intención continúa bloqueando.

Solo los dos primeros permiten resolver la Intención. Un error de red, una respuesta parcial o una observación ambigua mantienen el estado pendiente.

La Implementación consultará directamente estados no resueltos, sin depender de las 500 Intenciones más recientes. La asociación con workflows dejará de inferirse desde JSON y usará referencias normalizadas. La migración conservará compatibilidad de lectura con registros históricos hasta que todos los consumidores estén migrados.

## Persistencia y Adapters

La Seam de persistencia será interna al Module. Tendrá dos Adapters reales:

- SQLite, respaldado por `Store`;
- memoria, destinado a pruebas deterministas del protocolo.

El primer incremento reutilizará la tabla existente y añadirá únicamente las consultas o validaciones necesarias. La normalización de referencias y cualquier historial append-only se harán en una etapa separada, con migración y pruebas de reapertura real de SQLite.

No se reinterpretarán silenciosamente registros históricos. Cualquier dato legado conservará una referencia explícitamente marcada como tal.

## Tratamiento de errores

Los consumidores dejarán de duplicar la detección de `QvaMutationUncertainError` y `QvaApiError.status >= 500`. El Module expondrá errores estables que incluyan el identificador de la Intención y distingan:

- rechazo concluyente;
- resultado incierto;
- conflicto con otra Intención pendiente;
- fallo de persistencia antes o después del despacho.

Los detalles públicos y de auditoría estarán saneados; no se persistirán secretos ni objetos de error completos. Cuando un flujo necesite distinguir un estado específico como HTTP 409, podrá inspeccionar la causa sin saltarse el protocolo del Module.

## Estrategia de implementación

### Etapa A: caracterización

- fijar con tests el orden `submitted -> llamada remota -> estado terminal`;
- cubrir éxito, 4xx, timeout, 5xx y error desconocido;
- demostrar que la llamada remota no ocurre si falla la persistencia inicial;
- cubrir respuestas 2xx inválidas de creación y edición de ofertas;
- fijar el comportamiento actual de ambos consumidores.

### Etapa B: ejecución común

- introducir el Module y el Adapter de memoria;
- migrar `OpportunityOrchestrator.mutation`;
- ejecutar la suite completa;
- migrar `TradingEngine.executeMutation`;
- ejecutar nuevamente la suite completa;
- retirar clasificadores y wrappers duplicados.

Esta etapa no cambia reglas económicas ni estados de workflow.

### Etapa C: consultas y asociaciones

- consultar todas las Intenciones no resueltas directamente por estado;
- normalizar referencias a oferta, Operación y workflow;
- eliminar la inferencia mediante `request_json.workflowId`;
- verificar migración y reapertura real de SQLite.

### Etapa D: recuperación por clase de mutación

Agregar estrategias de observación y pruebas de reinicio para:

- aplicar a una oferta;
- cancelar una Operación;
- marcar `paid` y `received`;
- crear, editar y cancelar una oferta propia;
- cancelar una oferta propia por liquidez;
- restaurar una oferta durante compensación.

Cada estrategia entra por separado y solo después de que la suite completa continúe verde.

## Matriz mínima de pruebas

- éxito remoto con Intención ya persistida al comenzar la llamada;
- rechazo 4xx que termina en `rejected`;
- timeout después de aplicar el efecto que termina en `uncertain` y no reintenta;
- timeout antes del efecto que permanece pendiente hasta observar ausencia;
- reinicio después de persistir `submitted`, sin reenvío automático;
- reinicio después de éxito remoto y antes de la proyección local;
- reinicio después de completar proyección e Intención, sin repetición;
- conciliación inconclusa que mantiene el bloqueo;
- cuerpo 2xx inválido de creación o edición que termina en `uncertain`;
- persistencia terminal fallida que nunca se comunica como éxito;
- reapertura de una base SQLite real;
- al menos un escenario de recuperación por cada clase de mutación enumerada.

En cada puerta se ejecutarán typecheck, suite completa, cobertura, auditoría de dependencias y comprobación del diff.

## Criterio de finalización

La mejora estará completa cuando ambos consumidores utilicen una sola Interface, no existan clasificadores duplicados, las consultas no omitan Intenciones antiguas y todas las clases de mutación tengan una ruta de conciliación probada tras reinicio. Ninguna etapa podrá reducir la cobertura ni modificar una regla económica sin una decisión de diseño adicional.
