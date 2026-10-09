import {metaprotocolSchema,protocolEntry,isProtocolCreation} from '../shared/metaprotocols';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ProjectStore,checkpointIdSchema} from './project-store';
import type {ProjectActor} from '../shared/history';
import {AppError} from './errors';
import {decodeBase64} from './assets';
import {validate,mutationSchema,projectId,settingsSchema,templateSchema,safeRelativePath} from './validation';
import {templates} from './templates';
import {collectionSchema,runeSchema} from '../shared/ordinals';
import {libraries,libraryByKey} from '../catalog/libraries';
import researchCatalog from '../catalog/research-catalog.json';
import {guideFor,matchesLibrary} from '../catalog/library-guides';
import {buildProject} from '../compiler/build';
import type {BuildArtifact,PreviewState,ProjectSnapshot} from '../shared/types';
import type {DeploymentEngine} from '../deploy/engine';
import {SourceMergeService} from './merge-service';
import {mergeApplySchema,mergePrepareSchema,mergeReadSchema,mergeIdSchema} from './merge-validation';

export interface PreviewHost {
  start(build:BuildArtifact,force?:boolean):Promise<PreviewState|null>;
  inspect():PreviewState|null;
  screenshot():Promise<{dataUrl:string;width:number;height:number;buildId?:string}>;
  stop():Promise<void>;
}
const projectInput=z.object({projectId}).strict();
const revisionInput=z.object({projectId,expectedRevision:z.number().int().nonnegative().optional()}).strict();
export function inspectProject(p:ProjectSnapshot){
  return {id:p.id,revision:p.revision,title:p.title,template:p.template,settings:p.settings,libraries:p.libraries,libraryAcceptances:p.libraryAcceptances,assets:p.assets,createdAt:p.createdAt,updatedAt:p.updatedAt,canUndo:p.canUndo,canRedo:p.canRedo,change:p.change,
    files:Object.entries(p.files).map(([name,text])=>({path:name,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),uri:`btcsite://projects/${p.id}/files/${encodeURIComponent(name)}`}))};
}
export function inspectBuild(build:BuildArtifact){const {html,resources,...result}=build;return {...result,resources:resources.map(({source,text,references,containers,...resource})=>resource)};}

