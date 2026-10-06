import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/http-dashboard.js";

test("cooperative controls require session, CSRF and explicit distribution confirmation",async t=>{
 const calls:string[]=[];
 const app=buildDashboard({setCooperativeHunting:(enabled:boolean)=>{calls.push(`enabled:${enabled}`);},
 markCooperativeDistributed:(uuid:string)=>{calls.push(`distributed:${uuid}`);},checkCooperativeHunting:async()=>{calls.push("check");}} as never,
 {password:"cooperative-test-password-2026",trustedOrigin:"http://127.0.0.1:3000"});
 t.after(()=>app.close());
 const origin="http://127.0.0.1:3000",url="/api/cooperative-network/executions/group/distributed";
 assert.equal((await app.inject({method:"POST",url,payload:{confirmed:true}})).statusCode,401);
 const login=await app.inject({method:"POST",url:"/api/session",headers:{origin},payload:{password:"cooperative-test-password-2026"}});
 const cookie=String(login.headers["set-cookie"]).split(";",1)[0]!;
 assert.equal((await app.inject({method:"POST",url,headers:{origin,cookie},payload:{confirmed:true}})).statusCode,403);
 const headers={origin,cookie,"x-csrf-token":login.json().data.csrfToken};
 assert.equal((await app.inject({method:"POST",url,headers,payload:{confirmed:false}})).statusCode,400);
 assert.equal((await app.inject({method:"POST",url,headers,payload:{confirmed:true}})).statusCode,204);
 assert.equal((await app.inject({method:"PUT",url:"/api/cooperative-network/hunting",headers,payload:{enabled:false}})).statusCode,204);
 assert.deepEqual(calls,["distributed:group","enabled:false"]);
});
