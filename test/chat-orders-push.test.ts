import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ChatCatalog } from "../src/chat-catalog.js";
import { OperationChatService } from "../src/operation-chat.js";
import { ChatPushDispatcher, PushTokenExpired, type ChatPushMessage } from "../src/chat-push.js";
import type { P2pOffer } from "../src/types.js";

const offer = ():P2pOffer => ({uuid:"parent",type:"buy",coin:"CLASICA",amount:100,receive:110,status:"open",offer_kind:"flexible",User:{uuid:"me"},Orders:[
  {uuid:"order-one",amount:10,receive:11,status:"processing",Taker:{uuid:"alice"}},
  {uuid:"order-two",amount:20,receive:22,status:"paid",Taker:{uuid:"bob"}},
]});
const open=()=>new Store(mkdtempSync(join(tmpdir(),"qva-chat-orders-")));

test("catálogo propio separa dos órdenes sin crear operaciones ni cambiar el fiat",t=>{
  const store=open();t.after(()=>store.close());
  store.set("fiat_balance:CLASICA","123");
  const catalog=new ChatCatalog(store,()=>1000);
  catalog.discover([offer()],"me");
  const threads=catalog.list();
  assert.equal(threads.length,2);
  assert.deepEqual(threads.map(x=>x.counterpartyId).sort(),["alice","bob"]);
  assert.ok(threads.every(x=>x.role==="creator"));
  assert.equal(store.activeOperations().length,0);
  assert.equal(store.get("fiat_balance:CLASICA"),"123");
  assert.equal(catalog.get("parent","foreign"),undefined);
});

test("un tomador descubre solo sus órdenes; ofertas normales conservan ambos roles",t=>{
  const store=open();t.after(()=>store.close());
  const catalog=new ChatCatalog(store,()=>1000);
  catalog.discover([offer()],"alice");
  assert.equal(catalog.list().length,1);
  assert.equal(catalog.list()[0]?.counterpartyId,"me");
  assert.equal(catalog.list()[0]?.role,"taker");
  catalog.discover([{...offer(),uuid:"normal",offer_kind:"fixed",Peer:{uuid:"alice"}}],"alice");
  assert.equal(catalog.get("normal")?.role,"taker");
});

test("mensajes, lectura visible y outbox son independientes por orden y sobreviven al reinicio",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"qva-chat-restart-"));
  let store=new Store(directory);t.after(()=>store.close());
  store.set("analytics_account_uuid","me");
  new ChatCatalog(store,()=>1000).discover([offer()],"me");
  let fresh=false;
  const gateway={listChat:async(_uuid:string,order?:string)=>[
    {id:"old",peerId:order==="order-one"?"alice":"bob",message:"Historial",createdAt:500},
    ...(fresh?[{id:"same-new-id",peerId:order==="order-one"?"alice":"bob",message:`Nuevo ${order}`,createdAt:2000},
      {id:"own",peerId:"me",message:"Enviado por mí",createdAt:2001}]:[]),
  ],sendChat:async()=>({id:"sent"})};
  let chat=new OperationChatService(store,gateway,()=>3000);
  await chat.refresh("parent","order-one");await chat.refresh("parent","order-two");
  assert.equal(store.pendingChatPush(3000).length,0,"no avisar del historial inicial");
  fresh=true;
  await chat.refresh("parent","order-one");await chat.refresh("parent","order-two");
  assert.equal(store.pendingChatPush(3000).length,2,"un aviso por orden, ninguno propio");
  chat.markRead("parent","order-one",["old"]);
  assert.equal(chat.read("parent","order-one").unreadCount,1,"no marcar el mensaje recibido después del render");
  chat.markRead("parent","order-one",["same-new-id"]);
  assert.equal(chat.read("parent","order-two").unreadCount,2);
  store.close();store=new Store(directory);chat=new OperationChatService(store,gateway,()=>4000);
  assert.equal(chat.read("parent","order-one").unreadCount,0);
  await chat.refresh("parent","order-two");
  assert.equal(store.pendingChatPush(4000).length,2,"no duplicar al reiniciar");
  await assert.rejects(chat.send("parent","Hola","foreign"),/propia/);
});

test("entrega reintenta solo los dispositivos pendientes y elimina tokens expirados",async t=>{
  const store=open();t.after(()=>store.close());
  store.registerChatPushDevice("a","token-a",1000);store.registerChatPushDevice("b","token-b",1000);
  const message:ChatPushMessage={id:"event",uuid:"parent",orderUuid:"one",threadId:"parent:one",messageId:"message",title:"Alice",body:"Hola",sender:"Alice",createdAt:1000};
  store.enqueueChatPush("event",message.threadId,message,1000);
  let clock=2000,fail=true,web=0;const sends:string[]=[];
  const dispatcher=new ChatPushDispatcher(store,{operatorActive:()=>true,web:{notifyChat:async()=>{web++;}},native:{send:async(token,payload)=>{
    assert.equal(payload.threadId,"parent:one");sends.push(token);if(token==="token-b"&&fail)throw new Error("sin red");
  }}},()=>clock);
  await dispatcher.drain();assert.deepEqual(sends,["token-a","token-b"]);
  fail=false;clock=10_000;await dispatcher.drain();
  assert.deepEqual(sends,["token-a","token-b","token-b"]);assert.equal(web,1);assert.equal(store.pendingChatPush(clock).length,0);
  store.enqueueChatPush("expired",message.threadId,{...message,id:"expired"},clock);
  const expired=new ChatPushDispatcher(store,{operatorActive:()=>true,web:{notifyChat:async()=>{}},native:{send:async()=>{throw new PushTokenExpired();}}},()=>clock);
  await expired.drain();assert.equal(store.chatPushDevices().length,0);
});

test("leer antes de entregar suprime el aviso; revocar operador impide envío nativo",async t=>{
  const store=open();t.after(()=>store.close());
  store.registerChatPushDevice("revoked","token",1000);
  const message:ChatPushMessage={id:"event",uuid:"parent",threadId:"parent:fixed",messageId:"seen",title:"Alice",body:"Hola",sender:"Alice",createdAt:1000};
  store.enqueueChatPush(message.id,message.threadId,message,1000);
  store.set("operation-chat-read:parent:fixed",JSON.stringify(["seen"]));
  let calls=0;
  await new ChatPushDispatcher(store,{operatorActive:()=>false,web:{notifyChat:async()=>{calls++;}},native:{send:async()=>{calls++;}}},()=>2000).drain();
  assert.equal(calls,0);assert.equal(store.chatPushDevices().length,0);assert.equal(store.pendingChatPush(2000).length,0);
});

test("la primera consulta de una orden nueva avisa mensajes recibidos antes de descubrirla",async t=>{
 const store=open();t.after(()=>store.close());store.set("analytics_account_uuid","me");
 let now=1000;
 const chat=new OperationChatService(store,{listChat:async()=>[{id:"early",peerId:"alice",message:"Hola",createdAt:1500}],sendChat:async()=>({})},()=>now);
 now=2000;new ChatCatalog(store,()=>now).discover([offer()],"me");
 await chat.refresh("parent","order-one");
 assert.equal(store.pendingChatPush(now).length,1);
});
