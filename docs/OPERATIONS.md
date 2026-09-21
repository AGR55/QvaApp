# Runbook de operación

## Arranque diario

1. Abre el panel y comprueba **Auditoría → Salud e integridad**.
2. Confirma que la cadena de configuración es íntegra y no hay mutaciones pendientes.
3. Revisa saldo QUSD, saldos fiat declarados, reservas y operaciones activas.
4. Confirma que `CONFIRM_REAL_TRADING=true` y que los límites fueron revisados.
5. El sistema arranca activo; usa **Inactivar** o la parada de emergencia si no deben iniciarse nuevas operaciones.

En **Cockpit → Cobertura del escáner** comprueba que aparezcan los mercados activos, los lados consultados, las ofertas elegibles/bloqueadas y el presupuesto de aplicación. Una ronda que muestre solo compras de QUSD es normal: las ventas de QUSD se consultan en la ronda alterna.

No mantengas activa la automatización si `pnpm check` falla, la documentación de QvaPay cambió, existe una conciliación pendiente o los saldos declarados no coinciden.

Para el panel local se aceptan `http://127.0.0.1:3000`, `http://localhost:3000` y el loopback IPv6 equivalente. Deben conservar el protocolo y puerto de `DASHBOARD_TRUSTED_ORIGIN`; IPs LAN, dominios y otros puertos se rechazan.

## Conexión lenta o caída

- El indicador superior distingue el estado local; cada bloque remoto muestra la fecha de su última lectura.
- **Dato guardado** significa que SQLite conserva una lectura anterior: sirve para contexto, no como cotización actual para tomar una decisión financiera nueva.
- **Actualizar** consulta solo los recursos necesarios para la vista abierta y los envía secuencialmente.
- Si no hay conexión, siguen disponibles Estrategia, Operaciones, Auditoría e históricos locales.
- No actives ni repitas una acción financiera basándote únicamente en un dato marcado como guardado. Espera una lectura actual o comprueba directamente en QvaPay.
- Las operaciones activas se concilian periódicamente mediante `GET /p2p/:uuid`. Los estados remotos `completed` y `cancelled` salen de la vista operativa, pero se conservan en SQLite y en la auditoría. Si una aplicación vuelve a `open`, significa que ya no tiene contraparte y también se cierra localmente. `revision` permanece visible porque requiere seguimiento y no es un estado terminal.

En **Red cooperativa**, HTTP y NATS tienen estados independientes. Si NATS cae,
la reconciliación HTTP mantiene un snapshot eventual; si HTTP cae, NATS puede
seguir actualizando la vista, pero no publiques ni retires aportaciones hasta
recuperar HTTP. No uses el total guardado para comprometer dinero y no invoques
manualmente `POST /hunts/perform`: esa operación permanece fuera de QvaApply
hasta que Sync Core sea idempotente y transaccional.

## Inicio de sesión QvaPay con TOTP

Ejecuta `pnpm login`, introduce el correo, la contraseña oculta y después el código vigente de seis dígitos de la aplicación autenticadora. El comando usa `remember: true`, verifica el token mediante `GET /user` y solo entonces lo cifra en SQLite. Un timeout de transporte se reintenta hasta tres veces; un TOTP rechazado, bloqueo o rate limit requiere intervención humana y nunca se reintenta automáticamente.

## Flujo humano de pago

- Compra de QUSD: pulsa **Voy a pagar**, transfiere fuera de QvaApply y luego **Registrar pago** con referencia.
- Venta de QUSD: espera y verifica el fiat en tu cuenta; solo después pulsa **Confirmar recepción**.
- QvaApply nunca abre una banca, firma una transferencia ni inventa una referencia.

## Automatización del libro P2P

- Las ofertas propias vencen cinco minutos después de su última actualización conocida.
- El proceso comprueba cada cinco segundos, refresca solo una oferta por vez y respeta 20 segundos entre ediciones.
- Se intenta como máximo una aplicación por ronda y se conserva una separación superior a 30 segundos entre intentos, incluso después de reiniciar.
- Un rechazo confirmado después de liberar QUSD activa la restauración de las ofertas propias originales.
- Un timeout o respuesta incierta no activa restauración ni reintento: exige conciliación.

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

Las migraciones crean automáticamente una copia previa en `data/backups`. Para restaurar, mantén el proceso detenido, conserva primero la base dañada con otro nombre, copia el backup como `data/qvaapply.sqlite` y verifica permisos `600`. Si necesitas inspeccionar antes de operar, conserva una parada de emergencia en la copia restaurada. Comprueba Auditoría al arrancar.

La migración v6 añade configuración operativa y cachés remotas. En una base anterior crea automáticamente `qvaapply-before-v6-*.sqlite` antes de modificar el esquema.

## Rotación de secretos

- Telegram: revoca el token en BotFather, actualiza `.env` y reinicia.
- Panel: cambia `DASHBOARD_ADMIN_PASSWORD`; todas las sesiones en memoria desaparecen al reiniciar.
- `LOCAL_ENCRYPTION_KEY`: antes de cambiarla vuelve a ejecutar el login de QvaPay; el token cifrado anterior no será descifrable con la clave nueva.
- Sync Core: cambia `SYNC_PASSWORD`, revoca las API keys anteriores en Sync Core y reinicia QvaApply para emitir una credencial nueva cifrada.
- QvaPay: revoca sesiones desde QvaPay y ejecuta `pnpm login` de nuevo.

Nunca copies `.env`, `data/`, backups ni capturas con datos financieros a Git o a tickets públicos.

## Checklist de operación

- [ ] `pnpm check` verde.
- [ ] Backup reciente y restauración conocida.
- [ ] Contraseña del panel exclusiva y fuerte.
- [ ] Límites revisados y revisión visible en Estrategia.
- [ ] Saldos fiat declarados verificados.
- [ ] Sin mutaciones o workflows pendientes.
- [ ] Primera operación tras cambios limitada a un importe deliberadamente pequeño.
- [ ] Pago/recepción comprobados fuera del sistema antes de confirmar.
