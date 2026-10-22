import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { Store } from './store.js';
import type { P2pOffer } from './types.js';
import { sizeFlexibleOffer } from './flexible-order.js';
import { outgoingFiatCost } from './market-math.js';

export interface PriceSimulationInput {coin:string;hours:number;buyMaxRate:number;sellMinRate:number;maxQusd:number}
export async function simulatePrices(store:Store,input:PriceSimulationInput,current:{buyMaxRate:number;sellMinRate:number;outgoingTransferFee:number},now=Date.now()){
 if(![1,24,168].includes(input.hours)||![input.buyMaxRate,input.sellMinRate,input.maxQusd].every(n=>Number.isFinite(n)&&n>0&&n<=1e9))throw new Error('Introduce tasas e importe positivos y un período de 1, 24 o 168 horas.');
 const account=store.get('analytics_account_uuid');
 if(!account)throw new Error('Todavía no hay una cuenta identificada para excluir las ofertas propias.');
 const own=new Set((store.loadRemoteResource<Array<{uuid:string}>>('own-offers')?.data??[]).map(o=>o.uuid));
 const seen=new Set<string>();
 const counts={observations:0,own:0,stale:0,invalid:0,rangeOrAmount:0};
 const baseline={buy:0,sell:0,buyQusd:0,sellQusd:0};
 const proposed={...baseline};
 let scanned=0,cursor:{at:number;key:string}|undefined,oldest=now,truncated=false;
 const since=now-input.hours*3_600_000;
 while(scanned<5000){
  await yieldTurn();
  const rows=store.simulationObservations(since,cursor,250);
  if(!rows.length)break;
  for(const row of rows){
   scanned++;oldest=row.at;cursor={at:row.at,key:row.key};
   try{
    const payload=JSON.parse(row.payload) as {sent_at:string;data:Record<string,unknown>};
    const raw=payload.data;
    if(!raw||raw.coin!==input.coin||typeof raw.uuid!=='string')continue;
    counts.observations++;
    if(seen.has(raw.uuid))continue;
    seen.add(raw.uuid);
    const user=raw.User as {uuid?:string}|undefined;
    if(raw.owner_uuid===account||user?.uuid===account||own.has(raw.uuid)){counts.own++;continue;}
    const published=Date.parse(payload.sent_at);
    if(!Number.isFinite(published)||Math.abs(row.at-published)>5000){counts.stale++;continue;}
    const amount=Number(raw.amount),receive=Number(raw.receive);
    if(raw.status!=='open'||!['buy','sell'].includes(String(raw.type))||!Number.isFinite(amount)||!Number.isFinite(receive)||!Number.isFinite(receive/amount)||amount<=0||receive<=0){counts.invalid++;continue;}
    const offer={...raw,uuid:raw.uuid,coin:input.coin,amount,receive} as unknown as P2pOffer;
    const sized=offer.offer_kind==='flexible'?sizeFlexibleOffer(offer,input.maxQusd,input.maxQusd):amount<=input.maxQusd?offer:undefined;
    if(!sized){counts.rangeOrAmount++;continue;}
    const side=offer.type==='sell'?'buy':'sell';
    const effective=side==='buy'?outgoingFiatCost(sized.amount,sized.receive/sized.amount,current.outgoingTransferFee).effectiveRate:sized.receive/sized.amount;
    if(side==='buy'?effective<=current.buyMaxRate:effective>=current.sellMinRate){baseline[side]++;baseline[`${side}Qusd`]+=sized.amount;}
    if(side==='buy'?effective<=input.buyMaxRate:effective>=input.sellMinRate){proposed[side]++;proposed[`${side}Qusd`]+=sized.amount;}
   }catch{counts.invalid++;}
  }
  if(rows.length<250)break;
 }
 if(scanned===5000)truncated=store.simulationObservations(since,cursor,1).length>0;
 return {...input,generatedAt:now,since,coverageSince:truncated?oldest:since,truncated,scanned,uniqueOffers:seen.size,counts,baseline,proposed,
  assumptions:{outgoingTransferFee:current.outgoingTransferFee,currentBuyMaxRate:current.buyMaxRate,currentSellMinRate:current.sellMinRate},
  note:'Comparación de precios sobre la última observación de cada oferta. Usa QUSD brutos, comisión fiat actual y límites por rango; no comprueba saldo histórico, cupos, requisitos ni disponibilidad posterior. No garantiza capturas ni modifica tus límites.'};
}
