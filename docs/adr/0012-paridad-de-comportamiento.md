# ADR-0012: paridad de comportamiento como condición de despliegue

Estado: aceptado
Fecha: 2026-11-12

## Contexto

QvaApply se migra de TypeScript a Go conservando un dominio financiero frágil:
718 casos de test, invariantes de dinero no negociables, integraciones externas
que fallan de forma ambigua y un operador único que no puede permitirse un
incidente de doble gasto. La reescritura introduce un riesgo nuevo: **la
implementación nueva puede ser internamente correcta y, aun así, decidir
distinto** por un redondeo, un orden de eventos, un timeout o una clasificación
de error.

Una migración validada solo con "tests del lenguaje nuevo" no demuestra
equivalencia: demuestra que el código nuevo cumple los tests nuevos. La suite
actual es la única especificación completa del comportamiento observable.

## Decisión

1. **La suite actual se reutiliza como oráculo**, no como algo a sustituir. Cada
   caso se clasifica en una matriz de paridad y se cubre con: test portado,
   fixture dorado, test de contrato, property test, cobertura UI o descarte
   justificado y revisado. No se permite "lo cubre el test nuevo equivalente"
   sin evidencia.
2. **Se construye un arnés de paridad cross-language** antes de portar lógica de
   negocio: fixtures canónicos (importes como string decimal, reloj inyectable,
   orden normalizado, IDs deterministas), runner que ejecuta cualquier
   implementación por CLI/HTTP, y fake QvaPay determinista con inyección de
   fallos.
3. **Los contratos de frontera (K1–K14) son obligatorios** para ambas
   implementaciones. Una diferencia de envelope, código HTTP, clasificación de
   error o dedupe es un fallo, no una variante.
4. **Invariantes de dinero como propiedades ejecutables y como auditor
   independiente**: reserva única, sin doble gasto, intención antes de mutación,
   incierto sin reintento, compensación solo tras rechazo confirmado, redondeo
   idempotente.
5. **Comparación diferencial en shadow** contra producción antes de cualquier
   mutación real: ≥ 99,9 % de decisiones idénticas durante 7 días consecutivos y
   0 divergencias sin explicar.
6. **La regeneración de fixtures es un acto revisado**, con hash, diff y
   aprobación independiente. Prohibido regenerar para que un test pase.
7. **Ninguna fase avanza sin su gate** y el gate no lo firma quien implementó.

## Consecuencias

- Se invierte tiempo en infraestructura de verificación antes de escribir el
  servicio real (F0/F1 del [roadmap](../migration/roadmap.md)). Es
  deliberado: es el seguro más barato del proyecto.
- El corpus de fixtures y la matriz de paridad se convierten en el activo de
  conocimiento del sistema; sobreviven a la retirada de TypeScript.
- La migración es más lenta que un port directo, pero cada paso es reversible y
  medible.
- Los tests de contrato y el fake QvaPay son reutilizables para cualquier
  lenguaje futuro (incluida una pieza en Rust si algún día se justifica).
- El coste de añadir features durante la migración crece (hay que actualizar
  oráculo y fixtures); por eso el alcance funcional queda congelado.

## Alternativas consideradas

- **Port directo con tests nuevos del lenguaje.** Rápido, pero no demuestra
  equivalencia; los errores de redondeo y de clasificación de errores son los
  más probables y los que más daño hacen.
- **Solo shadow sin fixtures.** Detecta divergencias en lo que ocurre en
  producción, pero no cubre casos raros (429, respuestas ambiguas, caos) que no
  aparecen en la ventana de observación.
- **Solo fixtures sin shadow.** No valida el comportamiento bajo datos y
  condiciones reales, ni el rendimiento.

La decisión combina las tres capas porque cada una cubre un riesgo distinto.
