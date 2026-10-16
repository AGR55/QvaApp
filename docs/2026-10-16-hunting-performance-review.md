# Revisión del motor — 16 de octubre de 2026

## Diagnóstico de producción

Consultas de solo lectura, sin operaciones monetarias de prueba. Ventana de dos días; los valores describen las muestras disponibles, no garantizan tiempos futuros.

- Contenedor QvaApply: 141,1 MiB y 0,35 % de CPU durante la inspección. VPS con unos 82 GB libres y carga 0,06.
- Cacerías activas, sin pausa global; fuente híbrida sin último error de conexión.
- Última decisión: 4 ms. Cola local de aplicación: alrededor de 1 ms; sin espera de presupuesto en la última muestra. Varias respuestas remotas tardaron aproximadamente 1–1,9 s.
- Resultados registrados de aplicación: 23 confirmadas, 4 conflictos HTTP 409, 7 errores HTTP 500 y 11 ofertas pausadas.
- 6.007 eventos recibidos: retraso medio entre emisión y recepción de 1.216 ms, máximo de 98.451 ms. Se descartaron 51 oportunidades por antigüedad superior a cinco segundos.
- Persisten cinco intenciones con respuesta ambigua; una estaba reconocida. Reconocer un aviso no confirma ni repite una operación monetaria.
- El histórico de configuración ocupa aproximadamente 575 MB físicos (321 MB de JSON). Solo hubo 20 revisiones nuevas en la ventana: no indica un crecimiento acelerado actual. Se conserva el historial y se evita compactar la base en vivo durante las cacerías.

## Correcciones

1. Procesar oportunidades sin esperar consultas remotas de los eventos de estado. Conservar serialización de oportunidades e invalidaciones por oferta.
2. Reutilizar las instantáneas de mercado que mantienen feed/sondeo en la actualización periódica del panel. El refresco explícito mantiene su actualización remota.
3. Priorizar lecturas de saldo y de ofertas necesarias para liberar QUSD antes de aplicar, conservando cuotas y reservas.
4. Archivar de forma persistente avisos reconocidos en web y Telegram. Una nueva comprobación de la misma intención no reactiva su aviso. Retirar también notificaciones duplicadas de conciliación y sus reintentos, conservando evidencias, comprobaciones y restricciones sobre esa operación.

## Verificación y límites

Pruebas de cola de feed con consulta de estado retenida, invalidaciones existentes, prioridad de financiación, refresco periódico/manual y reconocimiento persistente con notificaciones duplicadas. Verificación general mediante `pnpm check` y prueba visual del panel.

No se rebajan tasas, reservas, requisitos de confirmación ni cuotas de QvaPay. El transporte del feed y la respuesta remota pueden decidir una carrera incluso con cola local prácticamente inmediata. No es posible garantizar ganar todas las ofertas ni eliminar interrupciones del proveedor.
