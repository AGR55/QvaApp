# Checklist de cutover TS → Go — 2026-11-14

> **Estado: pre-cutover. El corte NO se ha ejecutado.**
>
> Producción sigue siendo el monolito TypeScript `qvaapply` en
> `02bb5afc04b5eb95f5ac3996ef7634dedf073d02`. Go sigue en modo **shadow**
> aislado en `/opt/qvaapply-f3-shadow`. Este documento es una lista de
> comprobación y no autoriza por sí mismo el cambio de autoridad.

## 1. Objetivo y regla de oro

Este checklist prepara el corte del escritor autoritativo TS al núcleo Go. La
regla de oro de la migración se mantiene:

1. **El dinero no se reparte.** `trading-core` será el único escritor.
2. **El comportamiento se demuestra.** Sin paridad y sin invariantes limpios no
   hay corte.
3. **Siempre hay rollback.** La base y la release TS se conservan 14 días.

El cutover solo se autoriza cuando todos los gates de la sección 4 están en
verde, el rollback se ha ensayado de verdad y un verificador independiente firma
el informe. El script de comprobación **no** ejecuta el corte ni cambia Nginx,
contenedores, releases ni bases de datos.

## 2. Comprobación ejecutable (solo lectura)

Archivo: [`scripts/f3-cutover-check.sh`](../../scripts/f3-cutover-check.sh).

```bash
# Desde el repositorio local, sin copiar nada a la VPS:
ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 'bash -s' \
  < scripts/f3-cutover-check.sh

# En la VPS, si la release shadow ya contiene el script:
/opt/qvaapply-f3-shadow/current/scripts/f3-cutover-check.sh

# Ayuda y variables:
scripts/f3-cutover-check.sh --help
```

El script exige root en la VPS, usa solo `curl GET`, `docker inspect` y
`SELECT` con `psql`, y devuelve:

- `0`: todas las comprobaciones pasaron (puede haber avisos).
- `1`: alguna comprobación falló.
- `2`: error de uso o falta un requisito.

Variables admitidas: `F3_ROOT`, `PROD_ROOT`, `PROD_EXPECTED_REVISION`,
`INVARIANTS_MAX_AGE_SECONDS` (48 h por defecto) y `HTTP_TIMEOUT`.

No imprime tokens, claves, contraseñas ni saldos. Tampoco consulta Git: en la
VPS la comprobación se basa en releases, contenedores y estado persistido, no en
un árbol de trabajo.

### Resultado de la muestra verde (2026-11-14 18:34 UTC)

```text
Release shadow activa:     4ce81dbd21306e761ce64a29156f7ac019a317e0
Contenedores:              trading-core, hunter, notifier, edge y postgres healthy
Endpoints 8090–8093:       /healthz y /readyz = 200
Hunter:                    SSE conectado=1, polls /p2p=0, errores SSE=0
Core:                      eventos pendientes=0, stats_error=0, divergencias=0
shadow.hunter_events:      pending=0, failed=0, total=30
shadow.core_decisions:     allowed=13, blocked=0, total=13
shadow.core_executions:    12, sin importes negativos
shadow.core_operations:    6, todas en `reserved`
shadow.invariant_runs:     0 violaciones; último run hace ~14 h 37 min
shadow.runs:               35 runs, 0 divergencias
Producción TS:             release 02bb5afc..., contenedor healthy
Producción /api/session:   200
Resultado:                 35 comprobaciones, 0 fallos, 0 avisos
```

Esto demuestra que el shadow está sano **en esa muestra**. No demuestra 7 días
de paridad, 72 h de soak, migración de datos ni rollback ensayado.

> **Revalidación posterior (2026-11-14 18:39–18:44 UTC):** el contador
> acumulado `hunter_stream_errors_total` pasó a **1** tras un `WARN` de
> reconexión SSE (`stream error: stream ID 1; INTERNAL_ERROR; received from
> peer`) a las 18:39:29. El hunter volvió a conectar
> (`hunter_stream_connected=1`) y siguió recibiendo eventos, pero el script ya
> devuelve código 1 y el gate «errores SSE = 0» **no está verde**. Hay que
> explicar la reconexión y repetir la comprobación con el contador a 0 antes de
> cualquier go/no-go. Un reinicio que solo borre el contador no cierra el gate.

## 3. Estado actual de módulos y pendientes explícitos

