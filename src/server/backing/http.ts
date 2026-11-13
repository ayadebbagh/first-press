import 'server-only';
import { privateJson, AccessError } from '../auth/access';
import { OrderError } from './buy-orders';
export async function orderResponse(action:()=>Promise<Response>){
  try{return await action();}catch(error){
    if(error instanceof OrderError)return privateJson({error:error.message,code:error.code,intentAbsent:error.intentAbsent},
      {invalid:400,not_found:404,ineligible:422,uninitialized:409,insufficient:422,conflict:409,settled:409,drift:409}[error.code]);
    if(error instanceof AccessError)return privateJson({error:error.message},error.status);
    console.error('Backing request failed.');return privateJson({error:'Backing is temporarily unavailable. Retry with the same request key.',code:'unavailable'},503);
  }
}
export async function backingBody(request:Request,empty=false){
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(!reader){if(empty)return {};throw new AccessError(400,'A JSON backing intent is required.');}
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>4096){await reader.cancel();throw new AccessError(413,'Backing requests must fit within 4 KiB.');}chunks.push(value);}
    let value:unknown;
    try{const text=Buffer.concat(chunks).toString('utf8');value=empty&&!text.trim()?{}:JSON.parse(text);}catch{throw new AccessError(400,'Invalid JSON backing request.');}
    if(empty&&(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length))throw new AccessError(400,'Cancellation takes no amount, account or price fields.');
    return value;
  }finally{reader.releaseLock();}
}
