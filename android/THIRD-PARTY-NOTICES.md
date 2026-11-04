# Iconos

Los recursos `ph_*` se han redibujado como geometrías outline locales de 24 × 24,
con trazo uniforme de 1.75, extremos y uniones redondeados, sin capas duotono.
El prefijo se conserva por compatibilidad; volver, compra, venta, operaciones y
enviar usan chevrons abiertos sin astil ni triángulo. El icono de notificación
`ic_chat_notification` también es outline, con trazo blanco para su máscara alfa.
La marca `preciso_mark` es el logo original, no un pictograma de interfaz.
El adjunto de imágenes usa `ph_image`, una geometría local del mismo grosor.
No se carga una fuente, catálogo de iconos ni recursos de red en ejecución.

La versión anterior incorporaba Phosphor Icons Duotone el 24 de octubre de 2026.
Se conserva su licencia MIT en `PHOSPHOR-LICENSE.txt` y su atribución histórica:
https://github.com/phosphor-icons/core/tree/main/assets/duotone

## Logos de mercados

Los logos originales proceden de `public/icons`: CUP, Tropical, Clásica y QUSD
se copian sin cambios; los PNG embebidos en `etecsa.svg` y `zelle.svg` se extraen
sin red, sin recolorear, sin redibujar y sin recomprimir. Se conserva el raster
completo original, no el recorte del viewport del contenedor SVG.
Las marcas conservan los derechos de sus respectivos titulares; su presencia
no implica afiliación ni una licencia MIT sobre esos logos.

`scripts/generate_market_logos.py` usa únicamente Python 3 y su biblioteca estándar.
Gradle ejecuta `generateMarketLogos` antes de `preBuild` y registra su salida
`app/build/generated/marketLogos/res/drawable-nodpi` como recursos nativos.
La generación falla con un mensaje si falta un original o no es un PNG embebido
válido, en lugar de descargar sustitutos. Los seis originales deben formar parte
del checkout de compilación, incluidos ETECSA y Zelle.

`MarketLogo(market: String, modifier: Modifier = Modifier)` selecciona recursos
por código de mercado, conserva sus colores y proporciones y usa un banco outline
local para códigos desconocidos. Es decorativo: el llamador debe mostrar el nombre
del mercado. El tamaño por defecto es 32 dp y puede ajustarse con el modificador.

Pruebas: `python3 -B -m unittest discover -s android/scripts -p 'test_*.py'`.