| Módulo | Estado real a 2026-11-14 | Pendiente antes del corte |
| --- | --- | --- |
| Monolito TS `qvaapply` | Autoridad de producción; release `02bb5afc...`; `/api/session` 200; SQLite en `/opt/qvaapply/data/qvaapply.sqlite`. | Retirarlo solo después de 14 días estables en Go. Mantener release, datos y configuración restaurables. |
| `trading-core` Go | Shadow en `4ce81db...`; consume `shadow.hunter_events`, evalúa `riskpolicy`, persiste `shadow.core_decisions`, `shadow.core_executions` y `shadow.core_operations`. **No muta dinero ni llama a mutaciones de QvaPay.** | Despacho real de mutaciones con intención durable, conciliación/compensación, workflows y capital completos, lock de líder, base de producción, migración de datos y rollback ensayado. |
| `hunter` Go | SSE real, sin polling `/p2p` (`HUNTER_POLL_MS=0`), cola durable de eventos; a las 18:34 `polls=0` y `errores SSE=0`. A las 18:39 se observó 1 error de reconexión SSE (contador acumulado=1, ya reconectado). | Soak bajo carga, prueba de reconexión/fallback, alertas, explicar el error SSE y volver a 0 antes del corte; observación de 72 h. |
| `notifier` Go | Send-only, dry-run por defecto, dedupe, comandos y webhook parciales. No envía mensajes reales. | Envío real con token, ventana de corte del long-polling del bot TS, push/FCM y paridad de textos/menús. |
| `edge` Go | MVP: estáticos, shell SPA, `/api/edge/summary` y primitivas de sesión/CSRF. **No sustituye el panel ni las rutas `/api/*`.** | Rutas completas con auth/sesión/CSRF/origen, contratos móviles, PWA y canary de Nginx. |
| Postgres shadow | Aislado, sin puerto público; migraciones `0004`–`0014`; una ejecución por contenedor. | Topología de producción, roles, backups/PITR, restauración probada y migración de datos real. |
| Timers F3 | Tail, auditoría, replay, invariantes, soak, workflows y QvaPay. Solo unidades `qvaapply-f3-*`. | Acumular 7 días de decisiones y 72 h de soak sin fugas ni divergencias. |
| Paridad F0 | 159/159 puros, 74/74 contratos, 39/39 HTTP y replay 4/4 contra el oráculo TS. | Mantener el gate en verde; ampliar la evidencia a decisiones reales de 7 días. |
| Migración de datos | Importador SQLite→Postgres para staging y ensayo v16→v31; no es un procedimiento de corte. | Mínimo 2 dry-runs con snapshot de producción, manifiesto firmado, reconciliación y ensayo de rollback. |
| Observabilidad | `/metrics` y runbook con alertas recomendadas. | Confirmar alertas activas, paneles y guardia durante la ventana. |

### Pendientes que bloquean el corte

- [ ] **0 errores SSE** en la ventana de observación y explicación de cualquier
      reconexión. La muestra de 18:34 estaba limpia; la revalidación posterior
      encontró 1 error y el gate no está verde.
- [ ] **7 días consecutivos** con ≥ 99,9 % de decisiones idénticas y 0
      divergencias sin explicar. Hoy el shadow acumula horas, no 7 días.
- [ ] **72 h de soak** con RSS/CPU estables y sin fugas.
- [ ] **0 violaciones de invariantes todos los días** del periodo. El último
      run está limpio, pero el gate exige la serie completa.
- [ ] **Dos dry-runs** de migración de datos con snapshot de producción y
      manifiesto sin discrepancias sin explicar.
- [ ] **Rollback real ensayado**: restaurar TS, reconciliar intenciones creadas
      por Go y verificar que no queda doble aplicación.
- [ ] **Paridad de `edge` y `notifier`** suficiente para el panel, Android,
      Telegram y avisos. Hoy son MVPs.
- [ ] **Controles de corte cauteloso** en Go: un mercado, límites mínimos,
      cupo diario bajo y aprobación manual de las primeras aplicaciones.
- [ ] **Backup/PITR de Postgres** configurado y restauración probada.
- [ ] **Ventana, responsables y firmas** definidos (sección 7).
- [ ] **Aprobación independiente** del verificador; no la firma quien
      implementó el cambio.

## 4. Gates de go/no-go

