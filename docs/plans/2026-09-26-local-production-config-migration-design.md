# Migración selectiva de configuración local a producción

## Objetivo

Trasladar a la VPS la configuración operativa y los secretos cifrados de la
base SQLite local sin importar operaciones antiguas, workflows, mutaciones,
alertas, cachés ni eventos históricos.

## Alcance

La migración copiará mercados, saldos declarados, datos de pago, límites de
riesgo, estrategia, configuración del bot, historial de revisiones y claves de
configuración persistida necesarias para la sesión QvaPay, la fuente de mercado
y el comportamiento operativo. Los secretos siguen cifrados; producción ya
utiliza la misma `LOCAL_ENCRYPTION_KEY` que la base local.

No se copiarán operaciones, libro fiat histórico, intenciones de mutación,
workflows, reservas, acciones programadas, ofertas vistas, auditoría operativa,
observaciones, snapshots, alertas, notificaciones, eventos del feed, trabajos
de reajuste ni cachés remotas.

## Procedimiento

1. Crear un snapshot local coherente mediante la API de backup de SQLite.
2. Comparar versiones de esquema y tablas requeridas antes de detener el
   servicio.
3. Detener brevemente el contenedor y crear un backup restaurable de la base de
   producción.
4. Ejecutar la copia selectiva dentro de una única transacción, con claves
   foráneas habilitadas.
5. Ejecutar `PRAGMA integrity_check` y `PRAGMA foreign_key_check`.
6. Corregir propietario y permisos, reiniciar y comprobar salud HTTP, sesión
   QvaPay y configuración cargada.

Si cualquier paso posterior a la detención falla, se restaurará el backup de
producción y se arrancará de nuevo la release vigente.

## Seguridad operativa

El snapshot viajará exclusivamente por SSH y se eliminará de la carpeta de
entrada al finalizar. Ningún valor de secretos, datos de pago o tokens se
imprimirá en consola. La pausa de producción debe durar menos de un minuto.
