# QvaApply: centro de control de cacería

Fecha: 2026-09-08  
Estado: aprobado por el propietario

## Objetivo

Crear una sección web dedicada a controlar y observar la búsqueda automática de oportunidades P2P. El administrador podrá iniciar o detener por separado la cacería de compra y de venta en cada mercado, ajustar sus precios objetivo, revisar las aplicaciones realizadas por el bot y cancelar las operaciones que todavía lo permitan.

En este contexto, **cazar** significa aplicar a una oferta externa cuyo precio cumple la estrategia y todas las políticas de riesgo. Detener una cacería solo impide nuevas aplicaciones; nunca cancela operaciones existentes.

## Enfoques considerados

### Perfil persistente por mercado — elegido

Cada mercado conserva interruptores independientes para compra y venta junto a sus precios objetivo. El motor consulta esa misma configuración antes de clasificar o aplicar ofertas. La web y el bot comparten una única fuente de verdad.

### Filtros exclusivos de la interfaz

La web podría ocultar mercados o simular controles sin cambiar el dominio. Se descarta porque un reinicio, Telegram o el scheduler podrían continuar cazando fuera de lo mostrado en el panel.

### Sesiones de cacería como entidad completa

Cada inicio crearía una sesión con mercados, presupuesto y fechas propias. Aporta analítica histórica adicional, pero introduce estados y recuperación innecesarios para el control solicitado actualmente.

## Comportamiento funcional

- Compra y venta se activan o detienen de forma independiente.
- Cada mercado puede participar en ninguna, una o ambas cacerías.
- Cada mercado mantiene un precio máximo de compra y un precio mínimo de venta.
- La pausa global permanece como interruptor maestro y la parada de emergencia mantiene prioridad absoluta.
- Detener un mercado o un lado impide nuevas aplicaciones desde el siguiente escaneo.
- Las operaciones ya iniciadas permanecen visibles y siguen su flujo normal.
- Los límites globales de riesgo, exposición, liquidez, antigüedad, mediana y deslizamiento continúan siendo obligatorios.

## Configuración y persistencia

Cada mercado incorporará dos propiedades persistentes:

- `huntBuyEnabled`: permite aplicar a ofertas externas de venta para comprar QUSD.
- `huntSellEnabled`: permite aplicar a ofertas externas de compra para vender QUSD.

Los precios de caza reutilizan `buyMaxRate` y `sellMinRate`. Así, Cacería y Estrategia no crean valores divergentes. Los cambios se guardan mediante la configuración versionada y quedan incluidos en la cadena de revisiones.

La migración asignará ambos interruptores según el estado activo actual del mercado. Esto conserva el comportamiento de instalaciones existentes. Un mercado globalmente inactivo nunca se escanea aunque uno de sus interruptores de cacería estuviera activo.

## Flujo del motor

Antes de solicitar ofertas de cada lado, el escáner filtra por mercado activo y cacería habilitada. La clasificación conserva sus reglas actuales:

```text
mercado activo
  → lado de cacería habilitado
  → precio objetivo cumplido
  → mediana válida y cortafuegos superado
  → capital y límites de riesgo disponibles
  → aplicación externa
  → operación durable y auditable
```

Los lados deshabilitados no producen candidatos, alertas de oportunidad ni aplicaciones. El historial de cobertura indicará qué lados se inspeccionaron para que el panel no confunda una cacería detenida con un fallo de red.

## Interfaz de Cacería

La navegación añade una sección **Cacería** con tres zonas:

1. **Cabecera operativa**: estado maestro, modo real o simulación, último escaneo y acciones para iniciar o detener todas las cacerías habilitadas.
2. **Mesa por mercados**: una fila o bloque por mercado con controles independientes de compra y venta, precios objetivo, mediana actual, disponibilidad y estado. Guardar un cambio actualiza la configuración versionada. Los controles muestran progreso, éxito o error sin diálogos nativos.
3. **Registro de capturas**: operaciones automáticas en orden reciente con lado, mercado, QUSD, fiat, tasa, mediana de referencia, fecha, estado y acción disponible.

Los estados activos se distinguen por texto, icono y color. En móvil, los controles de cada mercado se apilan sin tablas rígidas; el registro usa tarjetas compactas. Los números usan cifras tabulares.

## Cancelación

Una operación solo presenta **Cancelar aplicación** cuando su estado permite cancelación. La acción abre un diálogo dedicado con mercado, lado, importe, tasa y advertencia. Al confirmar, reutiliza el comando de cancelación existente y su auditoría.

Si QvaPay devuelve un resultado incierto, la interfaz no afirma que se canceló: muestra que requiere conciliación y el motor conserva las reservas y bloquea nuevas mutaciones hasta conocer el estado remoto.

## Errores y concurrencia

- Los controles se deshabilitan mientras guardan para evitar escrituras duplicadas.
- Si un guardado falla, la interfaz conserva el último estado confirmado y muestra un error contextual.
- Un escaneo iniciado justo antes de detener una cacería vuelve a comprobar la configuración antes de mutar, evitando una aplicación posterior a la orden de detención.
- Una mutación remota sin resolver bloquea nuevas aplicaciones, pero no impide consultar ni detener cacerías.
- La parada de emergencia conserva prioridad sobre cualquier control local de Cacería.

## Pruebas

- Migración y persistencia de los dos interruptores por mercado.
- Compra y venta habilitadas o detenidas independientemente.
- Selección distinta para BANK_CUP, BANDECPREPAGO y CLASICA.
- Revalidación del interruptor antes de la mutación remota.
- Actualización inmediata de precios objetivo.
- Registro correcto de aplicaciones automáticas y estados terminales.
- Cancelación permitida, rechazada e incierta.
- Contratos HTTP y validación de entradas.
- Interfaz de escritorio y móvil sin desbordamiento.
- Foco, etiquetas, confirmación y estados de error accesibles.
