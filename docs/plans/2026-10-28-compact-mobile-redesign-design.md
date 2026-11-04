# Rediseño móvil compacto aprobado

## Alcance e inventario

Aplicación Android Kotlin/Compose existente: Inicio, Operaciones, Avisos,
Herramientas (Capital, Cacerías, Salud, Rentabilidad, Historial, Diagnóstico,
Simular), Ajustes, detalle y conversación por oferta/orden. El backend se amplía
solo para adjuntos, medición y seguridad de acciones; no se rediseña el portal web.

## Fases

1. Tokens 4/8 dp, radios moderados, superficies planas, iconos outline/chevrons,
   logos originales empaquetados desde public y fallback local neutro.
2. Búsqueda en barra superior, filas con divisores, sin indicadores permanentes
   de conexión. Avisos ocultables localmente con gesto y deshacer: no se acusa
   recepción en servidor ni se detienen otros canales.
3. Chat contextual de operación, sheet wrap-content, imágenes recibidas y envío
   comprimido según contrato oficial, conservando borradores e incertidumbre.
4. Snackbar sin conexión, caché conservada, estado local pendiente/confirmado/
   fallido y medición por tramo sin transacciones financieras reales.
5. Pruebas automatizadas, compilación y revisión visual y de red disponible.

## Decisiones aprobadas

Se evoluciona Compose sin biblioteca gráfica pesada ni reescritura. No hay
acciones financieras por deslizamiento. La pestaña Mensajes se elimina; los
accesos de notificaciones llevan a la operación correspondiente. Una mutación
no se muestra como pagada/liberada antes de confirmación. Ante resultado incierto
se mantiene bloqueo durable y nunca se reenvía automáticamente.

El usuario añadió un interruptor en Ajustes para activar/desactivar las
notificaciones de QvaApply. Conserva la preferencia entre reinicios, elimina las
notificaciones ya visibles al silenciar y no afecta QvaPay, SMS ni avisos dentro
de la app. Se respeta además el permiso y canal de notificaciones de Android.

## Validación y límites

Por fase se contrastan los criterios de aceptación. Medidas simuladas se
identifican como tales, nunca como latencias de producción. No se modifican
credenciales, firma, vinculación ni cambios preexistentes de public/docs.
