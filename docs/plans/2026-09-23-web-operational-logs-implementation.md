# Plan de implementación: consola web de logs operativos

1. Extender `Store` con una consulta paginada por ID para eventos operativos,
   filtros parametrizados y tipos públicos de nivel/componente.
2. Añadir clasificación y redacción deterministas, cubiertas por pruebas
   unitarias y de repositorio.
3. Exponer `GET /api/logs` dentro de la autenticación existente, con esquema
   estricto, límites y pruebas HTTP.
4. Reducir el ruido de `scan_complete`: conservar `last_scan` siempre y auditar
   solo los cambios o un latido por minuto. Cubrir el comportamiento con prueba
   de regresión.
5. Crear `web/features/logs.jsx` con historial, seguimiento por cursor cada dos
   segundos, filtros, pausa, actualización, autoscroll, copia y descarga.
6. Integrar la ruta **Sistema → Logs**, estilos responsive y estados accesibles.
7. Actualizar el preview con datos representativos y ampliar los smokes visuales
   y regresiones de layout.
8. Ejecutar pruebas enfocadas, `pnpm check` y `pnpm check:ui`; corregir cualquier
   regresión antes de desplegar.
9. Publicar la rama, integrar en `main`, esperar el despliegue automático y validar
   en la VPS que el endpoint, la UI y el volumen de auditoría funcionan.
