# QvaApply

Mesa local y bot P2P de un único administrador para QvaPay. Detecta oportunidades dentro de límites configurables, puede aplicar automáticamente y, cuando necesita liberar QUSD, cancela primero ofertas propias menos competitivas mediante un flujo durable y compensable. **QvaApply nunca realiza el pago fiat:** el propietario lo hace y registra la referencia.

## Garantías de seguridad

- El modo inicial es simulación y la automatización permanece pausada.
- El modo real requiere `CONFIRM_REAL_TRADING=true`, límites revisados en el panel y activación humana.
- Toda mutación se registra antes de enviarse a QvaPay.
- Un timeout de una mutación bloquea nuevas operaciones hasta conciliar por lectura.
- Las reservas de capital, workflows, configuración, revisiones y auditoría viven en SQLite.
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

`pnpm login` admite el TOTP de seis dígitos de una aplicación autenticadora. La contraseña y el código se introducen ocultos; ante fallos transitorios de conexión se hacen tres intentos y el token solo se guarda cifrado después de validarlo con `GET /user`.

La primera revisión de límites debe hacerse en **Estrategia**. Empieza en simulación, revisa Mercados, Capital, Operaciones y Auditoría, y solo después considera el modo real.

## Comandos

```bash
pnpm typecheck       # análisis estático estricto
pnpm test            # suite unitaria, contractual e integrada
pnpm build           # servidor + panel de producción
pnpm check           # tipos, 81 pruebas, builds y escáner de secretos
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
