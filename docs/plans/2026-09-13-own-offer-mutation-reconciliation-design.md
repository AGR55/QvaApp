# Diseño: conciliación de mutaciones de ofertas propias

## Problema

Toda intención remota `submitted` o `uncertain` activa el cortafuegos global,
pero el conciliador periódico solo revisa aplicaciones a ofertas externas. Una
edición, creación o cancelación de oferta propia que pierda su respuesta puede
quedar bloqueando el motor aunque QvaPay ya refleje el resultado y no exista
ninguna operación con dinero en movimiento.

## Solución

El conciliador de mutaciones independientes revisará también las ofertas
propias abiertas. Una edición se resolverá cuando importe y total fiat coincidan
con el estado remoto; una creación, cuando exista una oferta compatible creada
en la ventana de la intención; y una cancelación, cuando la oferta ya no figure
entre las abiertas. Si no hay evidencia suficiente, la intención seguirá
incierta.

Antes de editar se comparará además el estado remoto a precisión observable de
QvaPay y se buscará una intención idéntica confirmada durante el último minuto.
Si ambas evidencias coinciden, la petición se omitirá y se dejará constancia en
auditoría. Esto evita duplicados sin impedir un refresco intencional posterior.

## Errores y seguridad

Los fallos de lectura no resolverán ninguna intención. El cortafuegos continuará
activo ante resultados realmente ambiguos. La reparación del registro actual se
hará solo después de comprobar que la oferta remota almacenada coincide con la
edición solicitada, dejando respaldo y evento de auditoría.

## Pruebas

Se cubrirán la conciliación positiva de una edición redondeada a centavos, la
permanencia del bloqueo cuando el estado no coincide y la omisión de ediciones
duplicadas. Después se ejecutarán tipos, pruebas y compilación.
