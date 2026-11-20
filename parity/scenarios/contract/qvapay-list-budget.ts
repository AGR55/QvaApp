/**
 * Escenarios de contrato: `test/qvapay-list-budget.test.ts`.
 *
 * Presupuesto de listado inyectado; identidad y reloj canónicos.
 */
import assert from "node:assert/strict";
import { QvaApiError, QvaPayClient } from "../../../src/qvapay.js";
import type { ListTiming } from "../../../src/types.js";
import { ListingReadBudget } from "../../../src/market-list-budget.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "qvapay-list-budget/01-owner-token-binding",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:7",
    async run(ctx) {
      let token = "fixture-session-a";
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const settings = new Map<string, string>([["analytics_account_uuid", "stale-owner"]]);
      const client = new QvaPayClient(() => token, {
        throttleState: {
          get: (key) => settings.get(key),
          set: (key, value) => {
            settings.set(key, value);
          },
        },
        sleep: async () => {},
        fetch: async (_url, init) => {
          const original = new Headers(init?.headers).get("authorization") === "Bearer fixture-session-a";
          if (original) {
            entered();
            await blocked;
          }
          return new Response(JSON.stringify({ uuid: original ? "owner-a" : "owner-b" }));
        },
      });
      const oldProfile = ctx.observe("profile:old", client.profile());
      await started;
      token = "fixture-session-b";
      release();
      await oldProfile;
      assert.equal(settings.get("analytics_account_uuid"), "owner-a");
      assert.equal(client.verifiedListingOwner(token), undefined);
      assert.equal(client.verifiedListingOwner("fixture-session-a"), "owner-a");
      await ctx.observe("profile:new", client.profile());
      assert.equal(client.verifiedListingOwner(token), "owner-b");
      ctx.effect("throttleState", [...settings.entries()]);
      ctx.value("owners", {
        old: client.verifiedListingOwner("fixture-session-a") ?? null,
        new: client.verifiedListingOwner(token) ?? null,
      });
    },
  },
  {
    id: "qvapay-list-budget/02-shared-interval-rate-limit",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:33",
    async run(ctx) {
      let clock = 10000;
      const values = new Map<string, string>();
      const budget = new ListingReadBudget(
        {
          get: (key) => values.get(key),
          set: (key, value) => {
            values.set(key, value);
          },
        },
        {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      );
      const dispatches: number[] = [];
      const client = (owner: string | undefined, limited = false) =>
        new QvaPayClient(() => "fixture-token", {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          listBudget: {
            waitForDispatch: () => budget.waitForDispatch(() => owner),
            noteRateLimit: (identity, ms) => budget.noteRateLimit(identity, ms),
          },
          fetch: async () => {
            dispatches.push(clock);
            return new Response('{"data":[]}', limited ? { status: 429, headers: { "retry-after": "10" } } : {});
          },
        });
      await ctx.observe(
        "list:same-owner",
        client("same-owner").listOffersPage({}).then((page) => ({ total: page.total })),
      );
      await ctx.observe(
        "list:same-owner-upper",
        client("SAME-OWNER").listOffersPage({}).then((page) => ({ total: page.total })),
      );
      assert.deepEqual(dispatches, [10000, 12401]);
      const limited = await ctx.observe("list:unknown-429", client(undefined, true).listOffersPage({}));
      assert.equal(limited.ok, false);
      if (!limited.ok) assert.ok(QvaApiError);
      const limitedAt = clock;
      await ctx.observe(
        "list:independent-owner",
        client("independent-owner").listOffersPage({}).then((page) => ({ total: page.total })),
      );
      assert.equal(clock, limitedAt + 10000);
      ctx.effect("dispatches", dispatches);
      ctx.value("limitedAt", limitedAt);
    },
  },
  {
    id: "qvapay-list-budget/03-captured-token",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:51",
    async run(ctx) {
      let token = "fixture-original";
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let reservedToken: string | undefined;
      let authorization: string | null = null;
      const client = new QvaPayClient(() => token, {
        listBudget: {
          waitForDispatch: async (captured) => {
            reservedToken = captured;
            entered();
            await blocked;
            return "owner-original";
          },
          noteRateLimit: () => {},
        },
        fetch: async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return new Response('{"data":[]}');
        },
      });
      const request = ctx.observe("list", client.listOffersPage({}).then((page) => ({ total: page.total })));
      await started;
      token = "fixture-replacement";
      release();
      await request;
      assert.equal(reservedToken, "fixture-original");
      assert.equal(authorization, "Bearer fixture-original");
      ctx.value("reservedToken", reservedToken);
      ctx.value("authorization", authorization);
    },
  },
  {
    id: "qvapay-list-budget/04-retry-reserves-again",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:67",
    async run(ctx) {
      const calls: string[] = [];
      let attempt = 0;
      let clock = 0;
      const timings: ListTiming[] = [];
      const client = new QvaPayClient(() => "token", {
        monotonicNow: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        listBudget: {
          waitForDispatch: async () => {
            calls.push(`reserve-${++attempt}`);
            clock += 10;
            return `owner-${attempt}`;
          },
          noteRateLimit: (owner, retry) => {
            calls.push(`429-${owner}-${retry}`);
          },
        },
        fetch: async () => {
          calls.push(`fetch-${attempt}`);
          clock += 5;
          if (attempt === 1) throw new Error("network");
          return new Response("{}", { status: 429, headers: { "retry-after": "4" } });
        },
        onListTiming: (timing) => timings.push(timing),
      });
      const outcome = await ctx.observe("list", client.listOffersPage({}));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal((outcome.error as unknown as { status: number }).status, 429);
      assert.deepEqual(calls, ["reserve-1", "fetch-1", "reserve-2", "fetch-2", "429-owner-2-4000"]);
      assert.equal(timings[0]?.queueMs, 10);
      assert.equal(timings[0]?.responseMs, 820);
      assert.equal(timings[0]?.attempts, 2);
      ctx.effect("calls", calls);
      ctx.effect("timings", timings);
    },
  },
  {
    id: "qvapay-list-budget/05-reservation-failure",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:92",
    async run(ctx) {
      let waits = 0;
      let fetches = 0;
      const timings: ListTiming[] = [];
      const problem = new Error("budget unavailable");
      const client = new QvaPayClient(() => "token", {
        listBudget: {
          waitForDispatch: async () => {
            waits += 1;
            throw problem;
          },
          noteRateLimit: () => assert.fail("no hubo respuesta"),
        },
        fetch: async () => {
          fetches += 1;
          return new Response("{}");
        },
        onListTiming: (timing) => timings.push(timing),
      });
      const outcome = await ctx.observe("list", client.listOffersPage({}));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /budget unavailable/);
      assert.equal(waits, 1);
      assert.equal(fetches, 0);
      assert.equal(timings[0]?.attempts, 0);
      assert.equal(timings[0]?.queueMs, null);
      assert.equal(timings[0]?.responseMs, null);
      ctx.value("waits", waits);
      ctx.value("fetches", fetches);
      ctx.effect(
        "timings",
        timings.map((timing) => ({
          attempts: timing.attempts,
          queueMs: timing.queueMs,
          responseMs: timing.responseMs,
          outcome: timing.outcome,
        })),
      );
    },
  },
  {
    id: "qvapay-list-budget/06-rate-limit-note-failure",
    file: "test/qvapay-list-budget.test.ts",
    source: "test/qvapay-list-budget.test.ts:104",
    async run(ctx) {
      let waits = 0;
      let posts = 0;
      let notes = 0;
      const failure = new Error("store unavailable");
      const client = new QvaPayClient(() => "token", {
        sleep: async () => {},
        now: () => 100000,
        listBudget: {
          waitForDispatch: async () => {
            waits += 1;
            return undefined;
          },
          noteRateLimit: (owner, retry) => {
            assert.equal(owner, undefined);
            assert.equal(retry, undefined);
            notes += 1;
            throw failure;
          },
        },
        fetch: async (input) => {
          if (String(input).endsWith("/apply")) {
            posts += 1;
            return new Response("{}");
          }
          if (String(input).includes("/p2p/other"))
            return new Response(
              JSON.stringify({
                p2p: { uuid: "other", type: "sell", coin: "BANK_CUP", amount: 1, receive: 1, status: "open" },
              }),
            );
          return new Response("{}", { status: 429 });
        },
      });
      const outcome = await ctx.observe("list", client.listOffersPage({}));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /store unavailable/);
      assert.equal(waits, 1);
      assert.equal(notes, 1);
      await ctx.observe("getOffer", client.getOffer("other"));
      await ctx.observe("apply", client.apply("other", { beforeDispatch: () => true }));
      assert.equal(waits, 1);
      assert.equal(posts, 1);
      ctx.value("counters", { waits, notes, posts });
    },
  },
];

export { scenarios };
