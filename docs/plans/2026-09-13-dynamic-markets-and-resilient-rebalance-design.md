# Mercados dinámicos y reajuste resistente

## Objetivos

- Permitir que un mercado nuevo se integre en toda la web y Telegram inmediatamente después de guardar su configuración.
- Permitir cargar y sustituir el icono desde Estrategia mediante el explorador de archivos.
- Evitar que el modal de reajuste permanezca bloqueado o informe falsos problemas de conexión durante mutaciones lentas.
- Conservar la seguridad frente a resultados remotos inciertos y reanudar trabajos después de reiniciar.

## Mercados y presentación

La configuración de cada mercado incluirá sus metadatos visuales. El usuario escogerá PNG, WebP, JPEG o SVG desde Estrategia; el servidor validará tipo y tamaño, guardará el archivo bajo un identificador administrado por QvaApply y devolverá una URL interna. También podrá retirar el icono. La interfaz mostrará una inicial derivada del nombre cuando no exista imagen.

El header, Capital, Mercados, Cacería y Gráficas recorrerán la lista pública de mercados en vez de mantener códigos e iconos fijos. El header mostrará QUSD y después todos los mercados activos. Los mercados inactivos permanecerán configurados, pero no ocuparán el header ni serán escaneados.

Telegram resolverá dinámicamente el código y el nombre de los mercados configurados. Los alias heredados podrán mantenerse por compatibilidad, pero ningún mercado nuevo requerirá modificar código ni reiniciar el servicio.

Guardar una revisión actualizará el servicio de configuración en memoria. La siguiente actualización del dashboard y el siguiente ciclo del bot usarán la nueva lista inmediatamente.

## Reajuste persistente

El problema actual nace de una solicitud síncrona: antes de aplicar se refrescan las ofertas y cada edición vuelve a listar ofertas una o dos veces. Las mutaciones se serializan con una separación de hasta veinte segundos, mientras el navegador cancela la solicitud completa a los sesenta segundos. El servidor puede continuar trabajando después de que el modal informe un timeout.

El nuevo flujo validará una única instantánea y persistirá un trabajo de reajuste con sus ajustes. El endpoint responderá inmediatamente y un ejecutor en segundo plano procesará las mutaciones una por una, respetando el límite de QvaPay. Sus estados serán pendiente, aplicando, completado, parcial o requiere conciliación.

El modal consultará el progreso, podrá cerrarse durante la ejecución y no dependerá de una conexión HTTP abierta. Cada ajuste reutilizará la instantánea validada para evitar lecturas redundantes. Si una mutación no recibe confirmación, el sistema comprobará el estado remoto antes de continuar y nunca repetirá una edición a ciegas. Los trabajos incompletos se retomarán al arrancar.

Al completar o requerir atención, el reajuste generará un aviso persistente usando la infraestructura de notificaciones existente.

## Seguridad y validación

- Los iconos tendrán lista permitida de MIME, límite de tamaño, nombre generado y protección contra rutas arbitrarias; SVG será saneado o rechazado si contiene contenido activo.
- Los códigos seguirán siendo únicos y compatibles con QvaPay.
- Se probarán mercados nuevos en configuración, dashboard, header y resolución de Telegram.
- Se probarán cargas válidas e inválidas y el fallback visual.
- Se probarán reajustes lentos, resultados inciertos, progreso parcial y reanudación tras reinicio.
- La verificación final incluirá tipos, análisis estático, pruebas y builds de servidor y web.