| Gate | Criterio | Estado |
| --- | --- | --- |
| G1 paridad | ≥ 99,9 % de decisiones idénticas durante 7 días consecutivos; 0 divergencias sin explicar. | **Pendiente**: en curso. |
| G2 invariantes | 0 violaciones acumuladas y run reciente (≤ 48 h) todos los días. | **Parcial**: último run 0, falta la serie de 7 días. |
| G3 soak | 72 h con memoria plana y CPU comparable al baseline. | **Pendiente**. |
| G4 datos | 2 dry-runs con manifiesto de conteos, sumas, ofertas abiertas, operaciones no terminales, hashes de configuración y snapshots de lectura. | **Pendiente**. |
| G5 rollback | Restauración TS + reconciliación de intents ensayada en staging. | **Pendiente**. |
| G6 periferia | `edge` y `notifier` con paridad suficiente y fallo aislado probado. | **Pendiente**. |
| G7 backups | SQLite, configuración y Postgres con copia externa cifrada y restauración probada. | **Pendiente de evidencia**. |
| G8 operación | Ventana, responsables, alertas y criterios de rollback aprobados. | **Pendiente**. |

Mientras G1–G8 no estén cerrados, el único trabajo permitido sobre producción es
observación y lectura. No se cambia la autoridad de escritura.

## 5. Checklist de ejecución

> Los comandos de backup, parada y migración se ejecutan **solo dentro de la
> ventana autorizada**. No forman parte del script de comprobación.

### 5.1 T-7 días: preparación y congelación

- [ ] Congelar cambios de código, configuración, límites, mercados y tarifas
      hasta después del corte. Solo se admiten correcciones de rollback.
- [ ] Confirmar que la release TS `02bb5afc...` es la que se conservará y que
      su directorio sigue completo en `/opt/qvaapply/releases/`.
- [ ] Verificar el timer de backup SQLite y su retención de 14 días:

      ```bash
      systemctl list-timers qvaapply-backup.timer --no-pager
      ls -lh /opt/qvaapply/data/backups | tail
      ```

- [ ] Hacer una copia externa cifrada de `/opt/qvaapply/data` y
      `/opt/qvaapply/config`. No guardar secretos en el repositorio.
- [ ] Probar una restauración completa en un entorno desechable: abrir la copia
      SQLite, comprobar `PRAGMA integrity_check`, contar tablas y verificar que
      el panel arranca con la copia.
- [ ] Ejecutar el dry-run de migración a Postgres desde una **copia** de la
      SQLite, nunca desde el archivo de producción. Guardar el manifiesto y las
      diferencias.
- [ ] Repetir el dry-run una segunda vez y comparar conteos, sumas y hashes.
- [ ] Ensayar el rollback en staging: parar Go, restaurar TS, reconciliar
      intenciones y comprobar `/api/session`, panel, Telegram y móvil.
- [ ] Ejecutar a diario:

      ```bash
      ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 'bash -s' \
        < scripts/f3-cutover-check.sh
      ```

- [ ] Guardar cada salida como evidencia (sin secretos ni saldos) y revisar
      cualquier `[WARN]` o tendencia de `shadow.runs`, RSS y CPU.

### 5.2 T-24 h: ensayo general

- [ ] Repetir el dry-run de datos con la copia más reciente y firmar el
      manifiesto.
- [ ] Confirmar que el rollback ensayado usa la misma release, configuración y
      datos que se usarán en el corte.
- [ ] Verificar que el script de comprobación sale con código 0 y sin avisos.
- [ ] Revisar `invariant_runs`, `shadow.runs`, `hunter_events` y
      `core_decisions`; no debe haber fallos, pendientes ni divergencias.
- [ ] Confirmar que no hay `mutation_intents` en `submitted` o `uncertain` en
      producción y que no hay operaciones a medio reconciliar.
- [ ] Avisar a la persona/equipo que use el panel, Telegram y Android de la
      ventana y del modo de observación.
- [ ] Preparar el manifiesto de snapshot y el directorio privado de backups con
      permisos `700`.

### 5.3 T0: drenaje y snapshot

Orden obligatorio: **pausar → drenar → reconciliar → snapshot → parar TS**.

- [ ] Pausar la automatización de cacerías y cualquier acción programada desde
      el panel o el control operativo. No detener el proceso TS todavía.
- [ ] Dejar de aceptar operaciones nuevas y esperar a que terminen las que estén
      en curso.
