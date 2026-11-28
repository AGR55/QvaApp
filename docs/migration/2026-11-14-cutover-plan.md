# Planificador de cutover TS → Go — 2026-11-14

> **Estado: planificador en modo dry-run. El corte NO se ha ejecutado y este
> documento no lo autoriza.**
>
> Producción sigue siendo el monolito TypeScript. Go sigue en modo shadow. El
> script [`scripts/f3-cutover-plan.sh`](../../scripts/f3-cutover-plan.sh) solo
> comprueba precondiciones y muestra el checklist; no cambia la autoridad de
> escritura, no para contenedores y no escribe en `/opt/qvaapply`.

## 1. Objetivo y alcance

El planificador responde a una pregunta limitada: **¿están presentes las
precondiciones mínimas para planificar una ventana de cutover?** No responde a
«¿está Go listo para producir?» ni sustituye los gates G1–G8 del
[checklist de cutover](2026-11-14-cutover-checklist.md).

Hace, en modo lectura:

1. Comprueba raíces, releases activas y release TS de rollback.
2. Comprueba la SQLite y el puerto interno de producción.
3. Busca un backup reciente `.sqlite` o `.tar.gz` y avisa si falta su `.sha256`.
4. Exige que el rollback TS esté documentado con un encabezado explícito.
5. Valida la sintaxis y la ayuda de `f3-cutover-check.sh` y `f3-rehearsal.sh`.
6. Ejecuta la comprobación completa de cutover solo si hay root y Docker.
7. Muestra el checklist ordenado: backup, freeze, drenar, snapshot, import
   staging, verificación, ventana, rollback 14 días y responsables.

No hace:

- no ejecuta el corte ni cambia Nginx, releases, contenedores o bases;
- no escribe en `/opt/qvaapply` ni en `data/`;
- no envía Telegram ni llama a QvaPay;
- no crea backups ni restaura Postgres;
- no lanza el ensayo completo salvo que se pase `--rehearsal`.

## 2. Uso y variables

```bash
# Dry-run por defecto (solo comprueba y muestra el plan)
scripts/f3-cutover-plan.sh

# Ayuda
scripts/f3-cutover-plan.sh --help

# Ensayo completo explícito (crea base temporal y puede tardar)
scripts/f3-cutover-plan.sh --rehearsal

# Cualquier intento de ejecutar el corte se rechaza
scripts/f3-cutover-plan.sh --execute   # error, exit 2
```

`--execute` no está implementado. El script lo rechaza de forma explícita antes
de comprobar nada: el corte real requiere una ventana autorizada y un
procedimiento distinto, todavía no implementado.

| Variable | Defecto | Uso |
| --- | --- | --- |
| `F3_ROOT` | `/opt/qvaapply-f3-shadow` | Raíz shadow; debe estar fuera de `PROD_ROOT`. |
| `PROD_ROOT` | `/opt/qvaapply` | Raíz de producción TypeScript. |
| `BACKUP_DIR` | `$PROD_ROOT/data/backups` | Directorio donde se busca el backup más reciente. |
| `TS_RELEASE` | `$PROD_ROOT/current` | Release TS que se conserva para el rollback. |
| `BACKUP_MAX_AGE_HOURS` | `48` | Antigüedad máxima aceptada del backup. |
| `ROLLBACK_DOC` | vacío | Documento explícito de rollback TS. |
| `ROLLBACK_SEARCH_DIR` | `<repo>/docs/migration` | Directorio de búsqueda si no se fija `ROLLBACK_DOC`. |

Códigos de salida:

- `0`: plan listo en dry-run, sin precondiciones fallidas. Puede haber avisos.
- `1`: falta al menos una precondición; el plan no está listo.
- `2`: error de uso, incluido `--execute` y opciones desconocidas.

## 3. Precondiciones que verifica

