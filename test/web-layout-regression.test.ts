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
const logsSource = readFileSync(
  new URL("../web/features/logs.jsx", import.meta.url),
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

test("la consola de logs sigue por cursor y conserva controles accesibles", () => {
  assert.match(logsSource, /params\.set\("after", String\(cursorRef\.current\)\)/);
  assert.match(logsSource, /window\.setInterval\(\(\) => void loadNew\(\), 2_000\)/);
  assert.match(logsSource, /aria-label="Eventos operativos"/);
  assert.match(logsSource, /aria-pressed=\{autoScroll\}/);
  assert.match(styles, /\.log-row\s*\{[^}]*content-visibility:\s*auto/s);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.log-filters\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("la fuente de mercado permite alternar polling y webhook sin exponer el secreto", () => {
  assert.match(settingsSource, /changeMode\("polling"\)/);
  assert.match(settingsSource, /changeMode\("webhook"\)/);
  assert.match(settingsSource, /\/api\/market-source\/webhook-secret/);
  assert.match(settingsSource, /id="market-feed-secret"[^>]*type="password"/);
  assert.match(settingsSource, /source\?\.webhookUrl/);
  assert.match(styles, /\.market-source-mode-buttons/);
  assert.match(styles, /\.market-webhook-setup/);
});
