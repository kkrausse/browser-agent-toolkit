// Browser Control --file: evidence-only; no guest requests or lifecycle action.
return await page.evaluate(async () => {
  const data=window.matchedPilot.evidence;
  if(!['passed','failed'].includes(data.status))throw Error('Not terminal');
  const text=JSON.stringify(data),bytes=new TextEncoder().encode(text);
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  let chunks=0;
  for(let offset=0;offset<text.length;offset+=65536){
    const response=await fetch('/evidence/'+data.condition+'/'+chunks,{method:'POST',body:text.slice(offset,offset+65536)});
    if(!response.ok)throw Error('Chunk export HTTP '+response.status);
    const receipt=await response.json();if(receipt.index!==chunks)throw Error('Chunk receipt mismatch');chunks++;
  }
  const response=await fetch('/evidence/'+data.condition+'/complete',{method:'POST',body:JSON.stringify({chunks,bytes:bytes.length,sha256})});
  if(!response.ok)throw Error('Complete export HTTP '+response.status);
  return {url:location.href,condition:data.condition,status:data.status,error:data.error,receipt:await response.json()};
});
