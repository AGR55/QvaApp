# Diseño: migración gradual de UI/UX a Shadcn

## Objetivo

Reemplazar progresivamente el sistema visual propio de QvaApply por componentes
Shadcn y Tailwind, conservando íntegramente la lógica, los flujos operativos,
las rutas de datos y los dos temas existentes. El resultado será una interfaz
minimalista, sobria y consistente, inspirada en las superficies de Vercel,
Shadcn y la documentación de QvaPay.

## Base técnica

- Instalar Tailwind CSS y configurar Shadcn sobre React/Vite.
- Usar la variante Radix de Shadcn. Aporta primitivas estables y accesibles para
  diálogos, menús, selectores, popovers y controles por teclado.
- Definir tokens semánticos para claro y oscuro, tipografía sans de alta
  legibilidad, bordes discretos, sombras mínimas y una escala única de espacio.
- Mantener Lucide como biblioteca de iconos.

## Estrategia de migración

La migración será incremental. Una capa de adaptadores conservará inicialmente
las props públicas de `Button`, `Input`, `Select`, `Textarea`, `Field`,
`Badge`, `Panel` y `Tabs`, mientras su implementación pasa a Shadcn. Esto evita
cambios en el estado, las peticiones HTTP y las reglas de negocio de las vistas.

El orden de trabajo será:

1. Tailwind, tokens y componentes primitivos.
2. Estructura de aplicación, navegación y feedback global.
3. Estrategia, capital, operaciones y cacería.
4. Mercado, gráficas y auditoría.
5. Sustitución de modales, tablas, color picker y controles restantes.
6. Eliminación del CSS legado que ya no tenga referencias.

## Composición visual

Las secciones usarán tarjetas completas y no minicards por campo. En
Estrategia, cada bloque de riesgo, automatización, mercados e historial tendrá
una sola tarjeta con cabecera, descripción, campos agrupados y acciones al pie.
Los campos conservarán etiquetas, unidades, mensajes de validación y orden de
tabulación.

Las tablas, gráficos, alertas, cargas, vacíos y errores mantendrán toda la
información actual, pero se expresarán con los componentes y tokens de la base
nueva. El selector de tema claro/oscuro permanece disponible.

## Protección contra regresiones

- No modificar contratos de API, estado de React ni lógica de dominio durante
  una migración visual.
- Ejecutar typecheck y pruebas después de cada etapa.
- Añadir pruebas de estructura para la composición crítica y pruebas de
  accesibilidad donde se introduzcan controles interactivos.
- Verificar visualmente escritorio y móvil, incluyendo foco visible, diálogos,
  ausencia de desplazamiento horizontal y tema claro/oscuro.
