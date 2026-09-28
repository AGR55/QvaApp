# Diseño: optimización conservadora de calidad y rendimiento

Fecha: 2026-09-28

## Contexto

QvaApply ya cuenta con una suite amplia, un monolito modular documentado y
garantías explícitas para las operaciones con dinero real. La auditoría inicial
encontró oportunidades acotadas en el panel, la persistencia y las herramientas
de análisis sin necesidad de cambiar la política de riesgo ni los workflows
financieros.

La línea base aprobada es: 224 pruebas correctas, 89,53 % de cobertura de
líneas, build completo correcto y ninguna vulnerabilidad conocida en las
dependencias.

## Decisión

Aplicar las mejoras por bloques pequeños y verificables. Esta primera fase no
modifica Intenciones monetarias, conciliaciones, compensaciones ni reglas de
riesgo.

### Código muerto y herramientas

Knip dejará de considerar cada archivo de `web/components/ui` como una entrada.
Solo se eliminarán módulos y dependencias que, después de corregir esa
configuración, permanezcan sin consumidores. TypeScript, Knip y el build serán
la evidencia de que la limpieza no rompe imports dinámicos ni componentes
registrados indirectamente.

### Seguridad HTTP

Los fallos de dominio causados por entrada del usuario conservarán respuestas
4xx seguras. Los fallos internos inesperados mantendrán categoría 5xx y no
expondrán mensajes de SQLite, rutas locales ni detalles de implementación.

La página no declarará recursos externos que contradigan su CSP. Se conservará
la política restrictiva y se usará una pila tipográfica local del sistema en vez
de ampliar los orígenes permitidos.

### Rendimiento web

Las vistas grandes que no participan en el primer render se cargarán por ruta
mediante chunks diferidos. El estado de sesión, el snapshot local-first y los
controles esenciales seguirán en el bundle inicial. Cada carga diferida tendrá
un fallback accesible y no alterará la navegación ni el manejo de errores.

### Rendimiento SQLite

Una migración aditiva creará índices para las ventanas temporales realmente
usadas por el historial del panel. No cambiará filas ni contratos de lectura.
Las consultas se comprobarán con planes de SQLite y pruebas de migración.

La composición de la instantánea local reutilizará dentro de una misma llamada
los resultados que actualmente se consultan más de una vez. Se conservará la
interfaz de `DashboardReadModel` y el modelo local-first del ADR-0006.

## Manejo de errores

Las optimizaciones deben fallar de forma cerrada: un error interno del servidor
se registra y responde con un mensaje genérico; una carga diferida fallida no
expone datos; una migración permanece dentro de la transacción y conserva el
backup previo ya establecido.

## Verificación

Cada bloque incluirá o ajustará pruebas específicas. Después de cada cambio se
ejecutará el subconjunto relevante y, al finalizar, `pnpm check` completo,
reporte de cobertura y comparación de tamaños del build. El archivo no
rastreado `public/icons/zelle.png` queda fuera de todos los cambios.

## Trabajo posterior fuera de esta fase

Quedan como candidatos separados la unificación del módulo de Intención
monetaria, la reparación de los seams de dominio y prueba, y la separación
interna de `Store`, Telegram y scheduling. Se abordarán únicamente en otra fase
con pruebas específicas de resultados inciertos y conciliación.
