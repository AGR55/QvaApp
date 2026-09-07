# Diseño: orígenes loopback seguros para el panel

Fecha: 2026-09-07

## Problema

El panel local está enlazado a loopback, pero la protección CSRF exigía igualdad textual con `DASHBOARD_TRUSTED_ORIGIN`. Un navegador que accediera mediante `localhost` o IPv6 enviaba un origen distinto de `127.0.0.1` y el login fallaba aunque protocolo y puerto fueran correctos.

## Decisión

Cuando el origen configurado sea loopback, aceptar únicamente `127.0.0.1`, `localhost` y `[::1]` como nombres equivalentes, siempre con el mismo protocolo y puerto efectivo. Para cualquier origen no loopback se conserva igualdad exacta.

Se siguen rechazando peticiones sin `Origin`, URLs inválidas, otros puertos, cambios HTTP/HTTPS, subdominios, IPs LAN y dominios externos. No se confía en el header `Host` y no se desactiva CSRF.

## Verificación

Pruebas unitarias y Fastify cubrirán los alias loopback permitidos y variantes maliciosas o con puerto distinto. Después se ejecutará el gate completo y el recorrido Chromium.
