import argparse
import base64
import binascii
from pathlib import Path
import struct
import xml.etree.ElementTree as ElementTree


LOGOS = {
    "cup": "cup.png",
    "tropical": "tropical.png",
    "clasica": "clasica.png",
    "qusd": "qusd.png",
    "etecsa": "etecsa.svg",
    "zelle": "zelle.svg",
}


def read_logo(source):
    content = source.read_bytes()
    if source.suffix == ".svg":
        if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
            raise ValueError(f"{source.name}: SVG entities are not supported")
        root = ElementTree.fromstring(content)
        images = root.findall(".//{http://www.w3.org/2000/svg}image")
        if len(images) != 1:
            raise ValueError(f"{source.name}: expected one embedded raster image")
        href = images[0].get("href") or images[0].get("{http://www.w3.org/1999/xlink}href", "")
        prefix = "data:image/png;base64,"
        if not href.startswith(prefix):
            raise ValueError(f"{source.name}: only embedded PNG data is supported; no network access")
        try:
            content = base64.b64decode("".join(href[len(prefix):].split()), validate=True)
        except binascii.Error as error:
            raise ValueError(f"{source.name}: invalid embedded PNG encoding") from error
    if len(content) < 33 or content[:8] != b"\x89PNG\r\n\x1a\n" or content[12:16] != b"IHDR":
        raise ValueError(f"{source.name}: expected PNG raster data")
    width, height = struct.unpack(">II", content[16:24])
    if not width or not height or width > 4096 or height > 4096:
        raise ValueError(f"{source.name}: invalid logo dimensions")
    return content


def generate(source, output):
    logos = {name: read_logo(source / filename) for name, filename in LOGOS.items()}
    directory = output / "drawable-nodpi"
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in logos.items():
        destination = directory / f"market_{name}.png"
        if not destination.exists() or destination.read_bytes() != content:
            destination.write_bytes(content)


def main():
    repository = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Package original local market rasters as Android resources, without network access.")
    parser.add_argument("--source", type=Path, default=repository / "public" / "icons")
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        generate(arguments.source, arguments.output)
    except (OSError, ValueError, ElementTree.ParseError) as error:
        parser.exit(1, f"Market logo generation failed: {error}\n")


if __name__ == "__main__":
    main()
