import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {AppError} from './errors';

/** Bounds the read itself, including files that grow after the size check. */
export async function readInputFile(filename:string,limit:number,grantedRoot?:string):Promise<Buffer>{
  const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await file.stat();
    if(!stat.isFile())throw new AppError('UNSUPPORTED_FILE','Choose a regular web file.');
    if(grantedRoot){const canonical=await realpath(filename);if(!canonical.startsWith(grantedRoot+path.sep))throw new AppError('IMPORT_PATH_ESCAPE','A file leaves the selected website folder.');}
    if(stat.size>limit)throw new AppError('IMPORT_LIMIT',`This file exceeds its ${Math.round(limit/1_000_000)} MB import limit.`);
    const chunks:Buffer[]=[];let total=0;
    while(total<=limit){
      const buffer=Buffer.allocUnsafe(Math.min(64_000,limit+1-total)),result=await file.read(buffer,0,buffer.length,null);
      if(!result.bytesRead)return Buffer.concat(chunks,total);
      total+=result.bytesRead;if(total>limit)throw new AppError('IMPORT_LIMIT','A selected file exceeds its import limit.');chunks.push(buffer.subarray(0,result.bytesRead));
    }
    throw new AppError('IMPORT_LIMIT','A selected file exceeds its import limit.');
  }finally{await file.close();}
}
