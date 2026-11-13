import { createHash } from "node:crypto";

/**
 * Canonical JSON v1 for the QvaApply parity harness.
 *
 * Rules (see docs/migration/analysis/04-tests.md §4.3):
 *  - objects: keys sorted by Unicode code point
 *  - arrays: order preserved (semantic order is declared per case)
 *  - numbers, strings, booleans, null: identity
 *  - monetary values must already be fixed-scale decimal *strings*; the
 *    adapter/ops layer is responsible for formatting them
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface Difference {
  path: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Structural diff with type-strict equality. A number never equals its string
 * form: that is exactly the class of bug the harness exists to catch.
 */
export function diffValues(
  expected: unknown,
  actual: unknown,
  path = "$",
  out: Difference[] = [],
): Difference[] {
  if (expected === actual) return out;

  const expectedIsArray = Array.isArray(expected);
  const actualIsArray = Array.isArray(actual);
  if (expectedIsArray || actualIsArray) {
    if (!expectedIsArray || !actualIsArray) {
      out.push({ path, expected, actual });
      return out;
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= expected.length || index >= actual.length) {
        out.push({ path: `${path}[${index}]`, expected: expected[index], actual: actual[index] });
        continue;
      }
      diffValues(expected[index], actual[index], `${path}[${index}]`, out);
    }
    return out;
  }

  const expectedIsObject = expected !== null && typeof expected === "object";
  const actualIsObject = actual !== null && typeof actual === "object";
  if (expectedIsObject || actualIsObject) {
    if (!expectedIsObject || !actualIsObject) {
      out.push({ path, expected, actual });
      return out;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
    for (const key of keys) {
      const hasExpected = Object.hasOwn(expectedRecord, key);
      const hasActual = Object.hasOwn(actualRecord, key);
      if (!hasExpected || !hasActual) {
        out.push({
          path: `${path}.${key}`,
          expected: hasExpected ? expectedRecord[key] : "<absent>",
          actual: hasActual ? actualRecord[key] : "<absent>",
        });
        continue;
      }
      diffValues(expectedRecord[key], actualRecord[key], `${path}.${key}`, out);
    }
    return out;
  }

  // Primitive mismatch (including 1 vs "1" and NaN vs anything).
  out.push({ path, expected, actual });
  return out;
}

/** True when the two values are structurally identical under canonical rules. */
export function equalCanonical(expected: unknown, actual: unknown): boolean {
  return diffValues(expected, actual).length === 0;
}
