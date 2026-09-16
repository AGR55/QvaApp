# Separación configurable entre refrescos de ofertas

## Problema

La estrategia permite definir cuántos minutos debe llevar una oferta propia sin
actualizarse para considerarla vencida. Sin embargo, una vez que existen varias
ofertas vencidas, la separación entre refrescar una y la siguiente está fijada
en 20 segundos dentro del motor de trading y no puede ajustarse desde el panel.

## Diseño aprobado

- Añadir a la configuración de automatización el campo
  `offerRefreshSpacingSeconds`.
- Mostrarlo en Estrategia como **Separación entre refrescos**, expresado en
  segundos.
- Usar 20 segundos como valor predeterminado para instalaciones nuevas y como
  valor de migración para las existentes.
- Rechazar valores inferiores a 20 segundos tanto en la validación del servidor
  como mediante el límite del control numérico de la interfaz.
- Mantener separado este valor de `offerRefreshIntervalMinutes`: el intervalo en
  minutos determina cuándo vence cada oferta; la separación en segundos limita
  el ritmo al recorrer varias ofertas vencidas.

## Persistencia y flujo

SQLite incorporará una columna no nula con valor predeterminado de 20 en
`bot_config`. El servicio de configuración la cargará, validará y guardará junto
al resto de la estrategia. En cada turno automático, el motor comparará la última
edición global con la separación configurada antes de seleccionar una única
oferta vencida.

El limitador interno de QvaPay seguirá imponiendo su mínimo técnico de 20
segundos. La nueva opción solo podrá igualarlo o establecer una espera más
conservadora.

## Errores y compatibilidad

Las bases de datos existentes se migrarán automáticamente con 20 segundos, sin
cambiar el comportamiento actual. Una petición de configuración con un valor
menor producirá el mismo error de validación que los demás límites de estrategia.

## Verificación

- Probar que SQLite persiste y restaura el nuevo campo.
- Probar que se rechazan valores menores de 20 segundos.
- Probar que el refresco automático espera la separación configurada y continúa
  actualizando como máximo una oferta por turno.
- Ejecutar comprobación de tipos, pruebas y compilación del frontend.
