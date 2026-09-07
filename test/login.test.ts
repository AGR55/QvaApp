import assert from "node:assert/strict";
import test from "node:test";
import {
  QvaApiError,
  QvaConnectionError,
  QvaPayClient,
} from "../src/qvapay.js";
import { authenticateQvaSession } from "../src/application/qvapay-login.js";

test("solicita un PIN cuando QvaPay indica que el login no lo notificó", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    if (paths.length === 1)
      return new Response(
        JSON.stringify({
          info: "Código 2FA requerido",
          notified: false,
          has_otp: false,
        }),
        { status: 202 },
      );
    return new Response(
      JSON.stringify({ message: "PIN enviado correctamente" }),
      { status: 200 },
    );
  };

  try {
    const result = await new QvaPayClient(() => undefined).login(
      "user@example.com",
      "password",
    );
    assert.equal(result.requiresTwoFactor, true);
    assert.equal(result.pinRequested, true);
    assert.deepEqual(paths, [
      "https://api.qvapay.com/auth/login",
      "https://api.qvapay.com/auth/request-pin",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no solicita PIN por correo cuando la cuenta tiene OTP", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return new Response(
      JSON.stringify({
        info: "Código 2FA requerido",
        notified: false,
        has_otp: true,
      }),
      { status: 202 },
    );
  };

  try {
    const result = await new QvaPayClient(() => undefined).login(
      "user@example.com",
      "password",
    );
    assert.equal(result.requiresTwoFactor, true);
    assert.equal(result.hasOtp, true);
    assert.equal(result.pinRequested, undefined);
    assert.deepEqual(paths, ["https://api.qvapay.com/auth/login"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("envía el TOTP de seis dígitos en el segundo login", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new QvaPayClient(() => undefined, {
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? new Response(JSON.stringify({ has_otp: true }), { status: 202 })
        : new Response(JSON.stringify({ accessToken: "token-validado" }), { status: 200 });
    },
  });

  const first = await client.login("user@example.com", "password");
  assert.equal(first.hasOtp, true);
  const second = await client.login("user@example.com", "password", "123456");

  assert.equal(second.token, "token-validado");
  assert.equal(bodies[0]?.two_factor_code, undefined);
  assert.equal(bodies[1]?.two_factor_code, "123456");
  assert.equal(bodies[1]?.remember, true);
});

test("reintenta fallos transitorios de conexión al autenticar", async () => {
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

  const result = await client.login("user@example.com", "password");

  assert.equal(result.hasOtp, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [750, 1_500]);
});

test("convierte el timeout de conexión de Undici en un error accionable", async () => {
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

  await assert.rejects(
    client.login("user@example.com", "password"),
    (error: unknown) =>
      error instanceof QvaConnectionError &&
      error.reason === "timeout" &&
      /no respondió/.test(error.message),
  );
  assert.equal(attempts, 3);
});

test("no reintenta rechazos HTTP del login", async () => {
  let attempts = 0;
  const client = new QvaPayClient(() => undefined, {
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "OTP incorrecto" }), { status: 401 });
    },
    sleep: async () => undefined,
  });

  await assert.rejects(
    client.login("user@example.com", "password", "000000"),
    (error: unknown) => error instanceof QvaApiError && error.status === 401,
  );
  assert.equal(attempts, 1);
});

test("valida formato y token antes de guardar la sesión", async () => {
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

  await assert.rejects(
    authenticateQvaSession({
      email: "user@example.com",
      password: "password",
      gateway,
      requestCode: async () => "12a456",
      verifyToken: async () => { void calls.push("verify"); },
      saveToken: (token) => { void saved.push(token); },
    }),
    /seis dígitos/,
  );
  assert.equal(saved.length, 0);

  await authenticateQvaSession({
    email: "user@example.com",
    password: "password",
    gateway,
    requestCode: async () => "654321",
    verifyToken: async (token) => { void calls.push(`verify:${token}`); },
    saveToken: (token) => { void saved.push(token); },
  });
  assert.deepEqual(calls.slice(-3), [
    "login:first",
    "login:654321",
    "verify:token-candidato",
  ]);
  assert.deepEqual(saved, ["token-candidato"]);
});

test("no persiste el token cuando su verificación falla", async () => {
  let saved = false;
  await assert.rejects(
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
      verifyToken: async () => { throw new Error("token rechazado"); },
      saveToken: () => { saved = true; },
    }),
    /token rechazado/,
  );
  assert.equal(saved, false);
});

test("consulta el saldo QUSD mediante el perfil de usuario", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return new Response(JSON.stringify({ balance: 34.25 }), { status: 200 });
  };

  try {
    const balance = await new QvaPayClient(
      () => "token-de-prueba",
    ).qusdBalance();
    assert.equal(balance, 34.25);
    assert.deepEqual(paths, ["https://api.qvapay.com/user"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lee la respuesta P2P paginada que usa data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
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
    );

  try {
    const page = await new QvaPayClient(() => "token-de-prueba").listOffersPage(
      { take: 20, page: 1 },
    );
    assert.equal(page.total, 1);
    assert.equal(page.offers.length, 1);
    assert.equal(page.offers[0]?.uuid, "offer-1");
    assert.equal(page.offers[0]?.amount, 10);
    assert.equal(page.offers[0]?.receive, 9_700);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consulta los promedios P2P públicos para el cortafuegos", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(String(input));
    return new Response(
      JSON.stringify({ BANK_CUP: { average_buy: 1000, average_sell: 990 } }),
      { status: 200 },
    );
  };
  try {
    const averages = await new QvaPayClient(() => undefined).p2pAverages();
    assert.equal(averages.BANK_CUP?.average_sell, 990);
    assert.deepEqual(paths, ["https://api.qvapay.com/p2p/averages"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
