# Plan de implementación

1. Feed: tipos y normalización, colas persistentes, invalidaciones, pruebas de eventos de rango.
2. Persistencia: reservas vinculadas a intenciones; exposición y cierre al proyectar operación, pruebas de reinicio y errores.
3. Envío: serializar únicamente validación/cupo, separar respuesta; pruebas de ráfagas y límites.
4. Motor/feed: compras fiat independientes y ruta QUSD separada, descontar reservas en dimensionado y revalidación, probar concurrencia.
5. Preparación: perfil y liquidez en tareas de fondo, guardas de pausa/exposición/mutaciones, pruebas de conservación de tasa y capital.
6. Verificación completa; publicar, activar selección de eventos de rango y comprobar salud/estado.

La guía writing-plans referenciada por brainstorming no está instalada; se registra este plan directamente. La aprobación del diseño procede del mensaje del usuario «me sirve todas esas mejoras, puedes aplicarlas ya».
