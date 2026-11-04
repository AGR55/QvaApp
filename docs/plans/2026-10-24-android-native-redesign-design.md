# Rediseño Android: Preciso azul y menta

## Diseño aprobado

El usuario aprobó el 24 de octubre de 2026 un rediseño completo de la APK: lenguaje nativo Android, menos texto, más representación visual, iconografía profesional consistente, chat a pantalla completa y temas claro/oscuro. Sus cinco referencias inspiran la jerarquía, las filas compactas, los importes protagonistas y los accesos visuales. Se conserva la marca Preciso.

- Paleta azul Preciso con acentos menta y superficies claras; equivalente oscuro con contraste suficiente. Tipografía sans, cifras legibles y jerarquía compacta.
- Navegación principal: Inicio, Operaciones, Mensajes, Herramientas y Ajustes. Avisos accesibles mediante campana. Barra inferior ausente en conversaciones y detalles a pantalla completa.
- Inicio: saldo QUSD, capital por moneda, pendientes y actividad reciente. El estado de conexión se comunica discretamente; instrucciones extensas solo en vinculación o errores.
- Operaciones: filas con icono del mercado o dirección, importe, contraparte/referencia y estado. Búsqueda y filtros compactos; detalle con datos y acciones financieras existentes.
- Mensajes: lista de conversaciones con avatar de iniciales, mercado, referencia y contador. Identidad oferta + orden conservada.
- Conversación: cabecera con volver, contraparte y resumen de orden; burbujas ajustadas al contenido; mensajes ocupan el espacio restante. Campo multilínea y envío a su derecha, sobre el teclado. No repetir remitente propio en cada burbuja ni mostrar permanentemente el contador de caracteres.
- Herramientas: cuadrícula de accesos; cada consulta en su propia vista. Capital, cacerías, salud, rentabilidad, historial, diagnóstico y simulación siguen disponibles.
- Ajustes: grupos de apariencia, vinculación y SMS, con detalles desplegables para configuración avanzada. No perder permisos, cola ni credenciales al actualizar.
- Iconografía: selección pequeña de un pack vectorial coherente y con licencia conservada, empaquetada localmente. Sin cargar un catálogo completo en ejecución.

## Límites funcionales

Rediseñar presentación y navegación sin nuevas llamadas a QvaPay, modificaciones del servidor ni de las colas de cacería. Conservar FCM, destinos exactos por orden, borradores cifrados, lectura visible, confirmación de identidad y protección de acciones inciertas. No simular datos reales faltantes ni inventar curvas o ganancias.

## Plan de implementación

La skill writing-plans no está disponible; este plan explícito cubre la implementación aprobada.

1. Incorporar iconos vectoriales seleccionados, colores, tipografía y componentes nativos reutilizables.
2. Reestructurar navegación y pantallas secundarias con vuelta consistente, estado restaurable y separación visual del chat.
3. Rediseñar Inicio y Operaciones; conservar filtros, identidad de órdenes y acciones protegidas.
4. Rediseñar bandeja y conversación; comprobar teclado, texto largo, envío a la derecha, lectura visible y apertura desde FCM.
5. Adaptar Herramientas, Avisos y Ajustes a la misma jerarquía, manteniendo todas sus funciones.
6. Actualizar fixtures exclusivamente debug para revisar estados sintéticos claros/oscuros, vacíos y errores sin ejecutar acciones reales.
7. Compilar, ejecutar pruebas y lint, revisar pantallas en emulador y fuente ampliada; generar e instalar APK release con la misma firma cuando el teléfono esté conectado.
8. Publicar los cambios Android verificados sobre la revisión de producción, conservando los cambios ajenos del espacio de trabajo.
