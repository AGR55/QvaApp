# Plan de implementación: fuente de mercado por webhook de QvaPay

1. Añadir una migración SQLite para la bandeja durable de eventos del feed y
   operaciones de inserción idempotente, lectura, confirmación y fallo.
2. Crear un coordinador de fuente que conserve polling, gestione modo y secreto
   cifrado, valide firmas/timestamps, persista eventos y procese la cola.
3. Añadir al motor una entrada de oferta individual que reutilice clasificación,
   riesgo, liquidez, mutaciones y notificaciones sin esperar una ronda completa.
4. Exponer el webhook público con cuerpo crudo y endpoints autenticados para
   consultar/configurar la fuente desde el panel.
5. Conectar el runtime: polling solo en su modo y drenaje rápido/durable del feed.
6. Extender **Fuente de mercado** con selector, estado, URL y configuración del
   secreto sin devolver su valor.
7. Actualizar documentación de operación, despliegue y activación en QvaPay.
8. Añadir pruebas unitarias, HTTP, runtime/UI y ejecutar la validación integral.
9. Publicar la rama, integrarla en `main` y comprobar el despliegue automático.
