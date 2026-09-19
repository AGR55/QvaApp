# Menú nativo de Telegram y control guiado de cacerías

## Objetivo

Permitir que el administrador opere QvaApply desde el menú nativo de Telegram sin memorizar comandos. El bot debe exponer todas las funciones actuales y añadir controles guiados para iniciar, detener y configurar las tasas de caza globales y por mercado, sin duplicar la lógica financiera existente.

## Alcance

- Registrar un menú nativo, limitado al chat administrador, con accesos a Estado, Saldo, Cacería, Mercados, Mis ofertas, Operaciones, Estrategia, Automatización, Escanear, Logs y Ayuda.
- Mantener todos los comandos actuales como interfaz compatible.
- Usar vistas con botones inline para la navegación secundaria, porque Telegram no admite submenús jerárquicos dentro del menú nativo.
- Añadir una vista de Cacería con estado global y estado por mercado.
- Permitir iniciar o detener compra y venta globalmente.
- Permitir activar o detener compra y venta en cada mercado.
- Permitir cambiar la tasa máxima de compra y la tasa mínima de venta escribiendo un valor exacto.
- Exigir confirmación antes de persistir una tasa nueva.

## Experiencia de uso

El botón Menú de Telegram será el punto de entrada permanente. Elegir Cacería abrirá un resumen con los controles globales y una lista de mercados. Al seleccionar un mercado aparecerán sus dos lados, tasas actuales y botones para activar, detener o editar.

Para editar una tasa, el bot solicitará un número mediante respuesta guiada. Una entrada válida producirá una pantalla de confirmación con mercado, lado, valor anterior y valor nuevo. Confirmar aplicará el cambio; cancelar no modificará la configuración. Las entradas inválidas conservarán el flujo abierto y explicarán el formato esperado.

Los flujos de texto pendientes vivirán solo en memoria y únicamente para el chat administrador. Un reinicio los descartará deliberadamente para que ninguna edición incompleta pueda aplicarse después de recuperar el proceso. `/cancel` y el botón Cancelar abandonarán el flujo.

## Arquitectura y datos

- El arranque registrará los comandos mediante la API de Telegram con alcance para el chat administrador y configurará el botón de menú como menú de comandos.
- Los comandos del menú reutilizarán las funciones de renderizado actuales; no crearán una segunda capa de dominio.
- Los callbacks usarán datos compactos que incluyan acción, mercado y lado, dentro del límite de Telegram.
- Las mutaciones llamarán exclusivamente a `TradingEngine.updateHunting`, que ya valida, persiste y audita los cambios.
- La edición de una tasa se modelará como un pequeño estado pendiente con mercado, lado, valor anterior y valor propuesto. El valor propuesto solo llegará al motor después de la confirmación.
- La autorización global existente seguirá rechazando mensajes y callbacks de cualquier chat distinto del administrador.

## Seguridad y errores

- Activar o detener controles puede aplicarse directamente y devolver el estado resultante; cambiar una tasa requiere confirmación explícita.
- Solo se aceptarán números finitos y positivos.
- Se respetará la relación existente entre máximo de compra y mínimo de venta; cualquier combinación inválida será rechazada por la validación del dominio y mostrada como error seguro.
- Los callbacks caducados o repetidos se responderán de forma segura y no derribarán el bot.
- Si Telegram no permite registrar el menú durante el arranque, se auditará el error sin impedir que el motor y el panel web sigan funcionando.

## Pruebas

- Registro del catálogo completo de comandos y del botón de menú para el chat administrador.
- Navegación hacia Cacería y mercados configurados.
- Activación y detención global por lado.
- Activación y detención por mercado y lado.
- Solicitud, validación, confirmación y cancelación de tasas exactas.
- Rechazo de valores inválidos y de combinaciones incoherentes.
- Conservación de los comandos existentes y de la autorización administrativa.
- Verificación completa con typecheck, análisis estático, pruebas, builds y comprobación de secretos.

## Fuera de alcance

- Integración con WhatsApp.
- Telegram Mini Apps o apertura del panel web dentro de Telegram.
- Persistir borradores o conversaciones incompletas entre reinicios.
- Cambiar reglas de clasificación, riesgo o ejecución de operaciones.
