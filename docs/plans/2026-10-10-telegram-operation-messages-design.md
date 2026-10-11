# Mensajes y acciones de operaciones en Telegram

Alcance aprobado: solo QvaApply. La notificación de una aplicación debe presentar el tipo de operación, mercado, importe QUSD, importe fiat, siguiente paso y UUID en bloques breves. Los datos dinámicos se escapan para HTML de Telegram. Los avisos de ofertas propias y de cacerías cooperativas tendrán la misma jerarquía visual.

Una operación en la que QvaApply paga fiat ofrecerá «Registrar pago». El botón pedirá el ID de transacción en el chat administrador y llamará a la operación existente de `markPaid`, que envía `tx_id` a QvaPay. El comando `/paid UUID REFERENCIA` seguirá disponible. La captura del ID no forma parte del ciclo de escaneo ni del envío de aplicaciones.

La notificación inicial no tendrá «Cancelar». En la lista de operaciones, cada botón indicará el número de su operación y cancelar requerirá una segunda confirmación. El servicio comprobará el estado local y el remoto antes de enviar la cancelación a QvaPay. Un botón antiguo no podrá cancelar una operación ya pagada o completada. Las vistas nuevas reflejarán el estado actual, sin retrasar la cacería.

Las pruebas cubrirán el formato, el ID de pago, los estados que permiten cancelar y la continuidad del procesamiento de ofertas.
