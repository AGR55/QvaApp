import test from "node:test";
import assert from "node:assert/strict";
import {consumeChatStream} from "../src/chat-stream.js";
import {QvaPayClient} from "../src/qvapay.js";
const stream=(chunks:string[])=>new ReadableStream<Uint8Array>({start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close();}});

test("stream separa fragmentos SSE, ignora heartbeats y acota memoria",async()=>{
 let changes=0;
 await consumeChatStream(stream([": ping\n\nevent: heartbeat\ndata: {}\n\ndata: {\"message\":", "\"Hola\"}\r\n\r\ndata: {\"type\":\"ping\"}\n\ndata: changed\n\n"]),()=>changes++);
 assert.equal(changes,2);
 await assert.rejects(consumeChatStream(stream(["x".repeat(65537)]),()=>{}),/grande/);
});

test("chat de una orden utiliza su query y no bloquea aplicar una oferta",{timeout:2000},async()=>{
 let finishChat!:()=>void;let chatStarted!:()=>void;
 const started=new Promise<void>(resolve=>{chatStarted=resolve;});
 const waiting=new Promise<void>(resolve=>{finishChat=resolve;});
 const paths:string[]=[];
 const qva=new QvaPayClient(()=>"token",{fetch:async(input)=>{
   const path=String(input);paths.push(path);
   if(path.includes("/chat")){chatStarted();await waiting;return new Response(JSON.stringify({chat:[]}),{headers:{"content-type":"application/json"}});}
   return new Response(JSON.stringify({message:"ok"}),{headers:{"content-type":"application/json"}});
 },sleep:async()=>{}});
 const read=qva.listChat("parent","child");await started;
 await qva.apply("other");
 assert.ok(paths.some(path=>path.endsWith("/p2p/other/apply")));assert.ok(paths.some(path=>path.endsWith("/p2p/parent/chat?order=child")));
 finishChat();await read;
});
