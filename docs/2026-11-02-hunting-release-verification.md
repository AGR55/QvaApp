# Verificación del release de cacerías — 2 de noviembre de 2026

Base de producción verificada en GitHub: `507b9d5ba372f739501fffe86e966028db03b639`, con despliegue de CI satisfactorio. Se preparó un checkout aislado sobre esa revisión, sin promover el historial divergente del workspace.

La entrega incluye adquisición/evaluación separadas, lectoras concurrentes con identidad verificada, presupuesto compartido de listados, preparación y coherencia QUSD, telemetría e informe local. Se excluyeron cambios pendientes de Android, imágenes/chat y pago/recepción manual, incluidos los hunks mezclados en TradingEngine y QvaPayClient.

En la revisión previa al despliegue se separó la cola de listados para que esperar presupuesto no retenga lecturas normales ni preflights de edición. El informe queda empaquetado y disponible dentro de la imagen. El despliegue ejecuta el backup SQLite antes de construir/cambiar release y trata un fallo de compose up mediante la ruta existente de rollback.

Validación del checkout aislado: Node 24.22.1; pnpm check aprobado, con 89 archivos de pruebas, tipos, knip, builds servidor/web, compresión y escaneo de secretos. Se reutilizaron las dependencias locales instaladas mediante symlink y se desactivó únicamente la auto-instalación previa de pnpm para esta comprobación local. CI realizará una instalación propia con lockfile congelado. git diff --check y bash -n aprobados.

Una simulación del script Bash real, con raíz y comandos Docker/HTTP sustituidos solo en la copia de prueba, verificó tres escenarios: éxito con cleanup; error de respaldo que aborta antes de build/cambio de symlink; error de arranque que restaura la release anterior sin cleanup. No se enviaron transacciones financieras de prueba.

La autorización del usuario incluye publicar y desplegar cuando las comprobaciones estén listas. El estado final de CI y producción se verificará sobre el SHA integrado; la prueba HTTP de salud no demuestra por sí sola una reducción de latencia ni una captura real.
