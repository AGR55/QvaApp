# Verificación del release de cacerías — 2 de noviembre de 2026

Base de producción verificada en GitHub: `507b9d5ba372f739501fffe86e966028db03b639`, con despliegue de CI satisfactorio. Se preparó un checkout aislado sobre esa revisión, sin promover el historial divergente del workspace.

La entrega incluye adquisición/evaluación separadas, lectoras concurrentes con identidad verificada, presupuesto compartido de listados, preparación y coherencia QUSD, telemetría e informe local. Se excluyeron cambios pendientes de Android, imágenes/chat y pago/recepción manual, incluidos los hunks mezclados en TradingEngine y QvaPayClient.

En la revisión previa al despliegue se separó la cola de listados para que esperar presupuesto no retenga lecturas normales ni preflights de edición. El informe queda empaquetado y disponible dentro de la imagen. El despliegue ejecuta el backup SQLite antes de construir/cambiar release y trata un fallo de compose up mediante la ruta existente de rollback.

Validación del checkout aislado: Node 24.22.1; pnpm check aprobado, con 89 archivos de pruebas, tipos, knip, builds servidor/web, compresión y escaneo de secretos. Se reutilizaron las dependencias locales instaladas mediante symlink y se desactivó únicamente la auto-instalación previa de pnpm para esta comprobación local. CI realizará una instalación propia con lockfile congelado. git diff --check y bash -n aprobados.

Una simulación del script Bash real, con raíz y comandos Docker/HTTP sustituidos solo en la copia de prueba, verificó tres escenarios: éxito con cleanup; error de respaldo que aborta antes de build/cambio de symlink; error de arranque que restaura la release anterior sin cleanup. No se enviaron transacciones financieras de prueba.

La autorización del usuario incluye publicar y desplegar cuando las comprobaciones estén listas. El estado final de CI y producción se verificará sobre el SHA integrado; la prueba HTTP de salud no demuestra por sí sola una reducción de latencia ni una captura real.

## Resultado del despliegue

PR integrado: https://github.com/AGR55/QvaApp/pull/27. Revisión publicada en main: `4f3ea6ec9c686847b38813921d774a9065ae59ad`.

CI de producción aprobado: https://github.com/AGR55/QvaApp/actions/runs/41559792641. Los jobs verify y deploy terminaron correctamente. El log remoto confirmó a las 2026-11-03T01:32:36Z: `QvaApply desplegado en /opt/qvaapply/releases/4f3ea6ec9c686847b38813921d774a9065ae59ad`. El script de respaldo previo terminó sin error; no se inspeccionó el contenido ni la existencia del archivo de respaldo remoto de forma independiente.

Después del despliegue, HTTPS público devolvió HTTP 200 tanto para `https://qvapply.honux.tech/api/session` como para `https://qvapply.honux.tech/`. No se enviaron operaciones financieras de prueba. La mejora cuantitativa queda pendiente de comparar las métricas con actividad real; no se atribuye una reducción en milisegundos a la comprobación de salud.
