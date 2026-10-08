import {lstat,mkdir,readdir,readFile,mkdtemp,rename,rm,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {ProjectStore} from '../core/project-store';
import {readInputFile} from '../core/input-files';
import {AppError} from '../core/errors';

let importing=false;
/** Explicit native folder grant only. Copy immutable project snapshots; never
 * import credentials, vaults, deployments, AI tokens or wallet material. */
export async function importLegacyProjects(source:string,destination:string){
  if(importing)throw new AppError('IMPORT_BUSY','Wait for the current project import to finish.');importing=true;
  let stage:string|undefined;
  try{
    const info=await lstat(source);if(!info.isDirectory()||info.isSymbolicLink())throw new AppError('UNSAFE_IMPORT','Choose a regular projects folder.');
    if(await realpath(source)===await realpath(destination))throw new AppError('SAME_WORKSPACE','These projects are already in Create mode.');
    try{const lock=JSON.parse((await readInputFile(path.join(source,'.writer.lock'),4096)).toString('utf8'));if(Number.isSafeInteger(lock.pid)&&lock.pid>0){try{process.kill(lock.pid,0);throw new AppError('SOURCE_IN_USE','Quit Website Builder before importing its projects so their history stays consistent.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const ids=(await readdir(source,{withFileTypes:true})).filter(e=>/^[a-f0-9-]{36}$/.test(e.name));if(ids.length>200)throw new AppError('IMPORT_LIMIT','Import up to 200 projects at a time.');
    stage=await mkdtemp(path.join(destination,'.import-'));
    let bytes=0,files=0;
    async function copyTree(from:string,to:string,depth=0){
      if(depth>12)throw new AppError('IMPORT_LIMIT','The project folder is nested too deeply.');
      const st=await lstat(from);if(st.isSymbolicLink())throw new AppError('UNSAFE_IMPORT','Project imports cannot contain symbolic links.');
      if(st.isDirectory()){await mkdir(to,{mode:0o700});for(const entry of await readdir(from))await copyTree(path.join(from,entry),path.join(to,entry),depth+1);}
      else if(st.isFile()){if(++files>50000)throw new AppError('IMPORT_LIMIT','The project import exceeds 50,000 files.');const body=await readInputFile(from,64_000_000);bytes+=body.length;if(bytes>1_000_000_000)throw new AppError('IMPORT_LIMIT','The project import exceeds 1 GB.');await writeFile(to,body,{flag:'wx',mode:0o600});}
      else throw new AppError('UNSAFE_IMPORT','Project imports contain an unsupported file.');
    }
    const imported:string[]=[],skipped:string[]=[];
    for(const entry of ids){
      if(!entry.isDirectory()||entry.isSymbolicLink())throw new AppError('UNSAFE_IMPORT','Project imports must be regular directories.');
      try{await lstat(path.join(destination,entry.name));skipped.push(entry.name);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const from=path.join(source,entry.name),to=path.join(stage,entry.name);
      const names=await readdir(from);if(names.some(name=>!['project.btcsite','versions','assets','revisions'].includes(name)))throw new AppError('UNSAFE_IMPORT','This project contains unexpected storage entries. Export it as a .btcsite archive instead.');
      const before=await readInputFile(path.join(from,'project.btcsite'),2_000_000);await copyTree(from,to);
      if(!before.equals(await readInputFile(path.join(from,'project.btcsite'),2_000_000)))throw new AppError('SOURCE_CHANGED','The original project changed during import. Quit Website Builder and retry.');
      const reader=new ProjectStore(stage),project=await reader.read(entry.name);for(const asset of Object.values(project.assets))await reader.readAsset(project.id,asset.sha256);
      imported.push(entry.name);
    }
    // Every selected project has been validated before any is made visible.
    for(const id of imported)await rename(path.join(stage,id),path.join(destination,id));
    return {canceled:false,imported,skipped,bytes,files};
  }finally{if(stage)await rm(stage,{recursive:true,force:true});importing=false;}
}
