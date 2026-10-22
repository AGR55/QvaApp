import React, { useEffect, useState } from "react";
import { Panel } from "../components/common.jsx";
import { Button, Select, Badge } from "../components/ui.jsx";
import { requestJson } from "../lib/http.js";
const date=value=>new Date(value).toLocaleString();
const number=value=>value===null?'Sin registro':Number(value).toLocaleString(undefined,{maximumFractionDigits:6});

export function HuntingInsights({markets}){
  const [health,setHealth]=useState();
  const [report,setReport]=useState();
  const [coin,setCoin]=useState('');
  const [hours,setHours]=useState('24');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [healthError,setHealthError]=useState('');
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let current=true;
    requestJson('/api/operational-health').then(payload=>{if(current){setHealth(payload.data);setHealthError('');}})
      .catch(error=>{if(current)setHealthError(error.message);});
    return()=>{current=false;};
  },[refresh]);
  const load=async()=>{
    setBusy(true);setError('');setReport(undefined);
    try{
      const params=new URLSearchParams({hours});if(coin)params.set('coin',coin);
      const payload=await requestJson(`/api/hunting/diagnostics?${params}`);
      setReport(payload.data);
    }catch(error){setError(error.message);}finally{setBusy(false);}
  };
  return <>
    <Panel title="Salud del bot" description="Comprobaciones locales cada minuto. Los avisos se envían al detectar un problema persistente y al recuperarse." wide>
      <Button variant="secondary" onClick={()=>setRefresh(value=>value+1)}>Actualizar estado</Button>
      {healthError?<p role="alert">{healthError}</p>:null}
      {health?<><p className="muted">Comprobado: {date(health.checkedAt)}</p><div className="insights-checks">{health.checks.map(check=><div key={check.key}>
        <Badge variant={check.status==='warning'?'warning':check.status==='ok'?'success':'neutral'}>{check.status==='warning'?'Revisar':check.status==='ok'?'Correcto':'En espera'}</Badge>
        <strong>{check.label}</strong><p>{check.detail}</p>
      </div>)}</div></>:<p>Esperando la primera comprobación.</p>}
    </Panel>
    <Panel title="Diagnóstico de oportunidades" description="Consulta los motivos registrados y las aplicaciones enviadas. El informe se calcula al solicitarlo." wide>
      <div className="insights-controls">
        <label htmlFor="diagnostics-coin">Mercado<Select id="diagnostics-coin" value={coin||"all"} onValueChange={value=>setCoin(value==="all"?"":value)} disabled={busy} options={[{value:"all",label:"Todos los mercados"},...markets.map(m=>({value:m.code,label:m.label}))]} /></label>
        <label htmlFor="diagnostics-hours">Período<Select id="diagnostics-hours" value={hours} onValueChange={setHours} disabled={busy} options={[{value:"1",label:"Última hora"},{value:"24",label:"Últimas 24 horas"},{value:"168",label:"Últimos 7 días"}]} /></label>
        <Button onClick={load} disabled={busy}>{busy?'Preparando…':'Consultar diagnóstico'}</Button>
      </div>
      {error?<p role="alert">{error}</p>:null}
      {report?<div aria-live="polite">
        <p>{report.observations} observaciones · {report.uniqueOffers} ofertas distintas · {report.acceptedObservations} observaciones con aplicación confirmada</p>
        <div className="insights-metrics">{[['Enviadas',report.applications.sent],['Confirmadas',report.applications.confirmed],['Rechazadas por QvaPay',report.applications.rejected],['Resultado incierto',report.applications.uncertain],['Sin enviar',report.applications.notSent]].map(([label,value])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <h3>Motivos de las observaciones</h3>
        {report.reasons.length?<ul>{report.reasons.map(reason=><li key={reason.code}>{reason.label}: <strong>{reason.count}</strong></li>)}</ul>:<p>Sin descartes registrados en este período.</p>}
        {report.truncated?<p role="status">Cobertura limitada a los últimos 5.000 registros, desde {date(report.coverageSince)}.</p>:null}
        {report.applications.unknownMarket?<p>{report.applications.unknownMarket} solicitudes sin moneda identificable no se atribuyen a este mercado.</p>:null}
        <p className="muted">{report.note}</p>
      </div>:null}
    </Panel>
  </>;
}

export function FiatHistory({markets}){
  const [coin,setCoin]=useState(markets[0]?.code??'');
  const [page,setPage]=useState(1);
  const [history,setHistory]=useState();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    if(!coin)return;
    let current=true;setBusy(true);setError('');setHistory(undefined);
    requestJson(`/api/fiat-history?${new URLSearchParams({coin,page:String(page)})}`)
      .then(payload=>{if(current)setHistory(payload.data);}).catch(error=>{if(current)setError(error.message);})
      .finally(()=>{if(current)setBusy(false);});
    return()=>{current=false;};
  },[coin,page,refresh]);
  const currency=markets.find(m=>m.code===coin)?.currency??coin;
  return <Panel title="Historial del fiat" description="Cambios reales de saldo, declaraciones y operaciones. Los saldos antiguos sin evidencia se muestran como «Sin registro»." wide>
    <div className="insights-controls"><label htmlFor="fiat-history-coin">Mercado<Select id="fiat-history-coin" value={coin} onValueChange={value=>{setCoin(value);setPage(1);}} options={markets.map(m=>({value:m.code,label:m.label}))} /></label>
    <Button variant="secondary" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>Actualizar historial</Button></div>
    {error?<p role="alert">{error}</p>:null}
    {busy?<p role="status">Cargando movimientos…</p>:null}
    {history?<><div className="insights-table" tabIndex={0} role="region" aria-label="Movimientos del fiat"><table><caption>Movimientos en {currency} · página {page}</caption><thead><tr><th>Fecha y origen</th><th>Anterior</th><th>Movimiento</th><th>Posterior</th></tr></thead><tbody>
      {history.items.map(item=><tr key={item.id}><td><strong>{item.source}</strong><br/><small>{date(item.createdAt)}</small>{item.uuid?<><br/><code>{item.uuid}</code></>:null}
        {item.kind==='historical'?<p>Ya incluido en el saldo declarado; sin nuevo descuento.</p>:item.kind==='legacy'?<p>Movimiento anterior al historial detallado.</p>:item.kind==='opening'?<p>Punto de partida del historial.</p>:null}</td>
        <td>{number(item.before)}</td><td>{item.kind==='historical'?'Referencia: ':''}{item.amount>0?'+':''}{number(item.amount)}</td><td>{number(item.after)}</td></tr>)}
    </tbody></table></div>{history.items.length===0?<p>Sin movimientos registrados.</p>:null}
    <div className="insights-controls"><Button variant="secondary" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>Anterior</Button><span>Página {page}</span><Button variant="secondary" disabled={!history.hasMore||page>=1000} onClick={()=>setPage(value=>value+1)}>Siguiente</Button></div></>:null}
  </Panel>;
}
