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

## Resultado implementado

- Cacería: panel de salud e informe bajo demanda, por mercado y período. Lecturas y clasificación por lotes de 250, límite de 5.000 registros, cobertura truncada explícita y solicitudes simultáneas compartidas.
- Capital: historial paginado con saldos capturados por SQLite en la misma escritura que cambia el saldo. Las referencias antiguas sin capturas no reconstruyen saldos y los backfills indican que no modificaron el saldo declarado.
- Telegram: `/diagnostico [MONEDA|todas] [1|24|168]`, `/historial [MONEDA] [PAGINA]` y `/salud`.
- Salud: comprobaciones cada minuto, gracia inicial de dos minutos y dos comprobaciones consecutivas antes de avisar o confirmar recuperación; silencios del feed superiores a cinco minutos, medianas sin observación durante dos horas y última respuesta remota superior a tres segundos. No pausa ni cambia cacerías. Las transiciones usan la cola durable existente, incluyendo Web Push; una recuperación sustituye al aviso anterior.
- Compatibilidad: migración v29 con respaldo automático previo, índices de consulta y saldos históricos desconocidos identificados explícitamente. No se agregan dependencias ni peticiones a QvaPay.
- Verificación: 532 pruebas, comprobaciones de tipos/código/secretos y construcción aprobadas. Prueba visual y auditoría de accesibilidad en escritorio y móvil aprobadas; corregidos filtros Select y acceso por teclado a la tabla móvil.
