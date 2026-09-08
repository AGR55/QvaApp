import assert from "node:assert/strict";
import test from "node:test";
import { chartDomain } from "../web/lib/chart-domain.js";

test("el dominio amplifica diferencias pequeñas en precios altos", () => {
  const [minimum, maximum] = chartDomain([64_200, 64_210, 64_205]);
  assert.equal(minimum, 64_199.2);
  assert.equal(maximum, 64_210.8);
});

test("el dominio conserva aire visible para una serie plana", () => {
  const [minimum, maximum] = chartDomain([1.04, 1.04]);
  assert.ok(minimum < 1.04);
  assert.ok(maximum > 1.04);
});
