# Plan de implementación del bootstrap del panel

1. Añadir regresiones HTTP para documento autenticado, documento público, escape del bootstrap y ausencia de llamadas remotas.
2. Añadir una utilidad web comprobable que lea, valide y retire el bootstrap del documento.
3. Hacer dinámica la ruta `/` usando la sesión existente y `localSnapshot()`.
4. Inicializar sesión, CSRF y dashboard antes del primer render de React.
5. Cambiar el login a una recarga única tras crear la cookie.
6. Serializar los refrescos de fondo, ampliar su tolerancia y conservar siempre el último snapshot visible.
7. Ejecutar pruebas específicas, `pnpm check`, CI, despliegue y verificación HTTPS.