- [ ] Reconciliar todas las mutaciones e intenciones. Criterio de salida:
      `mutation_intents` en `submitted`/`uncertain` = 0 y ninguna operación con
      resultado remoto desconocido.
- [ ] Comprobar el estado de drenaje con consultas de solo lectura:

      ```bash
      sqlite3 -readonly -header -column \
        "file:/opt/qvaapply/data/qvaapply.sqlite?mode=ro" "
        SELECT state, COUNT(*) AS n FROM operations GROUP BY state;
        SELECT state, COUNT(*) AS n FROM mutation_intents GROUP BY state;
        SELECT COUNT(*) AS unresolved_intents
          FROM mutation_intents WHERE state IN ('submitted','uncertain');
        SELECT state, COUNT(*) AS n FROM trade_workflows GROUP BY state;
        SELECT COUNT(*) AS pending_actions
          FROM scheduled_actions WHERE state = 'pending';
        SELECT state, COUNT(*) AS n FROM market_feed_events GROUP BY state;
      "
      ```

- [ ] Confirmar que no hay acciones pendientes ni eventos de feed en estado
      `pending`/`failed`, o dejar por escrito por qué se acepta cada excepción.
- [ ] Hacer el backup final de SQLite y de configuración:

      ```bash
      umask 077
      install -d -m 700 /var/backups/qvaapply-cutover
      ts=$(date -u +%Y%m%dT%H%M%SZ)
      sqlite3 /opt/qvaapply/data/qvaapply.sqlite \
        ".timeout 5000" \
        ".backup '/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite'"
      sha256sum "/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite" \
        > "/var/backups/qvaapply-cutover/qvaapply-$ts.sqlite.sha256"
      ```

- [ ] Copiar la configuración cifrada fuera de la VPS y verificar el hash.
- [ ] Exportar el manifiesto de migración: conteos por tabla, ofertas abiertas,
      operaciones no terminales, cadena/epoch de configuración y snapshots de
      lectura. Las sumas de saldos van al manifiesto privado, no a este
      documento.
- [ ] Ejecutar el script de comprobación y archivar la salida. Si falla algo,
      **no continuar**.

### 5.4 Corte: parada de TS y arranque cauteloso de Go

- [ ] Confirmar la ventana y que el verificador independiente está presente.
- [ ] Parar TS de forma ordenada, respetando el drenaje (`stop_grace_period` de
      90 s):

      ```bash
      TS_RELEASE=$(readlink -f /opt/qvaapply/current)
      QVAAPPLY_REVISION=$(basename "$TS_RELEASE") \
      QVAAPPLY_HOST_PORT=$(cat /opt/qvaapply/config/host-port) \
        docker compose -f "$TS_RELEASE/deploy/compose.yaml" stop
      ```

- [ ] Hacer un último backup de SQLite **con TS parado** y verificar
      `PRAGMA integrity_check`.
- [ ] Migrar los datos al Postgres de producción con el procedimiento F5
      aprobado. Hoy el importador existente
      (`services/db/import-sqlite-to-postgres.mjs`) está pensado para staging:
      no usarlo como corte definitivo sin haber cerrado G4/G5.
- [ ] Antes de arrancar Go, hacer `pg_dump` del Postgres migrado y comprobar que
      se puede restaurar. Sustituir `CORE_PG_CONTAINER` por el contenedor real
      del Postgres de producción Go; reutilizar el `$ts` del backup:

      ```bash
      CORE_PG_CONTAINER=<postgres-core-produccion>
      docker exec "$CORE_PG_CONTAINER" pg_dump -U qvaapply -Fc qvaapply \
        > "/var/backups/qvaapply-cutover/core-$ts.dump"
      docker run --rm -i postgres:16 pg_restore --list \
        < "/var/backups/qvaapply-cutover/core-$ts.dump" >/dev/null
      ```

- [ ] Si el cliente `pg_restore` está instalado en la VPS, se puede usar
      directamente; si no, el contenedor anterior sirve para validar el dump.

- [ ] Arrancar `trading-core` en modo cauteloso: un solo mercado, límites
      mínimos, cupo diario bajo y aprobación manual de las primeras N
      aplicaciones. Estos controles deben existir y estar probados antes del
      corte; si no existen, el corte no está listo.
