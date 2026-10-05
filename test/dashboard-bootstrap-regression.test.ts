import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../web/main.jsx", import.meta.url), "utf8");
const commonSource = readFileSync(new URL("../web/components/common.jsx", import.meta.url), "utf8");
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

test("las vistas secundarias se cargan únicamente al navegar", () => {
  assert.doesNotMatch(mainSource, /import \{ Settings \} from/);
  assert.doesNotMatch(mainSource, /import \{ Capital \} from/);
  assert.match(mainSource, /lazy\(\(\) =>\s*import\("\.\/features\/settings\.jsx"\)/);
  assert.match(mainSource, /import\("\.\/features\/capital-workspace\.jsx"\)/);
  assert.match(mainSource, /<Suspense fallback=\{<ViewLoading\s*\/>\}>/);
  const loadingView = commonSource.match(/export function ViewLoading\([^]*?\n\}/)?.[0];
  assert.ok(loadingView);
  assert.match(loadingView, /role="status"/);
  assert.match(loadingView, /aria-label=\{label\}/);
  assert.match(loadingView, /<ShadcnSkeleton/);
});
