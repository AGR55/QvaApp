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
