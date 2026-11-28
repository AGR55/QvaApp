/**
 * Escenarios de contrato: `test/qvapay-list-isolation.test.ts`.
 */
import assert from "node:assert/strict";
import { QvaApiError, QvaPayClient } from "../../../src/qvapay.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "qvapay-list-isolation/01-budget-does-not-block-reads",
    file: "test/qvapay-list-isolation.test.ts",
    source: "test/qvapay-list-isolation.test.ts:6",
    async run(ctx) {
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paths: string[] = [];
      const client = new QvaPayClient(() => "token", {
        sleep: async () => undefined,
        listBudget: {
          waitForDispatch: async () => {
            entered();
            await blocked;
            return undefined;
          },
          noteRateLimit: () => undefined,
        },
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          return new Response(JSON.stringify(path === "/user" ? { uuid: "owner" } : { data: [] }));
        },
      });
      const list = client.listOffersPage({});
      const listed = ctx.observe("list", list.then((page) => ({ total: page.total })));
      try {
        await started;
        const profile = await ctx.observe("profile", client.profile());
        assert.equal(profile.ok, true);
        if (profile.ok) assert.equal((profile.value as { uuid: string }).uuid, "owner");
        const edit = await ctx.observe(
          "edit:conditions",
          client.editOffer("own", { amount: 1, receive: 100 }, { beforeDispatch: () => false }),
        );
        assert.equal(edit.ok, false);
        if (!edit.ok) {
          assert.equal((edit.error as unknown as { code: string }).code, "LOCAL_CONDITIONS_CHANGED");
          assert.ok(QvaApiError);
        }
        assert.deepEqual(paths, ["/user"]);
      } finally {
        release();
        await listed;
      }
      assert.ok(paths.includes("/p2p"));
      ctx.effect("paths", paths);
    },
  },
  {
    id: "qvapay-list-isolation/02-interval-starts-after-budget",
    file: "test/qvapay-list-isolation.test.ts",
    source: "test/qvapay-list-isolation.test.ts:30",
    async run(ctx) {
      let now = 10_000;
      const sleeps: number[] = [];
      const client = new QvaPayClient(() => "token", {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        listBudget: {
          waitForDispatch: async () => {
            now += 10_000;
            return undefined;
          },
          noteRateLimit: () => undefined,
        },
        fetch: async (input) =>
          new Response(
            JSON.stringify(new URL(String(input)).pathname === "/user" ? { uuid: "owner" } : { data: [] }),
          ),
      });
      await ctx.observe("list", client.listOffersPage({}).then((page) => ({ total: page.total })));
      await ctx.observe("profile", client.profile().then((profile) => ({ uuid: profile.uuid })));
      assert.deepEqual(sleeps, [1_667]);
      ctx.effect("sleeps", sleeps);
    },
  },
];

export { scenarios };