- [ ] Mantener las mutaciones deshabilitadas hasta que el smoke de lectura,
      sesión, panel y alertas esté en verde.
- [ ] Conmutar Nginx solo cuando `edge` esté listo. Si `edge` no cubre las rutas
      usadas por web/Android, no conmutar la superficie completa.
- [ ] Smoke mínimo (adaptar puertos y rutas al despliegue de producción Go):

      ```bash
      curl -fsS http://127.0.0.1:<core>/healthz
      curl -fsS http://127.0.0.1:<core>/readyz
      curl -fsS http://127.0.0.1:<edge>/healthz
      curl -fsS -o /dev/null -w '%{http_code}\n' \
        "http://127.0.0.1:$(cat /opt/qvaapply/config/host-port)/api/session"
      ```

- [ ] Verificar panel, login/logout, Telegram, Android, notificaciones y al menos
      una lectura de saldo/operaciones. No ejecutar una operación real sin
      autorización explícita y sin conciliación preparada.
- [ ] Registrar la hora exacta de parada TS, arranque Go, primer `apply` real (si
      se autoriza) y cada cambio de límite.

### 5.5 T+0 a T+48 h: observación intensiva

- [ ] Revisar cada 15–30 min: `/healthz`, `/readyz`, `/metrics`, errores,
      intenciones no resueltas, ofertas abiertas y operaciones no terminales.
- [ ] Ejecutar el script de comprobación adaptado a producción y archivar cada
      salida.
- [ ] Confirmar 0 dobles aplicaciones, 0 reservas huérfanas, 0 saldos negativos y
      0 intenciones `uncertain` sin resolver.
- [ ] Revisar logs de `core`, `edge`, `notifier` y Postgres; no debe haber
      secretos en logs.
- [ ] No ampliar límites hasta que el operador y el verificador lo aprueben por
      escrito. Cada ampliación se documenta con hora, valor anterior y nuevo.

### 5.6 T+48 h a T+14 días: estabilidad y decisión

- [ ] Mantener la release TS y la SQLite intactas y restaurables durante 14 días.
- [ ] Revisar a diario invariantes, paridad, conciliación, backups y capacidad.
- [ ] Cualquier incidente de reconciliación o doble aplicación reinicia el
      reloj de estabilidad y activa revisión.
- [ ] Al día 14, con 0 incidentes nuevos y rollback aún disponible, decidir si
      se retira TS (F6). La retirada no es parte de este checklist.

## 6. Rollback a TypeScript

### 6.1 Disparadores

Se revierte si ocurre cualquiera de estos casos:

- cualquier `apply` duplicado o mutación sin intención durable;
- saldo o ledger descuadrado sin explicación;
- intención `uncertain` sin resolver que bloquee una oferta más de 15 min;
- divergencia de decisión sistemática (> 0,1 % en una hora);
- pérdida de notificaciones o fallo de la superficie de control;
- imposibilidad de leer o escribir la base de forma consistente.

### 6.2 Procedimiento

- [ ] Declarar el rollback y congelar nuevas mutaciones en Go.
- [ ] Parar `trading-core` y cualquier worker que pueda despachar.
- [ ] Reconciliar contra QvaPay todas las intenciones creadas por Go. Ninguna
      puede quedar `submitted`/`uncertain`.
- [ ] Reconciliar los datos: la SQLite TS es la base de retorno, pero puede
      haberse quedado atrás. Hay que restaurar/mergear los cambios posteriores
      al corte antes de reabrir escrituras. **No basta con volver a levantar el
      contenedor.**
- [ ] Devolver Nginx a TS o mantener el puerto TS original.
- [ ] Arrancar la release TS conservada:

      ```bash
      TS_RELEASE=/opt/qvaapply/releases/02bb5afc04b5eb95f5ac3996ef7634dedf073d02
      QVAAPPLY_REVISION=$(basename "$TS_RELEASE") \
      QVAAPPLY_HOST_PORT=$(cat /opt/qvaapply/config/host-port) \
        docker compose -f "$TS_RELEASE/deploy/compose.yaml" up -d
      ```

- [ ] Verificar `/api/session` 200, panel, login, Telegram y Android.
- [ ] Reabrir la automatización solo después de que la conciliación esté
      cerrada y el verificador lo apruebe.
- [ ] Conservar la base Go y los logs para el post-mortem; no borrar evidencia.
- [ ] Registrar el incidente, la hora, las intenciones reconciliadas y el estado
      final de cada operación.

