import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";
import { OperationChatError } from "../src/operation-chat.js";

test("chat web exige sesión, CSRF y una operación autorizada", async () => {
  const sent: string[] = [];
  const readModel = {
    operationChatUnread: () => ({ offer: 1 }),
    readOperationChat: (uuid: string) => {
      if (uuid !== "offer") throw new OperationChatError(404, "Operación ajena.");
      return { uuid, messages: [], updatedAt: null, stale: true, unreadCount: 0 };
    },
    refreshOperationChat: async (uuid: string) => ({ uuid, messages: [], updatedAt: Date.now(), stale: false, unreadCount: 0 }),
    sendOperationChat: async (_uuid: string, message: string) => { sent.push(message); return { id: "sent", chat: { messages: [] } }; },
    markOperationChatRead: (uuid: string) => ({ uuid, messages: [], unreadCount: 0 }),
  };
  const origin = "http://127.0.0.1:3000";
  const app = buildDashboard(readModel as never, { password: "clave-muy-larga-y-segura", trustedOrigin: origin });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/operations/offer/chat" })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/session", headers: { origin, "content-type": "application/json" }, payload: { password: "clave-muy-larga-y-segura" } });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const csrf = login.json<{ data: { csrfToken: string } }>().data.csrfToken;
    assert.equal((await app.inject({ method: "GET", url: "/api/operations/foreign/chat", headers: { cookie } })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/operations/chats/unread", headers: { cookie } })).json(), { data: { offer: 1 } });
    const route = "/api/operations/offer/chat";
    assert.equal((await app.inject({ method: "POST", url: route, headers: { origin, cookie, "content-type": "application/json" }, payload: { message: "Hola" } })).statusCode, 403);
    const headers = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf };
    assert.equal((await app.inject({ method: "POST", url: route, headers, payload: { message: "x".repeat(600) } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: route, headers, payload: { message: "Hola" } })).statusCode, 201);
    assert.deepEqual(sent, ["Hola"]);
    assert.equal((await app.inject({ method: "POST", url: "/api/operations/offer/chat/read", headers, payload: {} })).statusCode, 200);
  } finally { await app.close(); }
});
