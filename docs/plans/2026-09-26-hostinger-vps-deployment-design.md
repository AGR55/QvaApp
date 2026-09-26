# Despliegue de QvaApply en la nueva VPS de Hostinger

## Objetivo

Preparar desde cero la VPS `2.25.247.171` para ejecutar una única instancia de
QvaApply, publicar el panel en `https://honux.tech` y conservar despliegues
automáticos desde `main` con comprobación de salud y rollback.

No se migrarán datos ni secretos de la VPS anterior. La aplicación comenzará
con una base SQLite vacía y `CONFIRM_REAL_TRADING=false`.

## Arquitectura aprobada

GitHub Actions construirá y verificará cada revisión. Los commits de `main`
enviarán un archivo versionado por SSH a la VPS. Allí Docker Compose construirá
una imagen Node.js 24, actualizará atómicamente la release activa y mantendrá
los datos fuera de la imagen.

Nginx será el único punto público. Los puertos 80 y 443 estarán abiertos; el
puerto de la aplicación escuchará exclusivamente en `127.0.0.1`. Cuando el DNS
de `honux.tech` resuelva a la nueva IP, Certbot emitirá el certificado y Nginx
redirigirá HTTP a HTTPS.

## Preparación del host

- Instalar actualizaciones de seguridad, Docker Engine con Compose, Nginx,
  Certbot, firewall y protección básica de SSH.
- Crear directorios estables para configuración, datos, releases y artefactos.
- Usar una clave Ed25519 exclusiva para el despliegue automatizado; la
  contraseña se utilizará únicamente para la preparación inicial.
- Abrir solo SSH, HTTP y HTTPS. La política conservará la sesión SSH antes de
  habilitar el firewall.
- Ejecutar el proceso Node como usuario sin privilegios dentro de un contenedor
  con filesystem de solo lectura, capacidades eliminadas y reinicio automático.

## Configuración y datos

Los secretos permanecerán en un archivo del host con permisos restrictivos y
nunca entrarán en Git. El bootstrap dejará una plantilla segura si las
credenciales todavía no están disponibles. QvaApply no empezará a operar hasta
que el propietario complete la configuración y habilite deliberadamente el
modo real.

SQLite vivirá en un volumen persistente del host. Una tarea local producirá
copias rotativas consistentes. Estas copias reducen el riesgo operativo, pero
no sustituyen una futura copia externa cifrada.

## Despliegue y recuperación

Cada release se construirá por separado. Tras cambiar el enlace `current`, el
despliegue consultará `/api/session`; si falla, restaurará la release anterior.
Las releases antiguas se limitarán para evitar crecimiento indefinido del
disco. Los cambios actualizarán también la documentación y eliminarán todas
las referencias operativas a la VPS anterior.

## Verificación

Se comprobarán la suite del repositorio, la sintaxis de los scripts y del
workflow, la configuración de Docker Compose y Nginx, los permisos, el estado
del firewall, el reinicio automático y la accesibilidad del servicio a través
del proxy. TLS se verificará después de que el DNS de `honux.tech` apunte a
`2.25.247.171`.
