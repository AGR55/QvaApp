import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";
import { OperationChatError } from "../src/operation-chat.js";
import { CHAT_MULTIPART_MAX_BYTES, type ChatImage } from "../src/chat-images.js";

test("image HTTP contract enforces auth, scope, CSRF, payload limits and exact order", async t => {
  const token="o".repeat(48);
  const imageBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
  const calls:unknown[]=[];
  let writable=true;
  const readModel={
    checkMobileOperator:(value:string,write:boolean)=>({ok:value===token&&(!write||writable),scopes:["read","actions"]}),
    sendOperationChat:async(uuid:string,message:string,order?:string,image?:ChatImage,attemptId?:string)=>{
      if(uuid!=="offer"||order!=="child") throw new OperationChatError(404,"Operación ajena.");
      calls.push({uuid,message,order,image,attemptId});return {id:"remote",chat:{messages:[]}};
    },
    operationChatSendStatus:(uuid:string,attemptId:string,order?:string)=>{
      calls.push({uuid,attemptId,order});return {state:"confirmed",id:"remote"};
    },
    operationChatImage:(uuid:string,messageId:string,order?:string)=>{
      if(uuid!=="offer"||messageId!=="remote"||order!=="child") throw new OperationChatError(404,"Imagen ajena.");
      return {bytes:imageBytes,mimeType:"image/png"};
    },
  };
  const origin="http://127.0.0.1:3000";
  const app=buildDashboard(readModel as never,{password:"clave-muy-larga-y-segura",trustedOrigin:origin});
  t.after(()=>app.close());
  const form=new FormData();form.set("file",new Blob([imageBytes],{type:"image/png"}),"receipt.png");form.set("message","Recibo");form.set("attemptId","attempt-0000000010");
  const encoded=new Request("https://local.invalid",{method:"POST",body:form});
  const payload=Buffer.from(await encoded.arrayBuffer());
  const headers={authorization:`Bearer ${token}`,"content-type":encoded.headers.get("content-type")!};
  const path="/api/mobile/operations/offer/chat/images?order=child";
  assert.equal((await app.inject({url:path,method:"POST",headers:{"content-type":headers["content-type"]},payload})).statusCode,401);
  writable=false;
  assert.equal((await app.inject({url:path,method:"POST",headers,payload})).statusCode,401);
  writable=true;
  assert.equal((await app.inject({url:path,method:"POST",headers,payload})).statusCode,201);
  const sent=calls[0] as {order:string;image:ChatImage;attemptId:string};
  assert.equal(sent.order,"child");assert.deepEqual(Buffer.from(sent.image.bytes),imageBytes);assert.equal(sent.attemptId,"attempt-0000000010");
  assert.equal((await app.inject({url:path,method:"POST",headers,payload:Buffer.alloc(CHAT_MULTIPART_MAX_BYTES+1)})).statusCode,413);
  assert.equal((await app.inject({url:path,method:"POST",headers,payload:Buffer.from("invalid")})).statusCode,400);
  assert.equal((await app.inject({url:path.replace("offer","foreign"),method:"POST",headers,payload})).statusCode,404);
  const binary=await app.inject({url:"/api/mobile/operations/offer/chat/images/remote?order=child",headers});
  assert.equal(binary.statusCode,200);assert.equal(binary.headers["content-type"],"image/png");assert.deepEqual(binary.rawPayload,imageBytes);assert.equal(binary.headers["cache-control"],"no-store");
  assert.equal((await app.inject({url:"/api/mobile/operations/offer/chat/images/foreign?order=child",headers})).statusCode,404);
  assert.equal((await app.inject({url:"/api/mobile/operations/offer/chat/sends/attempt-0000000010?order=child",headers})).json().data.state,"confirmed");
  const login=await app.inject({url:"/api/session",method:"POST",headers:{origin,"content-type":"application/json"},payload:{password:"clave-muy-larga-y-segura"}});
  const cookie=String(login.headers["set-cookie"]).split(";",1)[0]!;
  const csrf=login.json().data.csrfToken;
  assert.equal((await app.inject({url:path,method:"POST",headers:{...headers,cookie,origin},payload})).statusCode,403);
  assert.equal((await app.inject({url:path,method:"POST",headers:{...headers,cookie,origin,"x-csrf-token":csrf},payload})).statusCode,201);
  const webPath=path.replace("/mobile","");
  assert.equal((await app.inject({url:webPath,method:"POST",headers:{...headers,authorization:"",cookie,origin,"x-csrf-token":csrf},payload})).statusCode,201);
  assert.equal((await app.inject({url:"/api/operations/offer/chat",method:"POST",headers:{...headers,cookie,origin,"x-csrf-token":csrf},payload})).statusCode,400);
});

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

test("Android exige Bearer y conserva el ID de orden en lectura, envío y lectura visible",async()=>{
 const calls:unknown[]=[];const token="a".repeat(48);
 const readModel={
  checkMobileOperator:(value:string)=>value===token?{ok:true,operatorId:"device"}:{ok:false},
  chatThreads:()=>[{id:"parent:order",uuid:"parent",orderUuid:"order"}],
  readOperationChat:(uuid:string,order?:string)=>{calls.push(["read",uuid,order]);return {messages:[]};},
  sendOperationChat:async(uuid:string,message:string,order?:string)=>{calls.push(["send",uuid,order,message]);return {chat:{messages:[]}};},
  markOperationChatRead:(uuid:string,order?:string,ids?:string[])=>{calls.push(["seen",uuid,order,ids]);return {messages:[]};},
  registerChatPushDevice:(id:string,push:string)=>calls.push(["push",id,push]),
 };
 const app=buildDashboard(readModel as never,{password:"clave-muy-larga-y-segura",trustedOrigin:"http://127.0.0.1:3000"});
 try {
  const path="/api/mobile/operations/parent/chat?order=order";
  assert.equal((await app.inject({url:path})).statusCode,401);
  const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
  assert.equal((await app.inject({url:path,headers})).statusCode,200);
  assert.equal((await app.inject({url:path,method:"POST",headers,payload:{message:"Hola"}})).statusCode,201);
  assert.equal((await app.inject({url:"/api/mobile/operations/parent/chat/read?order=order",method:"POST",headers,payload:{ids:["visible"]}})).statusCode,200);
  assert.equal((await app.inject({url:"/api/mobile/operations/chats",headers})).json().data[0].orderUuid,"order");
  assert.equal((await app.inject({url:"/api/mobile/push-device",method:"POST",headers,payload:{token:"test-firebase-token-123456789"}})).statusCode,200);
  assert.deepEqual(calls.slice(0,3),[["read","parent","order"],["send","parent","order","Hola"],["seen","parent","order",["visible"]]]);
  assert.deepEqual(calls[3],["push","device","test-firebase-token-123456789"]);
 }finally{await app.close();}
});