// One command boundary is shared by desktop IPC and the scoped agent bridge.
export class WorkspaceService {
  private builds=new Map<string,BuildArtifact>();
  private compilations=new Map<string,Promise<BuildArtifact>>();
  private previewRequest?:{key:string;promise:Promise<PreviewState|null>};
  private previewGeneration=0;
  readonly merges:SourceMergeService;
  constructor(readonly store:ProjectStore,private preview?:PreviewHost,private compile:(project:ProjectSnapshot)=>Promise<BuildArtifact>=async project=>buildProject(project),private deployment?:()=>DeploymentEngine|undefined,merges?:SourceMergeService){this.merges=merges??new SourceMergeService(store);}
  async revokeScope(scope:string){await this.deployment?.()?.revokeScope(scope);}
  private async atRevision(input:unknown){const p=validate(revisionInput,input),project=await this.store.read(p.projectId);if(p.expectedRevision!==undefined&&p.expectedRevision!==project.revision)throw new AppError('REVISION_CONFLICT','The project changed. Inspect it before building or previewing.',project.revision);return project;}
  private build(project:ProjectSnapshot){const key=project.id+':'+project.revision;let task=this.compilations.get(key);if(!task){task=this.compile(project).catch(error=>{this.compilations.delete(key);throw error;});this.compilations.set(key,task);if(this.compilations.size>6)this.compilations.delete(this.compilations.keys().next().value!);}return task;}
  async execute(name:string,payload:unknown,creationScope?:string,actor:ProjectActor={kind:'user',label:'You'}):Promise<any>{return this.store.runAs(actor,()=>this.executeAs(name,payload,creationScope));}
  private async executeAs(name:string,payload:unknown,creationScope?:string):Promise<any>{
    if(name.startsWith('deployment.')||name.startsWith('operation.')){
      const engine=this.deployment?.();if(!engine)throw new AppError('BACKEND_NOT_CONFIGURED','Connect the local Bitcoin Core / Ord backend in the desktop Inscribe screen first.');
      if(name==='deployment.capabilities'){validate(projectInput,payload);try{return await engine.backend.qualify();}catch(error){return engine.backend.capabilities(false,error instanceof AppError?error.message:'The backend is unavailable.');}}
      if(name==='deployment.list')return engine.list(validate(projectInput,payload).projectId);
      if(name==='deployment.plan'){
        const p=validate(z.object({projectId,buildId:z.string().regex(/^[a-f0-9]{64}$/),destination:z.string().min(10).max(100),feeRate:z.number().int().min(1).max(1000),postageSats:z.number().int().min(10000).max(1000000).default(10000),idempotencyKey:z.string().min(1).max(128)}).strict(),payload);
        const build=this.builds.get(`${p.projectId}:${p.buildId}`);if(!build)throw new AppError('BUILD_NOT_FOUND','Create this build again before freezing deployment.');const project=await this.store.read(p.projectId);
        return engine.create({build,title:project.title,destination:p.destination,feeRate:p.feeRate,postageSats:p.postageSats,idempotencyKey:p.idempotencyKey,scope:creationScope??'desktop'},sha=>this.store.readAsset(p.projectId,sha));
      }
      const schema=z.object({projectId,deploymentId:z.string().uuid()}).strict();
      if(name==='deployment.request-review'){const p=validate(schema.extend({quoteId:z.string().uuid()}).strict(),payload);return engine.requestReview(p.projectId,p.deploymentId,p.quoteId);}
      if(name==='deployment.requote'){const p=validate(schema.extend({quoteId:z.string().uuid()}).strict(),payload);return engine.requote(p.projectId,p.deploymentId,p.quoteId);}
      if(name==='deployment.resume'){const p=validate(schema.extend({idempotencyKey:z.string().min(1).max(128)}).strict(),payload);return engine.resume(p.projectId,p.deploymentId,p.idempotencyKey,creationScope??'desktop');}
      const p=validate(schema,payload);
      if(name==='deployment.status'||name==='operation.get')return engine.status(p.projectId,p.deploymentId);
      if(name==='deployment.quote')return engine.quote(p.projectId,p.deploymentId);
      if(name==='operation.cancel')return engine.cancel(p.projectId,p.deploymentId);
      throw new AppError('COMMAND_DENIED','The domain command surface cannot authorize publication. Use the owner’s desktop review.');
    }
    switch(name){
      case 'project.list':validate(z.object({}).strict(),payload);return this.store.list();
      case 'project.create':{const p=validate(z.object({title:z.string().min(1).max(80),template:templateSchema,idempotencyKey:z.string().min(1).max(128).optional()}).strict(),payload);return this.store.create({title:p.title,template:p.template},p.idempotencyKey?{scope:creationScope??'desktop',idempotencyKey:p.idempotencyKey}:undefined);}
      case 'project.read':return this.store.read(validate(projectInput,payload).projectId);
      case 'project.inspect':return inspectProject(await this.store.read(validate(projectInput,payload).projectId));
      case 'project.settings':{const p=validate(mutationSchema.extend({changes:settingsSchema.partial()}).strict(),payload);return this.store.updateSettings(p,p.changes);}
      case 'project.file':{const p=validate(mutationSchema.extend({path:z.string().max(240),content:z.string().max(2_000_000)}).strict(),payload);return this.store.writeFile(p,p.path,p.content);}
      case 'file.merge-prepare':{const p=validate(mergePrepareSchema,payload);return this.merges.prepare(p.projectId,p.path,p.baseRevision,p.draft);}
      case 'file.merge-inspect':{const p=validate(z.object({projectId,mergeId:mergeIdSchema}).strict(),payload);return this.merges.inspect(p.projectId,p.mergeId);}
      case 'file.merge-read':{const p=validate(mergeReadSchema,payload);return this.merges.read(p.projectId,p.mergeId,p.side,{choices:p.choices,manualContent:p.manualContent},p.offset,p.limit,p.conflictId);}
      case 'file.merge-apply':{const p=validate(mergeApplySchema,payload),request={mergeId:p.mergeId,path:p.path,resultHash:p.resultHash,choices:p.choices,manualContent:p.manualContent};return this.store.mergeFile(p,request,current=>this.merges.resolve(current,request));}
      case 'project.patch':{const p=validate(mutationSchema.extend({path:z.string().max(240),baseHash:z.string().regex(/^[a-f0-9]{64}$/),edits:z.array(z.object({search:z.string().min(1).max(100_000),replacement:z.string().max(200_000)}).strict()).min(1).max(30)}).strict(),payload);return this.store.patchFile(p,p.path,p.baseHash,p.edits);}
      case 'project.history':{const p=validate(mutationSchema.extend({direction:z.enum(['undo','redo'])}).strict(),payload);return this.store.history(p,p.direction);}
      case 'project.history-list':{const p=validate(z.object({projectId,before:z.number().int().min(0).max(2_147_483_647).optional(),limit:z.number().int().min(1).max(50).default(30)}).strict(),payload);return this.store.listHistory(p.projectId,{before:p.before,limit:p.limit});}
      case 'project.checkpoint':{const p=validate(mutationSchema.extend({label:z.string().trim().min(1).max(80)}).strict(),payload);return this.store.checkpoint(p,p.label);}
      case 'project.checkpoint-remove':{const p=validate(mutationSchema.extend({checkpointId:z.string().uuid()}).strict(),payload);return this.store.removeCheckpoint(p,p.checkpointId);}
      case 'project.restore':{const p=validate(mutationSchema.extend({checkpointId:checkpointIdSchema}).strict(),payload);return this.store.restore(p,p.checkpointId);}
      case 'project.diff':{const p=validate(z.object({projectId,fromRevision:z.number().int().min(0).max(2_147_483_647),toRevision:z.number().int().min(0).max(2_147_483_647),path:z.string().max(240).optional(),maxCharacters:z.number().int().min(1000).max(64_000).optional(),maxLines:z.number().int().min(20).max(1000).optional()}).strict(),payload);return this.store.diff(p.projectId,p.fromRevision,p.toRevision,{path:p.path,maxCharacters:p.maxCharacters,maxLines:p.maxLines});}
      case 'project.revision-file':{
        const p=validate(z.object({projectId,revision:z.number().int().min(0).max(2_147_483_647),path:z.string().max(240),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(64_000).default(32_000)}).strict(),payload);safeRelativePath(p.path);
        const revision=await this.store.readRevision(p.projectId,p.revision),source=revision.files[p.path],asset=revision.assets[p.path];
        if(source!==undefined)return {projectId:p.projectId,revision:p.revision,path:p.path,kind:'text',sha256:createHash('sha256').update(source).digest('hex'),content:source.slice(p.offset,p.offset+p.limit),offset:p.offset,totalCharacters:source.length,nextOffset:p.offset+p.limit<source.length?p.offset+p.limit:null};
        if(!asset)throw new AppError('FILE_NOT_FOUND','This file is not present in the requested revision.');
        const bytes=await this.store.readAsset(p.projectId,asset.sha256);return {projectId:p.projectId,revision:p.revision,path:p.path,kind:'asset',mime:asset.mime,sha256:asset.sha256,offset:p.offset,totalBytes:bytes.length,base64:bytes.subarray(p.offset,p.offset+p.limit).toString('base64'),nextOffset:p.offset+p.limit<bytes.length?p.offset+p.limit:null};
      }
      case 'file.list':{const p=validate(projectInput,payload),project=await this.store.read(p.projectId);return {projectId:p.projectId,revision:project.revision,files:inspectProject(project).files,assets:Object.values(project.assets)};}
      case 'file.rename':{const p=validate(mutationSchema.extend({from:z.string().max(240),to:z.string().max(240)}).strict(),payload),graph=await this.build(await this.store.read(p.projectId));return this.store.changeFile(p,p.from,p.to,graph);}
      case 'file.remove':case 'asset.remove':{const p=validate(mutationSchema.extend({path:z.string().max(240)}).strict(),payload),graph=await this.build(await this.store.read(p.projectId));return this.store.changeFile(p,p.path,undefined,graph);}
      case 'asset.import':{const p=validate(mutationSchema.extend({path:z.string().max(240),base64:z.string().max(2_000_000)}).strict(),payload);return this.store.importFiles(p,[{path:p.path,bytes:decodeBase64(p.base64,1_500_000)}]);}
      case 'asset.read':{
        const p=validate(z.object({projectId,path:z.string().max(240),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(64_000).default(32_000)}).strict(),payload);
        safeRelativePath(p.path);const project=await this.store.read(p.projectId),asset=project.assets[p.path];if(!asset)throw new AppError('ASSET_NOT_FOUND','This asset is not in the project.');
        const bytes=await this.store.readAsset(project.id,asset.sha256);return {projectId:p.projectId,revision:project.revision,path:p.path,mime:asset.mime,sha256:asset.sha256,totalBytes:bytes.length,offset:p.offset,base64:bytes.subarray(p.offset,p.offset+p.limit).toString('base64'),nextOffset:p.offset+p.limit<bytes.length?p.offset+p.limit:null};
      }
      case 'file.read':{
        const p=validate(z.object({projectId,path:z.string().max(240),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(64_000).default(32_000)}).strict(),payload);
        safeRelativePath(p.path);const project=await this.store.read(p.projectId),content=project.files[p.path];if(content===undefined)throw new AppError('FILE_NOT_FOUND','That file is not in this project.');
        return {projectId:p.projectId,revision:project.revision,path:p.path,sha256:createHash('sha256').update(content).digest('hex'),content:content.slice(p.offset,p.offset+p.limit),offset:p.offset,totalCharacters:content.length,nextOffset:p.offset+p.limit<content.length?p.offset+p.limit:null};
      }
      case 'template.list':validate(z.object({}).strict(),payload);return templates;
      case 'collection.duplicate':{const p=validate(mutationSchema.extend({path:z.string().max(240)}).strict(),payload);return this.store.duplicateCollectionItem(p,p.path);}
      case 'collection.configure':{const p=validate(mutationSchema.extend({collection:collectionSchema}).strict(),payload);return this.store.configureCollection(p,p.collection);}
      case 'metaprotocol.configure':{const p=validate(mutationSchema.extend({protocol:metaprotocolSchema}).strict(),payload);return this.store.configureMetaprotocol(p,p.protocol);}
      case 'rune.configure':{const p=validate(mutationSchema.extend({rune:runeSchema}).strict(),payload);return this.store.configureRune(p,p.rune);}
      case 'library.search':{const p=validate(z.object({query:z.string().max(100).default('')}).strict(),payload);return libraries.filter(l=>matchesLibrary(l,p.query)).map(l=>({...l,guide:guideFor(l)?{category:guideFor(l)!.category,useCases:guideFor(l)!.useCases,hint:guideFor(l)!.hint,example:guideFor(l)!.example(l)}:undefined,license:{...l.license,sources:l.license.sources.map(({text,...source})=>source)}}));}
      case 'library.research':{const p=validate(z.object({query:z.string().max(100).default('')}).strict(),payload);return {scope:researchCatalog.scope,sourceSha256:researchCatalog.sourceSha256,entries:researchCatalog.entries.filter(r=>`${r.name} ${r.notes} ${r.aliases.join(' ')} ${r.id}`.toLowerCase().includes(p.query.toLowerCase()))};}
      case 'library.inspect':{const p=validate(z.object({key:z.string().max(80)}).strict(),payload),library=libraryByKey(p.key);if(!library)throw new AppError('UNKNOWN_LIBRARY','This catalog entry is not available.');return library;}
      case 'library.add':{const p=validate(mutationSchema.extend({key:z.string().max(80)}).strict(),payload);return this.store.addLibrary(p,p.key);}
      case 'build.create':{const project=await this.atRevision(payload),checkpoint=await this.store.checkpointForBuild(project.id,project.revision),build={...await this.build(project),sourceCheckpointId:checkpoint.id};this.builds.set(`${project.id}:${build.id}`,build);if(this.builds.size>12)this.builds.delete(this.builds.keys().next().value!);return build;}
      case 'build.inspect':{const p=validate(z.object({projectId,buildId:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),payload),build=this.builds.get(`${p.projectId}:${p.buildId}`);if(!build)throw new AppError('BUILD_NOT_FOUND','Create this build again; it is no longer in the current session.');return inspectBuild(build);}
      case 'dependency.inspect':{const p=validate(projectInput,payload),build=await this.build(await this.store.read(p.projectId));return {projectId:p.projectId,revision:build.revision,root:{path:build.metaprotocol?.path??(build.rune?'rune.json':'index.html'),sha256:build.sha256},resources:inspectBuild(build).resources,stages:build.stages,libraries:build.libraries.map(l=>({key:l.key,id:l.id,sha256:l.sha256,dependencies:l.dependencies})),findings:build.findings,unpublishedFiles:build.unpublishedFiles,coverage:'Parsed HTML, CSS, JavaScript imports/common literal requests, glTF URIs and catalog edges; dynamically constructed edges require runtime inspection.'};}
      case 'preview.start':case 'preview.reload':{
        if(!this.preview)throw new AppError('PREVIEW_UNAVAILABLE','Open the desktop app to run a preview.');
        const project=await this.atRevision(payload),key=project.id+':'+project.revision;if(isProtocolCreation(project.template))throw new AppError('PROTOCOL_NO_PREVIEW','This creation has a native protocol editor and payload review, not a website preview.');
        if(name!=='preview.reload'&&this.previewRequest?.key===key)return this.previewRequest.promise;
        const generation=++this.previewGeneration;
        const promise=this.build(project).then(build=>{if(generation!==this.previewGeneration)throw new AppError('PREVIEW_SUPERSEDED','A newer preview was requested. Inspect the current revision.');return this.preview!.start(build,name==='preview.reload');});
        this.previewRequest={key,promise};promise.catch(()=>{if(this.previewRequest?.promise===promise)this.previewRequest=undefined;});return promise;
      }
      case 'preview.inspect':case 'preview.screenshot':case 'preview.stop':{
        const p=validate(projectInput,payload);if(!this.preview)throw new AppError('PREVIEW_UNAVAILABLE','Open the desktop app to run a preview.');
        const state=this.preview.inspect();if(!state||state.projectId!==p.projectId)throw new AppError('PREVIEW_NOT_FOUND','Start a preview for this project first.');
        if(name==='preview.inspect')return state;if(name==='preview.screenshot')return {...await this.preview.screenshot(),projectId:p.projectId,revision:state.revision,profile:state.profile};this.previewGeneration++;this.previewRequest=undefined;await this.preview.stop();return {stopped:true};
      }
      default:throw new AppError('UNKNOWN_COMMAND','This command is not available.');
    }
  }
}
