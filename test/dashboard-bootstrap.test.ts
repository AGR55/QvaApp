import assert from "node:assert/strict";
import test from "node:test";
import { readDashboardBootstrap } from "../web/lib/dashboard-bootstrap.js";

test("consume una sola vez el bootstrap entregado por la VPS", () => {
  let removed = false;
  const node = {
    content: {
      textContent:
        '{"session":{"authenticated":true,"csrfToken":"token"},"dashboard":{"generatedAt":123}}',
    },
    remove: () => {
      removed = true;
    },
  };
  const documentLike = {
    getElementById: (id: string) => (id === "qvaapply-bootstrap" ? node : null),
  };

  assert.deepEqual(readDashboardBootstrap(documentLike as never), {
    session: { authenticated: true, csrfToken: "token" },
    dashboard: { generatedAt: 123 },
  });
  assert.equal(removed, true);
});

test("descarta un bootstrap ausente o estructuralmente inválido", () => {
  assert.equal(
    readDashboardBootstrap({ getElementById: () => null } as never),
    undefined,
  );
  assert.equal(
    readDashboardBootstrap({
      getElementById: () => ({
        content: { textContent: '{"dashboard":{}}' },
        remove: () => undefined,
      }),
    } as never),
    undefined,
  );
});
