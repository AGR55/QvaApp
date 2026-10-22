import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';
import { OperationalHealthMonitor, opportunityDiagnostics, opportunityReason } from '../src/operational-insights.js';
import { NotificationDispatcher, type NotificationInput } from '../src/notification-dispatcher.js';
import type { MarketSourceStatus } from '../src/market-source.js';
import { buildDashboard } from '../src/http-dashboard.js';

const temporary=()=>mkdtempSync(join(tmpdir(),'qva-insights-'));

test('historial captura declaraciones, créditos y débitos idempotentes sin cambiar el saldo',t=>{
 const store=new Store(temporary());t.after(()=>store.close());
 store.set('fiat_balance:CLASICA','100');
 store.set('fiat_balance:CLASICA','50');
 store.recordFiatMovement('first','CLASICA','debit',10,'Pago confirmado');
 store.recordFiatMovement('second','CLASICA','credit',5,'Cobro confirmado');
 assert.equal(store.recordFiatMovement('first','CLASICA','debit',10,'Duplicado'),false);
 assert.equal(store.get('fiat_balance:CLASICA'),'45');
 const items=store.fiatBalanceHistory('CLASICA').items;
 assert.equal(items.length,4);
 assert.deepEqual(items.find(x=>x.uuid==='first'),{id:items.find(x=>x.uuid==='first')!.id,coin:'CLASICA',before:50,after:40,amount:-10,uuid:'first',source:'Pago confirmado',kind:'movement',createdAt:items.find(x=>x.uuid==='first')!.createdAt});
 assert.equal(items.find(x=>x.kind==='declaration')?.before,100);
 assert.equal(store.fiatBalanceHistory('BANK_CUP').items.length,0);
 assert.equal(store.fiatBalanceHistory('CLASICA',1,2).hasMore,true);
 assert.equal(store.fiatBalanceHistory('CLASICA',2,2).items.length,2);
});

test('backfill informa su importe sin alterar el saldo declarado',t=>{
 const store=new Store(temporary());t.after(()=>store.close());
 store.set('fiat_balance:CLASICA','1');store.set('fiat_balance_declared_at:CLASICA',String(Date.now()));
 store.recordFiatMovement('old-order','CLASICA','debit',300,'Operación anterior',Date.now()-60_000);
 const row=store.fiatBalanceHistory('CLASICA').items.find(x=>x.uuid==='old-order')!;
 assert.equal(row.kind,'historical');assert.equal(row.before,1);assert.equal(row.after,1);assert.equal(row.amount,-300);
 assert.equal(store.get('fiat_balance:CLASICA'),'1');
});

test('migración v28 preserva operaciones antiguas sin inventar sus saldos',t=>{
 const dir=temporary();const first=new Store(dir);first.close();
 const db=new DatabaseSync(join(dir,'qvaapply.sqlite'));
 db.exec('DROP TRIGGER fiat_history_insert; DROP TRIGGER fiat_history_update; DROP TABLE fiat_balance_history; DELETE FROM schema_migrations WHERE version>=29;');
 db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('fiat_balance:CLASICA','50');
 db.prepare('INSERT INTO fiat_ledger(operation_uuid,direction,amount,source,created_at,coin) VALUES(?,?,?,?,?,?)').run('legacy','debit',10,'Anterior',Date.now()-1000,'CLASICA');db.close();
 const store=new Store(dir);t.after(()=>store.close());
 const items=store.fiatBalanceHistory('CLASICA').items;
 assert.equal(items.length,2);assert.equal(items.find(x=>x.kind==='legacy')?.before,null);
 assert.equal(items.find(x=>x.kind==='opening')?.after,50);assert.equal(store.get('fiat_balance:CLASICA'),'50');
});

test('diagnóstico separa observaciones, aplicaciones remotas y solicitudes no enviadas',async t=>{
 const store=new Store(temporary());t.after(()=>store.close());
 for(const [uuid,coin,reason] of [['a','CLASICA','La tasa flexible no cumple el objetivo'],['a','CLASICA','Saldo insuficiente'],['b','BANK_CUP','mercado o cacería inactivos'],['c','CLASICA','aplicada c']])
  store.audit('market_feed_processed',`Evento p2p.range_updated de oferta ${uuid} (${coin}) procesado desde el feed: ${reason}.`,uuid);
 const now=Date.now();
 for(const [uuid,dispatched,outcome] of [['c',now-10,'confirmed'],['a',null,'LOCAL_APPLY_QUOTA']] as const)
  store.audit('offer_apply_timing',JSON.stringify({dispatchedAt:dispatched,finishedAt:now,outcome}),uuid);
 const report=await opportunityDiagnostics(store,24,'CLASICA');
 assert.equal(report.observations,3);assert.equal(report.uniqueOffers,2);
 assert.equal(report.applications.sent,1);assert.equal(report.applications.confirmed,1);assert.equal(report.applications.notSent,1);
 assert.deepEqual(report.reasons.map(r=>r.code).sort(),['capital','price']);
 assert.equal(opportunityReason('Cotización del feed antigua (>5 s)'), 'stale');
});

