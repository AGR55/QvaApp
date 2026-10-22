import React,{useEffect,useState} from 'react';
import {Panel} from '../components/common.jsx';
import {Button,Input,Textarea,Select,Field} from '../components/ui.jsx';
import {requestJson} from '../lib/http.js';
import {money} from '../lib/format.js';

export function Profitability({report,markets,onChanged}){
 return <Panel title="Rentabilidad de operaciones cerradas" description="Coste FIFO por mercado: se asignan primero las compras más antiguas. Las monedas se mantienen separadas." wide>
  {!report?<p>Preparando el análisis local…</p>:<>
   <div className="insights-metrics">{(report.currencies||[]).map(row=><div key={row.currency}>
    <span>Resultado documentado · {row.currency}</span><strong>{row.documentedMatchedQusd>0?`${money(row.documentedProfit)} ${row.currency}`:'Sin evidencia suficiente'}</strong>
    <small>{money(row.documentedMatchedQusd||0)} QUSD vendidos con coste y cobro registrados.</small>
    <span>Parte estimada: {money(row.profit-(row.documentedProfit||0))} {row.currency}</span>
   </div>)}</div>
   {!report.currencies?.length?<p>Sin operaciones cerradas en este período.</p>:null}
   <p>El resultado documentado usa los importes fiat registrados y la comisión QUSD respaldada con evidencia. Una comisión cero también debe documentarse. Las estimaciones no presuponen tu comisión histórica.</p>
   {report.coverage?.unmatchedSoldQusd>0?<p role="status">{money(report.coverage.unmatchedSoldQusd)} QUSD vendidos no tienen un coste de compra identificable; no se cuentan como beneficio.</p>:null}
   {report.coverage?.partialPurchaseQusd>0?<p role="status">{money(report.coverage.partialPurchaseQusd)} QUSD comprados tienen un aporte fiat parcial. No se atribuye el coste de toda la compra a ese aporte.</p>:null}
   {!report.sync?.accountKnown||report.sync?.limited||report.sync?.complete===false?<p role="status">El historial disponible puede estar incompleto. El resultado cubre únicamente los registros identificados.</p>:null}
  </>}
  <FeeEvidence markets={markets} onChanged={onChanged}/>
 </Panel>;
}
function FeeEvidence({markets,onChanged}){
 const [open,setOpen]=useState(false),[page,setPage]=useState(1),[list,setList]=useState(),[reload,setReload]=useState(0);
 const [selected,setSelected]=useState(),[fee,setFee]=useState(''),[evidence,setEvidence]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{
  if(!open)return;let active=true;
  requestJson(`/api/analytics/fees?page=${page}`).then(payload=>{if(active)setList(payload.data);}).catch(error=>{if(active)setError(error.message);});
  return()=>{active=false;};
 },[open,page,reload]);
 const submit=async event=>{
  event.preventDefault();if(!selected||!fee.trim())return;
  setBusy(true);setError('');setStatus('');
  try{
   await requestJson('/api/analytics/fees',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uuid:selected.uuid,feeQusd:Number(fee),evidence,expectedVersion:selected.version})});
   setSelected(undefined);setReload(value=>value+1);onChanged?.();setStatus('Evidencia guardada. La rentabilidad se recalcula sin modificar tus saldos.');
  }catch(error){setError(error.message);}finally{setBusy(false);}
 };
 return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>Registrar o revisar comisiones de compras completadas</summary>
  <p>Esta evidencia solo afecta al análisis. No envía pagos, no modifica saldos y no cambia las cacerías.</p>
  {error?<p role="alert">{error}</p>:null}{status?<p role="status">{status}</p>:null}
  {selected?<form onSubmit={submit} className="fee-evidence-form">
   <p>Compra: <code>{selected.uuid}</code> · bruto: {money(selected.amount)} QUSD</p>
   <Field label="Comisión real en QUSD" htmlFor="fee-qusd" description="Escribe 0 solo si tienes evidencia de una operación sin comisión."><Input id="fee-qusd" type="number" min="0" max={selected.amount} step="any" required value={fee} onChange={event=>setFee(event.target.value)} disabled={busy}/></Field>
   <Field label="Evidencia" htmlFor="fee-evidence" description="Referencia del comprobante y sus importes bruto, neto y comisión."><Textarea id="fee-evidence" required minLength={10} maxLength={500} value={evidence} onChange={event=>setEvidence(event.target.value)} disabled={busy}/></Field>
   <div className="insights-controls"><Button type="submit" disabled={busy}>{busy?'Guardando…':'Guardar evidencia'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={()=>setSelected(undefined)}>Cerrar editor</Button></div>
  </form>:null}
  <ul className="fee-purchases">{list?.items.map(item=><li key={item.uuid}><div><strong>{markets.find(m=>m.code===item.coin)?.label||item.coin} · {money(item.amount)} QUSD</strong><br/><small>{new Date(item.completedAt).toLocaleString()}</small><br/><code>{item.uuid}</code><p>{item.feeQusd===null?'Comisión sin documentar':item.stale?'El importe bruto cambió; revisa la evidencia':`Comisión documentada: ${item.feeQusd} QUSD`}</p></div>
   <Button variant="secondary" disabled={busy} onClick={()=>{setSelected(item);setFee(item.feeQusd===null?'':String(item.feeQusd));setEvidence(item.evidence);setStatus('');}}> {item.version?'Revisar evidencia':'Registrar comisión'} </Button></li>)}</ul>
  {list&&!list.items.length?<p>Sin compras completadas en el historial local.</p>:null}
  {list?<div className="insights-controls"><Button variant="secondary" disabled={page===1||busy} onClick={()=>{setPage(value=>value-1);setSelected(undefined);}}>Anterior</Button><span>Página {page}</span><Button variant="secondary" disabled={!list.hasMore||page>=1000||busy} onClick={()=>{setPage(value=>value+1);setSelected(undefined);}}>Siguiente</Button><Button variant="secondary" disabled={busy} onClick={()=>{setError('');setReload(value=>value+1);setSelected(undefined);}}>Actualizar lista</Button></div>:null}
 </details>;
}

