import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { TradingEngine } from "../src/trading.js";
import { MarketConfigService } from "../src/market-config.js";

function setup() {
 const dataDir=mkdtempSync(join(tmpdir(),"qva-coop-capital-")),store=new Store(dataDir);
 const cfg={dataDir,initialUsdFiatBalance:0,buyQusdMaxRate:100,sellQusdMinRate:110,buyQusdUsdMaxRate:1.06,sellQusdUsdMinRate:1.12,
 cupPurchaseMaxQusd:150,maxOpenOwnOffers:10,priceGuardPercent:15,qusdReserve:0,realTradingAllowed:true,autoCancelMs:600000,
 offerRefreshIntervalMs:300000,paymentDetails:{BANK_CUP:[],BANDECPREPAGO:[]}};
 const markets=new MarketConfigService(dataDir,cfg as never,store),next=markets.current();
 next.risk.reviewedAt=Date.now(); next.markets.forEach(m=>{m.active=m.code==="BANK_CUP";}); markets.save(next);
 store.set("fiat_balance:BANK_CUP","1000");store.set("paused","false");store.set("mode","real");
 store.recordMarketObservation({coin:"BANK_CUP",medianSell:100,openOffers:10,eligible:0});
 let applies=0;
 const engine=new TradingEngine(store,{apply:async()=>{applies++;},sendChat:async()=>({}),qusdBalance:async()=>10} as never,cfg as never,markets,async()=>undefined);
 return {store,engine,applies:()=>applies};
}
test("personal buys reserve only cooperative owner's part, not the group's full payment",async t=>{
 const s=setup();t.after(()=>s.store.close());
 s.store.set("cooperative_owner_fiat:group","300");
 s.store.createOperation({uuid:"group",offerType:"sell",coin:"BANK_CUP",amount:20,receive:2000,rate:100,state:"acknowledged",autoApplied:true,cancelAt:null,createdAt:Date.now()});
 await s.engine.ingestMarketOffer({uuid:"personal",type:"sell",coin:"BANK_CUP",amount:6,receive:600,status:"open"});
 assert.equal(s.applies(),1);
 await new Promise(resolve=>setImmediate(resolve));
});
test("in-flight cooperative reservation cannot be spent by a concurrent personal offer",async t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("cooperative_fiat_reserved:BANK_CUP","500");
 const result=await s.engine.ingestMarketOffer({uuid:"personal",type:"sell",coin:"BANK_CUP",amount:6,receive:600,status:"open"});
 assert.equal(s.applies(),0);assert.match(result.action??"",/insuficiente/);
});
test("completed cooperative purchase debits only the owner's share without republishing spent capacity",async t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("cooperative_owner_fiat:group","300");
 s.store.set("cooperative_local_balance:BANK_CUP","1000");
 s.store.createOperation({uuid:"group",offerType:"sell",coin:"BANK_CUP",amount:20,receive:2000,rate:100,state:"acknowledged",autoApplied:true,cancelAt:null,createdAt:Date.now()});
 await s.engine.ingestMarketStateEvent("p2p.completed",{uuid:"group",type:"sell",coin:"BANK_CUP",amount:20,receive:2000,status:"completed"});
 assert.equal(s.store.get("fiat_balance:BANK_CUP"),"700");assert.equal(s.store.get("cooperative_local_balance:BANK_CUP"),"700");
});
test("QUSD owed to participants cannot be sold automatically",async t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("cooperative_qusd_owed","8");
 const result=await s.engine.ingestMarketOffer({uuid:"sell-personal",type:"buy",coin:"BANK_CUP",amount:3,receive:330,status:"open"});
 assert.equal(s.applies(),0);assert.match(result.action??"",/insuficiente/);
});
test("manual own sale creation and expansion cannot spend participants' QUSD",async t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("cooperative_qusd_owed","8");
 s.engine.listOwnOffers=async()=>[];
 await assert.rejects(s.engine.createOwnOffer("BANK_CUP","sell",3,110),/pendiente de repartir/);
 s.engine.listOwnOffers=async()=>[{uuid:"own-sale",coin:"BANK_CUP",type:"sell",amount:5,receive:550,status:"open"}];
 await assert.rejects(s.engine.editOwnOffer("own-sale",8,110),/pendiente de repartir/);
});
test("cooperative hunting cannot bypass simulation mode",t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("mode","simulation");
 assert.match(s.engine.cooperativeSafetyReason({uuid:"group",coin:"BANK_CUP",type:"sell",amount:10,receive:1000,status:"open"})??"",/detenido/);
});

