# Seguridad

QvaApply controla operaciones con dinero real. No reportes públicamente tokens, UUID de operaciones, datos de cobro, bases SQLite ni capturas del panel.

## Controles

- Secretos únicamente en `.env` y token QvaPay cifrado mediante la clave local.
- Panel en loopback con contraseña independiente, sesiones efímeras, cookie `HttpOnly`, CSRF, origen exacto y límite de login.
- CSP restrictiva, bloqueo de framing, MIME sniffing, permisos del navegador y caché desactivados.
- Schemas de entrada en Fastify y límite de cuerpo de 10 KB.
- Respuestas críticas de QvaPay decodificadas antes del dominio.
- Auditoría persistente e historial de configuración encadenado por hash.
- Modo real doblemente habilitado por entorno y panel; emergencia persistente.

## Reporte privado

Detén el modo real, reproduce únicamente con datos ficticios y conserva logs/UUID localmente. Corrige primero cualquier fuga de credenciales rotándolas en el proveedor correspondiente.

## Alcance actual

Es una aplicación de un solo administrador y una sola instancia. La contraseña del panel no sustituye TLS, firewall o VPN al pasar a VPS. No se promete protección si el sistema operativo local ya está comprometido.
