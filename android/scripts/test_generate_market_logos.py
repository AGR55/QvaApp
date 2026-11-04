import base64
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree

from generate_market_logos import LOGOS, generate, read_logo


REPOSITORY = Path(__file__).resolve().parents[2]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4J8AAAAASUVORK5CYII=")


class MarketLogoTests(unittest.TestCase):
    def test_original_png_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "logo.png"
            source.write_bytes(PNG)
            self.assertEqual(read_logo(source), PNG)

    def test_embedded_original_raster_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "logo.svg"
            encoded = base64.b64encode(PNG).decode()
            source.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64, {encoded}" /></svg>')
            self.assertEqual(read_logo(source), PNG)

    def test_remote_images_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "logo.svg"
            source.write_text('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/logo.png" /></svg>')
            with self.assertRaisesRegex(ValueError, "no network access"):
                read_logo(source)

    def test_invalid_payload_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "logo.svg"
            source.write_text('<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,!!!" /></svg>')
            with self.assertRaisesRegex(ValueError, "encoding"):
                read_logo(source)

    def test_missing_sources_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "res"
            with self.assertRaises(FileNotFoundError):
                generate(Path(directory), output)
            self.assertFalse(output.exists())

    def test_all_repository_logos_are_generated_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            generate(REPOSITORY / "public/icons", output)
            files = sorted((output / "drawable-nodpi").glob("*.png"))
            self.assertEqual(len(files), len(LOGOS))
            times = {path: path.stat().st_mtime_ns for path in files}
            generate(REPOSITORY / "public/icons", output)
            self.assertEqual(times, {path: path.stat().st_mtime_ns for path in files})
            for name, filename in LOGOS.items():
                self.assertEqual((output / "drawable-nodpi" / f"market_{name}.png").read_bytes(), read_logo(REPOSITORY / "public/icons" / filename))

    def test_all_icons_are_stroked_outlines_and_chevron_is_open(self):
        namespace = "{http://schemas.android.com/apk/res/android}"
        directory = REPOSITORY / "android/app/src/main/res/drawable"
        icons = sorted(path for path in directory.glob("*.xml") if path.name != "preciso_mark.xml")
        self.assertTrue(icons)
        for icon in icons:
            with self.subTest(icon=icon.name):
                root = ElementTree.parse(icon).getroot()
                for path in root.findall("path"):
                    self.assertEqual(path.get(namespace + "fillColor"), "@android:color/transparent")
                    self.assertEqual(path.get(namespace + "strokeWidth"), "1.75")
                    self.assertNotIn(namespace + "fillAlpha", path.attrib)
        chevron = ElementTree.parse(directory / "ph_caret_right.xml").getroot().find("path")
        self.assertEqual(chevron.get(namespace + "pathData"), "M9,5L16,12L9,19")

    def test_directional_icons_are_only_open_chevrons(self):
        namespace = "{http://schemas.android.com/apk/res/android}"
        directory = REPOSITORY / "android/app/src/main/res/drawable"
        expected = {
            "ph_arrow_left": "M15,5L8,12L15,19",
            "ph_arrow_down_left": "M5,9L12,16L19,9",
            "ph_arrow_up_right": "M5,15L12,8L19,15",
            "ph_arrows_left_right": "M14,3L19,8L14,13M10,11L5,16L10,21",
            "ph_paper_plane_right": "M9,5L16,12L9,19",
        }
        for name, data in expected.items():
            with self.subTest(icon=name):
                path = ElementTree.parse(directory / f"{name}.xml").getroot().find("path")
                self.assertEqual(path.get(namespace + "pathData"), data)

    def test_chat_contour_is_closed_before_decorative_dots(self):
        namespace = "{http://schemas.android.com/apk/res/android}"
        source = REPOSITORY / "android/app/src/main/res/drawable/ph_chat_circle_dots.xml"
        path = ElementTree.parse(source).getroot().find("path")
        self.assertIn("21,12ZM8,12", path.get(namespace + "pathData"))


if __name__ == "__main__":
    unittest.main()
