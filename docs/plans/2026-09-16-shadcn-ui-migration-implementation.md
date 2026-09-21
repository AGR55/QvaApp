# Plan de implementación: migración gradual a Shadcn

## Etapa 1: base y compatibilidad

1. Configurar Tailwind y Shadcn/Radix para Vite.
2. Establecer tokens de tema claro y oscuro, utilidades compartidas y fuentes.
3. Incorporar los primitivos Shadcn que cubren los componentes actuales.
4. Convertir `web/components/ui.jsx` en adaptador compatible sobre esa base.
5. Ejecutar pruebas, typecheck y compilación.

## Etapa 2: marco y Estrategia

1. Migrar navegación, feedback y superficies globales.
2. Reorganizar Estrategia en tarjetas de sección completas.
3. Sustituir checkbox, color picker, campos, diálogos e historial sin cambiar
   sus peticiones ni el estado de edición.
4. Validar escritorio, móvil, temas y accesibilidad.

## Etapas posteriores

Migrar Capital, Operaciones, Cacería, Mercado, Gráficas y Auditoría en cambios
acotados. Eliminar cada bloque de CSS heredado únicamente cuando no queden
referencias funcionales o visuales.
