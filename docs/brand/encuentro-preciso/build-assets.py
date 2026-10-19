"""Development-only exporter. Requires rsvg-convert, Adwaita Sans and ImageMagick."""
from pathlib import Path
import re, subprocess, xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'public/logo'
DOC=Path(__file__).resolve().parent
P='M108 32H220V48L202 66H112C84 66 68 84 68 112V144H32V108C32 62 62 32 108 32Z'
R='M108 32.5H219.5V47.8L201.8 65.5H112C83.5 65.5 67.5 83.5 67.5 112V143.5H32.5V108C32.5 62.5 62.5 32.5 108 32.5Z'
def body(inverse=False):
    p=R if inverse else P
    d='m128 102.5 25.5 25.5-25.5 25.5-25.5-25.5Z' if inverse else 'm128 102 26 26-26 26-26-26Z'
    return f'<path d="{p}"/><path d="{p}" transform="rotate(180 128 128)"/><path d="{d}"/>'
def svg(vb,w,h,inner,title='QvaApply · Encuentro Preciso'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img"><title>{title}</title>{inner}</svg>\n'
for suffix,color,inverse in [('', '#1D4E86',False),('-inverse','#F6F2EA',True),('-black','#000000',False)]:
    (OUT/f'encuentro-preciso-symbol{suffix}.svg').write_text(svg('0 0 256 256',256,256,f'<g fill="{color}">{body(inverse)}</g>'))
    source=DOC/'type-source.svg'
    source.write_text(svg('0 0 1056 256',1056,256,f'<g fill="{color}" transform="translate(12 24) scale(.8)">{body(inverse)}</g><text x="248" y="170" font-family="Adwaita Sans" font-weight="{535 if inverse else 550}" font-size="148" letter-spacing="-5" fill="{color}"><tspan>Q</tspan><tspan dx="1">vaApply</tspan></text>'))
    raw=subprocess.check_output(['rsvg-convert','-f','svg',str(source)]).decode()
    root=ET.fromstring(raw)
    paths=[]
    for element in root:
        if element.tag.endswith('path'):
            d=re.sub(r'-?\d+\.\d+',lambda m:f'{float(m.group()):.2f}'.rstrip('0').rstrip('.'),element.attrib['d'])
            paths.append(f'<path d="{d}"/>')
    (OUT/f'encuentro-preciso-horizontal{suffix}.svg').write_text(svg('24 36 860 180',860,180,f'<g fill="{color}">{"".join(paths)}</g>'))
source.unlink()
# A dedicated compact drawing: the 45° cut is removed only at favicon sizes.
small='M108 32H224V68H112C84 68 68 84 68 112V144H32V108C32 62 62 32 108 32Z'
smallbody=f'<path d="{small}"/><path d="{small}" transform="rotate(180 128 128)"/><path d="m128 102 26 26-26 26-26-26Z"/>'
(OUT/'encuentro-preciso-favicon.svg').write_text(svg('0 0 256 256',256,256,f'<rect width="256" height="256" rx="48" fill="#1D4E86"/><g fill="#F6F2EA">{smallbody}</g>'))
# Opaque app icons remain readable in OS notifications regardless of page theme.
icon=OUT/'encuentro-preciso-app.svg'
icon.write_text(svg('0 0 256 256',256,256,f'<rect width="256" height="256" fill="#1D4E86"/><g fill="#F6F2EA" transform="translate(12.8 12.8) scale(.9)">{body(True)}</g>'))
for size in [180,192,512]:
    subprocess.run(['rsvg-convert','-w',str(size),'-h',str(size),'-o',str(OUT/f'encuentro-preciso-icon-{size}.png'),str(icon)],check=True)
badge=OUT/'encuentro-preciso-badge.svg'
badge.write_text(svg('0 0 256 256',256,256,f'<g fill="#FFFFFF">{smallbody}</g>'))
subprocess.run(['rsvg-convert','-w','96','-h','96','-o',str(OUT/'encuentro-preciso-badge.png'),str(badge)],check=True)
# Refresh legacy URLs so older tabs/push payloads also receive the new identity.
for src,dest,width in [('encuentro-preciso-horizontal-inverse.svg','logotipo.webp',860),('encuentro-preciso-app.svg','isotipo.webp',256)]:
    tmp=DOC/'export.png'
    subprocess.run(['rsvg-convert','-w',str(width),'-o',str(tmp),str(OUT/src)],check=True)
    subprocess.run(['magick',str(tmp),'-define','webp:lossless=true',str(OUT/dest)],check=True)
    tmp.unlink()
# Secondary compositions reuse the outlined letters, never a substitute font.
for suffix, color in [('', '#1D4E86'), ('-inverse', '#F6F2EA')]:
    root = ET.parse(OUT/f'encuentro-preciso-horizontal{suffix}.svg').getroot()
    paths = list(list(root)[1])
    lettering = ''.join(f'<path d="{p.attrib["d"]}"/>' for p in paths[3:])
    symbol_root = ET.parse(OUT/f'encuentro-preciso-symbol{suffix}.svg').getroot()
    mark = ''.join(ET.tostring(x, encoding='unicode') for x in list(symbol_root)[1:])
    (OUT/f'encuentro-preciso-wordmark{suffix}.svg').write_text(svg('236 96 648 112',648,112,f'<g fill="{color}">{lettering}</g>'))
    (OUT/f'encuentro-preciso-stacked{suffix}.svg').write_text(svg('0 0 1024 464',1024,464,f'<g transform="translate(384 32)">{mark}</g><g fill="{color}" transform="translate(-47 210)">{lettering}</g>'))
