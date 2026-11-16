# Sincronizador cooperativo, gráfica y medias — 2026-11-15

## Sincronizador

El edge Go entra en la red externa `caceria-net` y usa el mismo contrato que
ya hablaba TS:

```text
SYNC_ENABLED=true
SYNC_BASE_URL=http://caceria-sync-server:8080
SYNC_NATS_URL=nats://caceria-sync-server:4222
SYNC_EMAIL=qvaapply-sync@honux.tech
SYNC_PASSWORD=<secreto>
```

`CooperativeSync` hace login, guarda la API key y refresca cada 10 s:

- `GET /hunts/sync` → snapshot de liquidez por mercado.
- `GET /hunts?me=true&active=true&page_size=100` → aportaciones propias.
- `POST /hunts {coin,fiat,minimal,price}` → publicar.
- `DELETE /hunts/{coin}` → retirar.

NATS queda como estado informativo (`natsConnected=false`). Publicar, retirar y
reconciliar funcionan por HTTP.

## Web

`view=red` muestra:

- estado real de conexión, última respuesta y error;
- una tarjeta por mercado con precio de compra (`buyMaxRate`), fiat disponible
  (`fiatBalance`) y mínimo de 5 QUSD;
- un solo campo: cantidad mínima;
- publicar/retirar contra el sincronizador real.

El precio y el fiat los calcula el edge; la web no los envía ni los puede
manipular.

Prueba real: `CLASICA` publicado con `fiat=29.35`, `price=1.071`,
`minimal=5`; el sincronizador devolvió la aportación y el snapshot pasó de
1 a 2 capacidades. La retirada devolvió 204 y la aportación desapareció.

## Telegram

La botonera principal incluye `🤝 Conjuntas` (`nav:coop`). El panel lista los
mercados activos con precio de compra, fiat y estado, y ofrece:

```text
coop:publish:COIN   pide solo la cantidad mínima
coop:withdraw:COIN  retira la aportación
coop:refresh        vuelve a leer el sincronizador
```

Tras pulsar Publicar, el siguiente mensaje de texto se interpreta como mínimo
QUSD (caduca a los 5 minutos). No se pregunta precio ni fiat.

También está el comando `/coop MERCADO MINIMO`.

Pruebas: `TestTelegramCooperativePublishFlow` y
`TestTelegramCooperativeRejectsInvalidMinimum` verifican panel, publicación con
solo `coin+minimal`, retirada y rechazo de mínimos inválidos.

## Gráfica de precios

El TS solo guardó `median_sell`; por eso la compra no aparecía. El edge ahora
registra cada ~40 s una observación por mercado en
`shadow.market_observations` con compra y venta (`average_*` y `median_*`).
El snapshot del dashboard se mantiene caliente cada 20 s, de modo que el
histórico se llena aunque nadie abra el panel.

`/api/market-analytics` mezcla el histórico viejo del snapshot con las
observaciones nuevas. El tooltip lee la fila completa y muestra siempre Compra
y Venta, no solo la serie bajo el cursor. La prueba visual
`/tmp/qvaapply-charts-tooltip-desktop.png` muestra ambos precios.

## Medias en Telegram

Los paneles de cacerías y de mercado muestran `media` con
`averageBuy`/`averageSell` en lugar de `mediana`.
