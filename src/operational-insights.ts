import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Store } from "./store.js";
import type { MarketSourceStatus } from "./market-source.js";
import type { NotificationInput } from "./notification-dispatcher.js";

const REASON_LABELS: Record<string,string> = {
  price:"Precio o comisión fuera del objetivo", capital:"Saldo o límites insuficientes", inactive:"Cacería desactivada o pausada",
  stale:"Observación antigua", own:"Oferta propia", previous:"Operación previa o ya evaluada", unavailable:"Oferta no disponible",
  safety:"Requisitos o protección de la operación", other:"Otros motivos",
};
export function opportunityReason(text:string):string {
  if (/antigua|>5 s|fresca|vencid/i.test(text)) return "stale";
  if (/propia/i.test(text)) return "own";
  if (/inactiv|detenid|pausad|emergencia/i.test(text)) return "inactive";
  if (/saldo|capital|límites|cupo|mínimo de la orden/i.test(text)) return "capital";
  if (/tasa|precio|comisión|objetivo/i.test(text)) return "price";
  if (/previa|ya evaluada|en curso|ya en curso/i.test(text)) return "previous";
  if (/invalidada|no disponible|ya no disponible/i.test(text)) return "unavailable";
  if (/VIP|KYC|requisito|conciliación|seguridad|condiciones/i.test(text)) return "safety";
  return "other";
}

export async function opportunityDiagnostics(store: Store, hours=24, coin?:string, now=Date.now()) {
  hours=[1,24,168].includes(hours)?hours:24;
  const since=now-hours*3_600_000;
  const rows: ReturnType<Store["insightAudit"]>=[];
  let before=Number.MAX_SAFE_INTEGER;
  // Yield between bounded indexed reads, so reporting does not monopolize the event loop.
  while(rows.length<5000) {
    await yieldTurn();
    const batch=store.insightAudit(since,before,250);
    rows.push(...batch);before=batch.at(-1)?.id??before;
    if(batch.length<250)break;
  }
  const truncated=rows.length===5000 && store.insightAudit(since,before,1).length>0;
  const observedCoins=new Map<string,string>();
  const parsed:Array<(typeof rows)[number]&{coin:string;outcome:string}>=[];
  for(const [index,row] of rows.entries()){
    if(index%250===0)await yieldTurn();
    if(row.action!=="market_feed_processed") continue;
    const match=/Evento (p2p\.(?:created|reopened|range_created|range_updated)) de oferta (\S+) \(([^)]+)\) procesado desde el feed: (.*)\.$/s.exec(row.detail);
    if(!match) continue;
    observedCoins.set(row.uuid,match[3]!);
    parsed.push({...row,coin:match[3]!,outcome:match[4]!});
  }
  const observations=parsed.filter(row=>!coin||row.coin===coin);
  const reasons:Record<string,number>={};
  let accepted=0;
  for(const [index,row] of observations.entries()) {
    if(index%250===0)await yieldTurn();
    if(/^(?:venta )?aplicada /i.test(row.outcome)) {accepted++;continue;}
    const reason=opportunityReason(row.outcome);reasons[reason]=(reasons[reason]??0)+1;
  }
  let sent=0,confirmed=0,rejected=0,uncertain=0,notSent=0,unknownMarket=0;
  const responseMs:number[]=[];
  for(const [index,row] of rows.entries()) {
    if(index%250===0)await yieldTurn();
    if(row.action!=="offer_apply_timing")continue;
    const market=observedCoins.get(row.uuid)??store.getOperation(row.uuid)?.coin;
    if(coin&&market!==coin){if(!market)unknownMarket++;continue;}
    try {
      const timing=JSON.parse(row.detail) as {dispatchedAt?:number|null;finishedAt:number;outcome:string};
      if(typeof timing.dispatchedAt!=="number"){notSent++;continue;}
      sent++;
      if(timing.outcome==="confirmed")confirmed++;
      else if(timing.outcome==="uncertain")uncertain++;
      else rejected++;
      if(Number.isFinite(timing.finishedAt)&&timing.finishedAt>=timing.dispatchedAt)responseMs.push(timing.finishedAt-timing.dispatchedAt);
    }catch{/* Old or malformed telemetry is not evidence of a sent request. */}
  }
  responseMs.sort((a,b)=>a-b);
  return {hours,coin:coin??null,generatedAt:now,since,coverageSince:truncated?(rows.at(-1)?.createdAt??since):since,truncated,
    observations:observations.length,uniqueOffers:new Set(observations.map(row=>row.uuid)).size,acceptedObservations:accepted,
    reasons:Object.entries(reasons).map(([code,count])=>({code,label:REASON_LABELS[code]??code,count})).sort((a,b)=>b.count-a.count),
    applications:{sent,confirmed,rejected,uncertain,notSent,unknownMarket,responseP50Ms:responseMs.length?responseMs[Math.floor(responseMs.length/2)]!:null},
    note:"Se cuentan observaciones del feed y solicitudes registradas; no demuestra ofertas perdidas frente a otros bots. No incluye todas las evaluaciones del sondeo de recuperación."};
}

