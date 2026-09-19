import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../web/main.jsx", import.meta.url), "utf8");
const hookSource = readFileSync(
  new URL("../web/hooks/use-dashboard.js", import.meta.url),
  "utf8",
);

test("React comienza con la sesión y el snapshot incluidos por la VPS", () => {
  assert.match(mainSource, /readDashboardBootstrap\(\)/);
  assert.match(mainSource, /initialBootstrap\?\.session/);
  assert.match(mainSource, /initialBootstrap\?\.dashboard/);
  assert.match(mainSource, /initialConfig=\{initialBootstrap\?\.config\}/);
  assert.match(mainSource, /window\.location\.reload\(\)/);
});

test("los refrescos lentos conservan datos y nunca se solapan", () => {
  assert.match(hookSource, /useState\(\(\) => initialData\)/);
  assert.match(hookSource, /timeoutMs:\s*30_000/);
  assert.match(hookSource, /inFlight\.current/);
  assert.doesNotMatch(hookSource, /setData\(undefined\)/);
});
