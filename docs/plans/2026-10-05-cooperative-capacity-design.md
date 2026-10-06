# Capacidad cooperativa ligada al fiat disponible

QvaApply crea una aportación solo mediante una acción explícita del propietario. En el alta pide mercado, precio y mínimo; la cantidad fiat se toma del saldo local del mercado. El servidor ignora cualquier cantidad enviada por el navegador. Al confirmar el alta guarda el saldo local que sirvió de base.

Una tarea breve compara el saldo local con esa base para los mercados que siguen activos. Antes de mutar consulta las aportaciones actuales de Sync Core. Para movimientos automáticos publica el menor entre el saldo local actual y la capacidad remota actual más el cambio local desde la última base. Así, una cacería ejecutada por el otro bot no recupera fiat mientras QvaApply aún desconoce el gasto. La primera adopción de aportaciones antiguas puede reducir la cifra remota, pero no aumentarla. Los abonos locales incrementan la capacidad solo en la cuantía nueva. Cuando el propietario declara explícitamente el saldo fiat en Telegram o en la web, esa cifra pasa a ser la referencia autoritativa y sustituye a la capacidad remota, evitando descontar dos veces una cacería que el propietario acaba de registrar.

Si la capacidad disponible dividida por el precio del mercado queda por debajo de 5 QUSD, QvaApply retira ese mercado. Los demás aportes siguen activos. Una retirada manual no activa de nuevo el mercado: volver a participar requiere una nueva publicación manual.

La API actual de Sync Core devuelve un booleano en DELETE, incluso tras una retirada correcta. El cliente acepta esa respuesta y confirma la operación sin supeditar el éxito a una lectura HTTP posterior. Los registros activos pueden tener fiat igual a cero tras una ejecución; ese caso se acepta y se retira según el umbral.