test('salud confirma incidentes y recuperación, sin duplicar tras reiniciar ni pausar cacerías',async t=>{
 const store=new Store(temporary());t.after(()=>store.close());let now=Date.now();
 const sent:NotificationInput[]=[];const notify=async(input:NotificationInput)=>{sent.push(input);};
 const monitor=new OperationalHealthMonitor(store,notify,()=>now);
 const source={mode:'hybrid',healthyAccounts:1,lastWebhookReceivedAt:now} as MarketSourceStatus;
 const input={source,markets:[],paused:false};
 await monitor.check(input);now+=360_000;
 await monitor.check(input);assert.equal(sent.length,0);
 await monitor.check(input);assert.equal(sent.length,1);
 await monitor.check(input);assert.equal(sent.length,1);
 const restarted=new OperationalHealthMonitor(store,notify,()=>now);
 await restarted.check(input);now+=120_000;await restarted.check(input);
 assert.equal(sent.length,1);
 source.lastWebhookReceivedAt=now;
 await restarted.check(input);await restarted.check(input);assert.equal(sent.length,2);
 assert.match(sent[1]!.message,/recuperado/);
 assert.equal(store.get('paused'),undefined);
});

test('los avisos de salud usan la cola durable de Telegram',async t=>{
 const store=new Store(temporary());t.after(()=>store.close());let calls=0;
 const dispatcher=new NotificationDispatcher(store,{telegram:async()=>{calls++;},webPush:async()=>undefined});
 const input={message:'Aviso de salud',event:{kind:'system-health' as const,uuid:'health:feed:1'}};
 await dispatcher.publish(input);await dispatcher.publish(input);
 assert.equal(calls,1);assert.equal(store.pendingUserNotifications()[0]?.kind,'system-health');
});

test('API de informes exige sesión y valida mercado, período y paginación',async t=>{
 const calls:string[]=[];
 const readModel={config:()=>({markets:[{code:'CLASICA'}]}),opportunityDiagnostics:async()=>{calls.push('diagnostics');return {};},operationalHealth:()=>null,fiatHistory:()=>({items:[]})};
 const origin='http://127.0.0.1:3000';const app=buildDashboard(readModel as never,{password:'test-insights-password',trustedOrigin:origin});t.after(()=>app.close());
 for(const url of ['/api/operational-health','/api/hunting/diagnostics','/api/fiat-history?coin=CLASICA'])assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/api/session',headers:{origin},payload:{password:'test-insights-password'}});
 const cookie=String(login.headers['set-cookie']).split(';')[0]!;
 for(const url of ['/api/hunting/diagnostics?hours=2','/api/hunting/diagnostics?coin=OTHER','/api/fiat-history?coin=CLASICA&page=-1'])assert.equal((await app.inject({method:'GET',url,headers:{cookie}})).statusCode,400);
 assert.equal(calls.length,0);
 assert.equal((await app.inject({method:'GET',url:'/api/hunting/diagnostics?coin=CLASICA&hours=24',headers:{cookie}})).statusCode,200);
 assert.equal(calls.length,1);
});

test('el informe limita la cobertura y cede el turno entre lotes',async()=>{
 const now=Date.now();let calls=0;let yielded=false;
 const fake={insightAudit:(_since:number,before:number,limit:number)=>{
  calls++;return Array.from({length:Math.min(limit,Math.max(0,Math.min(6001,before)-1))},(_,i)=>{
   const id=Math.min(6001,before)-i-1;return {id,createdAt:now-(6000-id),action:'market_feed_processed',uuid:String(id),detail:`Evento p2p.created de oferta ${id} (CLASICA) procesado desde el feed: La tasa no cumple el objetivo.`};
  });
 },getOperation:()=>undefined};
 const work=opportunityDiagnostics(fake as never,24,undefined,now);
 setImmediate(()=>{yielded=true;});
 const report=await work;
 assert.equal(report.observations,5000);assert.equal(report.truncated,true);assert.equal(calls,21);assert.equal(yielded,true);assert.ok(report.coverageSince>report.since);
});
