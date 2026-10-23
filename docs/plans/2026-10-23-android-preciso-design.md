# Android Preciso: aplicación operativa

Diseño aprobado el 23 de octubre de 2026 por el propietario.

## Dirección

Evolucionar la aplicación nativa Compose existente. Inicio, Operaciones,
Avisos y Ajustes con navegación flotante; Herramientas desde Inicio.
Marca Preciso, tipografía jerárquica, azul Preciso, marfil y verde para estados;
temas claro y oscuro. Transparencias limitadas a elementos de navegación,
borde fino y profundidad discreta, sin desenfoques continuos costosos.
Importes, estados y acciones conservan contraste y tamaño táctil adecuado.

Alternativas: una copia literal de iOS pierde convenciones Android; una WebView
reutiliza pantallas pero limita integración y trabajo con conectividad variable.
Se elige Compose por continuidad, rendimiento y accesibilidad nativa.

## Funciones y datos

- Inicio con resumen de pendientes, conexión, accesos y estado del motor.
- Operaciones con búsqueda, filtros, detalle, copia de ID y acciones protegidas.
- Avisos ordenados por prioridad y resultados SMS separados.
- Ajustes con tema persistente, vinculación, permisos y cola SMS actualizados.
- Capital, cacerías, salud, rentabilidad e historial mediante endpoints móviles
  locales, de lectura y alcance explícito. Simulación local bajo demanda.
- Ninguna lectura móvil inicia sincronización o consulta a QvaPay. Las pantallas
  nuevas consultan al abrir y por actualización explícita. Se mantiene el sondeo
  existente solo en primer plano y se evitan peticiones solapadas.
- Caché cifrada de lectura marcada como desactualizada; no mostrar datos de otra
  vinculación al cambiar servidor o credencial. No inventar resultados financieros.
- No añadir control remoto de estrategias en esta entrega: las utilidades de
  cacería muestran límites/estado y permiten simular sin alterar la configuración.

## Seguridad y verificación

Conservar confirmación explícita y credencial del dispositivo, no repetir una
acción monetaria incierta. No ampliar el token móvil a rutas web generales.
No usar datos reales de producción para pruebas de mutaciones.
Probar contratos y permisos, filtros y formatos, APK debug/release, instalación
y pantallas claras/oscuras en emulador, tamaño y errores de ejecución. Los avisos
con app cerrada siguen sin canal push verificado y se describen con honestidad.

## Plan de implementación

1. Preparar SDK/JDK/Gradle y una línea base de compilación; descargar de fuentes
   oficiales y reutilizar herramientas instaladas. La skill writing-plans no
   está instalada; este plan deja explícita la secuencia de implementación.
2. Añadir proyecciones móviles locales acotadas y rutas con permisos específicos,
   pruebas de autenticación, validación y ausencia de consultas remotas.
3. Separar tema/componentes/pantallas del manejo de acciones y captura SMS.
4. Implementar Inicio, búsqueda/filtros/detalle, Avisos y Ajustes; integrar marca.
5. Implementar herramientas de lectura y simulación con caché y carga bajo demanda.
6. Compilar, ejecutar pruebas y emulador, corregir errores visuales/funcionales,
   medir APK y documentar límites. Generar APK firmada conservando la clave previa.
7. Publicar backend compatible solo después de verificar; entregar APK y capturas.

## Resultado verificado

- Android 0.2.0 (4), Compose nativo, marca Preciso y temas Sistema/Claro/Oscuro.
- Inicio, búsqueda/filtros y detalle con acciones separadas, Avisos priorizados,
  Ajustes/SMS y siete herramientas locales. No cambia el motor de cacerías.
- Capital/estado desde proyección ligera; rentabilidad móvil con un máximo de
  1.000 ofertas y 1.000 transacciones, con aviso explícito de muestra parcial.
  Historial paginado; diagnóstico/simulación limitados a 5.000 observaciones.
- Caché de herramientas limitada a 24 entradas; se borra al cambiar vinculación.
  Los helpers SQLite de SMS se cierran después de usarlos.
- Security Crypto estable 1.1.0, exclusión de backup/transferencia, firma previa
  conservada y R8 con reglas precisas para seis anotaciones opcionales de Tink.
- `pnpm check` completo aprobado; contratos móviles comprueban permisos, CSRF,
  proyecciones sin consultas remotas, límites y separación de cuentas.
- 14 pruebas Android aprobadas y lint sin errores. APK debug y release compiladas.
  Release: 1.575.186 bytes; firma válida y coincidente con la clave existente;
  ninguna actividad ni fixture de vista previa en la distribución.
- Emulador Android 16: temas claro/oscuro, texto al 130 %, búsqueda y filtros,
  detalle, Avisos, Ajustes y Herramientas. Actualización de release conserva el
  tema cifrado de la dependencia anterior. Arranque sin registros de crash.
- No hay teléfono conectado. Quedan por validar en dispositivo físico el relay
  SMS y una transacción controlada. No se promete push con la app cerrada.

Referencias: [Android backup](https://developer.android.com/identity/data/autobackup)
y [Security Crypto](https://developer.android.com/jetpack/androidx/releases/security).
