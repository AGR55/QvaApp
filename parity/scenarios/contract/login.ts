/**
 * Escenarios de contrato: `test/login.test.ts`.
 *
 * `fetch` y `sleep` inyectados; sin red, sin esperas reales.
 */
import assert from "node:assert/strict";
import {
  QvaApiError,
  QvaConnectionError,
  QvaPayClient,
} from "../../../src/qvapay.js";
import { authenticateQvaSession } from "../../../src/application/qvapay-login.js";
import type { ContractScenario } from "../../../lib/contract/scenario.js";

const scenarios: ContractScenario[] = [
  {
    id: "login/01-request-pin-when-not-notified",
    file: "test/login.test.ts",
    source: "test/login.test.ts:9",
    async run(ctx) {
      const paths: string[] = [];
      const client = new QvaPayClient(() => undefined, {
        fetch: async (input) => {
          paths.push(String(input));
          if (paths.length === 1) {
            return new Response(
              JSON.stringify({ info: "Código 2FA requerido", notified: false, has_otp: false }),
              { status: 202 },
            );
          }
          return new Response(JSON.stringify({ message: "PIN enviado correctamente" }), { status: 200 });
        },
      });
      const outcome = await ctx.observe("login", client.login("user@example.com", "password"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const result = outcome.value as { requiresTwoFactor: boolean; pinRequested: boolean };
        assert.equal(result.requiresTwoFactor, true);
        assert.equal(result.pinRequested, true);
      }
      assert.deepEqual(paths, [
        "https://api.qvapay.com/auth/login",
        "https://api.qvapay.com/auth/request-pin",
      ]);
      ctx.effect("paths", paths);
    },
  },
  {
    id: "login/02-no-pin-when-otp",
    file: "test/login.test.ts",
    source: "test/login.test.ts:39",
    async run(ctx) {
      const paths: string[] = [];
      const client = new QvaPayClient(() => undefined, {
        fetch: async (input) => {
          paths.push(String(input));
          return new Response(
            JSON.stringify({ info: "Código 2FA requerido", notified: false, has_otp: true }),
            { status: 202 },
          );
        },
      });
      const outcome = await ctx.observe("login", client.login("user@example.com", "password"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const result = outcome.value as {
          requiresTwoFactor: boolean;
          hasOtp: boolean;
          pinRequested?: boolean;
        };
        assert.equal(result.requiresTwoFactor, true);
        assert.equal(result.hasOtp, true);
        assert.equal(result.pinRequested, undefined);
      }
      assert.deepEqual(paths, ["https://api.qvapay.com/auth/login"]);
      ctx.effect("paths", paths);
    },
  },
  {
    id: "login/03-totp-second-login",
    file: "test/login.test.ts",
    source: "test/login.test.ts:66",
    async run(ctx) {
      const bodies: Record<string, unknown>[] = [];
      const client = new QvaPayClient(() => undefined, {
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return bodies.length === 1
            ? new Response(JSON.stringify({ has_otp: true }), { status: 202 })
            : new Response(JSON.stringify({ accessToken: "token-validado" }), { status: 200 });
        },
      });
      const first = await ctx.observe("login:first", client.login("user@example.com", "password"));
      assert.equal(first.ok, true);
      if (first.ok) assert.equal((first.value as { hasOtp: boolean }).hasOtp, true);
      const second = await ctx.observe("login:totp", client.login("user@example.com", "password", "123456"));
      assert.equal(second.ok, true);
      if (second.ok) assert.equal((second.value as { token: string }).token, "token-validado");
      assert.equal(bodies[0]?.two_factor_code, undefined);
      assert.equal(bodies[1]?.two_factor_code, "123456");
      assert.equal(bodies[1]?.remember, true);
      ctx.effect("bodies", bodies);
    },
  },
  {
    id: "login/04-retry-transient-connection",
    file: "test/login.test.ts",
    source: "test/login.test.ts:85",
    async run(ctx) {
      let attempts = 0;
      const waits: number[] = [];
      const client = new QvaPayClient(() => undefined, {
        fetch: async (_input, init) => {
          attempts += 1;
          assert.ok(init?.signal instanceof AbortSignal);
          if (attempts < 3) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ has_otp: true }), { status: 202 });
        },
        sleep: async (milliseconds) => void waits.push(milliseconds),
      });
      const outcome = await ctx.observe("login", client.login("user@example.com", "password"));
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal((outcome.value as { hasOtp: boolean }).hasOtp, true);
      assert.equal(attempts, 3);
      assert.deepEqual(waits, [750, 1_500]);
      ctx.effect("attempts", attempts);
      ctx.effect("waits", waits);
    },
  },
  {
    id: "login/05-connect-timeout-actionable",
    file: "test/login.test.ts",
    source: "test/login.test.ts:108",
    async run(ctx) {
      let attempts = 0;
      const timeout = Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      });
      const client = new QvaPayClient(() => undefined, {
        fetch: async () => {
          attempts += 1;
          throw new TypeError("fetch failed", { cause: timeout });
        },
        sleep: async () => undefined,
      });
      const outcome = await ctx.observe("login", client.login("user@example.com", "password"));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { reason: string }).reason, "timeout");
        const error = outcome.error as unknown as { reason: string; message: string };
        assert.equal(error.reason, "timeout");
        assert.match(error.message, /no respondió/);
      }
      assert.equal(attempts, 3);
      ctx.effect("attempts", attempts);
    },
  },
  {
    id: "login/06-no-retry-http-rejection",
    file: "test/login.test.ts",
    source: "test/login.test.ts:131",
    async run(ctx) {
      let attempts = 0;
      const client = new QvaPayClient(() => undefined, {
        fetch: async () => {
          attempts += 1;
          return new Response(JSON.stringify({ error: "OTP incorrecto" }), { status: 401 });
        },
        sleep: async () => undefined,
      });
      const outcome = await ctx.observe(
        "login",
        client.login("user@example.com", "password", "000000"),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal((outcome.error as unknown as { status: number }).status, 401);
        assert.equal((outcome.error as unknown as { status: number }).status, 401);
      }
      assert.equal(attempts, 1);
      ctx.effect("attempts", attempts);
    },
  },
  {
    id: "login/07-validate-format-and-token",
    file: "test/login.test.ts",
    source: "test/login.test.ts:150",
    async run(ctx) {
      const saved: string[] = [];
      const calls: string[] = [];
      const gateway = {
        login: async (_email: string, _password: string, code?: string) => {
          calls.push(code ? `login:${code}` : "login:first");
          return code
            ? { requiresTwoFactor: false, token: "token-candidato" }
            : { requiresTwoFactor: true, hasOtp: true };
        },
      };

      const invalid = await ctx.observe(
        "authenticate:invalid-code",
        authenticateQvaSession({
          email: "user@example.com",
          password: "password",
          gateway,
          requestCode: async () => "12a456",
          verifyToken: async () => {
            void calls.push("verify");
          },
          saveToken: (token) => {
            void saved.push(token);
          },
        }),
      );
      assert.equal(invalid.ok, false);
      if (!invalid.ok) assert.match(invalid.error.message, /seis dígitos/);
      assert.equal(saved.length, 0);

      const valid = await ctx.observe(
        "authenticate:valid",
        authenticateQvaSession({
          email: "user@example.com",
          password: "password",
          gateway,
          requestCode: async () => "654321",
          verifyToken: async (token) => {
            void calls.push(`verify:${token}`);
          },
          saveToken: (token) => {
            void saved.push(token);
          },
        }),
      );
      assert.equal(valid.ok, true);
      assert.deepEqual(calls.slice(-3), ["login:first", "login:654321", "verify:token-candidato"]);
      assert.deepEqual(saved, ["token-candidato"]);
      ctx.effect("calls", calls);
      ctx.effect("saved", saved);
    },
  },
  {
    id: "login/08-no-persist-on-verify-failure",
    file: "test/login.test.ts",
    source: "test/login.test.ts:192",
    async run(ctx) {
      let saved = false;
      const outcome = await ctx.observe(
        "authenticate",
        authenticateQvaSession({
          email: "user@example.com",
          password: "password",
          gateway: {
            login: async (_email: string, _password: string, code?: string) =>
              code
                ? { requiresTwoFactor: false, token: "token-no-verificado" }
                : { requiresTwoFactor: true, hasOtp: true },
          },
          requestCode: async () => "123456",
          verifyToken: async () => {
            throw new Error("token rechazado");
          },
          saveToken: () => {
            saved = true;
          },
        }),
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error.message, /token rechazado/);
      assert.equal(saved, false);
      ctx.value("saved", saved);
    },
  },
  {
    id: "login/09-qusd-balance-profile",
    file: "test/login.test.ts",
    source: "test/login.test.ts:215",
    async run(ctx) {
      const paths: string[] = [];
      const client = new QvaPayClient(() => "token-de-prueba", {
        fetch: async (input) => {
          paths.push(String(input));
          return new Response(JSON.stringify({ balance: 34.25 }), { status: 200 });
        },
      });
      const outcome = await ctx.observe("qusdBalance", client.qusdBalance());
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.value, 34.25);
      assert.deepEqual(paths, ["https://api.qvapay.com/user"]);
      ctx.effect("paths", paths);
    },
  },
  {
    id: "login/10-p2p-paged-data",
    file: "test/login.test.ts",
    source: "test/login.test.ts:234",
    async run(ctx) {
      const client = new QvaPayClient(() => "token-de-prueba", {
        fetch: async () =>
          new Response(
            JSON.stringify({
              current_page: 1,
              per_page: 20,
              total: 1,
              data: [
                {
                  uuid: "offer-1",
                  type: "sell",
                  coin: "BANK_CUP",
                  amount: "10.00",
                  receive: "9700.00",
                  status: "open",
                },
              ],
            }),
            { status: 200 },
          ),
      });
      const page = await client.listOffersPage({ take: 20, page: 1 });
      ctx.value("listOffersPage", {
        total: page.total,
        offers: page.offers.map((offer) => ({
          uuid: offer.uuid,
          amount: offer.amount,
          receive: offer.receive,
        })),
      });
      assert.equal(page.total, 1);
      assert.equal(page.offers.length, 1);
      assert.equal(page.offers[0]?.uuid, "offer-1");
      assert.equal(page.offers[0]?.amount, 10);
      assert.equal(page.offers[0]?.receive, 9_700);
    },
  },
  {
    id: "login/11-public-p2p-averages",
    file: "test/login.test.ts",
    source: "test/login.test.ts:270",
    async run(ctx) {
      const paths: string[] = [];
      const client = new QvaPayClient(() => undefined, {
        fetch: async (input) => {
          paths.push(String(input));
          return new Response(
            JSON.stringify({ BANK_CUP: { average_buy: 1000, average_sell: 990 } }),
            { status: 200 },
          );
        },
      });
      const outcome = await ctx.observe("p2pAverages", client.p2pAverages());
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        const averages = outcome.value as Record<string, { average_sell: number }>;
        assert.equal(averages.BANK_CUP?.average_sell, 990);
      }
      assert.deepEqual(paths, ["https://api.qvapay.com/p2p/averages"]);
      ctx.effect("paths", paths);
    },
  },
];

export { scenarios };
