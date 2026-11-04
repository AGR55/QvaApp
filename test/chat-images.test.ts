import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_IMAGE_MAX_BYTES, chatImageUrl, parseChatImageMultipart, validateChatImage } from "../src/chat-images.js";
import { QvaMutationUncertainError, QvaPayClient } from "../src/qvapay.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("chat treats malformed success as uncertain and never retries the POST", async () => {
  for (const body of ["not-json", "{}", '{"message":null}']) {
    let calls=0;
    const client=new QvaPayClient(()=>"secret",{fetch:async()=>{calls++;return new Response(body);}});
    await assert.rejects(client.sendChat("offer","caption",undefined,{bytes:png,mimeType:"image/png"}),QvaMutationUncertainError);
    assert.equal(calls,1);
  }
});

test("chat images enforce MIME, dimensions and byte limits", () => {
  assert.equal(validateChatImage(png, "image/png").mimeType, "image/png");
  assert.throws(() => validateChatImage(png,"image/jpeg"));
  assert.throws(() => validateChatImage(Buffer.from("<svg/>"),"image/png"));
  assert.throws(() => validateChatImage(Buffer.alloc(CHAT_IMAGE_MAX_BYTES+1),"image/png"));
  const huge=Buffer.from(png); huge.writeUInt32BE(1001,16);
  assert.throws(() => validateChatImage(huge,"image/png"));
});

test("multipart accepts one image, optional caption and stable attempt; rejects duplicate fields", async () => {
  const form=new FormData();
  form.set("file",new Blob([png],{type:"image/png"}),"../untrusted.png");
  form.set("attemptId","attempt-0000000001");
  const request=new Request("https://local.invalid",{method:"POST",body:form});
  const parsed=await parseChatImageMultipart(Buffer.from(await request.arrayBuffer()),request.headers.get("content-type")!);
  assert.equal(parsed.message,"");
  assert.deepEqual(Buffer.from(parsed.image.bytes),png);
  form.append("file",new Blob([png],{type:"image/png"}),"second.png");
  const duplicate=new Request("https://local.invalid",{method:"POST",body:form});
  await assert.rejects(parseChatImageMultipart(Buffer.from(await duplicate.arrayBuffer()),duplicate.headers.get("content-type")!));
});

test("remote image URLs reject SSRF, credentials, redirects, alternate hosts and signed URLs", async () => {
  for (const url of ["http://www.qvapay.com/storage/a.png","https://127.0.0.1/storage/a.png","https://api.qvapay.com.evil.test/storage/a.png","https://user:pass@api.qvapay.com/storage/a.png","https://api.qvapay.com:444/storage/a.png","https://www.qvapay.com/storage/a.png?token=secret","https://www.qvapay.com/p2p/a.png","/storage/a.png","https://www.qvapay.com/storage/%2e%2e/private.png"]) assert.throws(()=>chatImageUrl(url),url);
  let calls=0;
  const client=new QvaPayClient(()=>"secret",{fetch:async (_url,init)=>{
    calls++;
    assert.equal(new Headers(init?.headers).has("authorization"),false);
    assert.equal(init?.redirect,"error");
    return new Response(png,{headers:{"content-type":"image/png"}});
  }});
  await assert.rejects(client.downloadChatImage("https://127.0.0.1/storage/a.png"));
  assert.equal(calls,0);
  assert.deepEqual(Buffer.from((await client.downloadChatImage("https://www.qvapay.com/storage/a.png")).bytes),png);
});

test("remote images reject oversized bodies, wrong types and HTTP errors", async () => {
  for (const response of [new Response(Buffer.alloc(CHAT_IMAGE_MAX_BYTES+1),{headers:{"content-type":"image/png"}}),new Response(png,{headers:{"content-type":"text/html"}}),new Response(null,{status:302,headers:{location:"http://127.0.0.1"}})]) {
    const client=new QvaPayClient(()=>"secret",{fetch:async()=>response});
    await assert.rejects(client.downloadChatImage("https://www.qvapay.com/storage/a.png"));
  }
});

test("upstream image sends multipart with order, caption and no JSON header", async () => {
  const client=new QvaPayClient(()=>"secret",{fetch:async(url,init)=>{
    assert.equal(String(url),"https://api.qvapay.com/p2p/offer/chat?order=child");
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer secret");
    assert.equal(new Headers(init?.headers).has("content-type"),false);
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("message"),"Recibo");
    assert.equal((init.body.get("file") as File).type,"image/png");
    assert.equal(init?.redirect,"error");
    return new Response(JSON.stringify({message:"image-id"}));
  }});
  assert.equal((await client.sendChat("offer","Recibo","child",{bytes:png,mimeType:"image/png"})).id,"image-id");
});

test("GET preserves images both with captions and without text, including stable distinct fallback IDs", async () => {
  const client=new QvaPayClient(()=>"secret",{fetch:async()=>new Response(JSON.stringify({chat:[
    {peer_id:"peer",message:"Recibo",image:"https://www.qvapay.com/storage/a.png"},
    {peer_id:"peer",image:"https://www.qvapay.com/storage/b.png"},
    {peer_id:"peer",image:"https://www.qvapay.com/storage/c.png"},
  ]}))});
  const messages=await client.listChat("offer");
  assert.equal(messages.length,3);
  assert.equal(messages[0]?.message,"Recibo");
  assert.equal(messages[0]?.image,"https://www.qvapay.com/storage/a.png");
  assert.equal(messages[1]?.message,"📎 Imagen adjunta");
  assert.notEqual(messages[1]?.id,messages[2]?.id);
});
