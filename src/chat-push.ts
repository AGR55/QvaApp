import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Store } from "./store.js";

export interface ChatPushMessage {
  id:string; uuid:string; orderUuid?:string; threadId:string; messageId:string;
  operatorId?:string; title:string; body:string; sender:string; createdAt:number;
}
export class PushTokenExpired extends Error {}

/** Small HTTP-v1 client: no Firebase admin runtime or additional QvaPay requests. */
export class FirebaseChatPush {
  private accessToken = "";
  private expiresAt = 0;
  private readonly key: KeyObject;
  private readonly email: string;
  private readonly project: string;
  constructor(credentialsFile:string, private readonly fetchImpl = fetch, private readonly now = Date.now) {
    const credentials = JSON.parse(readFileSync(credentialsFile,"utf8")) as Record<string,unknown>;
    if (credentials.type !== "service_account" || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string" ||
      typeof credentials.project_id !== "string" || !/^[a-z0-9-]+$/.test(credentials.project_id)) throw new Error("Credencial FCM inválida.");
    this.email=credentials.client_email; this.project=credentials.project_id; this.key=createPrivateKey(credentials.private_key);
  }
  private async token():Promise<string> {
    if(this.accessToken && this.expiresAt>this.now()+60_000) return this.accessToken;
    const issued=Math.floor(this.now()/1000);
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
    const body=`${encode({alg:"RS256",typ:"JWT"})}.${encode({iss:this.email,scope:"https://www.googleapis.com/auth/firebase.messaging",aud:"https://oauth2.googleapis.com/token",iat:issued,exp:issued+3600})}`;
    const assertion=`${body}.${sign("RSA-SHA256",Buffer.from(body),this.key).toString("base64url")}`;
    const response=await this.fetchImpl("https://oauth2.googleapis.com/token",{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
      headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion})});
    if(!response.ok) throw new Error(`Autenticación FCM rechazada (${response.status}).`);
    const data=await response.json() as {access_token?:string;expires_in?:number};
    if(!data.access_token) throw new Error("FCM no devolvió acceso.");
    this.accessToken=data.access_token; this.expiresAt=this.now()+Math.min(data.expires_in??3600,3600)*1000;
    return this.accessToken;
  }
  async send(token:string, message:ChatPushMessage):Promise<void> {
    const data = Object.fromEntries(Object.entries({...message,orderUuid:message.orderUuid??""}).map(([key,value])=>[key,String(value)]));
    // Data-only message is displayed immediately by FirebaseMessagingService,
    // including when the activity is closed, with durable local deduplication.
    const response=await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.project}/messages:send`,{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),headers:{authorization:`Bearer ${await this.token()}`,"content-type":"application/json"},
      body:JSON.stringify({message:{token,data,android:{priority:"HIGH",ttl:"86400s",restricted_package_name:"com.qvaapply.sms"}}}),
    });
    if(response.ok) return;
    const error=await response.json().catch(()=>({})) as {error?:{details?:{errorCode?:string}[]}};
    if(error.error?.details?.some(detail=>detail.errorCode==="UNREGISTERED")) throw new PushTokenExpired();
    if(response.status===401) { this.accessToken=""; this.expiresAt=0; }
    throw new Error(`FCM no confirmó el aviso (${response.status}).`);
  }
}

export class ChatPushDispatcher {
  private running=false;
  constructor(private readonly store:Store, private readonly dependencies:{
    native?:{send(token:string,message:ChatPushMessage):Promise<void>} | undefined;
    web:{notifyChat(message:ChatPushMessage):Promise<void>};
    operatorActive:(id:string)=>boolean;
  },private readonly now=Date.now) {}
  async drain():Promise<void> {
    if(this.running) return;
    this.running=true;
    try {
      const devices=this.store.chatPushDevices().filter(device=>{
        if(this.dependencies.operatorActive(device.operatorId)) return true;
        this.store.removeChatPushDevice(device.operatorId); return false;
      });
      for(const event of this.store.pendingChatPush<ChatPushMessage>(this.now())) {
        let alreadyRead=false;
        try { alreadyRead=(JSON.parse(this.store.get(`operation-chat-read:${event.threadId}`)??"[]") as string[]).includes(event.payload.messageId); } catch { /* Invalid read state is not proof of reading. */ }
        if(alreadyRead) {this.store.finishChatPush(event.id,true,true,event.attempts,0);continue;}
        let complete=true, webDelivered=event.webDelivered;
        if(!webDelivered) {
          try { await this.dependencies.web.notifyChat(event.payload); webDelivered=true; } catch { complete=false; }
        }
        for(const device of devices) {
          const hash=createHash("sha256").update(device.token).digest("hex");
          if(this.store.chatPushDelivered(event.id,hash)) continue;
          if(!this.dependencies.native) { complete=false; continue; }
          try { await this.dependencies.native.send(device.token,{...event.payload,operatorId:device.operatorId}); this.store.markChatPushDelivered(event.id,hash); }
          catch(error) {
            if(error instanceof PushTokenExpired) this.store.removeChatPushDevice(device.operatorId);
            else complete=false;
          }
        }
        const attempts=event.attempts+1;
        this.store.finishChatPush(event.id,webDelivered,complete,attempts,this.now()+Math.min(300_000,2000*2**Math.min(attempts,7)));
      }
    } finally {this.running=false;}
  }
}
