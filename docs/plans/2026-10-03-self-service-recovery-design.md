# Recuperación autoservicio y descarte masivo

Diseño aprobado por el propietario el 2026-10-03: sección web para auditar y
resolver bloqueos; añadir «Descartar todos» a las ofertas bloqueadas de Auditoría.

## Separación

- Decisiones de ofertas bloqueadas: descartar significa resolver avisos, no borrar
  historial ni aplicar/cancelar ofertas. Una transacción resuelve las versiones
  pendientes existentes al abrir la confirmación, incluidas todas las páginas.
  Nuevas versiones posteriores no se descartan inadvertidamente.
- Intenciones monetarias inciertas: panel independiente con intención, operación,
  workflow, exposición, último error, evidencia del feed y reintento programado.
  Comprobar ahora fuerza una conciliación acotada sin repetir la mutación.

## Resolución humana

El propietario puede registrar una comprobación manual concreta de una aplicación
independiente no realizada/cancelada. Requiere confirmación explícita, versión
vigente de la intención, explicación y evidencia escrita de la comprobación en
QvaPay. Se distingue la declaración del operador de la confirmación remota.
No se permiten cierres manuales de pagos/recepciones, workflows compensables,
operaciones pagadas o en revisión, ni contradicciones con evidencia remota activa.
No existe limpieza global de intenciones ni modificación del saldo fiat.
Una oferta abierta solo permite declarar una aplicación no realizada, nunca una
cancelación. Una conciliación en curso impide la resolución manual concurrente.
Las comprobaciones remotas manuales comparten una espera mínima persistente de
10 segundos; el motor automático conserva su propio calendario de reintentos.

Lecturas locales permiten auditar incluso sin QvaPay. La recuperación usa la
autenticación, autorización y CSRF existentes. Una acción registra actor, fecha,
alcance y motivo; revisiones obsoletas y doble envío se rechazan o son idempotentes.

## Implementación y comprobación

1. Módulo central para inspección/conciliación/revisión de intención y tests.
2. Descarte transaccional de decisiones bloqueadas por cursor de versión y tests
   de más de 20 registros, cambios concurrentes y conservación de otros estados.
3. Adaptador HTTP autorizado y panel web compacto reutilizando controles locales.
4. Tests de permisos, validación, fallos remotos, concurrencia y no duplicar dinero.
5. Revisión principal, pnpm check, prueba visual, CI y despliegue verificado.

WhatsApp queda fuera: no hay integración instalada. No se cambian umbrales de
precio ni reglas de fiat suficiente. La skill writing-plans no está disponible;
este documento incluye el plan de implementación como alternativa.
