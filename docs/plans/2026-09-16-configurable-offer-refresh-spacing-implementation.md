# Plan de implementación: separación configurable entre refrescos

1. Ampliar el modelo de automatización con `offerRefreshSpacingSeconds`, valor
   predeterminado 20 y validación mínima 20.
2. Añadir una migración de SQLite para persistir el nuevo valor y actualizar las
   consultas de lectura y escritura de `bot_config`.
3. Sustituir la espera fija del refresco automático por el valor activo de la
   estrategia.
4. Exponer el campo en el formulario de Estrategia como un número en segundos
   con mínimo 20.
5. Añadir cobertura de persistencia, validación y comportamiento temporal, y
   ejecutar las verificaciones del proyecto.
