# Plan de implementación

1. Feed: tipos y normalización, colas persistentes, invalidaciones, pruebas de eventos de rango.
2. Persistencia: reservas vinculadas a intenciones; exposición y cierre al proyectar operación, pruebas de reinicio y errores.
3. Envío: serializar únicamente validación/cupo, separar respuesta; pruebas de ráfagas y límites.
4. Motor/feed: compras fiat independientes y ruta QUSD separada, descontar reservas en dimensionado y revalidación, probar concurrencia.
5. Preparación: perfil y liquidez en tareas de fondo, guardas de pausa/exposición/mutaciones, pruebas de conservación de tasa y capital.
6. Verificación completa; publicar, activar selección de eventos de rango y comprobar salud/estado.

La guía writing-plans referenciada por brainstorming no está instalada; se registra este plan directamente. La aprobación del diseño procede del mensaje del usuario «me sirve todas esas mejoras, puedes aplicarlas ya».

## Resultado de implementación y verificación

- Eventos de rango integrados con reevaluación de capacidad y cierre del padre sin liquidar órdenes hijas.
- Compras fiat independientes, con reservas persistentes atómicas y recuperación del intervalo entre confirmación y proyección. Las rutas QUSD conservan su serialización y el límite oficial de aplicaciones.
- Preparación de liquidez en segundo plano, manteniendo tasa y reservas, con comprobación previa al envío y saldo verificado después.
- Requisitos filtrados localmente con datos verificados y caducidad; los valores desconocidos se dejan a la validación de QvaPay.
- `pnpm check` completo aprobado: 67 archivos de pruebas, tipos, código no utilizado, compilaciones y búsqueda de secretos. `git diff --check` sin errores. Sin aplicaciones ni pagos reales de prueba.
- Se conserva la exclusión existente de padres que ya tienen una operación registrada. La selección de los eventos nuevos depende del panel de QvaPay; el usuario ha confirmado que la activará.
