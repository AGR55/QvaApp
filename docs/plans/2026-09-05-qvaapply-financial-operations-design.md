# QvaApply: diseño de recuperación y evolución segura

Fecha: 2026-09-05  
Estado: aprobado por el propietario

## Objetivo

Convertir la base recuperada de QvaApply en una aplicación local de administración única, segura y verificable para operar ofertas P2P con dinero real. El sistema debe explicar sus decisiones, aplicar automáticamente solo cuando se cumplan todas las políticas, dejar los pagos fiat bajo control humano y permitir administrar estrategia, riesgo y mercados desde la web.

## Alcance operativo aprobado

- El panel se ejecuta inicialmente en la máquina del propietario y escucha solo en `127.0.0.1`.
- La arquitectura debe admitir un despliegue posterior en una VPS para el mismo administrador.
- El bot puede aplicar automáticamente a ofertas externas que cumplan precios y límites globales.
- Los pagos fiat siempre son manuales.
- Cuando una oportunidad externa requiera QUSD inmovilizado en una oferta propia de venta, el sistema puede cancelar esa oferta, aplicar a la oportunidad y restaurar la oferta original si se confirma que la aplicación falló.
- Un resultado ambiguo nunca se trata como fallo: primero se concilia con QvaPay.
- Todos los límites de estrategia y riesgo se controlan desde el panel.

## Enfoques considerados

### Monolito modular incremental — elegido

Conserva la lógica y pruebas recuperadas, pero reorganiza el sistema en módulos profundos alrededor del dominio financiero. Reduce el riesgo de regresión, facilita una transición gradual y mantiene un despliegue sencillo.

### Reescritura completa

Ofrece una estructura nueva, pero arriesga perder reglas implícitas y aumenta el periodo sin evidencia de equivalencia funcional.

### Microservicios y colas distribuidas

Aíslan procesos, pero introducen fallos distribuidos y carga operativa innecesaria para una sola instancia y un solo administrador.

## Arquitectura

El sistema será un monolito modular TypeScript. La interfaz HTTP y los adaptadores externos no contendrán decisiones financieras.

```text
Panel React
    │
    ▼
HTTP autenticado ──────► Consultas y analítica
    │
    ▼
Casos de uso
    ├── Política de riesgo
    ├── Orquestador de operaciones
    ├── Configuración versionada
    └── Conciliación
          │
          ▼
Dominio financiero
    ├── Oferta
    ├── Operación
    ├── Reserva de capital
    └── Decisión explicable
          │
          ▼
Infraestructura
    ├── QvaPay
    ├── SQLite
    ├── Telegram
    └── Scheduler
```

### Módulos

- **Política de riesgo**: evalúa una oportunidad y produce una decisión con evidencia. Su interfaz recibe una instantánea inmutable; su implementación concentra precios, reservas, exposición y límites.
- **Orquestador de operaciones**: ejecuta y recupera la máquina de estados. Ningún controlador HTTP, tarea programada o handler de Telegram puede encadenar mutaciones monetarias por su cuenta.
- **Conciliación**: resuelve resultados inciertos comparando intenciones locales con el estado remoto antes de reintentar o compensar.
- **Configuración versionada**: valida, activa, audita y restaura configuraciones. Secretos y credenciales quedan fuera de su interfaz.
- **Contabilidad y reservas**: separa saldo observado, saldo declarado, capital comprometido y movimientos realizados.
- **QvaPay**: encapsula autenticación, contratos, rate limits, backoff, idempotencia y clasificación de errores.
- **Panel**: presenta consultas y emite comandos; no replica reglas de dominio.
- **Telegram**: notifica y permite acciones humanas autorizadas; no contiene lógica financiera.

## Máquina de estados compensable

```text
OPORTUNIDAD
  → VALIDADA_POR_RIESGO
  → CAPITAL_RESERVADO
  → CANCELACIÓN_PROPIA_SOLICITADA
  → CANCELACIÓN_PROPIA_CONFIRMADA
  → APLICACIÓN_EXTERNA_SOLICITADA
  ├─→ APLICADA → ESPERANDO_ACCIÓN_HUMANA
  ├─→ RECHAZADA → RESTAURACIÓN_SOLICITADA → RESTAURADA
  └─→ INCIERTA → CONCILIANDO
                     ├─→ APLICADA
                     └─→ NO_APLICADA → RESTAURACIÓN
```

Antes de cancelar una oferta propia se persiste una instantánea completa para reconstruirla. Cada transición es durable, auditable y reiniciable. Una exclusión impide escaneos solapados y reservas dobles. Al arrancar, el sistema recupera operaciones no terminales antes de aceptar trabajo nuevo.

## Política de riesgo

Una oferta solo es operable si supera reglas de precio y todas las reglas globales:

- máximo QUSD por operación;
- máxima exposición QUSD simultánea;
- máximo volumen aplicado por día;
- máximo número de operaciones simultáneas;
- reserva mínima de QUSD;
- máxima antigüedad de cotización;
- margen mínimo esperado;
- deslizamiento máximo;
- límites específicos por mercado;
- tiempo de enfriamiento por mercado y contraparte;
- pausa tras errores consecutivos o mutaciones inciertas;
- modo simulación, modo real e interruptor de emergencia.

