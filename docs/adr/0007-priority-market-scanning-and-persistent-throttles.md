# ADR 0007: escaneo priorizado y límites remotos persistentes

## Contexto

QvaPay limita el listado P2P a 30 solicitudes por minuto, `apply` a dos por minuto y `edit`/`cancel` a una por 20 segundos. Consultar solo las 20 ofertas recientes omitía tasas favorables y recorrer todas las ofertas propias en una tarea larga hacía difícil observar y recuperar el proceso.

## Decisión

- Consultar hasta 100 ofertas con lado, mercado y `best_rate` explícitos.
- Consultar `sell` en cada ronda de 15 segundos y `buy` en rondas alternas.
- Compartir una cola de transporte entre escáner, sincronización y panel.
- Persistir en SQLite el inicio de cada mutación limitada antes de enviarla.
- Aplicar como máximo una oportunidad por ronda.
- Refrescar una sola oferta propia por ejecución, eligiendo la vencida más antigua.

## Consecuencias

Se amplía la cobertura sin exceder la cuota documentada, un reinicio no permite ráfagas de mutaciones y el scheduler no queda ocupado refrescando una lista completa. La venta de QUSD puede detectarse hasta una ronda más tarde que la compra de QUSD; es el margen reservado para sincronización y lecturas del panel.

La fuente contractual es la documentación oficial de QvaPay: `/docs/p2p/list`, `/docs/p2p/apply`, `/docs/p2p/edit` y `/docs/p2p/cancel`.
