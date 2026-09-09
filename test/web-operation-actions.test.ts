import assert from "node:assert/strict";
import test from "node:test";
import { operationActionBody } from "../web/lib/operation-actions.js";

test("solo envía la referencia al registrar un pago", () => {
  assert.deepEqual(operationActionBody("cancel", ""), {});
  assert.deepEqual(operationActionBody("ack", ""), {});
  assert.deepEqual(operationActionBody("received", ""), {});
  assert.deepEqual(operationActionBody("paid", " REF-123 "), { reference: "REF-123" });
});
