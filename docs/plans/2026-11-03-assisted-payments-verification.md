# Verificación de pagos asistidos y correcciones móviles

Entrega local del 2026-11-03. No se ejecutaron códigos USSD, autenticaciones
bancarias, pagos ni movimientos reales. Tampoco se arrancó el bot operativo.

## Resultado

- Laboratorio instalado en el Redmi Note 8 Pro, Android 16, con el paquete
  separado `com.qvaapply.sms.lab`; conserva intacta la instalación habitual.
- Exclusión bancaria, desconexión confirmada, espera indefinida por congestión,
  resultados inciertos y conciliación ficticia representados por una máquina de
  estados pura. No acepta claves ni destinos reales.
- El APK lab no solicita INTERNET, ACCESS_NETWORK_STATE, RECEIVE_SMS,
  POST_NOTIFICATIONS ni CALL_PHONE. Se verificó tanto el manifiesto fusionado
  como los permisos instalados por Android.
- El manifiesto release contiene MainActivity y GoogleApiActivity; excluye
  PaymentLabActivity y PreviewActivity. Los fuentes de laboratorio son debug/lab.
- Se corrigió la proyección local/remota de estados, incluidas operaciones ya
  cerradas que salían del listado local activo y reaparecían desde el catálogo
  antiguo. Cancelaciones sin Peer y órdenes canceladas sin Taker actualizan
  únicamente conversaciones conocidas. Las órdenes hermanas conservan su estado.
- Fuera de la primera página, se revisan como máximo dos padres activos por
  ciclo de conciliación, con rotación y cooldown persistente de 30 segundos.
  Una ausencia, 404 o timeout no se interpreta como cancelación. Son lecturas
  analíticas; la proyección no modifica el libro de operaciones ni sus saldos.
- El compositor usa adjunto circular con icono, campo de extremos redondeados y
  altura mínima 48 dp, y envío circular de 48 dp. El contador queda fuera de la
  fila y no altera la alineación. Conserva texto multilínea y bloqueo de envíos
  inciertos; el color del icono de envío sigue el estado del botón, también con
  imágenes sin texto.

## Comprobaciones

- TypeScript: `pnpm typecheck` y `pnpm build:server`, correctos.
- Suite servidor: 705 pruebas, cero fallos, con
  `node --import tsx --test --test-isolation=none test/*.test.ts`.
- Entorno servidor disponible: Node 25.9.0; pnpm advierte que el proyecto declara
  Node 24.22.1–24.x. No se cambió el runtime del usuario. Se desactivó aislamiento
  de procesos para ejecutar las pruebas en este entorno restringido.
- Gradle 8.14 con JBR 21 y SDK 35 local, modo offline:
  `:app:testDebugUnitTest :app:testLabUnitTest :app:lintDebug :app:lintLab
  :app:assembleLab :app:assembleDebug :app:assembleRelease`, correcto.
- 38 pruebas Android por variante, incluidas 10 pruebas nuevas de la máquina
  de estados. Lint sin errores; conserva avisos de deprecación y otros previos.
- En teléfono: autenticación sintética BPA; selección BANDEC conserva BPA y
  exige desconexión. Inspección visual del chat sintético sin teclado y con
  teclado abierto. Campo y botones alineados con altura 48 dp.
- `git diff --check`, correcto.

Capturas locales de demostración (fuera de Git):

- `artifacts/android/assisted-payments/qva-chat-composer.png`
- `artifacts/android/assisted-payments/qva-chat-composer-keyboard.png`
- `artifacts/android/assisted-payments/qva-payment-lab.png`

## Límites de esta entrega

No se desplegó el backend ni se sustituyó la APK habitual. El laboratorio está
instalado para pruebas; las correcciones productivas están en el código local.
Release se generó sin firma (`app-release-unsigned.apk`), ya que no se cargaron
credenciales de firma para esta comprobación.

No hay todavía preparación de operaciones reales ni adaptadores de códigos
por proveedor. La confirmación del laboratorio es propia y ficticia: no acredita
el comportamiento ni el punto de débito de ningún banco o de ETECSA. La siguiente
fase requiere verificar esos contratos manteniendo la autorización final manual.
