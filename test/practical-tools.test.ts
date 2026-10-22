import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Store} from '../src/store.js';
import {buildTradingAnalytics} from '../src/trading-analytics.js';
import {simulatePrices} from '../src/price-simulation.js';
import {NotificationDispatcher} from '../src/notification-dispatcher.js';
import {queueNotice} from '../web/lib/notification-queue.js';
import {buildDashboard} from '../src/http-dashboard.js';
const temp=()=>mkdtempSync(join(tmpdir(),'qva-practical-'));
const now=Date.now();
const buy={uuid:'buy',coin:'CLASICA',amount:10,receive:10,side:'incoming' as const,completedAt:now-10000};
const sell={uuid:'sell',coin:'CLASICA',amount:9,receive:12,side:'outgoing' as const,completedAt:now-1000};
const markets=[{code:'CLASICA',label:'Clásica',currency:'USD'}];

test('FIFO documentado usa QUSD netos y fiat con comisión, conserva pérdidas y estimaciones',()=>{
 const input={accountUuid:'me',transactions:[],offers:[buy,sell],fiat:[{uuid:'buy',direction:'debit',amount:10.08},{uuid:'sell',direction:'credit',amount:12}],fees:[{uuid:'buy',grossQusd:10,feeQusd:1,evidence:'Comprobante bruto 10, neto 9',version:1,updatedAt:now}],markets,days:7,now};
 const result=buildTradingAnalytics(input).markets[0]!;
 assert.ok(Math.abs(result.documentedProfit-1.92)<1e-8);assert.equal(result.documentedMatchedQusd,9);assert.equal(result.unmatchedSoldQusd,0);
 assert.equal(buildTradingAnalytics({...input,fees:[]}).markets[0]!.documentedMatchedQusd,0);
 assert.equal(buildTradingAnalytics({...input,fiat:[]}).markets[0]!.documentedMatchedQusd,0);
 assert.equal(buildTradingAnalytics({...input,fees:[{...input.fees[0]!,grossQusd:11}]}).markets[0]!.documentedMatchedQusd,0);
 assert.equal(buildTradingAnalytics({...input,fiat:[{...input.fiat[0]!,amount:5},input.fiat[1]!]}).markets[0]!.documentedMatchedQusd,0,'un aporte parcial no documenta el coste de toda la compra');
 const partial=buildTradingAnalytics({...input,fiat:[{...input.fiat[0]!,amount:5},input.fiat[1]!]});
 assert.equal(partial.coverage.partialPurchaseQusd,10);assert.equal(partial.markets[0]!.estimatedProfit,0);
 const loss=buildTradingAnalytics({...input,fiat:[input.fiat[0]!,{...input.fiat[1]!,amount:8}]}).markets[0]!.documentedProfit;
 assert.ok(Math.abs(loss+2.08)<1e-8);
});

test('evidencia exige compra completada propia, versión y pruebas; no toca saldos',t=>{
 const store=new Store(temp());t.after(()=>store.close());store.saveAnalyticsOffers('me',[buy,sell]);store.set('fiat_balance:CLASICA','1');
 store.recordAnalyticsFee('me','buy',0.025,'Comprobante: bruto 10 y neto 9.975',0);
 assert.equal(store.analyticsFees('me')[0]?.version,1);assert.equal(store.get('fiat_balance:CLASICA'),'1');assert.equal(store.activeOperations().length,0);
 assert.throws(()=>store.recordAnalyticsFee('other','buy',0,'Comprobante de otra cuenta',0),/cuenta/);
 assert.throws(()=>store.recordAnalyticsFee('me','sell',0,'Comprobante de una venta',0),/compra/);
 assert.throws(()=>store.recordAnalyticsFee('me','buy',10,'Comprobante bruto igual a comisión',1),/comisión/);
 assert.throws(()=>store.recordAnalyticsFee('me','buy',0,'corto',1),/evidencia/);
 assert.throws(()=>store.recordAnalyticsFee('me','buy',0,'Comprobante actualizado sin comisión',0),/cambió/);
 store.recordAnalyticsFee('me','buy',0,'Comprobante: exención y neto igual al bruto',1);
 assert.equal(store.analyticsFeePurchases('me').items[0]?.version,2);assert.equal(store.analyticsFees('other').length,0);
});

function event(store:Store,id:string,fields:Record<string,unknown>,at=now){
 store.enqueueMarketFeedEvent({key:id,event:'p2p.range_updated',receivedAt:at,payload:{event:'p2p.range_updated',sent_at:new Date(at).toISOString(),data:{uuid:id,coin:'CLASICA',type:'sell',status:'open',amount:10,receive:10,...fields}}});
}
test('simulación deduplica, descuenta comisión fiat, respeta rangos y no cambia cacerías',async t=>{
 const store=new Store(temp());t.after(()=>store.close());store.set('analytics_account_uuid','me');store.set('paused','false');
 event(store,'fixed',{});event(store,'updated',{uuid:'fixed',receive:11},now+1);
 event(store,'range',{offer_kind:'flexible',available_amount:8,order_min:2,order_max:5});
 event(store,'too-large',{amount:100,receive:100});event(store,'own',{owner_uuid:'me'});
 event(store,'late',{},now-10000);
 // A delayed delivery must not become an eligible historical quote.
 store.enqueueMarketFeedEvent({key:'actually-late',event:'p2p.created',receivedAt:now,payload:{event:'p2p.created',sent_at:new Date(now-10000).toISOString(),data:{uuid:'late-fresh-delivery',coin:'CLASICA',type:'sell',status:'open',amount:10,receive:10}}});
 const report=await simulatePrices(store,{coin:'CLASICA',hours:24,buyMaxRate:1.2,sellMinRate:1.1,maxQusd:10},{buyMaxRate:1,sellMinRate:1.1,outgoingTransferFee:0.08},now+2);
 assert.equal(report.baseline.buy,0);assert.equal(report.proposed.buy,3);assert.equal(report.counts.own,1);assert.equal(report.counts.stale,1);assert.equal(report.counts.rangeOrAmount,1);
 assert.equal(store.get('paused'),'false');assert.equal(store.activeOperations().length,0);
 assert.equal(report.assumptions.outgoingTransferFee,0.08);
});

