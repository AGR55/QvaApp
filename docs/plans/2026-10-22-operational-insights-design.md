# Diagnóstico, historial fiat y salud operativa

Aprobación: el usuario aceptó las tres funciones propuestas y autorizó comenzar. Se conserva la prioridad del procesamiento de cacerías.

## Diseño aprobado

- Diagnóstico bajo demanda en Cacería y `/diagnostico`: períodos 1 h, 24 h y 7 días; filtro de moneda; motivos de descarte separados de solicitudes enviadas y sus resultados. Se cuentan observaciones, no oportunidades perdidas ni capturas hipotéticas. Lecturas locales por lotes y límite explícito de cobertura.
- Historial en Capital y `/historial MONEDA`: saldo anterior, cambio, saldo posterior, origen y referencia; registros antiguos sin evidencia de saldos muestran «sin registro», sin reconstruir cifras. Los movimientos históricos ya incluidos en una declaración no vuelven a modificar el saldo.
- Salud en Cacería y `/salud`: actividad del feed, antigüedad de medianas y latencia remota. Comprobación local cada minuto, período de gracia al iniciar y confirmación de incidentes antes de avisar. Avisos persistentes mediante la cola existente, una vez por transición y otro al recuperarse. Ninguna pausa automática.

Alternativas consideradas: consultar QvaPay para cada informe (más carga y latencia); procesar y guardar contadores por cada oferta (más escrituras en el motor). Se reutilizan auditorías y datos locales, con lectura acotada fuera de la ruta de aplicación.

## Implementación y verificación

1. Migración compatible para historial fiat con capturas reales de saldo e índices para lecturas acotadas.
2. Servicio local de diagnóstico y salud; pruebas de clasificación, cobertura y transiciones sin duplicados.
3. API autenticada, comandos y vistas integradas en los componentes actuales, sin nuevas dependencias.
4. Verificar declaraciones, movimientos idempotentes y backfills; pruebas de API y avisos; verificación completa y despliegue habitual.

La skill auxiliar writing-plans no está instalada en los directorios de skills disponibles; este documento conserva el plan explícito para ejecutar el diseño ya autorizado.
