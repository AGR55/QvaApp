# Diseño: inicio de sesión QvaPay con TOTP

Fecha: 2026-09-07

## Objetivo

Permitir que el propietario inicie sesión con email, contraseña y el código TOTP de seis dígitos de su aplicación autenticadora, siguiendo el contrato oficial de `POST /auth/login`, sin exponer secretos ni guardar tokens sin verificar.

## Flujo

1. Solicitar email y contraseña oculta.
2. Enviar email, contraseña y `remember: true` sin código 2FA.
3. Ante `202` y `has_otp: true`, solicitar un TOTP de exactamente seis dígitos.
4. Repetir el login con `two_factor_code`.
5. Validar el Bearer token mediante una lectura autenticada de `/user`.
6. Guardar el token cifrado en SQLite únicamente después de la validación.
7. Cerrar la base y restaurar el estado de la terminal en éxito o error.

## Resiliencia

Las conexiones de autenticación tendrán timeout explícito y hasta tres intentos con backoff para fallos de transporte transitorios. Nunca se reintentarán automáticamente errores HTTP, credenciales, TOTP, bloqueo de cuenta o rate limit. Los mensajes distinguirán conexión, timeout y rechazo de QvaPay sin imprimir contraseña, TOTP ni token.

## Pruebas

Se cubrirán detección OTP, validación local del formato, reintento por timeout, ausencia de reintento ante error HTTP, verificación del token y prohibición de persistir una sesión no validada.
