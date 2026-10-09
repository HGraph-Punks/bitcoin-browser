import {protocolEntry} from '../shared/metaprotocols';
import {z} from 'zod';
import {libraryAcceptancesSchema} from '../catalog/library-acceptance';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {lstat,opendir,realpath,mkdir} from 'node:fs/promises';
import {AppError} from './errors';
import {validate,safeRelativePath,settingsSchema,templateSchema} from './validation';
import {describeAsset,isTextFile,decodeText,decodeBase64,mimeFor,validateAssets,MAX_PROJECT_ASSET_BYTES} from './assets';
import {atomicWrite,type ImportedFile,ProjectStore} from './project-store';
import {readInputFile} from './input-files';
import type {ProjectSnapshot,SourceAsset} from '../shared/types';

export const MAX_ARCHIVE_BYTES=160_000_000;
const encodedFile=z.object({path:z.string().min(1).max(240),encoding:z.enum(['utf8','base64']),content:z.string().max(11_000_000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const archiveSchema=z.object({format:z.literal('bitcoin-website-project'),version:z.literal(1),title:z.string().min(1).max(80),template:templateSchema,settings:settingsSchema,libraries:z.array(z.string().max(80)).max(32),libraryAcceptances:libraryAcceptancesSchema.optional(),files:z.array(encodedFile).min(1).max(256)}).strict();
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

export async function encodeProject(project:ProjectSnapshot,readAsset:(id:string,sha:string)=>Promise<Buffer>):Promise<Buffer>{
  const files:z.infer<typeof encodedFile>[]=[];
  for(const [relative,text] of Object.entries(project.files).sort(([a],[b])=>a.localeCompare(b)))files.push({path:relative,encoding:'utf8',content:text,sha256:hash(text)});
  for(const asset of Object.values(project.assets).sort((a,b)=>a.path.localeCompare(b.path))){const body=await readAsset(project.id,asset.sha256);files.push({path:asset.path,encoding:'base64',content:body.toString('base64'),sha256:asset.sha256});}
  const archive=Buffer.from(JSON.stringify({format:'bitcoin-website-project',version:1,title:project.title,template:project.template,settings:project.settings,libraries:project.libraries,libraryAcceptances:project.libraryAcceptances,files},null,2));
  if(archive.length>MAX_ARCHIVE_BYTES)throw new AppError('ARCHIVE_TOO_LARGE','The portable project exceeds the 160 MB archive limit.');return archive;
}
export function decodeProject(bytes:Buffer){
  if(bytes.length>MAX_ARCHIVE_BYTES)throw new AppError('ARCHIVE_TOO_LARGE','This project archive exceeds 160 MB.');
  let value:unknown;try{value=JSON.parse(decodeText(bytes));}catch(error){if(error instanceof AppError)throw error;throw new AppError('INVALID_ARCHIVE','Choose a Bitcoin Website Builder project archive.');}
  const archive=validate(archiveSchema,value),entries:ImportedFile[]=[],assets:Record<string,SourceAsset>={},texts:Record<string,string>={},paths=new Set<string>();let total=0;
  for(const file of archive.files){
    safeRelativePath(file.path);if(paths.has(file.path))throw new AppError('PATH_COLLISION','The archive contains a duplicate path.');paths.add(file.path);
    const body=file.encoding==='utf8'?Buffer.from(file.content):decodeBase64(file.content,8_000_000);
    if(hash(body)!==file.sha256)throw new AppError('ARCHIVE_INTEGRITY',`The saved hash for ${file.path} does not match its bytes.`);
    if(isTextFile(file.path)){if(body.length>2_000_000)throw new AppError('FILE_TOO_LARGE','A source file exceeds 2 MB.');texts[file.path]=decodeText(body);total+=body.length;}
    else assets[file.path]=describeAsset(file.path,body);
    entries.push({path:file.path,bytes:body});
  }
  if(total>8_000_000)throw new AppError('PROJECT_TOO_LARGE','The archive contains more than 8 MB of source text.');validateAssets(assets,texts);
  if(!Object.hasOwn(texts,protocolEntry(archive.template)))throw new AppError('ENTRY_REQUIRED','The archive must contain its creation design entry file.');
  return {title:archive.title,template:archive.template,settings:archive.settings,libraries:archive.libraries,libraryAcceptances:archive.libraryAcceptances,entries};
}

/** Read only a native-dialog-granted tree, with bounded files and no escaping links. */
export async function readWebsiteFolder(directory:string):Promise<{entries:ImportedFile[];skipped:string[]}>{
  const root=await realpath(directory),entries:ImportedFile[]=[],skipped:string[]=[];let total=0,visited=0,listed=0;
  async function visit(absolute:string,relative:string,ancestors:Set<string>){
    if(++visited>4096||ancestors.size>32)throw new AppError('IMPORT_LIMIT','The selected folder contains too many nested folders or files.');
    const canonical=await realpath(absolute);if(canonical!==root&&!canonical.startsWith(root+path.sep))throw new AppError('IMPORT_PATH_ESCAPE','A symbolic link leaves the selected website folder.');
    const stat=await lstat(canonical);
    if(stat.isDirectory()){
      if(ancestors.has(canonical))throw new AppError('IMPORT_DIRECTORY_CYCLE','A folder link creates a cycle inside this website.');
      const next=new Set(ancestors).add(canonical);
      for await(const entry of await opendir(canonical)){
        if(++listed>4096)throw new AppError('IMPORT_LIMIT','The selected folder contains too many directory entries.');const name=entry.name;
        const child=relative?relative+'/'+name:name;if(name.startsWith('.')||name==='node_modules'){if(skipped.length<100)skipped.push(child);continue;}
        await visit(path.join(absolute,name),child,next);
      }
    }else if(stat.isFile()){
      safeRelativePath(relative);if(mimeFor(relative)==='application/octet-stream'&&!relative.endsWith('.bin')){if(skipped.length<100)skipped.push(relative);return;}
      if(entries.length>=256||stat.size>(isTextFile(relative)?2_000_000:8_000_000))throw new AppError('IMPORT_LIMIT','The selected folder exceeds the file-count or per-file import limit.');
      const bytes=await readInputFile(canonical,isTextFile(relative)?2_000_000:8_000_000,root);
      total+=bytes.length;if(total>MAX_PROJECT_ASSET_BYTES+8_000_000)throw new AppError('IMPORT_LIMIT','The selected folder exceeds the project import limit.');
      entries.push({path:relative,bytes});
    }else throw new AppError('UNSUPPORTED_FILE','Only regular web files can be imported.');
  }
  await visit(root,'',new Set());
  if(!entries.some(file=>file.path==='index.html'))throw new AppError('ENTRY_REQUIRED','Choose the folder containing your website’s index.html.');
  return {entries:entries.sort((a,b)=>a.path.localeCompare(b.path)),skipped:skipped.slice(0,100)};
}
export async function exportWebsiteFolder(project:ProjectSnapshot,directory:string,store:ProjectStore){
  // The caller creates this new empty folder through a native destination grant.
  for(const [relative,text] of Object.entries(project.files)){safeRelativePath(relative);const file=path.join(directory,relative);await mkdir(path.dirname(file),{recursive:true});await atomicWrite(file,text);}
  for(const asset of Object.values(project.assets)){safeRelativePath(asset.path);const file=path.join(directory,asset.path);await mkdir(path.dirname(file),{recursive:true});await atomicWrite(file,await store.readAsset(project.id,asset.sha256));}
}
