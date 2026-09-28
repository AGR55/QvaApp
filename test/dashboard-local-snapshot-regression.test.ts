import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/dashboard.ts", import.meta.url),
  "utf8",
);
const localSnapshot = source.match(
  /\n  localSnapshot\(\) \{([^]*?)\n  \}\n\n  async refreshBalance/,
)?.[1];

test("la instantánea local reutiliza cada lectura costosa", () => {
  assert.ok(localSnapshot);
  assert.equal(matches(localSnapshot, /\.marketHistory\(/g), 1);
  assert.equal(matches(localSnapshot, /\.activeOperations\(/g), 1);
  assert.equal(matches(localSnapshot, /\.tradeWorkflows\(/g), 1);
  assert.equal(
    matches(localSnapshot, /loadRemoteResource<MarketView>/g),
    1,
  );
});

function matches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}
