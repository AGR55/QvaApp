# Diseño global de interfaz y revisión de ofertas bloqueadas

## Objetivo

Renovar toda la interfaz de QvaApply con un sistema visual único, limpio y cómodo inspirado en `design/photo_2026-09-02_16-01-55.jpg`, sin reescribir la aplicación ni alterar sus garantías operativas. Auditoría incorporará además una bandeja persistente de ofertas bloqueadas que permita descartarlas o intentar aplicarlas manualmente con trazabilidad completa.

## Dirección visual aprobada

Se aplicará un retrofit progresivo sobre el React y CSS existentes:

- fondo frío gris azulado, superficies blancas y capas suaves;
- azul como único color de acción; verde, ámbar y rojo solo para estados;
- tipografía sans moderna, jerarquía compacta y números tabulares;
- contenedores amplios con radios suaves y controles internos más contenidos;
- navegación lateral flotante en escritorio y navegación inferior en móvil;
- espaciado basado en 4/8/12/16/24/32 px, ancho máximo legible y márgenes móviles seguros;
- estados de carga, vacío, error, éxito, foco, hover y pulsación coherentes;
- diálogos, formularios, selectores y confirmaciones propios en lugar de controles o avisos nativos sin diseño.

La referencia será una guía de lenguaje visual, no una copia literal de una pantalla móvil. Se conservarán la densidad y legibilidad necesarias para un panel financiero de escritorio.

## Sistema de componentes

Los componentes compartidos cubrirán `AppShell`, cabecera de página, superficies, métricas, insignias de estado, botones, campos, barras de acción, mensajes de estado, esqueletos, estados vacíos y diálogos. Las pantallas existentes se migrarán a estos primitives sin cambiar sus contratos de datos.

El trabajo alcanzará inicio de sesión, Cockpit, Mercados, Capital, Cacería, Operaciones, Gráficas, Estrategia y Auditoría. Capital conservará sus componentes dedicados para crear, editar y cancelar; Estrategia recibirá la misma composición y ritmo visual; las gráficas conservarán el dominio ajustado a sus valores para que las diferencias sigan siendo perceptibles.

## Bandeja de ofertas bloqueadas

`trading_alerts` se ampliará para aceptar la decisión `blocked`. Cada bloqueo por precio o mediana guardará una instantánea con UUID, mercado, lado, cantidad, importe, tasa, referencia disponible, motivo y fechas. Una nueva resolución explícita distinguirá entre descartada, aplicada, expirada o resuelta automáticamente.

Auditoría se organizará en dos zonas: el historial cronológico principal y, a su lado en escritorio, una columna de revisión. Cada card bloqueada mostrará:

- compra o venta desde la perspectiva del usuario;
- mercado, QUSD, fiat, tasa ofrecida y mediana de referencia;
- diferencia porcentual frente a la mediana;
- motivo exacto del bloqueo y antigüedad de los datos;
- botones `Descartar` y `Revisar y aplicar`.

En móvil, la columna se apilará antes del historial para que las decisiones pendientes tengan prioridad. Descartar abrirá una confirmación breve, resolverá la card y registrará la acción. Las ofertas resueltas dejarán de ocupar la bandeja activa, pero permanecerán en el historial de auditoría.

## Aplicación manual segura

`Revisar y aplicar` abrirá un diálogo con el impacto económico, la mediana, la desviación, la liquidez necesaria y las ofertas propias que habría que cancelar. La confirmación enviará una intención explícita de anular únicamente la regla de precio/mediana.

La ejecución reutilizará la política de riesgo y, para ventas de QUSD que requieran liberar saldo, el orquestador compensable existente. La anulación manual no permitirá evitar:

- saldo o reserva insuficiente;
- límites de exposición, volumen diario u operaciones simultáneas;
- parada de emergencia, pausa operativa o modo simulación;
- mutaciones remotas sin resolver;
- enfriamientos, estado remoto no operable u otras protecciones de seguridad.

Antes de aplicar se volverá a consultar la oferta. Si cambió, cerró o dejó de ser compatible, la operación se rechazará sin cancelar ofertas propias. Cuando sea necesario liberar QUSD, el sistema planificará y persistirá las cancelaciones, reservará capital, cancelará las ofertas propias, aplicará a la externa y restaurará las ofertas canceladas si la aplicación es rechazada. Los estados inciertos exigirán reconciliación y nunca se ocultarán como éxito.

## Auditoría y estados

Se registrarán como mínimo: apertura de revisión, descarte, solicitud de anulación de precio, resultado de la reevaluación de seguridad, reserva de capital, cancelaciones propias, intento de aplicación, confirmación, rechazo, compensación, restauración y reconciliación. El usuario verá progreso y resultado dentro del diálogo/card, sin depender de alertas del navegador.

Los botones quedarán deshabilitados durante una mutación y la UI evitará envíos duplicados. Después de cada acción se recargará el snapshot local; la fuente de verdad seguirá siendo SQLite.

## API y persistencia

Se añadirán operaciones locales autenticadas y protegidas por CSRF para:

- descartar una oferta bloqueada;
- obtener una previsualización actualizada de la aplicación manual;
- confirmar la aplicación con `overridePriceGuard: true`.

La previsualización no mutará estado remoto. La confirmación será la única ruta capaz de iniciar el workflow compensable. Las entradas antiguas se resolverán cuando un barrido posterior ya no encuentre la oferta abierta, sin borrar su historial.

## Accesibilidad y rendimiento

Toda acción tendrá nombre accesible, foco visible, navegación por teclado y mensajes `aria-live`. Los diálogos gestionarán foco y cierre por Escape cuando no exista una mutación en curso. Se respetará `prefers-reduced-motion`. Las listas extensas usarán renderizado contenido y los cálculos derivados se harán durante render o se memorizarán solo cuando sean costosos.

## Verificación

La entrega requerirá pruebas de persistencia y resolución de bloqueos, autorización de override, rechazo de cualquier bypass de seguridad, compensación de ofertas propias, endpoints HTTP y prevención de doble envío. También deberá pasar typecheck, suite completa, builds, comprobación de secretos, smoke visual de escritorio y móvil, y auditoría automatizada de accesibilidad.