## 7. Ventana, responsables y comunicación

### Ventana propuesta (sin fecha asignada)

- **Duración del cambio:** 2 h en horario de bajo tráfico, con la automatización
  pausada.
- **Observación intensiva:** 48 h.
- **Rollback disponible:** 14 días.
- **Congelación:** desde T-24 h hasta T+14 días para cambios ajenos al corte.
- **Fecha definitiva:** pendiente. No se asigna hasta cerrar G1–G8.

La ventana debe confirmarse en UTC y en la zona horaria del operador. Si el
volumen de operaciones no es bajo, se pospone; la prisa no es un criterio.

### Responsables

| Rol | Responsabilidad | Nombre / firma |
| --- | --- | --- |
| Operador-ejecutor | Ejecuta la ventana, backups, parada, migración y smoke. | |
| Verificador independiente | Ejecuta el script, revisa evidencia y firma el go/no-go. No es quien implementó el cambio. | |
| Observador | Vigila métricas, logs, QvaPay, panel y alertas durante 48 h. | |
| Aprobador de rollback | Puede ordenar el rollback sin esperar consenso. | |

Una sola persona puede cubrir varios roles operativos, pero **la firma de
verificación debe ser independiente**. Si no hay segunda persona, se usa un
agente revisor con acceso de solo lectura y se documenta.

### Comunicación

- [ ] Aviso previo a quien use el panel, Telegram y Android.
- [ ] Canal único de incidentes y hora de inicio/fin.
- [ ] Criterio explícito: ante duda, rollback; el dinero pesa más que el corte.
- [ ] Post-mortem obligatorio si hubo rollback o cualquier discrepancia.

## 8. Comandos de referencia (solo lectura)

```bash
# Comprobación completa (recomendada)
ssh -i ~/.ssh/qvaapply_codex root@2.25.247.171 'bash -s' \
  < scripts/f3-cutover-check.sh

# Endpoints shadow
for p in 8090 8091 8092 8093; do
  curl -fsS "http://127.0.0.1:$p/healthz"
  curl -fsS "http://127.0.0.1:$p/readyz"
done

# Métricas concretas, sin volcar el endpoint completo
curl -fsS http://127.0.0.1:8091/metrics | grep -E \
  '^(hunter_stream_connected|hunter_polls_total|hunter_stream_errors_total) '
curl -fsS http://127.0.0.1:8090/metrics | grep -E \
  '^(trading_core_hunter_events_pending|trading_core_shadow_mismatches_total|trading_core_shadow_stats_error) '

# Estado shadow
docker exec qvaapply-f3-shadow-postgres psql -U qvaapply -d qvaapply -c "
  SELECT state, count(*) FROM shadow.hunter_events GROUP BY state;
  SELECT allowed, count(*) FROM shadow.core_decisions GROUP BY allowed;
  SELECT count(*) FROM shadow.core_executions;
  SELECT state, count(*) FROM shadow.core_operations GROUP BY state;
  SELECT run_id, violations, to_timestamp(created_at)
    FROM shadow.invariant_runs ORDER BY created_at DESC LIMIT 5;
"

# Producción: release, puerto y salud (sin imprimir el cuerpo de /api/session)
readlink -f /opt/qvaapply/current
cat /opt/qvaapply/config/host-port
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:$(cat /opt/qvaapply/config/host-port)/api/session"
```

## 9. Evidencia y cierre

- [ ] Guardar la salida del script antes y después de cada fase, sin secretos ni
      saldos, en un archivo privado o en `docs/migration/evidence/` cuando se
      ejecute el corte real.
- [ ] Adjuntar el manifiesto de migración, los hashes de backup y la prueba de
      restauración.
- [ ] Adjuntar el ensayo de rollback con hora, release y resultado.
- [ ] Firmar el go/no-go y el cierre de la ventana.
- [ ] Actualizar `docs/migration/roadmap.md`, el runbook y los ADR solo cuando
      el corte esté aprobado y ejecutado.

## 10. Lo que este documento no afirma

- No afirma que el cutover esté hecho ni aprobado.
- No afirma que Go tenga permiso para mutar dinero.
- No afirma que la migración de datos de producción esté completa.
- No afirma que el rollback esté ensayado.
- No sustituye la revisión independiente ni la decisión del operador.
