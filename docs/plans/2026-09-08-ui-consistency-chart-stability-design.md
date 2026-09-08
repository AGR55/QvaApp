# Diseño de coherencia visual y estabilidad de gráficas

## Objetivo

Completar la migración visual de QvaApply al sistema claro aprobado, eliminando los componentes, estilos y separaciones heredados que todavía conviven con la nueva interfaz. Evitar además que una actualización de datos de las gráficas ensanche temporalmente la página antes de recuperar su tamaño.

## Dirección visual

Toda la aplicación usará superficies claras, fondo gris azulado, azul como acción principal y colores semánticos reservados para éxito, advertencia y peligro. Los bloques verde oscuro, tipografía serif decorativa, monoespaciado ornamental, colores cálidos hardcodeados, radios rectos y sombras antiguas se retirarán.

La interfaz conservará densidad suficiente para operar, pero con jerarquía clara, cifras tabulares, textos legibles y aire consistente. Ninguna sección tendrá una identidad visual aislada.

## Arquitectura de interfaz

Cada vista tendrá un contenedor `page-stack` y usará los mismos primitives para:

- cabeceras y ayudas contextuales;
- paneles y superficies secundarias;
- métricas y comparaciones numéricas;
- botones primarios, secundarios, de texto y destructivos;
- campos, selectores, switches y barras de acción;
- badges, mensajes, estados vacíos y carga;
- diálogos y confirmaciones.

La escala de separación será 4, 8, 12, 16, 20, 24 y 32 px. Los layouts usarán Grid con columnas `minmax(0, 1fr)`, hijos con `min-width: 0` y puntos de ruptura compartidos. Las acciones relacionadas permanecerán agrupadas y las secciones distintas conservarán una separación visible.

## Revisión por páginas

- **Acceso:** card, campo y acción principal alineados con el shell.
- **Cockpit:** controles operativos, decisión actual, mercados, riesgo y alertas sobre superficies claras.
- **Mercados:** tabs, tabla, badges y estados de carga con el sistema común.
- **Capital:** saldos, listado, editor y confirmación destructiva sin estilos editoriales heredados.
- **Cacería:** comando general, controles por mercado, switches y registro de capturas sin fondo oscuro ni beige.
- **Operaciones:** tablas, workflows, alertas y diálogo de acción financiera consistentes.
- **Gráficas:** selector, leyenda, tooltip, ejes y contenedor estables y claros.
- **Estrategia:** política global, formularios, mercados, detalles de pago, revisión y revisiones históricas unificados.
- **Auditoría:** salud, reservas, mutaciones, historial, cards bloqueadas y diálogos conservan el sistema ya renovado.

## Estabilidad de gráficas

Primero se reproducirá el cambio de anchura al sustituir datos en la vista activa. Se medirá `clientWidth`, `scrollWidth` y el rectángulo del contenedor durante varios frames para localizar si el cambio nace en Recharts, la leyenda, el selector o la grid exterior.

La corrección mantendrá estable la caja antes, durante y después de actualizar:

- wrapper con `width: 100%`, `min-width: 0`, altura definida y overflow contenido;
- hijos flex/grid autorizados a encogerse;
- identidad React estable para no remontar el gráfico;
- animación de series desactivada durante actualizaciones, evitando interpolaciones geométricas que afecten el layout;
- etiquetas, tooltip y leyenda sin anchuras intrínsecas capaces de expandir el documento.

Se respetará `prefers-reduced-motion` y la visualización seguirá actualizando los valores inmediatamente.

## Limpieza técnica

Los overrides acumulados se consolidarán por responsabilidad. Los archivos correctivos antiguos que ya no tengan consumidores se eliminarán o absorberán en el sistema global. No se cambiará React, Recharts ni la arquitectura de datos y no se añadirán dependencias.

## Verificación

El smoke visual navegará por todas las páginas en escritorio y móvil, capturará cada vista y comprobará:

- ausencia de overflow horizontal;
- separación y alineación de componentes;
- controles con nombre accesible y foco visible;
- ausencia de infracciones WCAG serias;
- estabilidad del ancho de Gráficas durante una actualización de datos;
- funcionamiento de editores, confirmaciones y diálogos clave.

La entrega deberá pasar typecheck, suite completa, builds, comprobación de secretos, `git diff --check` e inspección visual de las capturas.
