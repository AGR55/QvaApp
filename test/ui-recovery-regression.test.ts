import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const audit = readFileSync(new URL("../web/features/audit.jsx", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../web/features/recovery-panel.jsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../web/ui-polish.css", import.meta.url), "utf8");

test("la conciliación y resolución manual usan solo el contrato de recuperación y gates manualEligible", () => {
  assert.match(recovery, /requestJson\("\/api\/recovery"\)/);
  assert.match(recovery, /\/api\/recovery\/\$\{encodeURIComponent\(item\.intentId\)\}\/check/);
  assert.match(recovery, /\/api\/recovery\/\$\{encodeURIComponent\(selected\.intentId\)\}\/resolve/);
  assert.match(recovery, /expectedUpdatedAt:\s*selected\.updatedAt/);
  assert.match(recovery, /confirmed:\s*true/);
  assert.match(recovery, /item\.manualEligible\s*===\s*true\s*\?/);
  assert.match(recovery, /no es una confirmación de QvaPay/);
  assert.match(recovery, /sin volver a enviar una mutación/);
  assert.match(recovery, /payload\.data\?\.message/);
  assert.match(recovery, /await onChanged\?\.\(\)/);
});

test("descartar todas usa el cursor global, confirma cantidad y recarga primera página sin optimismo", () => {
  const action = audit.match(/const dismissAll = async \(\) => \{([^]*?)\n  \};/)?.[1];
  assert.ok(action);
  assert.match(audit, /dismissThroughId/);
  assert.match(action, /JSON\.stringify\(\{ throughId \}\)/);
  assert.match(action, /dismissAllSnapshot\?\.throughId/);
  assert.match(action, /loadEvents\(1\)/);
  assert.match(action, /setPage\(1\)/);
  assert.doesNotMatch(action, /setEvents\(/);
  assert.match(audit, /setDismissAllSnapshot\(\{ throughId: latest\.dismissThroughId, pending: latest\.pending \}\)/);
  assert.match(audit, /¿Descartar \{dismissAllSnapshot\?\.pending/);
  assert.match(audit, /decisiones creadas después de ese cursor se conservarán/);
  assert.match(audit, /disabled=\{dismissAllBusy/);
});

test("los paneles de recuperación quedan separados y se adaptan a móvil", () => {
  assert.match(audit, /<RecoveryPanel\s+onChanged=\{onChanged\}\s*\/>/);
  assert.match(recovery, /aria-label|role="status"/);
  assert.match(styles, /\.recovery-panel\s*\{/);
  assert.match(styles, /@media \(max-width: 640px\)[^]*\.recovery-fields/);
});
