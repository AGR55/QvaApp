# Diseño: decodificación decimal de ofertas QvaPay

Fecha: 2026-09-07

## Problema

`GET /p2p` documenta `amount`, `receive` y otros decimales como strings JSON. El adaptador local solo aceptaba números JSON y bloqueaba `fiat_sync` antes de llegar al dominio.

## Decisión

Normalizar en `src/qvapay.ts` números finitos positivos y strings decimales canónicos positivos. El resultado entregado al dominio siempre será `number`. Se rechazan cero, negativos, notación no decimal, cadenas vacías, `NaN` e infinitos.

No se amplían los tipos del dominio y no se introduce una excepción particular en `fiat_sync`; todos los consumidores de ofertas reciben el mismo contrato normalizado.

## Verificación

Añadir fixtures contractuales equivalentes a `GET /p2p`, cubrir números y strings válidos, y conservar pruebas de rechazo para entradas ambiguas o no positivas. Ejecutar la suite completa, builds y escáner de secretos.
