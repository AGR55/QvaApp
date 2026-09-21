import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(
  new URL("../web/features/settings.jsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../web/ui-polish.css", import.meta.url),
  "utf8",
);

test("las tarjetas de mercados contienen sus campos sin invadir la columna vecina", () => {
  assert.match(
    settingsSource,
    /className="sr-only"\s+type="file"\s+aria-label=/,
  );
  assert.doesNotMatch(settingsSource, /className="visually-hidden"/);
  assert.match(
    styles,
    /\.market-settings-grid\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*500px\),\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /\.market-settings-content\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    settingsSource,
    /<section\s+key=\{market\.code\}\s+className="market-settings"\s+aria-labelledby=/,
  );
  assert.match(
    styles,
    /\.market-icon-editor\s*>\s*div\s*{[^}]*flex-wrap:\s*wrap/s,
  );
});
