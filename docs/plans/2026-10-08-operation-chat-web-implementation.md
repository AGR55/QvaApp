# Plan de implementación: chat web de operaciones

1. Añadir pruebas de contrato para las respuestas documentadas `chat: [...]` y `message: "id"`; corregir `QvaPayClient` sin perder compatibilidad con las variantes existentes.
2. Añadir `OperationChatService` con autorización por operación local, instantánea persistida y acotada, deduplicación por ID, marca de lectura y sincronización periódica de operaciones activas. Nunca reintentar automáticamente `POST` inciertos.
3. Exponer API web de lectura local, actualización explícita, envío y marca de lectura usando la sesión/CSRF existentes. Probar acceso anónimo, UUID ajeno, validación y fallos remotos.
4. Añadir panel contextual de chat a Operaciones con copia local inmediata, contador de no leídos, envío de texto, estados de carga/vacío/error/desactualizado y acciones financieras existentes intactas.
5. Añadir pruebas de regresión y ejecutar `pnpm check`, revisión de diff y CI. Publicar en PR separado, sin incluir la eliminación local de `public/icons/cup.svg`.

No se activan cuentas ajenas ni se modifica el presupuesto o la cola de `apply`.
