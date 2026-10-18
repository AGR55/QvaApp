import assert from 'node:assert/strict';
import test from 'node:test';
import {huntingRequirementReason,recordHuntingEligibility,recordMissingRequirements} from '../src/hunting-requirements.js';
import type {P2pOffer} from '../src/types.js';
const offer:P2pOffer={uuid:'offer',type:'sell',coin:'CUP',amount:10,receive:100,status:'open',requirements:{min_completed:25,min_rating:4}};
test('filtra datos verificados sin inventar los ausentes y permite refrescarlos',()=>{
 const map=new Map<string,string>();const state={get:(k:string)=>map.get(k),set:(k:string,v:string)=>{map.set(k,v);}};
 assert.equal(huntingRequirementReason(state,offer,1000),undefined);
 recordHuntingEligibility(state,{_count:{P2P:10,P2P_Peer:20},rating_avg:3.8},1000);
 assert.match(huntingRequirementReason(state,offer,1000)!,/min_rating/);
 assert.equal(huntingRequirementReason(state,offer,62_000),undefined);
 recordHuntingEligibility(state,{rating_avg:4.5},62_000);
 assert.equal(huntingRequirementReason(state,offer,62_000),undefined);
 recordMissingRequirements(state,[{key:'min_completed',actual:12,required:25}],62_000);
 assert.match(huntingRequirementReason(state,offer,62_000)!,/min_completed/);
 recordHuntingEligibility(state,{_count:{P2P:20}},62_000);
 assert.match(huntingRequirementReason(state,offer,62_000)!,/min_completed/,'un total incompleto no reemplaza el dato conocido');
});
