# Panel local-first y configuración SQLite

## Objetivo

Mantener el panel utilizable cuando QvaPay responde lentamente o no responde, sin ocultar la antigüedad de los datos y sin permitir que una lectura remota bloquee controles o configuración locales.

## Decisiones

- SQLite es la fuente de verdad de precios, límites, mercados, automatización y datos de cobro. Los valores de entorno solo inicializan una base vacía y conservan secretos o barreras de despliegue.
- Cada respuesta remota válida se almacena como un recurso independiente en SQLite con fecha de actualización.
- El arranque del panel lee únicamente SQLite. Balance, ofertas propias, transacciones y cada mercado se actualizan mediante endpoints separados.
- El navegador consulta solo los recursos necesarios para la vista actual, conserva el dato anterior ante errores, cancela solicitudes obsoletas y aplica reintentos con espera creciente.
- Un fallo remoto nunca devuelve el panel completo al estado de carga. Los datos anteriores se muestran como obsoletos con hora y causa.
- Los skeletons tienen dimensiones estables, se limitan al bloque pendiente y respetan `prefers-reduced-motion`.

## Seguridad financiera

- Las credenciales, claves de cifrado, contraseña del panel y el interruptor de despliegue que permite dinero real no se guardan como configuración editable.
- Las acciones financieras remotas siguen requiriendo una lectura actual y conservan los controles existentes de modo, pausa, CSRF, límites e idempotencia.
- Los cambios de configuración se validan transaccionalmente y continúan en la cadena de revisiones auditable.

## Flujo

1. Autenticar la sesión local.
2. Renderizar inmediatamente la estructura y el estado persistido de SQLite.
3. Actualizar el recurso de la vista activa.
4. Guardar la respuesta válida y fusionarla en la interfaz.
5. Si falla, mantener la copia anterior, indicar su antigüedad y ofrecer reintento.

## Verificación

- Migración con respaldo automático y pruebas de persistencia tras reinicio.
- Pruebas HTTP que demuestren que `/api/dashboard` no llama a QvaPay.
- Pruebas de recursos independientes y conservación de caché ante error.
- Build, suite completa, comprobación de secretos y smoke visual accesible.
