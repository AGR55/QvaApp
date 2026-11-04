import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { QvaApiError, QvaMutationUncertainError } from "../src/qvapay.js";
import { OperationChatService } from "../src/operation-chat.js";

function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-operation-chat-")));
  store.set("analytics_account_uuid", "mine");
  store.createOperation({ uuid: "offer", offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 1000, rate: 100, state: "applied", autoApplied: true, cancelAt: null,
    createdAt: Date.now(), counterpartyId: "seller" });
  return store;
}

test("image send is durable, idempotent and cannot reuse an attempt for different content", async t => {
  const store=setup(); t.after(()=>store.close());
  const image={bytes:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64"),mimeType:"image/png" as const};
  let sends=0;
  const gateway={listChat:async()=>[],sendChat:async()=>{sends++;return {id:"remote-image"};}};
  const service=new OperationChatService(store,gateway);
  await service.send("offer","",undefined,image,"attempt-0000000001");
  const restarted=new OperationChatService(store,gateway);
  assert.equal((await restarted.send("offer","",undefined,image,"attempt-0000000001")).id,"remote-image");
  assert.equal(sends,1);
  assert.equal(restarted.sendStatus("offer","attempt-0000000001").state,"confirmed");
  await assert.rejects(restarted.send("offer","different",undefined,image,"attempt-0000000001"),/otro envío/);
  await assert.rejects(restarted.send("foreign","",undefined,image,"attempt-0000000001"),/operación/);
});

test("concurrent and uncertain attempts never redispatch, even after service restart", async t => {
  const store=setup(); t.after(()=>store.close());
  let sends=0;
  let finish!:()=>void;
  const wait=new Promise<void>(resolve=>{finish=resolve;});
  const gateway={listChat:async()=>[],sendChat:async()=>{sends++;await wait;throw new QvaMutationUncertainError("chat",new Error("timeout"));}};
  const service=new OperationChatService(store,gateway);
  const first=service.send("offer","Hola",undefined,undefined,"attempt-0000000002");
  await assert.rejects(service.send("offer","Hola",undefined,undefined,"attempt-0000000002"),/incierto/);
  finish();
  await assert.rejects(first,/incierto/);
  const restarted=new OperationChatService(store,gateway);
  await assert.rejects(restarted.send("offer","Hola",undefined,undefined,"attempt-0000000002"),/incierto/);
  assert.equal(restarted.sendStatus("offer","attempt-0000000002").state,"uncertain");
  assert.equal(sends,1);
});

test("only definitive rejection permits retry of the same attempt", async t => {
  const store=setup(); t.after(()=>store.close());
  let sends=0;
  const service=new OperationChatService(store,{listChat:async()=>[],sendChat:async()=>{if(++sends===1) throw new QvaApiError(400,"invalid");return {id:"ok"};}});
  await assert.rejects(service.send("offer","Hola",undefined,undefined,"attempt-0000000003"),/invalid/);
  assert.equal(service.sendStatus("offer","attempt-0000000003").state,"rejected");
  assert.equal((await service.send("offer","Hola",undefined,undefined,"attempt-0000000003")).id,"ok");
});

test("image download resolves cached message belonging to the authorized conversation only", async t => {
  const store=setup();t.after(()=>store.close());
  const service=new OperationChatService(store,{listChat:async()=>[{id:"image",peerId:"seller",message:"Recibo",image:"remote-reference"}],sendChat:async()=>({}),downloadChatImage:async reference=>{
    assert.equal(reference,"remote-reference");return {bytes:new Uint8Array(),mimeType:"image/png"};
  }});
  await service.refresh("offer");
  assert.equal((await service.image("offer","image")).mimeType,"image/png");
  await assert.rejects(service.image("offer","foreign"),/no disponible/);
  await assert.rejects(service.image("foreign","image"),/operación/);
});

test("conserva una copia local, deduplica por ID y marca leídos solo los mensajes visibles", async t => {
  const store = setup(); t.after(() => store.close());
  let messages = [{ id: "a", peerId: "seller", message: "Ya está listo", createdAt: 1000 }];
  const chat = new OperationChatService(store, { listChat: async () => messages, sendChat: async () => ({ id: "sent" }) }, () => 2000);
  assert.deepEqual(chat.read("offer").messages, []);
  await chat.refresh("offer");
  assert.equal(chat.read("offer").unreadCount, 1);
  chat.markRead("offer");
  assert.equal(chat.read("offer").unreadCount, 0);
  messages = [...messages, { id: "a", peerId: "seller", message: "Ya está listo", createdAt: 1000 },
    { id: "b", peerId: "seller", message: "¿Pagaste?", createdAt: 2000 },
    { id: "c", peerId: "mine", message: "En breve", createdAt: 2001 }];
  await chat.refresh("offer");
  assert.equal(chat.read("offer").messages.length, 3);
  assert.equal(chat.read("offer").unreadCount, 1);
});

test("un fallo remoto conserva el último chat y no borra mensajes", async t => {
  const store = setup(); t.after(() => store.close());
  let fail = false;
  const chat = new OperationChatService(store, { listChat: async () => {
    if (fail) throw new Error("sin red");
    return [{ id: "a", peerId: "seller", message: "Hola", createdAt: 1000 }];
  }, sendChat: async () => ({ id: "sent" }) }, () => 2000);
  await chat.refresh("offer"); fail = true;
  await assert.rejects(chat.refresh("offer"), /sin red/);
  assert.equal(chat.read("offer").messages[0]?.message, "Hola");
  assert.equal(chat.read("offer").stale, true);
});

test("no deja leer ni enviar chat de una oferta sin operación propia", async t => {
  const store = setup(); t.after(() => store.close());
  const chat = new OperationChatService(store, { listChat: async () => [], sendChat: async () => ({}) });
  assert.throws(() => chat.read("foreign"), /operación/i);
  await assert.rejects(chat.send("foreign", "Hola"), /operación/i);
});

test("valida el texto y nunca reintenta automáticamente un envío incierto", async t => {
  const store = setup(); t.after(() => store.close());
  let sends = 0;
  const chat = new OperationChatService(store, { listChat: async () => [], sendChat: async () => {
    sends += 1;
    throw new QvaMutationUncertainError("chat", new Error("timeout"));
  } });
  await assert.rejects(chat.send("offer", " "), /vacío/i);
  await assert.rejects(chat.send("offer", "x".repeat(600)), /599/);
  await assert.rejects(chat.send("offer", "Hola"), /incierto/i);
  assert.equal(sends, 1);
});

test("un envío confirmado sigue confirmado aunque falle la lectura posterior", async t => {
  const store = setup(); t.after(() => store.close());
  let sends = 0;
  const chat = new OperationChatService(store, { listChat: async () => { throw new Error("lectura caída"); },
    sendChat: async () => { sends += 1; return { id: "confirmed" }; } });
  const result = await chat.send("offer", "Hola");
  assert.equal(result.id, "confirmed");
  assert.equal(result.chat.stale, true);
  assert.equal(sends, 1);
});

test("el trabajador solo revisa dos chats activos por turno y nunca envía mensajes", async t => {
  const store = setup(); t.after(() => store.close());
  for (const uuid of ["second", "third"]) store.createOperation({ uuid, offerType: "sell", coin: "BANK_CUP", amount: 10,
    receive: 1000, rate: 100, state: "applied", autoApplied: true, cancelAt: null, createdAt: Date.now(), counterpartyId: "seller" });
  const reads: string[] = [];
  const chat = new OperationChatService(store, { listChat: async uuid => { reads.push(uuid); return []; },
    sendChat: async () => { throw new Error("No debe enviar"); } });
  await chat.syncActive();
  assert.equal(reads.length, 2);
  await chat.syncActive();
  assert.equal(reads.length, 4);
  assert.equal(new Set(reads).size, 3);
});

test("limpia chats antiguos incluso cuando no quedan operaciones activas", async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), "qva-operation-chat-prune-")));
  t.after(() => store.close());
  const now = 31 * 24 * 60 * 60_000;
  store.saveRemoteResource("operation-chat:old", [{ id: "old" }], 1);
  store.saveRemoteResource("operation-chat:new", [{ id: "new" }], now);
  store.saveRemoteResource("other-resource", { safe: true }, 1);
  const chat = new OperationChatService(store, { listChat: async () => [], sendChat: async () => ({}) }, () => now);
  await chat.syncActive();
  assert.equal(store.loadRemoteResource("operation-chat:old"), undefined);
  assert.ok(store.loadRemoteResource("operation-chat:new"));
  assert.ok(store.loadRemoteResource("other-resource"));
});
