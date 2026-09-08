# Plan de implementación: avisos de ofertas bloqueadas y Peer

## 1. Reproducir y corregir la respuesta de QvaPay

- Añadir en `test/qvapay-gateway.test.ts` un caso de `GET /p2p/:uuid` abierto con un `Peer` vacío.
- Añadir el caso opuesto: un `Peer` inválido en una oferta no abierta debe seguir fallando.
- Normalizar `Peer` a `null` únicamente para ofertas abiertas antes de validar las identidades opcionales.

## 2. Persistencia y envío Web Push

- Añadir `web-push` y sus tipos.
- Crear un servicio con generación y persistencia local de claves VAPID, alta/baja validada de suscripciones, deduplicación por versión de alerta y eliminación de endpoints vencidos.
- Añadir pruebas unitarias con un transporte inyectable, sin realizar conexiones externas.

## 3. Integrar el evento del motor

- Ampliar el callback de notificación del motor con un evento estructurado opcional para ofertas bloqueadas.
- Emitirlo solo cuando una oferta nueva pasa por primera vez a bloqueada.
- Conectar el destino Telegram existente y el nuevo servicio Push sin cambiar el comportamiento financiero.

## 4. API local protegida

- Exponer la clave pública VAPID mediante una lectura autenticada.
- Crear rutas CSRF para registrar y eliminar la suscripción del navegador.
- Probar autorización, validación de payload y persistencia.

## 5. Service worker y experiencia interna

- Construir y servir un service worker de alcance raíz.
- Ante un push, enviar el evento a clientes visibles o mostrar la notificación nativa si no hay ninguno.
- Abrir o enfocar `/?view=auditoria` al pulsar la notificación.
- Añadir un centro global de avisos con control de permiso, tarjeta flotante, contador y tono interno.
- Detectar alertas nuevas mediante el mensaje del service worker y mediante refresco local de respaldo.

## 6. Diseño y accesibilidad

- Estilizar el control y la tarjeta con los tokens claros actuales.
- Mantener foco visible, regiones vivas, botones etiquetados y adaptación móvil.
- Añadir estados de permiso denegado, no compatible y activado.

## 7. Verificación

- Ejecutar pruebas focalizadas durante cada etapa.
- Extender la vista previa y el smoke visual para activar el aviso y validar su tarjeta.
- Ejecutar `pnpm check`, `pnpm check:ui` y `git diff --check`.
