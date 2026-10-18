import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Store} from '../src/store.js';

test('la reserva sobrevive a confirmación y reinicio hasta proyectar la operación',()=>{
 const dir=mkdtempSync(join(tmpdir(),'qva-apply-reserve-'));let store=new Store(dir);
 store.createMutationIntent({intentId:'one',kind:'apply',operationUuid:'offer',request:{capitalReserve:{coin:'CUP',fiat:105,qusd:0,amount:10}}});
 assert.equal(store.applicationReservedCapital('CUP').fiat,105);
 assert.equal(store.applicationReservedCapital('CUP','one').fiat,0);
 store.updateMutationIntent('one','confirmed');store.close();store=new Store(dir);
 assert.equal(store.applicationReservedCapital('CUP').fiat,105);
 assert.equal(store.getMutationIntent('one')?.state,'uncertain','el reinicio recupera una proyección interrumpida sin liberar ni reaplicar');
 store.createOperation({uuid:'offer',coin:'CUP',offerType:'sell',amount:10,receive:100,rate:10,state:'applied',autoApplied:true,cancelAt:null,createdAt:Date.now()});
 assert.equal(store.applicationReservedCapital('CUP').fiat,0);store.close();
});
test('un rechazo libera la reserva, una respuesta ambigua y el reconocimiento la conservan',()=>{
 const store=new Store(mkdtempSync(join(tmpdir(),'qva-apply-reserve-')));
 for(const id of ['one','two'])store.createMutationIntent({intentId:id,kind:'apply',operationUuid:id,request:{capitalReserve:{coin:'CUP',fiat:50,qusd:0,amount:5}}});
 store.updateMutationIntent('one','rejected');store.updateMutationIntent('two','uncertain');
 store.set('recovery_ack:two','true');assert.equal(store.applicationReservedCapital('CUP').fiat,50);
 store.updateMutationIntent('two','reconciled');assert.equal(store.applicationReservedCapital('CUP').fiat,0);store.close();
});