for (const type of ["buy", "sell"] as const) {
 test(`una oferta ${type} cancelada no mueve fiat cuando otra persona la paga o completa`,async t=>{
  const s=setup();t.after(()=>s.store.close());
  s.store.set("analytics_account_uuid","me");
  s.store.createOperation({uuid:"old-cancelled",offerType:type,coin:"BANK_CUP",amount:10,receive:1000,rate:100,state:"cancelled",autoApplied:true,cancelAt:null,createdAt:Date.now()-10000});
  for(const event of ["p2p.paid","p2p.completed"] as const) await s.engine.ingestMarketStateEvent(event,{uuid:"old-cancelled",type,coin:"BANK_CUP",amount:10,receive:1000,status:event==="p2p.paid"?"paid":"completed",User:{uuid:"seller"},Peer:{uuid:"someone-else"}});
  assert.equal(s.store.get("fiat_balance:BANK_CUP"),"1000");
  assert.equal(s.store.hasFiatMovement("old-cancelled"),false);
  assert.equal(s.store.getOperation("old-cancelled")?.state,"cancelled");
 });
}

test("un peer diferente no completa ni contabiliza una operación local activa",async t=>{
 const s=setup();t.after(()=>s.store.close());s.store.set("analytics_account_uuid","me");
 s.store.createOperation({uuid:"changed-peer",offerType:"sell",coin:"BANK_CUP",amount:10,receive:1000,rate:100,state:"acknowledged",autoApplied:true,cancelAt:null,createdAt:Date.now()});
 await s.engine.ingestMarketStateEvent("p2p.completed",{uuid:"changed-peer",type:"sell",coin:"BANK_CUP",amount:10,receive:1000,status:"completed",User:{uuid:"seller"},Peer:{uuid:"someone-else"}});
 assert.equal(s.store.get("fiat_balance:BANK_CUP"),"1000");
 assert.equal(s.store.getOperation("changed-peer")?.state,"acknowledged");
});

for (const personalDirection of ["debit","credit"] as const) {
 test(`el pago conjunto conserva un ${personalDirection} personal aún no sincronizado`,async t=>{
  const s=setup();t.after(()=>s.store.close());
  s.store.set("cooperative_owner_fiat:group","300");
  s.store.set("cooperative_local_balance:BANK_CUP","1000");
  s.store.createOperation({uuid:"group",offerType:"sell",coin:"BANK_CUP",amount:20,receive:2000,rate:100,state:"acknowledged",autoApplied:true,cancelAt:null,createdAt:Date.now()});
  s.store.recordFiatMovement("personal","BANK_CUP",personalDirection,100,"Operación personal");
  for(const event of ["p2p.paid","p2p.completed"] as const) await s.engine.ingestMarketStateEvent(event,{uuid:"group",type:"sell",coin:"BANK_CUP",amount:20,receive:2000,status:event==="p2p.paid"?"paid":"completed"});
  assert.equal(s.store.get("cooperative_local_balance:BANK_CUP"),"700","la base solo descuenta los 300 ya reservados, sin absorber movimientos personales");
  assert.equal(s.store.get("fiat_balance:BANK_CUP"),personalDirection==="debit"?"600":"800");
  assert.equal(s.store.recentFiat("BANK_CUP",10).filter(row=>row.uuid==="group").length,1);
 });
}

