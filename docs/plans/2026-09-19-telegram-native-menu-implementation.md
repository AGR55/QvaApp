# Plan de implementación del menú nativo de Telegram

## 1. Extraer un modelo comprobable del menú

- Crear `src/telegram-menu.ts` con el catálogo completo de comandos, tipos de acciones de cacería, codificación/decodificación de callbacks y el estado seguro de edición de tasas.
- Mantener los callbacks por debajo del límite de Telegram y resolver mercados dinámicos sin asumir una lista fija.
- Añadir `test/telegram-menu.test.ts` para comandos, callbacks, valores exactos, confirmación y cancelación.

## 2. Registrar el menú nativo

- Registrar los comandos para el chat administrador mediante `setMyCommands`.
- Configurar el botón de menú como menú de comandos mediante `setChatMenuButton`.
- Hacer el registro tolerante a fallos: auditar y continuar con el arranque del bot.
- Añadir una regresión arquitectónica que compruebe que el arranque conserva esta configuración.

## 3. Completar la navegación del bot

- Añadir comandos de acceso para Cacería, Mercados, Operaciones, Estrategia y Automatización.
- Reutilizar las vistas existentes para Estado, Saldo, Ofertas, Escaneo, Logs y Ayuda.
- Incorporar todos los accesos en el panel inline existente para que el menú nativo y `/start` sean coherentes.

## 4. Implementar Cacería guiada

- Renderizar el estado global de compra y venta y permitir alternar cada lado.
- Renderizar por mercado su disponibilidad, controles por lado y tasas actuales.
- Iniciar una edición de tasa solicitando texto exacto mediante respuesta forzada.
- Validar el número, mostrar valor anterior/nuevo y exigir confirmación.
- Aplicar únicamente mediante `TradingEngine.updateHunting`; cancelar o reiniciar no muta configuración.

## 5. Pruebas y entrega

- Ejecutar primero las pruebas de regresión específicas y después `pnpm check`.
- Revisar que no se altere la lógica de trading ni la autorización administrativa.
- Publicar la rama, abrir PR contra `main`, esperar CI, fusionar y seguir el despliegue automático.
- Verificar por HTTPS la revisión nueva y comprobar el registro del menú mediante los logs de producción cuando sea posible.