El resultado visible usa `APLICAR`, `REVISIÓN MANUAL`, `BLOQUEADA` o `IGNORADA` e incluye reglas evaluadas, capital requerido y motivos exactos.

## Seguridad

- Escucha local en `127.0.0.1` por defecto.
- Preparación para autenticación de administrador y proxy TLS en VPS.
- Sesiones en cookies `HttpOnly`, `Secure` en HTTPS y `SameSite=Strict`.
- Protección CSRF, CSP, clickjacking, MIME sniffing y caché accidental.
- Esquemas estrictos, límites de cuerpo y rate limiting en HTTP.
- Tokens y secretos nunca se envían al navegador ni se guardan como configuración ordinaria.
- Token QvaPay cifrado en reposo; clave maestra proporcionada por el entorno.
- Auditoría estructurada y encadenada mediante hashes para detectar modificaciones silenciosas.
- Interruptor de emergencia que bloquea trabajo nuevo sin impedir consulta o conciliación.

## Persistencia

SQLite transaccional es apropiado para una sola instancia local. El acceso se concentra en un módulo profundo para preservar localidad y facilitar sustituir su implementación cuando una VPS o múltiples procesos justifiquen PostgreSQL.

Los datos se separan en:

- configuraciones y revisiones;
- operaciones y transiciones;
- intenciones monetarias;
- reservas de capital;
- libro contable;
- ofertas propias restaurables;
- observaciones de mercado;
- instantáneas analíticas;
- auditoría e incidentes.

Las migraciones son explícitas, respaldan la base antes de cambios destructivos y se prueban desde versiones anteriores.

## Panel y experiencia de usuario

La interfaz adopta una estética sobria de mesa de operaciones financiera, con alta densidad legible y jerarquía clara.

- **Centro de control**: saldos, capital, exposición, límites, modo, salud e interruptor de emergencia.
- **Operaciones**: línea temporal, siguiente acción humana, vencimientos y conciliaciones.
- **Radar de mercado**: libro, medias, medianas, spread y decisiones explicadas.
- **Mis ofertas**: creación, edición y cancelación con formularios y vista previa de impacto.
- **Estrategia y riesgo**: configuración tipada, comparación de cambios, historial y restauración.
- **Capital y contabilidad**: saldos, reservas, movimientos y discrepancias.
- **Analítica**: precios, volumen, descarte por reglas, éxito, duración, errores y uso de capital.
- **Auditoría e incidentes**: decisiones, mutaciones, compensaciones, errores y cambios.
- **Salud**: scheduler, QvaPay, rate limits, sesión, Telegram y base de datos.

Los gráficos tienen tablas equivalentes. Toda acción es operable por teclado, tiene foco visible y no depende solo del color. Se eliminan diálogos nativos `prompt()` y `confirm()`.

## Tecnologías

- TypeScript estricto sobre una versión LTS soportada de Node.js.
- Fastify para HTTP y políticas transversales.
- Validación compartida mediante esquemas tipados.
- React y Vite para el panel.
- TanStack Query para estado remoto.
- Recharts para gráficos con alternativas tabulares.
- SQLite y migraciones explícitas para la fase local.
- Vitest, Testing Library y Playwright para verificación.
- ESLint, Prettier, TypeScript y auditoría de dependencias como puertas de calidad.

## Manejo de errores

Los errores se clasifican como validación, autorización, conflicto, rate limit, fallo remoto confirmado, mutación incierta, persistencia o error interno. La interfaz presenta mensajes accionables y un identificador de incidente sin filtrar secretos. Los reintentos automáticos solo se permiten cuando son seguros; una mutación incierta exige conciliación.

## Estrategia de pruebas

1. Pruebas unitarias y basadas en propiedades para precios, comisiones, reservas, exposición y límites.
2. Pruebas de máquina de estados con reinicio en cada transición.
3. Pruebas contractuales de QvaPay con respuestas documentadas y errores conocidos.
4. Integración HTTP y SQLite para autenticación, CSRF, validación y concurrencia.
5. Pruebas de interfaz y recorridos completos con Playwright.
6. Inyección de fallos para timeouts, `409`, `429`, sesión expirada, respuestas inválidas y caída durante conciliación.

Las pruebas automáticas nunca realizan mutaciones reales en QvaPay. El modo real permanece bloqueado hasta superar migraciones, análisis estático y suite crítica. La validación de producción usa un procedimiento manual, explícito y limitado.

## Criterios de aceptación

- Ninguna mutación monetaria parte directamente de HTTP, Telegram o scheduler.
- Toda decisión automática puede explicarse desde el panel.
- Toda configuración no secreta relevante se administra desde la web y conserva historial.
- Un reinicio en cualquier paso no duplica exposición ni pierde la compensación pendiente.
- Una respuesta ambigua de QvaPay pausa y concilia antes de actuar.
- El panel permite observar operaciones, capital, mercado, riesgo, auditoría y salud.
- Las pruebas críticas y controles de calidad son obligatorios antes de modo real.

## Restricciones actuales de recuperación

La copia recibida no contiene un manifiesto `package.json`, configuración TypeScript, lockfile ni historial Git utilizable. El directorio `.git` está vacío y montado como solo lectura. Esas piezas deben reconstruirse antes de ejecutar la suite completa; el documento no puede confirmarse en Git desde esta copia.