| Comprobación | Criterio | Si falla |
| --- | --- | --- |
| Separación de raíces | `F3_ROOT` no es igual ni está dentro de `PROD_ROOT`. | FAIL |
| Raíces | `F3_ROOT` y `PROD_ROOT` existen y son directorios. | FAIL |
| Releases activas | `current` apunta a un directorio bajo `releases/`. | FAIL |
| Compose shadow | Existe `deploy/compose.f3-shadow.yaml` en la release shadow. | FAIL |
| Release TS | `TS_RELEASE` es absoluta y existe. | FAIL |
| Puerto de producción | `$PROD_ROOT/config/host-port` es un puerto válido. | FAIL |
| SQLite | `$PROD_ROOT/data/qvaapply.sqlite` es legible. | FAIL |
| Backup | Hay un `.sqlite` o `.tar.gz` no vacío con antigüedad ≤ `BACKUP_MAX_AGE_HOURS`. | FAIL |
| Hash del backup | Existe `<backup>.sha256`. | WARN |
| Rollback documentado | Algún `.md` de `ROLLBACK_SEARCH_DIR` tiene un encabezado de rollback a TypeScript/TS. | FAIL |
| Retención 14 días | El documento menciona 14 días/catorce días. | WARN |
| Release en el rollback | El documento menciona el nombre de `TS_RELEASE`. | WARN |
| Herramientas | `f3-cutover-check.sh` y `f3-rehearsal.sh` pasan `bash -n` y `--help`. | FAIL |
| Comprobación completa | `f3-cutover-check.sh` sale con 0 si hay root y Docker. | FAIL si se ejecuta; WARN si no hay entorno |
| Ensayo | `f3-rehearsal.sh` completo solo con `--rehearsal`. | FAIL si se pide y falla |

Notas:

- El backup puede ser el diario de `scripts/backup-vps.sh` o el backup final de
  `/var/backups/qvaapply-cutover`. El script no crea ninguno.
