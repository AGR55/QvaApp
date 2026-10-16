import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync(
  new URL("../web/hooks/use-dashboard.js", import.meta.url),
  "utf8",
);
const huntingSource = readFileSync(
  new URL("../web/features/hunting.jsx", import.meta.url),
  "utf8",
);
const serverSource = readFileSync(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

test("el navegador solo lee el snapshot preparado por la VPS", () => {
  assert.doesNotMatch(hookSource, /\/api\/live\//);
  assert.doesNotMatch(hookSource, /dashboardResources/);
  assert.match(hookSource, /window\.setInterval\([^]*20_000\)/);
  assert.doesNotMatch(hookSource, /\[view, market, enabled\]/);
});

test("la VPS refresca el snapshot al arrancar y periódicamente", () => {
  assert.match(
    serverSource,
    /scheduler\.register\("dashboard_cache",\s*30_000,[^]*refreshCache\(\{ refreshMarkets: false \}\)/,
  );
  assert.match(serverSource, /scheduler\.run\("dashboard_cache"\)/);
});

test("una acción de Cacería no deshabilita todos los controles", () => {
  assert.doesNotMatch(huntingSource, /disabled=\{Boolean\(busy\)\}/);
  assert.match(huntingSource, /disabled=\{isBusy\("master:buy"\)\}/);
  assert.match(huntingSource, /isBusy\(`market:\$\{market\.code\}:buy`\)/);
  assert.match(huntingSource, /new Set\(current\)/);
});
