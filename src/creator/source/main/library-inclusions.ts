import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ProjectStore} from '../core/project-store';
import {validate,mutationSchema} from '../core/validation';
import {AppError} from '../core/errors';
import {libraries} from '../catalog/libraries';
import researchCatalog from '../catalog/research-catalog.json';
import {researchKey} from '../catalog/library-acceptance';
import type {LibraryAcceptance} from '../shared/types';
type Resolver={resolve:(url:string,options:Record<string,unknown>)=>Promise<{status:number;data:Buffer;headers:Record<string,string>}>};
/** Called only by the desktop host. Scoped agents cannot accept a user's warning. */
export async function includeLibrary(store:ProjectStore,resolver:Resolver,settings:()=>{network:string},payload:unknown){
  const p=validate(mutationSchema.extend({key:z.string().max(80),acceptWarning:z.literal(true).optional(),format:z.enum(['classic','esm','stylesheet','asset']).optional()}).strict(),payload);
  const library=libraries.find(l=>l.key===p.key),record=researchCatalog.entries.find(r=>researchKey(r.id)===p.key);
  if(!library&&!record)throw new AppError('UNKNOWN_LIBRARY','Choose a library from the catalog.');
  if(!p.acceptWarning){if(record)throw new AppError('LIBRARY_WARNING_REQUIRED','Accept the warning before adding this research library.');return store.addLibrary(p,p.key);}
  let pin:LibraryAcceptance;
  if(library)pin={key:library.key,id:library.id,sha256:library.sha256,mime:library.mime,bytes:library.bytes,format:library.format,acceptedAt:new Date().toISOString(),warningVersion:1};
  else{
    if(settings().network!=='mainnet')throw new AppError('LIBRARY_NETWORK','Select mainnet sources in Browse settings before adding this research inscription.');
    const result=await resolver.resolve('/content/'+record!.id,{maxBytes:8_000_000,signal:AbortSignal.timeout(20_000)});
    if(result.status!==200||!result.data.length||result.data.length>8_000_000)throw new AppError('LIBRARY_UNAVAILABLE','The native browser source could not fetch this inscription within the 8 MB limit. Try another source in Browse settings.');
    const mime=String(result.headers['content-type']??'application/octet-stream').trim(),contentType=mime.split(';')[0].trim().toLowerCase(),format=p.format??'classic';
    if((format==='classic'||format==='esm')&&!['text/javascript','application/javascript','application/x-javascript','text/ecmascript','application/ecmascript','text/plain'].includes(contentType)||format==='stylesheet'&&!['text/css','text/plain'].includes(contentType))throw new AppError('LIBRARY_FORMAT','This inscription is '+mime+'. Select its matching include format, or add it as a resource.');
    pin={key:p.key,id:record!.id,sha256:createHash('sha256').update(result.data).digest('hex'),bytes:result.data.length,mime,format,acceptedAt:new Date().toISOString(),warningVersion:1};
  }
  return store.addLibrary(p,p.key,pin);

}
