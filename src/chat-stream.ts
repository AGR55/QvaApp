/** Bounded SSE framing. Payloads only invalidate the cache; financial code never consumes them. */
export async function consumeChatStream(body: ReadableStream<Uint8Array>, changed: () => void): Promise<void> {
  const reader=body.getReader();const decoder=new TextDecoder();let buffer="";
  try {
    while(true) {
      const {done,value}=await reader.read();if(done) break;
      buffer+=decoder.decode(value,{stream:true});
      if(buffer.length>65_536) throw new Error("Evento de chat demasiado grande.");
      const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop()??"";
      for(const frame of frames) {
        const lines=frame.split(/\r?\n/);
        const event=lines.find(line=>line.startsWith("event:"))?.slice(6).trim().toLowerCase();
        if(event && /^(ping|heartbeat|keepalive|connected)$/.test(event)) continue;
        const data=lines.filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
        if(!data || /^(ping|heartbeat|keepalive)$/i.test(data.trim())) continue;
        try {const value=JSON.parse(data) as {type?:string;event?:string};if(/^(ping|heartbeat|keepalive|connected)$/.test(value?.type??value?.event??"")) continue;} catch { /* Unknown data still requires an authenticated refresh. */ }
        changed();
      }
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
