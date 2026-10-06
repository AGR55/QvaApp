# Reparación de gráficas y capital total

## Diagnóstico

En producción había 664 transacciones archivadas y ninguna contenía la relación `P2P`. El cálculo anterior exigía esa relación para todas las gráficas de mercado, por lo que mostraba cero aunque existieran operaciones. La curva de saldo procedía de `dashboard_snapshots.qusd_balance`, que solo guardaba el QUSD disponible y bajaba al publicar ofertas de venta.

## Fuente de actividad

QvaPay documenta `GET /p2p?my=true&status=completed` para obtener las ofertas finalizadas donde la cuenta participa como creadora o contraparte. Un proceso de fondo importa páginas de hasta 100, conserva el cursor en SQLite y normaliza solo el identificador, mercado, importe, fiat, lado y fecha de finalización. La dirección se determina con el tipo de oferta y el rol de la cuenta. Las ofertas en revisión se excluyen. El histórico de transacciones sigue alimentando la gráfica de entradas y salidas, y se deduplica por UUID de oferta si una transacción P2P aparece después.

El volumen y los flujos fiat por mercado se calculan directamente sobre operaciones completadas. Compras y ventas pueden tener importes diferentes. Las anteriores gráficas de beneficio FIFO se sustituyen en la interfaz por evolución del capital: la falta de costes de adquisición completos, los movimientos entre mercados y las comisiones impiden presentar FIFO como ganancia fiable.

## Capital y valoración

Una foto nueva cada cinco minutos, cuando las tres lecturas tienen menos de cinco minutos, registra QUSD libre, QUSD comprometido en ofertas abiertas/en proceso/pagadas y fiat por mercado convertido a QUSD. La conversión usa la última mediana de venta observada; si falta, usa el promedio de venta reciente. La cotización debe tener menos de una hora. Si falta una cotización de un mercado con fiat positivo, se conserva la última foto válida y se muestra el motivo; nunca se sustituye un mercado por cero.

La gráfica diaria usa la última foto de cada día en la zona horaria de La Habana y se actualiza durante el día. También se muestra la evolución intradía y el cambio entre días consecutivos. Este cambio es una variación patrimonial aproximada: incorpora depósitos, retiradas y cambios de cotización, por lo que no equivale a beneficio neto. El histórico total comienza al desplegar este cambio; los saldos libres antiguos no se reinterpretan como capital total.

## Verificación

Pruebas de ofertas sin relación P2P en las transacciones, compras y ventas desiguales, exclusión de revisión, datos de pago irrelevantes mal formados, persistencia y cálculo de una foto con libre, comprometido y fiat. `pnpm check` y revisión visual antes de integrar y desplegar.
