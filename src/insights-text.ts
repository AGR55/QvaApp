import type { Store } from "./store.js";
import type { opportunityDiagnostics, readOperationalHealth } from "./operational-insights.js";
const escape=(value:string)=>value.replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]!);
const amount=(value:number|null)=>value===null?"sin registro":new Intl.NumberFormat('es-CU',{maximumFractionDigits:6}).format(value);
const date=(value:number)=>new Date(value).toLocaleString('es-CU',{timeZone:'America/Havana'});
export function diagnosticsText(report:Awaited<ReturnType<typeof opportunityDiagnostics>>,market:string) {
  return [`<b>🎯 Diagnóstico de cacerías</b>`,`🪙 ${escape(market)} · últimas ${report.hours} h`,
    `👀 Observaciones: <b>${report.observations}</b>\n🆔 Ofertas distintas observadas: <b>${report.uniqueOffers}</b>`,
    `<b>📨 Aplicaciones registradas</b>\n• Enviadas: ${report.applications.sent}\n• Confirmadas: ${report.applications.confirmed}\n• Rechazadas por QvaPay: ${report.applications.rejected}\n• Resultado incierto: ${report.applications.uncertain}\n• Sin enviar: ${report.applications.notSent}`,
    `<b>🔎 Resultado de las observaciones</b>\n${report.reasons.map(r=>`• ${escape(r.label)}: ${r.count}`).join('\n')||'Sin descartes registrados.'}`,
    report.truncated?`⚠️ Cobertura limitada a los últimos 5.000 registros; comienza el ${date(report.coverageSince)}.`:'',
    report.applications.unknownMarket?`ℹ️ ${report.applications.unknownMarket} solicitudes sin moneda identificable no se atribuyen a este mercado.`:'',
    `ℹ️ ${report.note}`,`Consulta: <code>/diagnostico todas 24</code>`].filter(Boolean).join('\n\n');
}
export function healthText(state:ReturnType<typeof readOperationalHealth>){
  if(!state)return '<b>🩺 Salud del bot</b>\n\nLa primera comprobación se realizará en el próximo minuto.';
  return ['<b>🩺 Salud del bot</b>',...state.checks.map(c=>`${c.status==='ok'?'✅':c.status==='warning'?'⚠️':'⏳'} <b>${escape(c.label)}</b>\n${escape(c.detail)}`),`🕒 Comprobado: ${date(state.checkedAt)}`].join('\n\n');
}
export function fiatHistoryText(history:ReturnType<Store['fiatBalanceHistory']>,label:string,currency:string){
  return [`<b>💰 Historial del fiat · ${escape(label)}</b>`,`📄 Página ${history.page}`,
    ...history.items.slice(0,5).map(item=>[`${item.amount>=0?'+':''}${amount(item.amount)} ${escape(currency)} · ${date(item.createdAt)}`,
      `Saldo: ${amount(item.before)} → ${amount(item.after)}`,escape(item.source.slice(0,180)),
      item.kind==='historical'?'ℹ️ Histórico ya incluido en el saldo; sin nuevo descuento.':item.kind==='legacy'?'ℹ️ Movimiento anterior al historial detallado.':'',
      item.uuid?`🆔 <code>${escape(item.uuid)}</code>`:''].filter(Boolean).join('\n')),
    history.items.length?'':'Sin movimientos registrados.',history.hasMore&&history.page<1000?`Siguiente: <code>/historial ${escape(history.items[0]?.coin??'MONEDA')} ${history.page+1}</code>`:'',
    history.items.length>5?'🌐 Consulta la web para ver todos los movimientos de esta página.':''].filter(Boolean).join('\n\n');
}

export function profitabilityText(report:ReturnType<import('./dashboard.js').DashboardReadModel['tradingAnalytics']>){
 return ['<b>📊 Rentabilidad de operaciones cerradas</b>',`📅 Últimos ${report.days} días`,
  ...report.currencies.map(row=>`<b>🪙 ${escape(row.currency)}</b>\n• Resultado documentado: ${row.documentedMatchedQusd>0?amount(row.documentedProfit):'sin evidencia suficiente'}\n• QUSD vendidos con coste y cobro documentados: ${amount(row.documentedMatchedQusd)}\n• Parte estimada: ${amount(row.profit-row.documentedProfit)}`),
  report.currencies.length?'':'Sin operaciones cerradas en el período.',
  report.coverage.unmatchedSoldQusd?`ℹ️ ${amount(report.coverage.unmatchedSoldQusd)} QUSD vendidos sin coste identificable; no se cuentan como beneficio.`:'',
  '🧾 FIFO por mercado. Las comisiones documentadas y los movimientos fiat respaldan la parte documentada; el resto es estimación. El historial puede estar incompleto.',
  '🌐 Registra evidencia de comisiones en Gráficas. Los saldos y las cacerías no se modifican.'].filter(Boolean).join('\n\n');
}
export function simulationText(report:Awaited<ReturnType<typeof import('./price-simulation.js').simulatePrices>>,label:string){
 return ['<b>🧪 Simulación de precios</b>',`🪙 ${escape(label)} · ${report.hours} h\n💰 Máximo por oferta: ${amount(report.maxQusd)} QUSD`,
  `<b>🎯 Ofertas que cumplen el precio</b>\n• Compras: ${report.baseline.buy} → ${report.proposed.buy}\n• Ventas: ${report.baseline.sell} → ${report.proposed.sell}\nActuales → propuestos`,
  `👀 ${report.uniqueOffers} ofertas distintas en la muestra.\n💸 Comisión fiat actual por salida: ${amount(report.assumptions.outgoingTransferFee)}`,
  report.truncated?`⚠️ Cobertura limitada a 5.000 observaciones desde ${date(report.coverageSince)}.`:'',
  `ℹ️ ${report.note}`].filter(Boolean).join('\n\n');
}
