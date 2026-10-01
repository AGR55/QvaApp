# Plan de implementación: Android Material y SMS

## 1. Establecer línea base

- Revisar estado de Git y preservar archivos del usuario.
- Ejecutar pruebas actuales de servidor y Android cuando el entorno lo permita.
- Medir APK release actual y verificar conectividad de compilación/ADB.

## 2. Contrato SMS y servidor (subagente Luna)

- Agregar pruebas de aceptación y rechazo para BPA, Metropolitano, FINCIMEX,
  Bandec y ETECSA saliente/entrante.
- Extender contrato de recibo sin romper clientes APK existentes.
- Validar remitente, esquema, importe, teléfono/beneficiario, tiempo y
  deduplicación. No almacenar cuerpo completo ni saldo.
- Agregar emparejamiento estricto de ETECSA a una única operación de mercado
  ETECSA y referencia interna determinista claramente etiquetada.
- Mantener revisión para ambigüedad, errores remotos y mutaciones inciertas.
- Exponer el resultado de procesamiento de recibos a la app.
- Sincronizar de forma acotada las operaciones `processing` de QvaPay hechas
  fuera del bot (aprobado el 1 de octubre). Antes de habilitar marcado SMS,
  verificar inequívocamente rol de pagador, contraparte, importe y destino;
  una identidad o rol ambiguo exige revisión humana.

## 3. UI Android y captura SMS (subagente Luna)

- Migrar a Material 3 Compose estable con tres destinos y estado de conexión.
- Sustituir campos de remitente por constantes `PAGOxMOVIL`/`ETECSA`.
- Actualizar parser/receiver/cola para los formatos acordados y el nuevo
  contrato; migrar preferencias y SQLite sin perder recibos ni token.
- Pruebas unitarias del parser y errores de envío. Medir APK release.

## 4. Operaciones, avisos y acciones móviles (subagentes Luna; revisión principal)

- Endpoints móviles de lectura mínima y credencial de operador independiente,
  revocable; pruebas de permisos por ruta y de datos sensibles.
- UI de operaciones/avisos, actualización cuando está abierta y caché local
  identificada como obsoleta cuando corresponda.
- Acciones `paid`, `received`, `cancel` con confirmación local, auditoría e
  intención monetaria durable; impedir repeticiones ante incertidumbre.
- Planificar/implantar canal push nativo con configuración verificable; no
  afirmar entrega en segundo plano sin una prueba en el Redmi.

## 5. Integración y despliegue (agente principal)

- Revisar cada diff y los límites de seguridad, ejecutar typecheck, tests,
  builds y chequeo de secretos.
- Comprobar migración Android sin pérdida de datos y comparar tamaño APK.
- Desplegar backend compatible, probar una operación pequeña, luego instalar
  APK firmada. Validar recepción y resultado desde dispositivo a QvaPay.
- Si falta un requisito externo para push, mantener esa parte desactivada y
  documentar exactamente qué falta; no bloquear mejoras independientes.
- Si este equipo carece del SDK Android, no dar por verificado el APK ni
  instalarlo: completar la compilación en un entorno con SDK antes de publicar.
