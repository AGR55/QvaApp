import type { P2pOffer } from './types.js';

type State = { get(key: string): string | undefined; set(key: string, value: string): void };
const KEY = 'hunting_eligibility';
const FRESH_MS = 60_000;
const keys = ['min_completed','min_rating','min_account_days','min_trustscore'] as const;
type Key = typeof keys[number];
type Facts = Partial<Record<Key | 'kyc', { value: number; at: number }>>;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown): number | undefined => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
function facts(state: State): Facts {
 try { const value=JSON.parse(state.get(KEY) ?? '{}');return record(value)?value as Facts:{}; } catch { return {}; }
}
export function recordHuntingEligibility(state: State | undefined, value: unknown, now: number): void {
 if (!state || !record(value)) return;
 const current=facts(state);
 const put=(key:Key|'kyc',v:unknown)=>{const n=number(v);if(n!==undefined)current[key]={value:n,at:now};};
 const count=record(value._count)?value._count:undefined;
 if(count && number(count.P2P)!==undefined && number(count.P2P_Peer)!==undefined)put('min_completed',Number(count.P2P)+Number(count.P2P_Peer));
 put('min_rating',value.rating_avg ?? value.average_rating);
 put('min_trustscore',value.trustscore ?? value.trust_score);
 if(typeof value.created_at==='string'){
  const at=Date.parse(value.created_at);if(Number.isFinite(at)&&at<=now)put('min_account_days',Math.floor((now-at)/86_400_000));
 }
 if(typeof value.kyc==='boolean')put('kyc',value.kyc?1:0);
 if(value.kyc==='verified')put('kyc',1);
 state.set(KEY,JSON.stringify(current));
}
export function recordMissingRequirements(state: State | undefined, value: unknown, now: number): void {
 if(!state || !Array.isArray(value))return;
 const current=facts(state);
 for(const missing of value){
  if(!record(missing)||!keys.includes(missing.key as Key))continue;
  const actual=number(missing.actual);if(actual!==undefined)current[missing.key as Key]={value:actual,at:now};
 }
 state.set(KEY,JSON.stringify(current));
}
export function huntingRequirementReason(state: State, offer: P2pOffer, now=Date.now()): string | undefined {
 if(offer.requirements_met===false)return 'No cumple los requisitos del anunciante';
 if(!record(offer.requirements) && !offer.only_kyc)return;
 const current=facts(state);
 const fresh=(key:Key|'kyc')=>{const fact=current[key];return fact && Number.isFinite(fact.value) && Number.isFinite(fact.at) && now>=fact.at && now-fact.at<=FRESH_MS?fact.value:undefined;};
 if((offer.only_kyc === true || offer.only_kyc === 1) && fresh('kyc')===0)return 'KYC requerido por el anunciante';
 for(const key of keys){
  const required=number(offer.requirements?.[key]),actual=fresh(key);
  if(required!==undefined && actual!==undefined && actual<required)return `Requisito ${key}: ${actual} disponible; exige ${required}`;
 }
 // Missing or stale facts never become fabricated zeroes; QvaPay validates them.
 return;
}
