# Implementación aprobada: simulador de pagos y correcciones móviles

El operador aprobó el enfoque el 2026-11-03. La sesión bancaria es exclusiva:
hay que desconectarse antes de autenticar otro banco. La autenticación USSD suele
tardar entre 5 segundos y un minuto y puede superar ese tiempo por congestión;
un timeout no acredita desconexión ni autoriza repetir una solicitud.

Plan de esta entrega:

1. Reproducir con fixtures los estados cerrados que reaparecen activos. Corregir
   la proyección catálogo/local y la actualización de cancelaciones sin Peer.
   Revisar también los activos fuera de la primera página mediante lecturas acotadas.
2. Cambiar el adjunto por un icono con superficie circular y unificar el compositor
   con campo redondeado de altura mínima 48 dp. Conservar texto multilínea,
   accesibilidad, borradores y protección de envíos inciertos.
3. Añadir laboratorio exclusivamente debug, con destinos sintéticos y máquina
   de estados pura. Separar sesión, autenticación, desconexión, revisión y resultado.
   Representar espera larga e incertidumbre; nunca reintentar automáticamente.
   El laboratorio no tiene Intents de llamada, API USSD, credenciales ni backend.
4. Probar regresiones servidor y estados del simulador; compilar/lint Android y
   comprobar en pantalla el compositor y el laboratorio si el entorno lo permite.

La integración de códigos reales y cualquier transferencia siguen fuera de esta
entrega. No se pide ni se almacena PIN real en el laboratorio. Aceptar el resultado
simulado no cambia el estado de ninguna operación ni genera comprobantes.
