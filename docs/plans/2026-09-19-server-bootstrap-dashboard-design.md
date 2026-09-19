# Bootstrap del panel desde la VPS

## Problema

El documento, los estilos y el JavaScript pueden cargar correctamente con una conexión lenta, pero React bloquea toda la aplicación hasta completar una petición adicional a `/api/dashboard`. Esa petición se aborta a los cinco segundos. Cuando falla, el estado `data` continúa vacío y la interfaz queda atrapada en la pantalla de carga aunque la VPS ya tenga un snapshot SQLite disponible.

El mensaje que afirma conservar datos guardados tampoco describe el comportamiento real: el navegador solo conserva el estado en memoria y lo pierde al recargar.

## Solución elegida

La ruta HTML inicial incorporará un bootstrap JSON generado por la VPS con:

- el estado de sesión y el token CSRF cuando exista una sesión válida;
- el snapshot producido exclusivamente por `DashboardReadModel.localSnapshot()`;
- la configuración y su historial local para que Estrategia también sea utilizable
  desde el primer render.

El JSON se incluirá dentro de un elemento `template`, escapando caracteres con significado HTML para impedir que contenido almacenado pueda cerrar el elemento o inyectar marcado. La respuesta seguirá usando `Cache-Control: no-store`.

React consumirá y eliminará ese bootstrap antes del primer render. Una sesión autenticada empezará con datos y configuración disponibles, por lo que nunca mostrará la compuerta de carga observada. Una visita no autenticada seguirá mostrando el formulario normal.

## Inicio de sesión

Después de un login correcto, el navegador hará una única recarga de la página. La cookie recién creada viajará en esa petición y la VPS devolverá el documento ya acompañado por sesión, CSRF y snapshot. Esto evita encadenar login, verificación de sesión y lectura del dashboard.

## Refrescos posteriores

- `/api/dashboard` seguirá existiendo para refrescos en segundo plano.
- El timeout aumentará para tolerar conexiones lentas.
- Solo habrá una lectura en vuelo; los intervalos no crearán peticiones solapadas.
- Un error actualizará el indicador de estado, pero nunca borrará el snapshot ni sustituirá la aplicación por una pantalla bloqueante.
- El refresco periódico continuará leyendo únicamente datos preparados por la VPS, sin consultar QvaPay desde el navegador.

## Seguridad

- No se guardarán saldos, operaciones ni configuración en `localStorage`, IndexedDB o Cache Storage.
- El bootstrap autenticado será privado, escapado y marcado `no-store`.
- El token CSRF tendrá la misma exposición que ya tiene mediante `/api/session`.
- El logout eliminará la cookie y volverá al formulario sin conservar el snapshot en almacenamiento persistente.

## Pruebas

- Una petición autenticada a `/` incluye sesión y snapshot sin consultar QvaPay.
- Una petición no autenticada no incluye datos operativos.
- Contenido con secuencias como `</template>` no puede cerrar el bootstrap.
- React usa el bootstrap como estado inicial.
- Un timeout posterior conserva los datos visibles.
- Los refrescos no se solapan y mantienen la lectura exclusiva de `/api/dashboard`.
- Login recarga el documento para recibir el bootstrap autenticado.
