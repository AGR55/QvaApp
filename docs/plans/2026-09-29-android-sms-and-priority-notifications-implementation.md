# Plan de implementación: SMS Android y avisos de operación

1. Registrar la línea base de pruebas. En este entorno `tsx --test` falla al
   abrir su IPC (`EPERM`); `node --import tsx --test` ejecuta los mismos casos.
2. Añadir el servicio de comprobantes: esquema mínimo, credencial aleatoria
   por dispositivo y hash, deduplicación durable, matching de importe/moneda/
   beneficiario/tiempo y llamada al caso de uso `markPaid` solo con un candidato.
   Un resultado incierto o ambiguo permanece en revisión.
3. Añadir endpoints autenticados de emparejamiento, estado, revocación y
   revisión, y un endpoint limitado por credencial de dispositivo para entregar
   el comprobante. No aceptar SMS íntegros ni claves QvaPay.
4. Añadir avisos distintos para aplicaciones a ofertas propias y para ofertas
   tomadas por el bot. Conservarlos en SQLite y entregarlos por Web Push y
   Telegram de forma independiente; destacarlos en la UI de Operaciones.
5. Crear `android/` con APK privada Kotlin: `SMS_RECEIVED_ACTION`, permiso
   solicitado en contexto, emisor permitido configurable, parser para los tres
   formatos, cola local y reintento de envío por HTTPS. Una pantalla simple
   permite emparejar y ver entregas. No incluir credenciales de QvaPay.
6. El hilo principal revisa los cambios de cada subagente, corrige la
   integración, ejecuta pruebas enfocadas y `pnpm check` completo usando el
   comando alternativo del test runner si el IPC sigue bloqueado.
7. La activación automática en producción depende de poder construir la APK,
   instalarla en un Android y verificar una transferencia pequeña real con la
   cuenta de destino de QvaPay. Mientras tanto el sistema conserva la revisión
   manual para cada comprobante sin evidencia suficiente.

## Reparto

- Subagente GPT-6 Luna 1: backend y pruebas de comprobantes. Archivos de
  dominio/HTTP/SQLite asignados; no modificar `src/index.ts`.
- Subagente GPT-6 Luna 2: APK Android completa bajo `android/` y pruebas del
  parser. Sin tocar servidor ni web.
- Subagente GPT-6 Luna 3: avisos prioritarios, lógica de feed, Web Push y UI.
  Puede tocar `src/index.ts`; coordinar su integración con el hilo principal.
- Hilo principal: revisar diseño, límites de seguridad, integración entre
  componentes, tests, build y entrega.
