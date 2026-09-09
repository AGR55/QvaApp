# Implementación: operaciones accionables y auditoría coherente

1. Añadir pruebas de contrato HTTP para cuerpos vacíos en `cancel` y referencia obligatoria en `paid`.
2. Añadir una prueba del read model que excluya `cancelled` sin borrar la fila persistida.
3. Añadir pruebas del repositorio para que `pending` reutilice los filtros de decisión.
4. Añadir una prueba de escaneo donde una oferta ya vista cambia a `blocked` y crea un evento versionado.
5. Corregir el cuerpo enviado por el diálogo de Operaciones.
6. Filtrar canceladas en la proyección local del dashboard.
7. Separar persistencia de decisiones y deduplicación de notificaciones durante el escaneo.
8. Ejecutar pruebas focalizadas, `pnpm check`, revisión de cambios y compilación final.
