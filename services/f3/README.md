# F3 — shadow

Herramientas locales de validación del shadow. No se despliegan en producción.

```bash
# Caos: JSON inválido, evidencia vacía, run duplicado/concurrente, kill -9, DB caída.
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply PGPASSWORD=... \
  PGADMIN_DB=qvaapply bash services/f3/chaos.sh

# Benchmark: replay, auditoría y RSS del servicio.
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=qvaapply PGPASSWORD=... \
  PGADMIN_DB=qvaapply bash services/f3/bench.sh
```

El runbook operativo está en
[`docs/migration/f3-shadow-runbook.md`](../../docs/migration/f3-shadow-runbook.md).