type HealthCheck={key:string;label:string;status:"ok"|"warning"|"idle";detail:string};
type HealthState={checkedAt:number;checks:HealthCheck[];incidents:Record<string,{warning:boolean;streak:number;revision:number}>};
export function readOperationalHealth(store:Pick<Store,"get">):HealthState|null {
  try{return JSON.parse(store.get("operational_health")??"null") as HealthState|null;}catch{return null;}
}
export class OperationalHealthMonitor {
  private readonly startedAt:number;
  constructor(private readonly store:Store,private readonly publish:(input:NotificationInput)=>Promise<void>,private readonly now:()=>number=Date.now){this.startedAt=now();}
  async check(input:{source:MarketSourceStatus;markets:{code:string;label:string;active:boolean}[];paused:boolean}) {
    const now=this.now(),previous=readOperationalHealth(this.store);
    const grace=now-this.startedAt<120_000;
    const lastReceived=Math.max(input.source.lastStreamReceivedAt??0,input.source.lastWebhookReceivedAt??0);
    const feedWarning=input.source.mode==="hybrid"
      ? (!lastReceived||now-lastReceived>300_000)
      : input.source.healthyAccounts===0;
    const checks:HealthCheck[]=[{key:"feed",label:"Datos del mercado",status:input.paused?"idle":grace?"idle":feedWarning?"warning":"ok",
      detail:input.paused?"Cacerías pausadas por el usuario.":grace?"Comprobando después del inicio.":feedWarning?"Sin actividad reciente del mercado; comprueba conexión y suscripción.":"Se reciben datos del mercado."}];
    for(const market of input.markets.filter(m=>m.active)) {
      const at=this.store.latestMedianAt(market.code);
      checks.push({key:`median:${market.code}`,label:`Medianas · ${market.label}`,status:grace?"idle":!at||now-at>2*3_600_000?"warning":"ok",
        detail:at?`Última observación: ${new Date(at).toLocaleString('es-CU',{timeZone:'America/Havana'})} (Cuba).`:"Todavía no hay medianas locales registradas."});
    }
    const response=Number(this.store.get("qva_apply_last_response_ms")??0);
    const lastApply=Number(this.store.get("qva_throttle:apply")??0);
    const recent=lastApply>0&&now-lastApply<900_000;
    checks.push({key:"latency",label:"Respuesta de QvaPay",status:!recent?"idle":response>3000?"warning":"ok",
      detail:recent?`Última solicitud: ${response} ms. No es un promedio.`:"Sin aplicaciones recientes para medir."});
    const incidents={...previous?.incidents};
    const activeKeys=new Set(checks.map(check=>check.key));
    for(const [key,old] of Object.entries(incidents))if(!activeKeys.has(key)){
      if(old.revision)this.store.acknowledgeNotification(`system-health:health:${key}:${old.revision}`);
      delete incidents[key];
    }
    for(const check of checks){
      const old=incidents[check.key]??{warning:false,streak:0,revision:0};
      if(check.status==="idle"){incidents[check.key]={...old,streak:0};continue;}
      const warning=check.status==="warning";
      const streak=warning===old.warning?0:old.streak+1;
      if(streak>=2){
        const revision=old.revision+1;
        await this.publish({message:`${warning?"⚠️ Aviso de salud":"✅ Servicio recuperado"}\n\n${check.label}\n${check.detail}\n\nLas cacerías mantienen su configuración. Consulta /salud para ver el estado.`,
          event:{kind:"system-health",uuid:`health:${check.key}:${revision}`}});
        if(old.revision) this.store.acknowledgeNotification(`system-health:health:${check.key}:${old.revision}`);
        incidents[check.key]={warning,streak:0,revision};
      }else incidents[check.key]={...old,streak};
    }
    const state:HealthState={checkedAt:now,checks,incidents};
    this.store.set("operational_health",JSON.stringify(state));return state;
  }
}