export function PriceSimulation({markets}){
 const [coin,setCoin]=useState(markets[0]?.code||''),[buy,setBuy]=useState(String(markets[0]?.buyMaxRate||'')),[sell,setSell]=useState(String(markets[0]?.sellMinRate||''));
 const [amount,setAmount]=useState('25'),[hours,setHours]=useState('24'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState();
 const market=markets.find(m=>m.code===coin);
 const submit=async event=>{
  event.preventDefault();setBusy(true);setError('');setResult(undefined);
  try{const payload=await requestJson('/api/hunting/simulate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({coin,hours:Number(hours),buyMaxRate:Number(buy),sellMinRate:Number(sell),maxQusd:Number(amount)})});setResult(payload.data);}
  catch(error){setError(error.message);}finally{setBusy(false);}
 };
 return <Panel title="Simulación de precios" description="Compara límites con ofertas observadas. Se calcula al solicitarlo y no modifica tu configuración." wide>
  <form onSubmit={submit}>
   <div className="simulation-fields">
    <Field label="Mercado" htmlFor="simulation-market"><Select id="simulation-market" value={coin} disabled={busy} options={markets.map(m=>({value:m.code,label:m.label}))} onValueChange={value=>{setCoin(value);const next=markets.find(m=>m.code===value);setBuy(String(next?.buyMaxRate||''));setSell(String(next?.sellMinRate||''));setResult(undefined);}}/></Field>
    <Field label="Período" htmlFor="simulation-period"><Select id="simulation-period" value={hours} disabled={busy} onValueChange={setHours} options={[{value:'1',label:'Última hora'},{value:'24',label:'Últimas 24 horas'},{value:'168',label:'Últimos 7 días'}]}/></Field>
    <Field label={`Comprar hasta (${market?.currency||coin}/QUSD)`} htmlFor="simulation-buy"><Input id="simulation-buy" type="number" min="0.00000001" step="any" required value={buy} disabled={busy} onChange={event=>setBuy(event.target.value)}/></Field>
    <Field label={`Vender desde (${market?.currency||coin}/QUSD)`} htmlFor="simulation-sell"><Input id="simulation-sell" type="number" min="0.00000001" step="any" required value={sell} disabled={busy} onChange={event=>setSell(event.target.value)}/></Field>
    <Field label="Máximo QUSD por oferta" htmlFor="simulation-amount"><Input id="simulation-amount" type="number" min="0.01" step="any" required value={amount} disabled={busy} onChange={event=>setAmount(event.target.value)}/></Field>
   </div>
   <Button type="submit" disabled={busy||!market}>{busy?'Comparando…':'Comparar precios'}</Button>
  </form>
  {error?<p role="alert">{error}</p>:null}
  {result?<div aria-live="polite"><div className="insights-metrics">
   <div><span>Compras que cumplen el precio</span><strong>{result.baseline.buy} → {result.proposed.buy}</strong></div>
   <div><span>Ventas que cumplen el precio</span><strong>{result.baseline.sell} → {result.proposed.sell}</strong></div>
  </div><p>Izquierda: límites actuales. Derecha: propuesta. {result.uniqueOffers} ofertas distintas del mercado en la muestra.</p>
  <p>Comisión fiat actual: {result.assumptions.outgoingTransferFee} {market?.currency} por salida. {result.counts.rangeOrAmount} ofertas excluidas por importe o rango; {result.counts.own} propias; {result.counts.stale} con entrega antigua.</p>
  {result.truncated?<p role="status">Muestra limitada a 5.000 observaciones, desde {new Date(result.coverageSince).toLocaleString()}.</p>:null}
  <p>{result.note}</p></div>:null}
 </Panel>;
}
