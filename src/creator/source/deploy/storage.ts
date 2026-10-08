import {mkdir,open,readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {atomicWrite} from '../core/project-store';
import {readInputFile} from '../core/input-files';
import {AppError} from '../core/errors';

export interface SecretProtector {seal(plaintext:Buffer,context:string):Promise<Buffer>;open(ciphertext:Buffer,context:string):Promise<Buffer>}
export const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const objectHash=(value:unknown)=>sha256(JSON.stringify(canonical(value)));
export async function durableWrite(filename:string,bytes:Buffer|string){
  await atomicWrite(filename,bytes);
  // A synced file alone does not make its renamed directory entry durable.
  const directory=await open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
}

/** Private application storage, never included in portable projects or returned by MCP. */
export class DeploymentStorage {
  constructor(readonly root:string,private protector:SecretProtector){}
  async initialize(){await mkdir(this.root,{recursive:true,mode:0o700});const info=await lstat(this.root);if(info.isSymbolicLink()||!info.isDirectory())throw new AppError('UNSAFE_STORAGE','Deployment storage must be a private application directory.');}
  directory(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError('INVALID_DEPLOYMENT','The deployment identifier is invalid.');return path.join(this.root,id);}
  async create(id:string){await mkdir(this.directory(id),{mode:0o700});}
  private async filename(id:string,name:string){
    if(!/^[a-z0-9-]+\.(sealed|json)$/.test(name))throw new AppError('INVALID_DEPLOYMENT','Invalid deployment record.');
    const directory=this.directory(id);if((await lstat(directory)).isSymbolicLink()||path.dirname(await realpath(directory))!==await realpath(this.root))throw new AppError('UNSAFE_STORAGE','Deployment records cannot leave their private directory.');
    return path.join(directory,name);
  }
  async write(id:string,name:string,value:unknown){const filename=await this.filename(id,name);await durableWrite(filename,await this.protector.seal(Buffer.from(JSON.stringify(value)),id+'/'+name));}
  async read<T>(id:string,name:string):Promise<T>{const filename=await this.filename(id,name);try{return JSON.parse((await this.protector.open(await readInputFile(filename,120_000_000),id+'/'+name)).toString('utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw error;throw new AppError('DEPLOYMENT_DAMAGED','The encrypted deployment record could not be verified. No transaction will be recreated or submitted.');}}
  async exists(id:string,name:string){try{await this.read(id,name);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
  async ids(){return (await readdir(this.root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^[a-f0-9-]{36}$/.test(entry.name)).map(entry=>entry.name);}
}
