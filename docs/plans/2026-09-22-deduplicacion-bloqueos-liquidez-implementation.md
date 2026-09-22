# Plan de implementación: deduplicación de bloqueos por liquidez

1. Añadir una prueba de regresión en `test/trading-automation.test.ts` que
   simule la misma oferta después de vencer el cooldown actual y exija una sola
   notificación para una decisión idéntica.
2. Añadir una prueba que mantenga la oferta abierta, mejore el saldo QUSD y
   confirme que el escáner puede aplicarla en una ronda posterior.
3. Sustituir en `TradingEngine.notifyRiskBlock` el cooldown temporal por una
   huella persistente de la instantánea bloqueada (UUID, datos económicos,
   motivo y referencia de mercado).
4. Ejecutar primero la prueba focalizada, luego typecheck y la verificación
   completa del proyecto.
5. Registrar el arreglo en `develop`, fusionar `develop` en `main` con un commit
   de merge y verificar de nuevo el historial y el estado de ambas ramas.
