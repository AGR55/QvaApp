# QvaApply

Mesa local y bot P2P de un único administrador para QvaPay. Detecta oportunidades dentro de límites configurables, puede aplicar automáticamente y, cuando necesita liberar QUSD, cancela primero ofertas propias menos competitivas mediante un flujo durable y compensable. **QvaApply nunca realiza el pago fiat:** el propietario lo hace y registra la referencia.

## Garantías de seguridad

- Producción opera únicamente en real y arranca activa, salvo que exista una parada de emergencia persistente.
- El proceso exige `CONFIRM_REAL_TRADING=true` y límites revisados antes de iniciar.
- Toda mutación se registra antes de enviarse a QvaPay.
- Las aplicaciones, cancelaciones y ediciones pasan por una cola única; sus separaciones se conservan en SQLite incluso tras reiniciar.
- Un timeout de una mutación bloquea nuevas operaciones hasta conciliar por lectura.
- Las reservas de capital, workflows, configuración, revisiones y auditoría viven en SQLite.
- Las cuentas secundarias solo reciben capacidad de listado; la cuenta principal es la única que puede consultar fondos privados o mutar operaciones.
- Cada oferta candidata conserva en SQLite una decisión versionada con todas sus comprobaciones; Auditoría las consulta con paginación y filtros.
- El saludo automático se excluye al vigilar el chat: cualquier mensaje propio posterior detiene la autocancelación. Si el chat no responde, la cancelación se aplaza.
- Telegram y Web Push avisan de aplicaciones, bloqueos y conciliaciones mediante canales independientes.
- La última lectura válida de cada recurso QvaPay vive en SQLite y se muestra con su fecha cuando la conexión falla.
- El panel escucha solo en `127.0.0.1`, usa contraseña, sesión `HttpOnly`, `SameSite=Strict`, CSRF y origen exacto.
- Los pagos y confirmaciones finales siempre requieren intervención humana.

## Instalación local

Requisitos: Node.js 24 o 25 y pnpm 11.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm check
pnpm login
pnpm dev
```

Configura en `.env` una `LOCAL_ENCRYPTION_KEY` aleatoria y una `DASHBOARD_ADMIN_PASSWORD` distinta, de al menos 14 caracteres. No reutilices la contraseña de QvaPay. Abre [http://127.0.0.1:3000](http://127.0.0.1:3000).

### Desarrollo con recarga

Para levantar el servidor y el watcher del panel en un solo comando:

```bash
pnpm dev:all
```

El servidor reinicia automáticamente al cambiar archivos de `src/` y el
frontend recompila automáticamente al cambiar archivos de `web/`. Como el
panel se sirve como archivos estáticos, actualiza el navegador después de
cada cambio visual. También puedes ejecutar `pnpm dev` y `pnpm dev:web` en
terminales separadas.

En operación local también puedes entrar mediante [http://localhost:3000](http://localhost:3000). La protección de origen considera equivalentes únicamente `127.0.0.1`, `localhost` e IPv6 loopback cuando protocolo y puerto coinciden; cualquier dirección externa continúa bloqueada.

### Preview de UI aislado

Para trabajar en la interfaz sin iniciar Telegram, QvaPay ni leer las
credenciales reales, usa:

```bash
pnpm preview:ui
```

Abre [http://127.0.0.1:3100](http://127.0.0.1:3100) e inicia sesión con
`preview-segura-2026`. El preview usa un modelo en memoria con datos de
demostración. No ejecutes `pnpm dev` ni `pnpm dev:all` con el mismo `.env` que
utiliza la VPS: dos procesos competirían por el bot de Telegram y podrían usar
la misma sesión operativa de QvaPay.

`pnpm login` admite el TOTP de seis dígitos de una aplicación autenticadora. La contraseña y el código se introducen ocultos; ante fallos transitorios de conexión se hacen tres intentos y el token solo se guarda cifrado después de validarlo con `GET /user`.

La primera revisión de límites debe hacerse en **Estrategia** antes de iniciar el servicio. Revisa también Mercados, Capital, Operaciones y Auditoría; usa la parada de emergencia si necesitas inspeccionar el sistema sin nuevas aplicaciones.

La fuente de mercado consulta hasta 100 ofertas por turno y rota de forma justa entre la cuenta principal y cualquier cantidad de cuentas secundarias. Cada cuenta respeta su intervalo propio; dos cuentas configuradas a 3 segundos producen aproximadamente una lectura global cada 1,5 segundos. La compra de QUSD conserva prioridad y el lado de venta se intercala con menor frecuencia. El motor ejecuta como máximo una oportunidad a la vez; si va a vender y necesita liberar QUSD, el workflow compensable puede cancelar ofertas propias peores y restaurarlas ante un rechazo confirmado. Los pagos y las confirmaciones de recepción siguen siendo manuales.

Las cuentas secundarias se añaden en **Estrategia → Fuente de mercado** mediante tokens de API limitados a `p2p:read`. QvaApply valida cada token con un listado mínimo, lo cifra y nunca vuelve a enviarlo al navegador. Un `429`, timeout o token vencido afecta solo a esa cuenta; las demás continúan. La frontera `MarketDataSource` permite reemplazar posteriormente este polling por el stream oficial de QvaPay sin cambiar el motor de riesgo ni la cuenta operadora.

Precios, límites, mercados, saldos declarados, intervalos, autocancelación, refresco, cortafuegos y mensaje P2P se administran en **Estrategia** y se versionan en SQLite. Los antiguos valores de entorno o `trading-config.json` solo pueden inicializar una base vacía; después SQLite es la fuente de verdad. Credenciales, claves y `CONFIRM_REAL_TRADING` permanecen fuera del panel.

El panel abre primero con SQLite y actualiza únicamente los recursos de la vista activa. Si QvaPay tarda o no responde, conserva los datos anteriores, muestra su fecha y permite navegar, auditar o cambiar configuración local sin quedar atrapado en una pantalla de carga.

Los avisos del navegador se activan desde el icono de campana. En la máquina local funcionan mediante `localhost`/`127.0.0.1`; un despliegue futuro en VPS deberá usar HTTPS. Las gráficas leen una ventana móvil de 24 horas alimentada por el escáner y usan un SVG local liviano.

## Comandos

```bash
pnpm typecheck       # análisis estático estricto
pnpm test            # suite unitaria, contractual e integrada
pnpm build           # servidor + panel de producción
pnpm check           # tipos, 118 pruebas, builds y escáner de secretos
pnpm check:ui        # build + recorrido Chromium, responsive y WCAG automatizado
pnpm start           # ejecuta dist/index.js
```

## Documentación

- [Contexto de dominio](CONTEXT.md)
- [Diseño aprobado](docs/plans/2026-09-05-qvaapply-financial-operations-design.md)
- [Arquitectura y extensiones](docs/ARCHITECTURE.md)
- [Runbook de operación e incidentes](docs/OPERATIONS.md)
- [Despliegue futuro en VPS](docs/VPS.md)
- [Política de seguridad](SECURITY.md)
- [Evidencia de verificación](docs/VERIFICATION.md)
- Contrato local OpenAPI autenticado: `/api/openapi.json`

La integración se basa en la [documentación oficial de QvaPay](https://www.qvapay.com/docs). No se ejecutan pruebas automáticas contra mutaciones reales de QvaPay.
