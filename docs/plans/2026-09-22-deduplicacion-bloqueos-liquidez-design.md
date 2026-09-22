# Diseño: deduplicación de bloqueos por liquidez

## Problema

Cuando una oferta apta por precio falla la evaluación de riesgo o liquidez, el
escáner persiste la decisión pero vuelve a enviar la misma notificación en cada
ronda. A diferencia de otros rechazos definitivos, este caso no puede marcar la
oferta como vista permanentemente: el saldo o las ofertas propias pueden cambiar
y hacer que la operación sea válida más adelante.

## Decisión

El motor continuará reevaluando la oferta en cada ronda, pero notificará un
bloqueo solamente cuando la decisión persistida sea nueva o haya cambiado. Una
decisión se considera igual cuando conserva el UUID, los datos económicos de la
oferta, el motivo del bloqueo y la referencia de mercado.

La comparación se hará contra la alerta bloqueada que ya vive en SQLite. Se
leerá la alerta anterior antes de actualizarla; después se conservarán el evento
de decisión, la alerta y la auditoría actuales, pero la notificación a Telegram
solo se enviará si la instantánea cambió. No se usará `seen_offers` para este
caso, porque eso impediría un intento posterior cuando mejore la liquidez.

## Flujo

1. El escáner vuelve a evaluar una oferta candidata no aplicada.
2. Si riesgo o liquidez la bloquean, genera la instantánea bloqueada.
3. Compara esa instantánea con la alerta persistida anterior.
4. Persiste la decisión y la alerta para mantener la trazabilidad.
5. Notifica únicamente si no existía una alerta bloqueada equivalente.
6. Si en una ronda posterior cambian las condiciones y la evaluación permite
   aplicar, la oferta sigue disponible para el flujo automático normal.

## Pruebas

- Dos escaneos con la misma oferta y el mismo déficit producen una sola
  notificación de bloqueo.
- Tras el primer bloqueo, una mejora del saldo permite que la misma oferta sea
  aplicada en una ronda posterior.
- La suite completa y el chequeo de tipos deben permanecer verdes.

## Integración

El cambio se desarrollará y verificará sobre `develop`. Después se fusionará
`develop` en `main` mediante un commit de merge, sin incorporar la rama de
trabajo ni los cambios locales preexistentes del directorio principal.