test("una declaración manual no vuelve a descontar una orden antigua descubierta después",async t=>{
 const s=setup();t.after(()=>s.store.close());
 s.store.createOperation({uuid:"old-range",orderUuid:"child",offerType:"sell",coin:"BANK_CUP",amount:3,receive:300,rate:100,state:"applied",autoApplied:true,cancelAt:null,createdAt:Date.now()-10000});
 s.engine.setFiatBalance("BANK_CUP",1);
 (s.engine as unknown as {qva:unknown}).qva={getOffer:async()=>({uuid:"old-range",type:"sell",coin:"BANK_CUP",amount:3,receive:300,status:"completed",offer_kind:"flexible",updated_at:new Date(Date.now()-5000).toISOString(),Orders:[{uuid:"child",amount:3,receive:300,status:"completed",Taker:{uuid:"me"},updated_at:new Date(Date.now()-5000).toISOString()}]})};
 await s.engine.syncRemoteOperations();
 assert.equal(s.store.getOperation("old-range")?.state,"completed");
 assert.equal(s.engine.fiatBalance("BANK_CUP"),1);
 await s.engine.syncRemoteOperations();assert.equal(s.engine.fiatBalance("BANK_CUP"),1);
});

test("la cacería conjunta no gasta la reserva de una aplicación individual aún sin respuesta",t=>{
 const s=setup();t.after(()=>s.store.close());
 s.store.createMutationIntent({intentId:"personal-pending",kind:"apply",operationUuid:"personal",request:{capitalReserve:{coin:"BANK_CUP",fiat:900,qusd:0,amount:9}}});
 s.store.set("cooperative_fiat_reserved:BANK_CUP","200");
 assert.equal(s.engine.cooperativeOwnCapacity("BANK_CUP",200),false);
});

test("las participaciones de otra cuenta reservan, liquidan una vez y no se reembolsan al liberar", async t=>{
 const s=setup();t.after(()=>s.store.close());
 const row={cursor:1,external_id:"third-party",coin:"BANK_CUP",fiat:300,state:"reserved" as const,created_at:Date.now()};
 s.store.set("cooperative_local_balance:BANK_CUP","1000");
 s.store.recordCooperativeParticipations([row],()=>0);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),1000);
 assert.equal(s.store.cooperativeParticipantReserved("BANK_CUP"),300);
 await s.engine.ingestMarketOffer({uuid:"too-large",type:"sell",coin:"BANK_CUP",amount:8,receive:800,status:"open"});
 assert.equal(s.applies(),0);
 s.store.recordCooperativeParticipations([{...row,state:"completed"}],()=>0);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),700);
 assert.equal(s.store.get("cooperative_local_balance:BANK_CUP"),"700");
 assert.equal(s.store.cooperativeParticipantReserved("BANK_CUP"),0);
 s.store.recordCooperativeParticipations([{...row,state:"completed"}],()=>0);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),700);
 const released={...row,cursor:2,external_id:"released",state:"released" as const};
 s.store.recordCooperativeParticipations([released],()=>0);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),700);
 assert.equal(s.store.get("cooperative_participation_cursor"),"2");
});

test("importar participaciones históricas respeta el saldo manual y revierte el lote inválido",t=>{
 const s=setup();t.after(()=>s.store.close());s.engine.setFiatBalance("BANK_CUP",1);
 const row={cursor:1,external_id:"historical",coin:"BANK_CUP",fiat:300,state:"completed" as const,created_at:Date.now()-10000};
 s.store.recordCooperativeParticipations([row],()=>0);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),1);
 assert.equal(s.store.hasFiatMovement("cooperative:historical"),true);
 assert.throws(()=>s.store.recordCooperativeParticipations([{...row,cursor:2,external_id:"valid",created_at:Date.now()+1000},{...row,fiat:400}],()=>0),/cambió/);
 assert.equal(s.engine.fiatBalance("BANK_CUP"),1);
 assert.equal(s.store.hasFiatMovement("cooperative:valid"),false);
});

test("la capacidad individual publicada no se descuenta otra vez al registrar su pago", async t=>{
 const s=setup();t.after(()=>s.store.close());
 s.store.createOperation({uuid:"personal-reserved",offerType:"sell",coin:"BANK_CUP",amount:3,receive:300,rate:100,state:"applied",autoApplied:true,cancelAt:null,createdAt:Date.now()});
 assert.equal(s.engine.cooperativeSyncFiat("BANK_CUP"),700);
 await s.engine.ingestMarketStateEvent("p2p.paid",{uuid:"personal-reserved",type:"sell",coin:"BANK_CUP",amount:3,receive:300,status:"paid"});
 assert.equal(s.engine.fiatBalance("BANK_CUP"),700);
 assert.equal(s.engine.cooperativeSyncFiat("BANK_CUP"),700);
});
