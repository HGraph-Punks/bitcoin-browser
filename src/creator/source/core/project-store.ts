import { mkdir, open, readFile, writeFile, rename, readdir, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {AsyncLocalStorage} from 'node:async_hooks';
import {compareProjects,summarizeChanges} from './project-diff';
import type {ProjectActor,ProjectChange,ProjectCheckpoint,ProjectHistory,ProjectRevision} from '../shared/history';
import type {MergeCommit} from '../shared/merge';
import { AppError } from './errors';
import { mutationSchema, projectId, safeRelativePath, settingsSchema, templateSchema, validate } from './validation';
import {withLibraryNotices} from '../catalog/notices';
import { createTemplate, initialSettings, templates, updateTemplateFields,readTemplateSettings } from './templates';
import {collectionSchema,readCollection,defaultCollection,runePlan,defaultRune,type CollectionSpec,type RuneSpec} from '../shared/ordinals';
import {collectionHTML,runeHTML} from './ordinal-templates';
import {libraryAcceptancesSchema,needsLibraryWarning} from '../catalog/library-acceptance';
import { resolveLibraries } from '../catalog/libraries';
import {assetSchema,describeAsset,isTextFile,decodeText,validateAssets,mimeFor} from './assets';
import {changeFile} from '../compiler/file-change';
import type { Mutation, ProjectSnapshot, ProjectSummary, SiteSettings, TemplateId,SourceAsset,BuildArtifact } from '../shared/types';
export type ImportedFile={path:string;bytes:Buffer};

type Content = Omit<ProjectSnapshot, 'revision' | 'canUndo' | 'canRedo' | 'change'>;
const uuid = z.string().uuid();
const revisionNumber=z.number().int().min(0).max(2_147_483_647);
const actorSchema=z.object({kind:z.enum(['user','agent','system']),label:z.string().min(1).max(80),id:uuid.optional()}).strict();
export const checkpointIdSchema=z.union([uuid,z.string().regex(/^revision:(?:0|[1-9][0-9]{0,9})$/)]);
const checkpointSchema=z.object({id:checkpointIdSchema,label:z.string().trim().min(1).max(80),revision:revisionNumber,createdAt:z.string().datetime(),actor:actorSchema,kind:z.enum(['named','before-agent','before-build','before-restore','before-merge'])}).strict();
const metadataResultSchema=z.object({projectId:uuid,revision:revisionNumber,checkpoint:checkpointSchema.optional(),removed:uuid.optional()}).strict();
type MetadataResult=z.infer<typeof metadataResultSchema>;
const pointerSchema = z.object({ schemaVersion: z.union([z.literal(1),z.literal(2)]), revision: revisionNumber, version: uuid, undo: z.array(uuid).max(200), redo: z.array(uuid).max(200), operations: z.record(z.string(), z.object({hash:z.string().length(64),version:uuid,revision:revisionNumber,canUndo:z.boolean(),canRedo:z.boolean()})),historyStart:revisionNumber.optional(),checkpoints:z.array(checkpointSchema).max(400).default([]),checkpointOperations:z.record(z.string(),z.object({hash:z.string().length(64),result:metadataResultSchema})).default({}) });
type Pointer=z.infer<typeof pointerSchema>;
type RevisionRecord=ProjectRevision&{schemaVersion:1;projectId:string;version:string};
const MAX_REVISION_RECORD_BYTES=1_000_000;
const identitySchema=z.object({kind:z.enum(['text','asset']),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative(),mime:z.string().max(100)}).strict();
const recordSchema=z.object({schemaVersion:z.literal(1),projectId:uuid,version:uuid,revision:revisionNumber,previousRevision:revisionNumber.optional(),at:z.string().datetime(),actor:actorSchema,summary:z.string().max(400),checkpointId:checkpointIdSchema,changes:z.object({files:z.array(z.object({path:z.string().max(240),status:z.enum(['added','modified','removed']),before:identitySchema.optional(),after:identitySchema.optional()}).strict()).max(512),settings:z.array(z.string().max(40)).max(16),librariesAdded:z.array(z.string().max(80)).max(32),librariesRemoved:z.array(z.string().max(80)).max(32)}).strict()}).strict();
const contentSchema = z.object({ schemaVersion: z.union([z.literal(1),z.literal(2)]), id: projectId, title: z.string().min(1).max(80), template: templateSchema, createdAt: z.string(), updatedAt: z.string(), settings: settingsSchema, libraries: z.array(z.string()).max(32), libraryAcceptances:libraryAcceptancesSchema.optional(), files: z.array(z.string()).max(256),assets:z.record(z.string(),assetSchema).default({}) });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const creationsSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({id:uuid,hash:z.string().length(64)}));

export async function atomicWrite(filename: string, value: string | Buffer) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  try { await rename(temp, filename); } catch (error) { await rm(temp, { force: true }); throw error; }
  if(process.platform!=='win32'){const directory=await open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}}
}

