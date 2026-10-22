export const noticePriority = notice => ['operation-applied','own-offer-applied','recovery-blocked','reconciliation-required','rebalance-attention'].includes(notice.type) ? 0 : notice.type === 'informational-summary' ? 2 : 1;
export function queueNotice(queue, notice, limit=32) {
  const id=notice.id||notice.version;
  if(id&&queue.some(item=>(item.id||item.version)===id))return {queued:false};
  let evicted;
  if(queue.length>=limit){
    let index=-1,worst=noticePriority(notice);
    queue.forEach((item,position)=>{if(noticePriority(item)>noticePriority(notice)&&noticePriority(item)>=worst){worst=noticePriority(item);index=position;}});
    if(index<0)return {queued:false};
    [evicted]=queue.splice(index,1);
  }
  const index=queue.findIndex(item=>noticePriority(item)>noticePriority(notice));
  queue.splice(index<0?queue.length:index,0,notice);
  return {queued:true,evicted};
}