test('resumen agrupa solo información, prioriza pagos y sobrevive a reintentos',async t=>{
 const store=new Store(temp());t.after(()=>store.close());let tick=1000;const delivered:string[]=[];let fail=true;
 const runtime={telegram:async()=>undefined,webPush:async(item:{kind:string})=>{delivered.push(item.kind);if(item.kind==='informational-summary'&&fail)throw new Error('sin red');}};
 let dispatcher=new NotificationDispatcher(store,runtime,()=>tick);
 await dispatcher.publish({message:'Reajuste uno',event:{kind:'rebalance-completed',uuid:'one'}});
 await dispatcher.publish({message:'Reajuste dos',event:{kind:'rebalance-completed',uuid:'two'}});
 assert.equal(delivered.length,0);assert.equal(store.pendingUserNotifications().length,0);
 tick=31000;await dispatcher.publish({message:'Pago pendiente',event:{kind:'operation-applied',uuid:'payment'}});
 assert.deepEqual(delivered,['operation-applied','informational-summary']);
 const notices=store.pendingUserNotifications();assert.equal(notices[0]?.kind,'operation-applied');
 const summary=notices.find(item=>item.kind==='informational-summary')!;
 assert.deepEqual(summary.payload.sourceIds,['rebalance-completed:one','rebalance-completed:two']);
 assert.match(summary.message,/2 aviso/);
 fail=false;tick+=20000;dispatcher=new NotificationDispatcher(store,runtime,()=>tick);await dispatcher.deliverDue();
 assert.equal(store.pendingNotificationDeliveries(tick).length,0);assert.equal(delivered.filter(x=>x==='operation-applied').length,1);
 assert.equal(delivered.filter(x=>x==='informational-summary').length,2);
});

test('cola visual acotada preserva la prioridad y permite reintentar avisos desplazados',()=>{
 const queue=[{id:'info',type:'informational-summary'},{id:'health',type:'system-health'}];
 const result=queueNotice(queue,{id:'payment',type:'operation-applied'},2);
 assert.equal(result.queued,true);assert.equal(result.evicted?.id,'info');assert.equal(queue[0]?.id,'payment');assert.equal(queue.length,2);
 assert.equal(queueNotice(queue,{id:'info-two',type:'informational-summary'},2).queued,false);
 assert.equal(queueNotice(queue,{id:'payment',type:'operation-applied'},2).queued,false);
});

test('API de simulación y comisiones exige sesión y CSRF y valida la entrada',async t=>{
 const calls:string[]=[];const origin='http://127.0.0.1:3000';
 const app=buildDashboard({simulatePrices:async()=>{calls.push('simulation');return {};},recordAnalyticsFee:()=>{calls.push('fee');return {};},analyticsFeePurchases:()=>({items:[]})} as never,{password:'practical-tests-password',trustedOrigin:origin});t.after(()=>app.close());
 assert.equal((await app.inject({method:'GET',url:'/api/analytics/fees'})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin},payload:{password:'practical-tests-password'}});
 const cookie=String(login.headers['set-cookie']).split(';')[0]!,csrf=login.json().data.csrfToken;
 const payload={coin:'CLASICA',hours:24,buyMaxRate:1,sellMinRate:1.1,maxQusd:25};
 assert.equal((await app.inject({method:'POST',url:'/api/hunting/simulate',headers:{origin,cookie},payload})).statusCode,403);
 const headers={origin,cookie,'x-csrf-token':csrf};
 assert.equal((await app.inject({method:'POST',url:'/api/hunting/simulate',headers,payload:{...payload,maxQusd:-1}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/api/hunting/simulate',headers,payload})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/analytics/fees',headers,payload:{uuid:'buy',feeQusd:0,evidence:'Comprobante sin comisión',expectedVersion:0}})).statusCode,200);
 assert.deepEqual(calls,['simulation','fee']);
});

test('un resumen con red bloqueada no retiene el aviso de una nueva operación',async t=>{
 const store=new Store(temp());t.after(()=>store.close());let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const telegram:string[]=[],push:string[]=[];
 const dispatcher=new NotificationDispatcher(store,{telegram:async item=>{telegram.push(item.kind);},webPush:async item=>{push.push(item.kind);if(item.kind==='informational-summary')await blocked;}},()=>31000);
 store.enqueueNotification({id:'info',kind:'rebalance-completed',message:'Reajuste',payload:{},createdAt:1000});
 const background=dispatcher.deliverDue();
 try{
  await new Promise(resolve=>setImmediate(resolve));
  await dispatcher.publish({message:'Nueva operación',event:{kind:'operation-applied',uuid:'urgent'}},{waitForDelivery:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(telegram,['operation-applied']);assert.deepEqual(push,['informational-summary','operation-applied']);
 }finally{release();await background;}
 assert.equal(push.filter(kind=>kind==='operation-applied').length,1);
});