export class ProjectStore {
  private queues = new Map<string, Promise<unknown>>();
  private lockToken = randomUUID();
  private closed = false;
  private actors=new AsyncLocalStorage<ProjectActor>();
  constructor(public readonly root: string, private onChange: (id: string) => void = () => {}) {}
  runAs<T>(actor:ProjectActor,operation:()=>Promise<T>){return this.actors.run(validate(actorSchema,actor),operation);}
  private actor():ProjectActor{return this.actors.getStore()??{kind:'user',label:'You'};}

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.root, '.writer.lock');
    try {
      const old = JSON.parse(await readFile(lockPath, 'utf8'));
      if (Number.isSafeInteger(old.pid) && old.pid > 0 && typeof old.token === 'string') {
        try { process.kill(old.pid, 0); throw new AppError('PROJECTS_IN_USE', 'These projects are already open in another builder process.'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          const current = JSON.parse(await readFile(lockPath, 'utf8'));
          if (current.token === old.token) await rm(lockPath);
        }
      } else throw new AppError('INVALID_LOCK', 'The project writer lock is damaged. Close other builder processes before recovering it.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await lock.close();
    } catch { throw new AppError('PROJECTS_IN_USE', 'Another builder process is opening these projects.'); }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    const file = path.join(this.root, '.writer.lock');
    try { const lock = JSON.parse(await readFile(file, 'utf8')); if (lock.token === this.lockToken) await rm(file); } catch { /* No lock owned by this instance. */ }
  }
  private directory(id: string) { validate(projectId, id); return path.join(this.root, id); }
  private async checkDirectory(directory: string) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await realpath(directory)).startsWith((await realpath(this.root)) + path.sep)) throw new AppError('UNSAFE_PATH', 'The project directory must remain inside its granted workspace.');
  }
  private async pointer(id: string): Promise<Pointer> {
    const directory = this.directory(id); await this.checkDirectory(directory);
    const filename = path.join(directory, 'project.btcsite');
    if ((await lstat(filename)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', 'Project manifests cannot be symbolic links.');
    return validate(pointerSchema, JSON.parse(await readFile(filename, 'utf8')));
  }
  private async serialized<T>(id:string,operation:()=>Promise<T>){
    validate(projectId,id);if(this.closed)throw new AppError('STORE_CLOSED','The application is closing.');
    const task=(this.queues.get(id)??Promise.resolve()).catch(()=>{}).then(operation);this.queues.set(id,task);
    try{return await task;}finally{if(this.queues.get(id)===task)this.queues.delete(id);}
  }
  private async saveRecord(id:string,record:RevisionRecord){
    const directory=path.join(this.directory(id),'revisions');await mkdir(directory,{recursive:true,mode:0o700});await this.checkDirectory(directory);
    if(!(await realpath(directory)).startsWith((await realpath(this.directory(id)))+path.sep))throw new AppError('UNSAFE_PATH','Revision records must stay inside this project.');
    const json=JSON.stringify(validate(recordSchema,record));if(Buffer.byteLength(json)>MAX_REVISION_RECORD_BYTES)throw new AppError('REVISION_TOO_LARGE','The change record exceeds the history storage limit.');
    await atomicWrite(path.join(directory,record.revision+'.json'),json);
  }
  private legacyRecord(id:string,p:Pointer,content:Content):RevisionRecord{return {schemaVersion:1,projectId:id,version:p.version,revision:p.revision,at:content.updatedAt,actor:{kind:'system',label:'Earlier saved project'},summary:'History begins with this saved version',checkpointId:'revision:'+p.revision,changes:{files:[],settings:[],librariesAdded:[],librariesRemoved:[]}};}
  private async ensureHistory(id:string,p:Pointer,content?:Content){
    if(p.historyStart!==undefined)return;
    await this.saveRecord(id,this.legacyRecord(id,p,content??await this.content(id,p.version)));p.historyStart=p.revision;p.schemaVersion=2;
  }
  private async revisionRecord(id:string,revision:number,p:Pointer):Promise<RevisionRecord>{
    validate(revisionNumber,revision);const first=p.historyStart??p.revision;
    if(revision<first||revision>p.revision)throw new AppError('REVISION_NOT_AVAILABLE',`Revision ${revision} is not recorded in this project. Recorded history begins at revision ${first}.`);
    if(p.historyStart===undefined)return this.legacyRecord(id,p,await this.content(id,p.version));
    const filename=path.join(this.directory(id),'revisions',revision+'.json'),stat=await lstat(filename);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_REVISION_RECORD_BYTES||!(await realpath(filename)).startsWith((await realpath(this.directory(id)))+path.sep))throw new AppError('UNSAFE_PATH','This revision record is not a bounded local project file.');
    const record=validate(recordSchema,JSON.parse(await readFile(filename,'utf8')));
    if(record.projectId!==id||record.revision!==revision||revision===p.revision&&record.version!==p.version)throw new AppError('REVISION_MISMATCH','The revision record does not match this project.');
    return record;
  }
  private publicRecord({schemaVersion,projectId,version,...record}:RevisionRecord):ProjectRevision{return record;}
  private async changeRecord(id:string,revision:number,p:Pointer):Promise<ProjectChange|undefined>{
    if(p.historyStart===undefined||revision<p.historyStart)return;
    const record=await this.revisionRecord(id,revision,p);return record.previousRevision===undefined?undefined:{...this.publicRecord(record),beforeCheckpointId:'revision:'+record.previousRevision};
  }
  private automaticCheckpoint(p:Pointer,revision:number,kind:ProjectCheckpoint['kind'],label:string,actor:ProjectActor){
    const checkpoint:ProjectCheckpoint={id:'revision:'+revision,label:label.slice(0,80),revision,createdAt:new Date().toISOString(),actor,kind};
    const named=p.checkpoints.filter(c=>c.kind==='named'),automatic=p.checkpoints.filter(c=>c.kind!=='named'&&c.id!==checkpoint.id);
    p.checkpoints=[...named,...automatic.slice(-199),checkpoint];return checkpoint;
  }
  async listHistory(id:string,options:{before?:number;limit?:number}={}):Promise<ProjectHistory>{
    const input=validate(z.object({before:revisionNumber.optional(),limit:z.number().int().min(1).max(50).default(30)}).strict(),options),p=await this.pointer(id),first=p.historyStart??p.revision;
    const start=Math.min(p.revision,(input.before??p.revision+1)-1),revisions:ProjectRevision[]=[];
    let bytes=0;
    for(let revision=start;revision>=first&&revisions.length<input.limit;revision--){const record=this.publicRecord(await this.revisionRecord(id,revision,p)),size=Buffer.byteLength(JSON.stringify(record));if(revisions.length&&bytes+size>256_000)break;revisions.push(record);bytes+=size;}
    const last=revisions.at(-1)?.revision;
    return {projectId:id,revision:p.revision,availableFrom:first,revisions,nextBefore:last!==undefined&&last>first?last:undefined,checkpoints:[...p.checkpoints].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
  }
  async readRevision(id:string,revision:number){const p=await this.pointer(id),record=await this.revisionRecord(id,revision,p);return {...await this.content(id,record.version),revision,record:this.publicRecord(record)};}
  async diff(id:string,fromRevision:number,toRevision:number,options:{path?:string;maxCharacters?:number;maxLines?:number}={}){
    const input=validate(z.object({path:z.string().max(240).optional(),maxCharacters:z.number().int().min(1000).max(64_000).optional(),maxLines:z.number().int().min(20).max(1000).optional()}).strict(),options);if(input.path)safeRelativePath(input.path);
    const p=await this.pointer(id),from=await this.revisionRecord(id,fromRevision,p),to=await this.revisionRecord(id,toRevision,p);
    const [before,after]=await Promise.all([this.content(id,from.version),this.content(id,to.version)]);return compareProjects(id,fromRevision,toRevision,before,after,input);
  }
  async checkpoint(context:Mutation,label:string):Promise<MetadataResult>{
    validate(mutationSchema,context);label=validate(z.string().trim().min(1).max(80),label);const actor=this.actor();
    return this.serialized(context.projectId,async()=>{
      const p=await this.pointer(context.projectId),hash=digest({context,label,action:'checkpoint'}),prior=p.checkpointOperations[context.idempotencyKey];
      if(p.operations[context.idempotencyKey])throw new AppError('IDEMPOTENCY_CONFLICT','This key was already used for a source edit.');
      if(prior){if(prior.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for a different checkpoint change.');return prior.result;}
      if(p.revision!==context.expectedRevision)throw new AppError('REVISION_CONFLICT','The project changed. Refresh its history before saving a checkpoint.',p.revision);
      if(p.checkpoints.filter(c=>c.kind==='named').length>=200)throw new AppError('CHECKPOINT_LIMIT','This project has 200 named checkpoints. Remove an unused label to save another; recorded revisions remain available.');
      await this.ensureHistory(context.projectId,p);
      const checkpoint:ProjectCheckpoint={id:randomUUID(),label,revision:p.revision,createdAt:new Date().toISOString(),actor,kind:'named'};p.checkpoints.push(checkpoint);
      const result={projectId:context.projectId,revision:p.revision,checkpoint};await this.saveCheckpointMetadata(context,p,hash,result);return result;
    });
  }
  async removeCheckpoint(context:Mutation,id:string):Promise<MetadataResult>{
    validate(mutationSchema,context);validate(uuid,id);
    return this.serialized(context.projectId,async()=>{
      const p=await this.pointer(context.projectId),hash=digest({context,id,action:'checkpoint-remove'}),prior=p.checkpointOperations[context.idempotencyKey];
      if(p.operations[context.idempotencyKey])throw new AppError('IDEMPOTENCY_CONFLICT','This key was already used for a source edit.');
      if(prior){if(prior.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for a different checkpoint change.');return prior.result;}
      if(p.revision!==context.expectedRevision)throw new AppError('REVISION_CONFLICT','The project changed. Refresh history before removing this label.',p.revision);
      if(!p.checkpoints.some(c=>c.id===id&&c.kind==='named'))throw new AppError('CHECKPOINT_NOT_FOUND','That named checkpoint is no longer in this project.');
      p.checkpoints=p.checkpoints.filter(c=>c.id!==id);const result={projectId:context.projectId,revision:p.revision,removed:id};await this.saveCheckpointMetadata(context,p,hash,result);return result;
    });
  }
  private async saveCheckpointMetadata(context:Mutation,p:Pointer,hash:string,result:MetadataResult){
    p.checkpointOperations[context.idempotencyKey]={hash,result};for(const key of Object.keys(p.checkpointOperations).slice(0,-200))delete p.checkpointOperations[key];
    await atomicWrite(path.join(this.directory(context.projectId),'project.btcsite'),JSON.stringify(p,null,2));this.onChange(context.projectId);
  }
  async checkpointForBuild(id:string,revision:number){
    const actor=this.actor();return this.serialized(id,async()=>{const p=await this.pointer(id);await this.ensureHistory(id,p);await this.revisionRecord(id,revision,p);
      const prior=p.checkpoints.find(c=>c.id==='revision:'+revision);if(prior)return prior;
      const checkpoint=this.automaticCheckpoint(p,revision,'before-build',`Before build · Revision ${revision}`,actor);await atomicWrite(path.join(this.directory(id),'project.btcsite'),JSON.stringify(p,null,2));this.onChange(id);return checkpoint;
    });
  }
  restore(context:Mutation,id:string){
    validate(checkpointIdSchema,id);
    return this.change(context,{type:'restore',checkpointId:id},async(content,p)=>{
      const revision=id.startsWith('revision:')?Number(id.slice(9)):p.checkpoints.find(c=>c.id===id)?.revision;
      if(revision===undefined)throw new AppError('CHECKPOINT_NOT_FOUND','That checkpoint is not available in this project.');
      const record=await this.revisionRecord(content.id,revision,p),target=await this.content(content.id,record.version);
      for(const asset of Object.values(target.assets))await this.readAsset(content.id,asset.sha256);
      return {content:target};
    });
  }
  private async content(id: string, version: string): Promise<Content> {
    validate(uuid, version);
    const directory = path.join(this.directory(id), 'versions', version); await this.checkDirectory(directory);
    const metaFile = path.join(directory, 'manifest.json');
    if ((await lstat(metaFile)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', 'Snapshot metadata cannot be a symbolic link.');
    const meta = validate(contentSchema, JSON.parse(await readFile(metaFile, 'utf8')));
    if (meta.id !== id) throw new AppError('PROJECT_MISMATCH', 'The saved project identity does not match.');
    const files: Record<string,string> = {}; let total = 0;
    const canonicalDirectory=await realpath(directory);
    for (const relative of meta.files) {
      safeRelativePath(relative);
      const file = path.join(directory, 'source', relative);
      if (!(await realpath(file)).startsWith(canonicalDirectory + path.sep) || !(await lstat(file)).isFile()) throw new AppError('UNSAFE_PATH', 'Source files must stay in their project snapshot.');
      const stat = await lstat(file); total += stat.size;
      if (stat.size > 2_000_000 || total > 8_000_000) throw new AppError('PROJECT_TOO_LARGE', 'This text project exceeds the current editor limits.');
      files[relative] = await readFile(file, 'utf8');
    }
    validateAssets(meta.assets,files);
    resolveLibraries(meta.libraries,meta.libraryAcceptances);
    return { ...meta,schemaVersion:2,files };
  }
  private async saveVersion(content: Content) {
    const version = randomUUID();
    const directory = path.join(this.directory(content.id), 'versions', version);
    await mkdir(path.join(directory, 'source'), { recursive: true, mode: 0o700 });
    for (const [relative, text] of Object.entries(content.files)) {
      safeRelativePath(relative);
      const filename = path.join(directory, 'source', relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await atomicWrite(filename, text);
    }
    await atomicWrite(path.join(directory, 'manifest.json'), JSON.stringify({ ...content, files: Object.keys(content.files) }, null, 2));
    if(process.platform!=='win32'){
      const directories=new Set<string>([path.join(directory,'source'),directory,path.dirname(directory)]);
      for(const relative of Object.keys(content.files)){let parent=path.dirname(path.join(directory,'source',relative));while(parent.startsWith(directory+path.sep)){directories.add(parent);parent=path.dirname(parent);}}
      for(const name of [...directories].sort((a,b)=>b.length-a.length)){const handle=await open(name,'r');try{await handle.sync();}finally{await handle.close();}}
    }
    return version;
  }
  async read(id: string): Promise<ProjectSnapshot> {
    const p = await this.pointer(id);
    return { ...await this.content(id, p.version), revision: p.revision, canUndo: p.undo.length > 0, canRedo: p.redo.length > 0,change:await this.changeRecord(id,p.revision,p) };
  }
  async list(): Promise<ProjectSummary[]> {
    const dirs = await readdir(this.root, { withFileTypes: true }); const items: ProjectSummary[] = [];
    for (const dir of dirs.filter(d=>d.isDirectory() && uuid.safeParse(d.name).success)) {
      try { const p = await this.read(dir.name); items.push({id:p.id,title:p.title,template:p.template,revision:p.revision,updatedAt:p.updatedAt}); } catch { /* One damaged project does not hide healthy projects. */ }
    }
    return items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  async create(input: { title: string; template: TemplateId }, request?: {scope:string;idempotencyKey:string},initial?:{entries:ImportedFile[];libraries:string[];settings?:SiteSettings;libraryAcceptances?:import('../shared/types').LibraryAcceptance[]}): Promise<ProjectSnapshot> {
    validate(z.object({ title: z.string().trim().min(1).max(80), template: templateSchema }).strict(), input);
    if (this.closed) throw new AppError('STORE_CLOSED', 'The application is closing.');
    const task=(this.queues.get('create')??Promise.resolve()).catch(()=>{}).then(async()=>{
    let id:string = randomUUID();
    if(request){
      validate(z.object({scope:z.string().min(1).max(160),idempotencyKey:z.string().min(1).max(128)}).strict(),request);
      const registryFile=path.join(this.root,'.creations.json');
      let registry:z.infer<typeof creationsSchema>={};
      try{registry=validate(creationsSchema,JSON.parse(await readFile(registryFile,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const key=digest(request),hash=digest({input,initial:initial?{entries:initial.entries.map(f=>({path:f.path,sha256:createHash('sha256').update(f.bytes).digest('hex')})),libraries:initial.libraries,libraryAcceptances:initial.libraryAcceptances,settings:initial.settings}:null}),prior=registry[key];
      if(prior){
        if(prior.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This creation key was already used for a different project.');
        id=prior.id;
        let exists=false;try{await lstat(path.join(this.directory(id),'project.btcsite'));exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(exists)return this.read(id);
      }else{
        if(Object.keys(registry).length>=10000)throw new AppError('WORKSPACE_LIMIT','This workspace has reached its project creation limit.');
        registry[key]={id,hash};await atomicWrite(registryFile,JSON.stringify(registry));
      }
    }
    const now = new Date().toISOString(), settings = initialSettings(input.template, input.title.trim());
    await mkdir(this.directory(id), { mode: 0o700,recursive:true });await this.checkDirectory(this.directory(id));
    let content: Content = { schemaVersion:2,id,title:settings.name,template:input.template,createdAt:now,updatedAt:now,settings,libraries:templates.find(t=>t.id===input.template)!.libraries,files:{'index.html':createTemplate(input.template,settings)},assets:{} };
    if(input.template==='runes')content.files['rune.json']=JSON.stringify(defaultRune,null,2)+'\n';
    if(['collection','image','recursive'].includes(input.template))content.files['collection.json']=JSON.stringify({...defaultCollection(settings.name),layout:input.template==='image'?'showcase':'grid'},null,2)+'\n';
    if(initial){
      if(!initial.entries.some(f=>f.path==='index.html'))throw new AppError('ENTRY_REQUIRED','The imported website needs an index.html at its root.');
      resolveLibraries(initial.libraries,initial.libraryAcceptances);
      content=await this.mergeImports({...content,files:{},libraries:[...new Set(initial.libraries)],libraryAcceptances:initial.libraryAcceptances,settings:initial.settings?validate(settingsSchema,initial.settings):settings},initial.entries);
    }
    const version = await this.saveVersion(content);
    await this.saveRecord(id,{schemaVersion:1,projectId:id,version,revision:0,at:now,actor:this.actor(),summary:initial?'Imported project':'Created project',checkpointId:'revision:0',changes:summarizeChanges({files:{},assets:{},settings:content.settings,libraries:[]},content)});
    const pointer: Pointer = {schemaVersion:2,revision:0,version,undo:[],redo:[],operations:{},historyStart:0,checkpoints:[],checkpointOperations:{}};
    await atomicWrite(path.join(this.directory(id),'project.btcsite'),JSON.stringify(pointer,null,2));
    if(process.platform!=='win32'){const directory=await open(this.root,'r');try{await directory.sync();}finally{await directory.close();}}
    this.onChange(id); return this.read(id);
    });
    this.queues.set('create',task);
    try{return await task;}finally{if(this.queues.get('create')===task)this.queues.delete('create');}
  }
  private async change(context: Mutation, operation: unknown, apply: (content: Content, pointer: Pointer) => Promise<{ content: Content; history?: 'undo' | 'redo' }>): Promise<ProjectSnapshot> {
    validate(mutationSchema, context);
    const actor=this.actor();
    if (this.closed) throw new AppError('STORE_CLOSED', 'The application is closing.');
    const previous = this.queues.get(context.projectId) ?? Promise.resolve();
    const run = previous.catch(()=>{}).then(async () => {
      const p=await this.pointer(context.projectId), hash=digest({context,operation});
      if(p.checkpointOperations[context.idempotencyKey])throw new AppError('IDEMPOTENCY_CONFLICT','This key was already used for a checkpoint change.');
      const prior=p.operations[context.idempotencyKey];
      if(prior){if(prior.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This operation key was already used for a different change.');return {...await this.content(context.projectId,prior.version),revision:prior.revision,canUndo:prior.canUndo,canRedo:prior.canRedo,change:await this.changeRecord(context.projectId,prior.revision,p)};}
      if(p.revision!==context.expectedRevision)throw new AppError('REVISION_CONFLICT','The project changed. Reload it before applying this edit.',p.revision);
      const before=await this.content(context.projectId,p.version),result=await apply(before,p);
      const files=Object.values(result.content.files);
      if(files.length>256||files.some(file=>Buffer.byteLength(file)>2_000_000)||files.reduce((n,file)=>n+Buffer.byteLength(file),0)>8_000_000)throw new AppError('PROJECT_TOO_LARGE','Keep source within 256 files, 2 MB per file, and 8 MB total.');
      validateAssets(result.content.assets,result.content.files);
      await this.ensureHistory(context.projectId,p,before);
      result.content.updatedAt=new Date().toISOString();
      const version=await this.saveVersion(result.content);
      const changes=summarizeChanges(before,result.content),op=operation as {type:string;relative?:string;from?:string;to?:string;key?:string;checkpointId?:string};
      const summary=op.type==='settings'?`Updated ${changes.settings.join(', ')||'website settings'}`:op.type==='file'||op.type==='file-patch'?`Edited ${op.relative}`:op.type==='file-merge'?`Merged ${op.relative} with saved source`:op.type==='file-rename'?`Renamed ${op.from} to ${op.to}`:op.type==='file-remove'?`Removed ${op.from}`:op.type==='import'?`Imported ${changes.files.length} ${changes.files.length===1?'file':'files'}`:op.type==='library-add'?`Updated ${op.key} include and credits`:op.type==='undo'?'Undid the previous edit':op.type==='redo'?'Redid an edit':op.type==='restore'?`Restored ${op.checkpointId?.startsWith('revision:')?'revision '+op.checkpointId.slice(9):p.checkpoints.find(c=>c.id===op.checkpointId)?.label??'a checkpoint'}`:'Updated project source';
      const record:RevisionRecord={schemaVersion:1,projectId:context.projectId,version,revision:p.revision+1,previousRevision:p.revision,at:result.content.updatedAt,actor,summary:summary.slice(0,400),changes,checkpointId:'revision:'+(p.revision+1)};
      await this.saveRecord(context.projectId,record);
      if(actor.kind==='agent')this.automaticCheckpoint(p,p.revision,'before-agent',`Before ${actor.label} changes`,actor);
      else if(op.type==='restore')this.automaticCheckpoint(p,p.revision,'before-restore','Before restoring a checkpoint',actor);
      else if(op.type==='file-merge')this.automaticCheckpoint(p,p.revision,'before-merge',`Before merging ${op.relative}`,actor);
      const undo=result.history==='undo'?p.undo.slice(0,-1):[...p.undo,p.version].slice(-200);
      const redo=result.history==='undo'?[...p.redo,p.version].slice(-200):result.history==='redo'?p.redo.slice(0,-1):[];
      const next:Pointer={...p,version,revision:p.revision+1,undo,redo,operations:{...p.operations,[context.idempotencyKey]:{hash,version,revision:p.revision+1,canUndo:undo.length>0,canRedo:redo.length>0}}};
      const keys=Object.keys(next.operations);for(const key of keys.slice(0,Math.max(0,keys.length-200)))delete next.operations[key];
      await atomicWrite(path.join(this.directory(context.projectId),'project.btcsite'),JSON.stringify(next,null,2));
      this.onChange(context.projectId);
      return {...result.content,revision:next.revision,canUndo:undo.length>0,canRedo:redo.length>0,change:{...this.publicRecord(record),beforeCheckpointId:'revision:'+p.revision}};
    });
    this.queues.set(context.projectId,run);
    try { return await run; } finally { if(this.queues.get(context.projectId)===run)this.queues.delete(context.projectId); }
  }
  updateSettings(context: Mutation, changes: Partial<SiteSettings>) {
    const values=validate(settingsSchema.partial(),changes);
    return this.change(context,{type:'settings',changes:values},async content=>{
      if(values.heroImage){safeRelativePath(values.heroImage);if(!Object.hasOwn(content.files,values.heroImage)&&!Object.hasOwn(content.assets,values.heroImage))throw new AppError('ASSET_NOT_FOUND','Import the image before using it on this page.');if(!mimeFor(values.heroImage).startsWith('image/'))throw new AppError('IMAGE_REQUIRED','Choose an image for the main page.');}
      return {content:{...content,title:values.name??content.title,settings:{...content.settings,...values},files:{...content.files,'index.html':updateTemplateFields(content.files['index.html'],values,content.settings)}}};
    });
  }
  writeFile(context: Mutation, relative: string, text: string) {
    safeRelativePath(relative);validate(z.string().max(2_000_000),text);
    if(!isTextFile(relative))throw new AppError('TEXT_FILE_REQUIRED','Use a standard HTML, CSS, JavaScript, JSON, SVG, or text extension for source files.');
    return this.change(context,{type:'file',relative,text},async content=>{if(content.assets[relative])throw new AppError('PATH_COLLISION','An imported asset already uses this path. Rename it before creating a source file.');return {content:this.withSource(content,relative,text)};});
  }
  private withSource(content:Content,relative:string,text:string){
    let settings=content.settings;
    // Unsupported or deeply nested custom markup must remain editable even if
    // its visual-field interpretation is unavailable.
    if(relative==='index.html')try{settings=readTemplateSettings(text,settings);}catch{/* Preserve the exact source and the prior visual fallback. */}
    let result={...content,title:settings.name===content.settings.name?content.title:settings.name,settings,files:{...content.files,[relative]:text}};
    // Keep valid managed previews in sync with direct source edits. Malformed
    // design files and custom markup remain editable; the compiler blocks an
    // invalid publication, and the repair UI preserves the original source.
    if(relative==='collection.json'&&['collection','image','recursive'].includes(content.template))try{result=this.withCollection(result,collectionSchema.parse(JSON.parse(text)));result.files[relative]=text;}catch{}
    if(relative==='rune.json'&&content.template==='runes')try{const plan=runePlan(JSON.parse(text));result.files['index.html']=this.updateOrdinalDesign(result,runeHTML(result.settings,plan.spec,plan.supply),'rune',result.settings);}catch{}
    return result;
  }
  mergeFile(context:Mutation,request:MergeCommit,resolve:(project:Content&{revision:number})=>string|null){
    safeRelativePath(request.path);if(!isTextFile(request.path))throw new AppError('TEXT_FILE_REQUIRED','Choose a supported source file.');
    return this.change(context,{type:'file-merge',relative:request.path,...request},async(content,p)=>{
      const text=resolve({...content,revision:p.revision});
      if(text===null){if(Object.hasOwn(content.files,request.path)||Object.hasOwn(content.assets,request.path))throw new AppError('MERGE_MISMATCH','This review cannot remove an existing file.');return {content};}
      if(content.assets[request.path])throw new AppError('PATH_COLLISION','The current path contains an asset.');
      return {content:this.withSource(content,request.path,text)};
    });
  }
  async readAsset(id:string,sha256:string){
    validate(projectId,id);validate(z.string().regex(/^[a-f0-9]{64}$/),sha256);
    const directory=this.directory(id);await this.checkDirectory(directory);
    const filename=path.join(directory,'assets',sha256);
    const stat=await lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8_000_000||!(await realpath(filename)).startsWith((await realpath(directory))+path.sep))throw new AppError('UNSAFE_PATH','The asset must remain inside its project.');
    const bytes=await readFile(filename);if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new AppError('ASSET_INTEGRITY','The stored asset differs from its recorded content hash. Reimport the original file.');return bytes;
  }
  private async mergeImports(content:Content,entries:ImportedFile[]):Promise<Content>{
    if(entries.length<1||entries.length>256)throw new AppError('IMPORT_LIMIT','Import between 1 and 256 web files at a time.');
    const files={...content.files},assets={...content.assets},bodies=new Map<string,Buffer>(),imported=new Set<string>();
    for(const entry of entries){
      safeRelativePath(entry.path);if(imported.has(entry.path))throw new AppError('PATH_COLLISION','The import contains a duplicate path.');imported.add(entry.path);
      if(isTextFile(entry.path)){if(entry.bytes.length>2_000_000)throw new AppError('FILE_TOO_LARGE','Each source file must be smaller than 2 MB.');files[entry.path]=decodeText(entry.bytes);delete assets[entry.path];}
      else{const asset=describeAsset(entry.path,entry.bytes);assets[entry.path]=asset;bodies.set(asset.sha256,entry.bytes);delete files[entry.path];}
    }
    validateAssets(assets,files);
    if(Object.values(files).reduce((total,text)=>total+Buffer.byteLength(text),0)>8_000_000)throw new AppError('PROJECT_TOO_LARGE','Keep text source within 8 MB per project.');
    const assetDirectory=path.join(this.directory(content.id),'assets');await mkdir(assetDirectory,{recursive:true,mode:0o700});await this.checkDirectory(assetDirectory);
    for(const [sha256,body] of bodies)await atomicWrite(path.join(assetDirectory,sha256),body);
    return {...content,files,assets};
  }
  importFiles(context:Mutation,entries:ImportedFile[]){
    const fingerprint=entries.map(f=>({path:f.path,sha256:createHash('sha256').update(f.bytes).digest('hex')}));
    return this.change(context,{type:'import',files:fingerprint},async content=>({content:await this.mergeImports(content,entries)}));
  }
  replaceFiles(context:Mutation,files:Record<string,string>,assets:Record<string,SourceAsset>,operation:unknown){
    return this.change(context,operation,async content=>{validateAssets(assets,files);if(!files['index.html'])throw new AppError('ENTRY_REQUIRED','Keep an index.html entry point in the project.');return {content:{...content,files,assets}};});
  }
  changeFile(context:Mutation,from:string,to?:string,graph?:BuildArtifact){
    safeRelativePath(from);if(to)safeRelativePath(to);
    return this.change(context,{type:to?'file-rename':'file-remove',from,to},async(content,p)=>{
      if((['collection','image','recursive'].includes(content.template)&&from==='collection.json')||(content.template==='runes'&&from==='rune.json'))throw new AppError('CREATOR_SPEC_REQUIRED','Keep the project design file. Edit it in Code or restore a version in History.');
      const spec=['collection','image','recursive'].includes(content.template)?readCollection(content.files):null;if(spec?.items.some(item=>item.path===from)&&!to)throw new AppError('COLLECTION_MEMBER_REFERENCED','Remove this member from the collection before deleting its source asset.');
      const updated={...content,...changeFile({...content,revision:p.revision,canUndo:p.undo.length>0,canRedo:p.redo.length>0},from,to,graph)};
      if(spec?.items.some(item=>item.path===from)&&to)updated.files['collection.json']=JSON.stringify({...spec,items:spec.items.map(item=>item.path===from?{...item,path:to}:item)},null,2)+'\n';return {content:updated};
    });
  }
  patchFile(context:Mutation,relative:string,baseHash:string,edits:{search:string;replacement:string}[]){
    safeRelativePath(relative);validate(z.string().regex(/^[a-f0-9]{64}$/),baseHash);
    validate(z.array(z.object({search:z.string().min(1).max(100_000),replacement:z.string().max(200_000)}).strict()).min(1).max(30),edits);
    return this.change(context,{type:'file-patch',relative,baseHash,edits},async content=>{
      let source=content.files[relative];if(source===undefined)throw new AppError('FILE_NOT_FOUND','That source file is not in this project.');
      if(createHash('sha256').update(source).digest('hex')!==baseHash)throw new AppError('FILE_CONFLICT','The file content changed. Read it again before applying this patch.');
      for(const edit of edits){
        const position=source.indexOf(edit.search);
        if(position<0||source.indexOf(edit.search,position+1)>=0)throw new AppError('PATCH_AMBIGUOUS','Each patch search must match exactly once. Include more surrounding text.');
        source=source.slice(0,position)+edit.replacement+source.slice(position+edit.search.length);
      }
      return {content:this.withSource(content,relative,source)};
    });
  }
  history(context: Mutation, direction: 'undo'|'redo') {
    return this.change(context,{type:direction},async (content,p)=>{const target=p[direction].at(-1);if(!target)throw new AppError('NO_HISTORY',`There is nothing to ${direction}.`);return {content:await this.content(content.id,target),history:direction};});
  }
  private updateOrdinalDesign(content:Content,next:string,kind:'collection'|'rune',settings:SiteSettings){
    const start=`<!-- btcsite-${kind}:start -->`,end=`<!-- btcsite-${kind}:end -->`,source=content.files['index.html'];
    if(!source.includes(start)||!source.includes(end)||source.indexOf(start)!==source.lastIndexOf(start)||source.indexOf(end)!==source.lastIndexOf(end)||source.indexOf(end)<source.indexOf(start))throw new AppError('CUSTOM_DESIGN','The visual editor markers were removed. Restore an earlier version in History or edit the design in Code. Your custom source is preserved.');
    const updated=source.slice(0,source.indexOf(start))+next.slice(next.indexOf(start),next.indexOf(end)+end.length)+source.slice(source.indexOf(end)+end.length);
    return withLibraryNotices(updateTemplateFields(updated,Object.fromEntries(Object.entries(settings).filter(([key,value])=>value!==content.settings[key as keyof SiteSettings])),content.settings),content.libraries,content.libraryAcceptances);
  }
  configureCollection(context:Mutation,value:CollectionSpec){return this.change(context,{type:'file',relative:'collection.json',value},async content=>({content:this.withCollection(content,validate(collectionSchema,value))}));}
  private withCollection(content:Content,spec:CollectionSpec):Content{
    if(!['collection','image','recursive'].includes(content.template))throw new AppError('COLLECTION_PROJECT_REQUIRED','Create an image collection project to use this editor.');
    for(const item of spec.items){safeRelativePath(item.path);const mime=content.assets[item.path]?.mime??(content.files[item.path]!==undefined?mimeFor(item.path):'');if(!/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mime))throw new AppError('COLLECTION_IMAGE_REQUIRED',`Import the image ${item.path} before adding it to this collection.`);}
    if(content.template==='image'&&spec.items.length>1)throw new AppError('ONE_IMAGE_ONLY','Use an Image collection project to include multiple works.');
    const settings={...content.settings,name:spec.name,headline:spec.name,description:spec.description};
    return {...content,title:spec.name,settings,files:{...content.files,'collection.json':JSON.stringify(spec,null,2)+'\n','index.html':this.updateOrdinalDesign(content,collectionHTML(settings,spec),'collection',settings)}};
  }
  importCollection(context:Mutation,entries:ImportedFile[]){return this.change(context,{type:'import',files:entries.map(e=>({path:e.path,sha256:createHash('sha256').update(e.bytes).digest('hex')}))},async content=>{
    const imported=await this.mergeImports(content,entries),prior=readCollection(content.files)??defaultCollection(content.title),items=[...prior.items];
    for(const entry of entries)if(!items.some(i=>i.path===entry.path))items.push({path:entry.path,name:path.posix.basename(entry.path).replace(/\.[^.]+$/,''),description:'',attributes:[]});
    return {content:this.withCollection(imported,validate(collectionSchema,{...prior,items}))};
  });}
  configureRune(context:Mutation,value:RuneSpec){let plan;try{plan=runePlan(value)}catch(error){throw new AppError('INVALID_RUNE',(error as Error).message)}return this.change(context,{type:'file',relative:'rune.json',value},async content=>{if(content.template!=='runes')throw new AppError('RUNE_PROJECT_REQUIRED','Create a Rune project to use this editor.');return {content:{...content,files:{...content.files,'rune.json':JSON.stringify(plan.spec,null,2)+'\n','index.html':this.updateOrdinalDesign(content,runeHTML(content.settings,plan.spec,plan.supply),'rune',content.settings)}}};});}
  duplicateCollectionItem(context:Mutation,relative:string){safeRelativePath(relative);return this.change(context,{type:'collection-edition',relative},async content=>{
    const spec=readCollection(content.files),original=spec?.items.find(item=>item.path===relative);if(!spec||!original)throw new AppError('ITEM_NOT_FOUND','Select a saved collection item.');
    const extension=path.posix.extname(relative),stem=relative.slice(0,-extension.length);let next=stem+'-edition-2'+extension,n=3;while(Object.hasOwn(content.files,next)||Object.hasOwn(content.assets,next))next=stem+'-edition-'+n+++extension;
    const copy={...content,files:{...content.files},assets:{...content.assets}};if(content.assets[relative])copy.assets[next]={...content.assets[relative],path:next};else copy.files[next]=content.files[relative];
    const items=[...spec.items],index=items.indexOf(original);items.splice(index+1,0,{...original,path:next,name:(original.name+' · edition').slice(0,120)});return {content:this.withCollection(copy,validate(collectionSchema,{...spec,items}))};
  });}
  addLibrary(context: Mutation,key:string,acceptance?:import('../shared/types').LibraryAcceptance) {
    return this.change(context,{type:'library-add',key,acceptance},async content=>{
      const acceptances=acceptance?libraryAcceptancesSchema.parse([...(content.libraryAcceptances??[]).filter(a=>a.key!==key),acceptance]):content.libraryAcceptances??[];
      if(acceptance?.key!==undefined&&acceptance.key!==key)throw new AppError('LIBRARY_ACCEPTANCE_MISMATCH','Accept the warning for this exact library.');
      const library=resolveLibraries([key],acceptances)[0];
      if(key==='three-core-r178')throw new AppError('UNKNOWN_LIBRARY','Add Three.js to include its core dependency.');
      if(!content.libraries.includes(key)&&library.name==='p5.js'&&content.libraries.some(k=>k.startsWith('p5-')))throw new AppError('LIBRARY_CONFLICT','This site already has a p5.js version. Keep one version per page.');
      if(!content.libraries.includes(key)&&needsLibraryWarning(library)&&!acceptance)throw new AppError('LIBRARY_WARNING_REQUIRED','Click Add in the library browser and accept the warning before including this unqualified library.');
      if(content.libraries.includes(key))return {content:{...content,libraryAcceptances:acceptances,files:{...content.files,'index.html':withLibraryNotices(content.files['index.html'],content.libraries,acceptances)}}};
      if(content.libraries.length>=32)throw new AppError('LIBRARY_LIMIT','A project supports up to 32 library includes.');
      const attrs=`data-btcsite-library="${key}"`,url=`/content/${library.id}`;
      const tag=library.format==='classic'?`<script ${attrs} src="${url}"></script>`:library.format==='esm'?library.key.startsWith('research-')?`<script type="module" ${attrs} src="${url}"></script>`:`<script type="importmap" ${attrs}>${JSON.stringify({imports:{[library.packageName]:url}})}</script>`:library.format==='stylesheet'?`<link rel="stylesheet" ${attrs} href="${url}">`:`<link rel="preload" as="fetch" crossorigin="anonymous" ${attrs} href="${url}">`;
      const html=content.files['index.html'];if(!/<\/head>/i.test(html))throw new AppError('HTML_HEAD_REQUIRED','Add a closing </head> element before inserting a library.');
      return {content:{...content,libraries:[...content.libraries,key],libraryAcceptances:acceptances,files:{...content.files,'index.html':withLibraryNotices(html.replace(/<\/head>/i,`${tag}\n</head>`),[...content.libraries,key],acceptances)}}};
    });
  }
}
