import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Library } from '../shared/types';
import { atomicWrite } from '../core/project-store';
import { AppError } from '../core/errors';

const gateways=['https://ordinals.com','https://ord-mirror.magiceden.dev'];
export class ResourceCache {
  private pending=new Map<string,Promise<Buffer>>();
  constructor(private directory:string){}
  async get(library:Library):Promise<Buffer>{
    if(this.pending.has(library.id))return this.pending.get(library.id)!;
    const operation=this.load(library);this.pending.set(library.id,operation);
    try{return await operation;}finally{this.pending.delete(library.id);}
  }
  private async load(library:Library){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,library.sha256);
    try{const bytes=await readFile(file);if(createHash('sha256').update(bytes).digest('hex')===library.sha256)return bytes;}catch{}
    for(const gateway of gateways){
      try{
        const response=await fetch(`${gateway}/content/${library.id}`,{headers:{'User-Agent':'Mozilla/5.0 (Bitcoin Website Builder)','Accept':'*/*'},signal:AbortSignal.timeout(20_000),redirect:'error'});
        if(!response.ok || !response.body)continue;
        const chunks:Uint8Array[]=[];let length=0;
        for await(const chunk of response.body){length+=chunk.length;if(length>8_000_000)throw new AppError('RESOURCE_TOO_LARGE','The on-chain library exceeds the download limit.');chunks.push(chunk);}
        const bytes=Buffer.concat(chunks);
        if(createHash('sha256').update(bytes).digest('hex')!==library.sha256)throw new AppError('INTEGRITY_MISMATCH','The source returned unexpected library bytes.');
        await atomicWrite(file,bytes);return bytes;
      }catch{/* Try only the next known public gateway. */}
    }
    throw new AppError('RESOURCE_UNAVAILABLE',`${library.name} could not be loaded with its expected content hash. Check your connection and retry.`);
  }
}
