# Diseño: sistema visual unificado para componentes QvaApply

## Objetivo

Convertir las ocho vistas del panel en una interfaz coherente, compacta y accesible, con una navegación lateral pequeña y un lenguaje de superficies tipo Apple: jerarquía por espacio y contraste, no por sombras o colores saturados.

## Alcance y orden

1. Centralizar tokens y primitivas visuales en CSS compartido.
2. Ajustar el shell: sidebar compacta, cabecera, responsive y estados de conexión.
3. Normalizar paneles de datos: métricas, tablas, tarjetas, listas, badges y paginación.
4. Normalizar formularios y acciones críticas: campos, validación, diálogos y estados asíncronos.
5. Adaptar gráficas, skeletons, estados vacíos y errores a ambos temas.
6. Verificar tamaños de viewport, teclado, contraste, typecheck, tests, build y smoke visual.

## Restricciones

- Mantener React, Vite y CSS existente; no añadir una biblioteca de UI pesada.
- No modificar reglas de negocio, llamadas financieras ni contratos de QvaPay.
- Conservar la información completa y el historial; solo cambiar presentación y composición.
- Todos los botones deben conservar objetivos táctiles mínimos de 44 px y foco visible.

## Patrón de componentes

Las features seguirán usando `Panel`, `Empty`, `Skeleton` y `Freshness` como primitives. Las variantes se expresarán mediante clases semánticas (`primary`, `secondary`, `danger`, `buy`, `sell`, `warning`) y variables CSS; no mediante colores directos por pantalla.

## Verificación

- Tests de regresión para cada cambio de comportamiento accidental.
- `pnpm typecheck`, `pnpm test`, `pnpm build` y `pnpm check:secrets`.
- Revisión manual en 375, 768, 1024 y 1440 px, en claro y oscuro.