- La búsqueda del rollback exige un encabezado, no solo la palabra «rollback»
  en el cuerpo. El
  [checklist](2026-11-14-cutover-checklist.md#6-rollback-a-typescript) y el
  [ensayo](2026-11-14-cutover-rehearsal.md) cumplen el criterio.
- Sin root o sin Docker, la comprobación completa no se ejecuta. Se valida su
  `--help` y se emite `[WARN]`; eso no equivale a un gate verde.

## 4. Checklist ordenado

El script imprime esta lista, pero **no ejecuta ninguno de sus pasos**. El orden
es obligatorio: cada paso depende del anterior.

### 4.1 Backup

- [ ] Backup final de SQLite con TS parado y `PRAGMA integrity_check`.
- [ ] Copia de configuración cifrada fuera de la VPS.
- [ ] `sha256` de cada archivo y restauración probada en un entorno desechable.
- [ ] Backup o dump del Postgres que se usará como destino, con restauración
      verificada.

Criterio de salida: el backup existe, es legible, tiene hash y se ha restaurado
al menos una vez.

### 4.2 Freeze

- [ ] Congelar código, configuración, mercados, límites, tarifas y trabajos
      programados ajenos al corte.
- [ ] Confirmar que la release TS de rollback está completa en
      `/opt/qvaapply/releases/`.
- [ ] Dejar por escrito qué correcciones de rollback se admiten durante la
      congelación.

Criterio de salida: no hay cambios ajenos al corte desde T-24 h.

### 4.3 Drenar

- [ ] Pausar la automatización de cacerías y las acciones programadas.
- [ ] Dejar de aceptar operaciones nuevas.
- [ ] Esperar a que terminen las operaciones en curso.
- [ ] Reconciliar `mutation_intents` y operaciones no terminales.

Criterio de salida: `submitted`/`uncertain` = 0 y ninguna operación con
resultado remoto desconocido. El drenaje se comprueba con consultas de solo
lectura; no se ejecuta desde este planificador.

### 4.4 Snapshot

- [ ] Exportar conteos por tabla, sumas, ofertas abiertas, operaciones no
      terminales y cadena/epoch de configuración.
- [ ] Guardar los hashes de configuración y el manifiesto privado.
- [ ] Hacer el backup final de SQLite y el `pg_dump` del Postgres migrado.
- [ ] Verificar que el dump se puede listar/restaurar.

Criterio de salida: manifiesto reproducible y backup restaurable. Las sumas de
saldos van al manifiesto privado, no a este documento.

### 4.5 Import staging

- [ ] Ejecutar al menos dos dry-runs desde una **copia** de la SQLite, nunca
      desde el archivo de producción.
- [ ] Comparar conteos, sumas, índices, claves foráneas y hashes entre dry-runs.
- [ ] Explicar cualquier diferencia; una diferencia sin explicar es no-go.
- [ ] Importar en producción solo con el procedimiento aprobado y el manifiesto
      firmado.

Criterio de salida: dos dry-runs coherentes y G4 cerrado. El importador actual
está pensado para staging; no es por sí solo un procedimiento de corte.

### 4.6 Verificación

- [ ] Invariantes sin violaciones.
- [ ] `verify-money` con saldos, ledger y operaciones correctos.
- [ ] Paridad suficiente de decisiones y contratos.
- [ ] Smoke de lectura, sesión, panel, Telegram y Android.
- [ ] `f3-cutover-check.sh` en verde y sin `[FAIL]`.
- [ ] Firma de un verificador independiente que no implementó el cambio.

Criterio de salida: todos los gates aplicables en verde y evidencia archivada.

### 4.7 Ventana

- [ ] Confirmar fecha y hora en UTC y en la zona del operador.
- [ ] Elegir horario de bajo tráfico; si el volumen no es bajo, posponer.
- [ ] Reservar 2 h para el cambio y 48 h de observación intensiva.
- [ ] Abrir un canal único de incidentes y avisar a panel, Telegram y Android.
- [ ] Acordar el criterio «ante duda, rollback».

Criterio de salida: ventana, responsables y comunicación confirmados por
escrito.

### 4.8 Rollback 14 días

- [ ] Conservar release TS, SQLite previa, snapshot final, dump de Postgres,
      manifiestos y logs durante 14 días.
- [ ] Tener el procedimiento de rollback y la reconciliación de intenciones
      ensayados.
- [ ] No borrar evidencia hasta cerrar el post-mortem y el periodo de 14 días.

Criterio de salida: rollback disponible y probado; cualquier incidente de
conciliación o doble aplicación reinicia el reloj de estabilidad.

### 4.9 Responsables

- [ ] Operador-ejecutor.
- [ ] Verificador independiente.
- [ ] Observador durante 48 h.
- [ ] Aprobador de rollback con autoridad para ordenarlo sin consenso.

Criterio de salida: nombres y firmas registrados. Una persona puede cubrir
varios roles operativos, pero la verificación debe ser independiente.

## 5. Criterios go/no-go

El cutover solo es **go** si se cumplen todos estos puntos:

| Gate | Criterio mínimo |
| --- | --- |
| G1 paridad | ≥ 99,9 % de decisiones idénticas durante 7 días consecutivos y 0 divergencias sin explicar. |
| G2 invariantes | 0 violaciones acumuladas y run reciente (≤ 48 h) todos los días. |
| G3 soak | 72 h con memoria plana y CPU comparable al baseline. |
| G4 datos | Dos dry-runs con manifiesto, conteos, sumas, ofertas abiertas, operaciones no terminales, hashes y snapshots. |
| G5 rollback | Restauración TS + reconciliación de intenciones ensayada en staging. |
| G6 periferia | `edge` y `notifier` con paridad suficiente y fallo aislado probado. |
| G7 backups | SQLite, configuración y Postgres con copia externa cifrada y restauración probada. |
| G8 operación | Ventana, responsables, alertas y criterios de rollback aprobados. |

Son **no-go** automáticos:

- cualquier `apply` duplicado, mutación sin intención durable o saldo/ledger
  descuadrado;
- intención `uncertain` sin resolver que bloquee una oferta más de 15 min;
- divergencia sistemática > 0,1 % en una hora;
- backup no restaurable, rollback no ensayado o documentación de rollback
  ausente;
- falta de verificador independiente o de ventana autorizada.

El planificador puede devolver `0` con avisos. Un `0` significa «no faltan
precondiciones detectadas en dry-run», **no** «cutover autorizado».

## 6. Rollback a TypeScript

Resumen del procedimiento documentado en el
[checklist, sección 6](2026-11-14-cutover-checklist.md#6-rollback-a-typescript)
y en el [ensayo, sección 7.8](2026-11-14-cutover-rehearsal.md):

1. Declarar el rollback y congelar nuevas mutaciones en Go.
2. Parar `trading-core` y cualquier worker que pueda despachar.
3. Reconciliar contra QvaPay todas las intenciones creadas por Go; ninguna puede
   quedar `submitted`/`uncertain`.
4. Reconciliar los datos posteriores al corte contra la SQLite TS. No basta con
   volver a levantar el contenedor.
5. Devolver Nginx a TS o mantener el puerto TS original.
6. Arrancar la release TS conservada con su configuración y datos.
7. Verificar `/api/session` 200, panel, login, Telegram y Android.
8. Reabrir la automatización solo con la conciliación cerrada y aprobación del
   verificador.
9. Conservar base Go, logs, manifiestos y dumps para el post-mortem.

La release TS, la SQLite, el snapshot, el dump y los logs se conservan **14
días**. El rollback real no se ha ejecutado todavía; G5 sigue pendiente.

## 7. Limitaciones explícitas

- **El corte no se ha ejecutado.** No hay cambio de autoridad, Nginx,
  contenedores Go ni release de producción.
- **El planificador no autoriza nada.** Un dry-run en verde no sustituye la
  decisión del operador ni la firma del verificador.
- **No hay PITR ni archivo WAL de Postgres.** No se ha probado backup/PITR,
  restauración point-in-time ni recuperación ante corrupción.
- **No se ha ejecutado un rollback TS real.** El procedimiento está documentado,
  pero restaurar TS y reconciliar intenciones sigue siendo G5 pendiente.
- **La comprobación completa puede no haberse ejecutado.** Sin root o sin
  Docker, el planificador solo valida `--help` y emite un aviso.
- **El ensayo es opt-in.** `--rehearsal` crea una base Postgres temporal y puede
  fallar si no hay Postgres local; no se lanza por defecto.
- **No hay evidencia de producción en este documento.** Los conteos, saldos y
  logs reales deben guardarse en evidencia privada, sin secretos.
- **No se toca QvaPay, Telegram ni la automatización.** Cualquier mutación real
  requiere autorización explícita y un procedimiento distinto.
- **Una ejecución local no demuestra la VPS.** Rutas, permisos, Docker, release y
  backups deben validarse en el entorno real.

## 8. Ejecución segura y evidencia

Desde un checkout del repositorio:

```bash
# 1. Validar sintaxis y ayuda
bash -n scripts/f3-cutover-plan.sh
scripts/f3-cutover-plan.sh --help

# 2. Dry-run con los valores reales (solo lectura)
F3_ROOT=/opt/qvaapply-f3-shadow \
PROD_ROOT=/opt/qvaapply \
BACKUP_DIR=/var/backups/qvaapply-cutover \
TS_RELEASE=/opt/qvaapply/releases/02bb5afc04b5eb95f5ac3996ef7634dedf073d02 \
  scripts/f3-cutover-plan.sh

# 3. Guardar la salida como evidencia (sin secretos ni saldos)
mkdir -p /var/backups/qvaapply-evidence
F3_ROOT=/opt/qvaapply-f3-shadow \
PROD_ROOT=/opt/qvaapply \
  scripts/f3-cutover-plan.sh \
  | tee "/var/backups/qvaapply-evidence/plan-$(date -u +%Y%m%dT%H%M%SZ).log"
```

El planificador debe ejecutarse desde el repositorio o desde una release que
contenga `scripts/f3-cutover-check.sh`, `scripts/f3-rehearsal.sh` y
`docs/migration/`. No se recomienda canalizarlo por `ssh 'bash -s'` porque
resuelve sus herramientas relativas al repositorio.

## 9. Lo que este documento no afirma

- No afirma que el cutover esté hecho, aprobado o autorizado.
- No afirma que Go tenga permiso para mutar dinero.
- No afirma que la migración de datos de producción esté completa.
- No afirma que el rollback esté ensayado.
- No afirma que exista PITR, backup externo verificado o restauración de
  Postgres probada.
- No sustituye la revisión independiente ni la decisión del operador.

## 10. Referencias

- [Checklist de cutover](2026-11-14-cutover-checklist.md)
- [Ensayo de cutover y rollback](2026-11-14-cutover-rehearsal.md)
- [Runbook shadow F3](f3-shadow-runbook.md)
- [`scripts/f3-cutover-check.sh`](../../scripts/f3-cutover-check.sh)
- [`scripts/f3-rehearsal.sh`](../../scripts/f3-rehearsal.sh)
- [`scripts/f3-cutover-plan.sh`](../../scripts/f3-cutover-plan.sh)
