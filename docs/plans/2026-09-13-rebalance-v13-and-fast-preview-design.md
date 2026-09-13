# Migración reparadora y previsualización rápida del reajuste

## Diagnóstico

La base de producción registra la migración 12 y contiene las columnas visuales añadidas por ella, pero no contiene `capital_rebalance_jobs`. Durante el desarrollo se amplió la migración 12 después de que esa versión ya hubiera sido ejecutada. SQLite omite correctamente una versión registrada, por lo que el código nuevo intenta acceder a una tabla inexistente.

La previsualización también espera siempre una consulta remota de ofertas propias. Esa consulta pasa por la cola y los reintentos de QvaPay, aunque el dashboard ya conserva una copia local reciente suficiente para calcular el plan.

## Diseño aprobado

### Reparación del esquema

- Incrementar la versión del esquema a 13.
- Crear en la migración 13 la tabla y su índice con `IF NOT EXISTS`.
- Mantener intacta la migración 12 para representar correctamente lo que pudo haberse desplegado.
- Crear una copia automática de la base antes de aplicar v13 mediante el mecanismo existente.
- Cubrir con una prueba una base marcada como v12 que tenga las columnas visuales pero carezca de la tabla.

### Previsualización híbrida

- Calcular y devolver inmediatamente el plan usando la última lista local de ofertas propias.
- Incluir la fecha de esa lista en la respuesta para mostrar su antigüedad en el modal.
- Solicitar una actualización remota en segundo plano sin bloquear la apertura del modal.
- Antes de crear el trabajo, comprobar la frescura de la lista local.
- Si está fuera del límite seguro, refrescarla de forma acotada y volver a validar los ajustes contra el plan actualizado.
- Si la actualización necesaria falla, no crear el trabajo y explicar que no se pudo validar el estado actual, evitando actuar con datos antiguos.

## Interfaz

El modal aparecerá inmediatamente con el plan disponible y una indicación de cuándo se actualizaron las ofertas. Si llega una actualización remota mientras permanece abierto, el plan se sustituirá sin cerrar el modal. El botón Aplicar indicará brevemente que está validando cuando sea necesario.

## Verificación

- Migración de una base v12 incompleta a v13.
- Creación y lectura de trabajos después de migrar.
- Previsualización local sin esperar a QvaPay.
- Revalidación remota obligatoria cuando la caché está vencida.
- Suite completa y compilación web/servidor.
