# Runbook de operación

## Arranque diario

1. Abre el panel y comprueba **Auditoría → Salud e integridad**.
2. Confirma que la cadena de configuración es íntegra y no hay mutaciones pendientes.
3. Revisa saldo QUSD, saldos fiat declarados, reservas y operaciones activas.
4. Ejecuta primero en simulación y comprueba las decisiones explicadas.
5. Para operar: selecciona modo real; el sistema seguirá pausado. Reanuda en una acción separada.

No habilites modo real si `pnpm check` falla, la documentación de QvaPay cambió, existe una conciliación pendiente o los saldos declarados no coinciden.

## Inicio de sesión QvaPay con TOTP

Ejecuta `pnpm login`, introduce el correo, la contraseña oculta y después el código vigente de seis dígitos de la aplicación autenticadora. El comando usa `remember: true`, verifica el token mediante `GET /user` y solo entonces lo cifra en SQLite. Un timeout de transporte se reintenta hasta tres veces; un TOTP rechazado, bloqueo o rate limit requiere intervención humana y nunca se reintenta automáticamente.

## Flujo humano de pago

- Compra de QUSD: pulsa **Voy a pagar**, transfiere fuera de QvaApply y luego **Registrar pago** con referencia.
- Venta de QUSD: espera y verifica el fiat en tu cuenta; solo después pulsa **Confirmar recepción**.
- QvaApply nunca abre una banca, firma una transferencia ni inventa una referencia.

## Resultado incierto

1. Activa **Parada de emergencia**.
2. No repitas manualmente la mutación en QvaPay.
3. Abre **Operaciones** y pulsa **Conciliar** una vez que QvaPay responda.
4. Si el estado sigue sin ser concluyente, conserva la reserva y revisa directamente la oferta en QvaPay.
5. Guarda la hora, UUID y evidencia; exporta `/api/audit` desde una sesión autenticada.

## Backup y restauración

SQLite usa WAL. Para una copia coherente sencilla, detén QvaApply antes de copiar:

```bash
systemctl --user stop qvaapply  # o termina pnpm dev con Ctrl+C
cp -a data/qvaapply.sqlite data/backups/qvaapply-manual-AAAA-MM-DD.sqlite
systemctl --user start qvaapply
```

Las migraciones crean automáticamente una copia previa en `data/backups`. Para restaurar, mantén el proceso detenido, conserva primero la base dañada con otro nombre, copia el backup como `data/qvaapply.sqlite`, verifica permisos `600` y arranca en simulación/pausa. Comprueba Auditoría antes de modo real.

## Rotación de secretos

- Telegram: revoca el token en BotFather, actualiza `.env` y reinicia.
- Panel: cambia `DASHBOARD_ADMIN_PASSWORD`; todas las sesiones en memoria desaparecen al reiniciar.
- `LOCAL_ENCRYPTION_KEY`: antes de cambiarla vuelve a ejecutar el login de QvaPay; el token cifrado anterior no será descifrable con la clave nueva.
- QvaPay: revoca sesiones desde QvaPay y ejecuta `pnpm login` de nuevo.

Nunca copies `.env`, `data/`, backups ni capturas con datos financieros a Git o a tickets públicos.

## Checklist de modo real

- [ ] `pnpm check` verde.
- [ ] Backup reciente y restauración conocida.
- [ ] Contraseña del panel exclusiva y fuerte.
- [ ] Límites revisados y revisión visible en Estrategia.
- [ ] Saldos fiat declarados verificados.
- [ ] Sin mutaciones o workflows pendientes.
- [ ] Prueba de simulación coherente.
- [ ] Primera operación real limitada a un importe deliberadamente pequeño.
- [ ] Pago/recepción comprobados fuera del sistema antes de confirmar.
