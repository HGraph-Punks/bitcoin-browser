import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, protocol, session, shell, dialog } from 'electron';
import researchCatalog from '../catalog/research-catalog.json';
import {includeLibrary} from './library-inclusions';
import {guideFor} from '../catalog/library-guides';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectStore, atomicWrite } from '../core/project-store';
import { AppError, safeError } from '../core/errors';
import { validate, projectId,safeRelativePath } from '../core/validation';
import { templates } from '../core/templates';
import { libraries } from '../catalog/libraries';

import { NativeDraftPreview } from './native-preview';
import {WorkspaceService} from '../core/service';
import {AgentBridge} from '../agent/bridge';
import {CompilerEngine} from '../compiler/engine';
import {MergeEngine} from '../core/merge-engine';
import {SourceMergeService} from '../core/merge-service';
import {NativeProjectFiles} from './project-files';
import {NativeDeployments} from './deployments';
import {DraftStore,draftSaveInput,draftRemoveInput} from '../core/draft-store';
import {importLegacyProjects} from './import-legacy';


export function createCreatorHost(options:any){
const root=path.join(options.dataDirectory,'creator');
let window:BrowserWindow,store:ProjectStore,preview:NativeDraftPreview,service:WorkspaceService,agents:AgentBridge,projectFiles:NativeProjectFiles,deployments:NativeDeployments;
let ready:Promise<void>|undefined,themePreference:'dark'|'light'='dark',lastProjectId:string|null=null;
let closeAction:(()=>void)|undefined,browseRequest:{target:string;connection?:{network:string;ordUrl:string}}|undefined;
const workerRoot=app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked','src/creator/generated'):__dirname;
const compiler=new CompilerEngine(path.join(workerRoot,'compiler/worker.cjs'));
const mergeEngine=new MergeEngine(path.join(workerRoot,'core/merge-worker.cjs'));
const drafts=new DraftStore(path.join(root,'drafts'));
function currentTheme():'dark'|'light'{const preference=options.theme();return preference==='light'||preference==='system'&&!nativeTheme.shouldUseDarkColors?'light':'dark';}
function changed(type:string,id?:string,deploymentId?:string){const w=options.getWindow();if(w&&!w.isDestroyed()&&w.webContents.getURL()==='app://app/creator/generated/renderer/index.html')w.webContents.send('builder:changed',{type,projectId:id,deploymentId});}
function requestBrowse(target:string,connection?:{network:string;ordUrl:string}){browseRequest={target,connection};changed('browse-request');}
async function showSource(library:any){const result=await dialog.showMessageBox(window,{type:'info',title:library.name+' source',message:library.name+' '+library.version,detail:'Inscription: '+library.id+'\nSHA-256: '+library.sha256+'\nLicense: '+library.license.spdx+'\nUpstream source: '+library.license.sourceCode+'\n\nThe source URL is supplied for provenance. Open the on-chain content in Bitcoin Browser to inspect the exact inscription.',buttons:['Done','View inscription','Copy source URL'],defaultId:0,cancelId:0});if(result.response===1)requestBrowse('satnav://inscription/'+library.id);if(result.response===2)clipboard.writeText(library.license.sourceCode);}
async function initialize(){
  if(ready)return ready;
  ready=(async()=>{await mkdir(root,{recursive:true});store=new ProjectStore(path.join(root,'projects'),id=>changed('project',id));await store.initialize();await drafts.initialize();
    try{lastProjectId=validate(z.object({projectId:projectId.nullable()}).strict(),JSON.parse(await readFile(path.join(root,'session.json'),'utf8'))).projectId;}catch{}
    window=options.getWindow();if(!window||window.isDestroyed())throw new AppError('CREATOR_WINDOW','Open Bitcoin Browser to create a project.');
    themePreference=currentTheme();
    preview=new NativeDraftPreview(options.getWindow,options.resolver,options.settings,()=>changed('preview'),(id,sha)=>store.readAsset(id,sha));preview.attach(window);
    deployments=new NativeDeployments(window,path.join(root,'deployments'),id=>changed('deployment',id),(id,connection)=>requestBrowse('satnav://inscription/'+id,connection));
    service=new WorkspaceService(store,preview,p=>compiler.build(p),()=>deployments.engine,new SourceMergeService(store,input=>mergeEngine.prepare(input)));
    projectFiles=new NativeProjectFiles(window,store,p=>compiler.build(p));
    agents=new AgentBridge(path.join(root,'agent-connections'),service,()=>changed('agents'),(id,deploymentId)=>changed(deploymentId?'agent-review':'agent-open',id,deploymentId));await agents.initialize();
    // Source authoring is ready before any Keychain-dependent backend reconnect.
    void deployments.initialize().catch(()=>changed('deployment'));
  })();return ready;
}
async function importBuilderWorkspace(){
  const selection=await dialog.showOpenDialog(window,{title:'Import Website Builder projects',message:'Choose the Website Builder projects folder. Only project source, assets and revision history are imported. Wallets, node credentials and deployment records stay with the original application.',properties:['openDirectory']});
  if(selection.canceled||!selection.filePaths[0])return {canceled:true};
  return importLegacyProjects(selection.filePaths[0],path.join(root,'projects'));
}
async function command(name:string,payload:unknown){
  if(name.startsWith('backend.')||['deployment.authorize','deployment.resume-owner','deployment.refresh','deployment.copy-id','deployment.export-receipt'].includes(name))return deployments.command(name,payload);
  switch(name){
    case 'draft.list':{const p=validate(z.object({projectId}).strict(),payload);await store.read(p.projectId);return drafts.list(p.projectId);}
    case 'draft.save':{const p=validate(draftSaveInput,payload),project=await store.read(p.projectId);if(p.baseRevision>project.revision)throw new AppError('INVALID_BASE','A recovery copy cannot begin at a future revision.');return drafts.save(p);}
    case 'draft.remove':{const p=validate(draftRemoveInput,payload);await store.read(p.projectId);return drafts.remove(p);}
    case 'app.bootstrap':themePreference=currentTheme();return {projects:await store.list(),templates,libraries:libraries.filter(l=>l.key!=='three-core-r178'),researchLibraries:researchCatalog.entries,platform:process.platform,theme:themePreference,version:app.getVersion(),lastProjectId,sourceCommit:'96141f4'};
    case 'library.add':return includeLibrary(store,options.resolver,options.settings,payload);
    case 'library.copy':{
      const p=validate(z.object({key:z.string().max(80).optional(),id:z.string().regex(/^[a-f0-9]{64}i\d+$/).optional(),kind:z.enum(['example','id'])}).strict(),payload);
      const library=libraries.find(l=>l.key===p.key||l.id===p.id);
      if(p.kind==='example'){const guide=library&&guideFor(library);if(!library||!guide)throw new AppError('UNKNOWN_LIBRARY','Choose a supported library example.');clipboard.writeText(guide.example(library));}
      else{const id=library?.id??researchCatalog.entries.find(r=>r.id===p.id)?.id;if(!id)throw new AppError('UNKNOWN_LIBRARY','Choose a catalog inscription.');clipboard.writeText(id);}
      return {copied:true};
    }
    case 'library.open':{const p=validate(z.object({key:z.string().max(80).optional(),id:z.string().regex(/^[a-f0-9]{64}i\d+$/).optional(),target:z.enum(['upstream','inscription'])}).strict(),payload);const library=libraries.find(l=>l.key===p.key||l.id===p.id),id=library?.id??researchCatalog.entries.find(r=>r.id===p.id)?.id;if(!id)throw new AppError('UNKNOWN_LIBRARY','Choose a catalog inscription.');if(p.target==='upstream'&&library){await showSource(library);return {opened:true};}requestBrowse('satnav://inscription/'+id);return {opened:true};}
    case 'library.open-source':{const p=validate(z.object({key:z.string().max(80)}).strict(),payload),library=libraries.find(l=>l.key===p.key);if(!library)throw new AppError('UNKNOWN_LIBRARY','Choose a catalog library.');await showSource(library);return {opened:true};}
    case 'deployment.open':return deployments.command(name,payload);
    case 'build.export':{const p=validate(z.object({projectId}).strict(),payload);return projectFiles.export({...p,format:'html'});}
    case 'project.export':return projectFiles.export(payload);
    case 'project.export-draft':return projectFiles.exportDraft(payload);
    case 'project.open-dialog':return projectFiles.openArchive(payload);
    case 'project.import-folder':return projectFiles.importFolder(payload);
    case 'asset.import-dialog':return projectFiles.importAssets(payload);
    case 'file.copy-path':{const p=validate(z.object({projectId,path:z.string().max(240)}).strict(),payload);safeRelativePath(p.path);const project=await store.read(p.projectId);if(!Object.hasOwn(project.files,p.path)&&!Object.hasOwn(project.assets,p.path))throw new AppError('FILE_NOT_FOUND','This file is no longer in the project.');clipboard.writeText(p.path);return {copied:true};}
    case 'preview.bounds':{const p=validate(z.object({rect:z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().min(0).max(10000),height:z.number().min(0).max(10000)}).nullable()}).strict(),payload);preview.setBounds(p.rect);return null;}
    case 'preview.inspect':return preview.inspect();
    case 'preview.screenshot':return preview.screenshot();
    case 'preview.loaded':{const p=validate(z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),failed:z.boolean().default(false)}).strict(),payload);preview.loaded(p.buildId,p.failed);return null;}
    case 'app.browse':{validate(z.object({}).strict(),payload??{});const target=browseRequest;await preview.stop();await options.browse(target?.target,target?.connection);browseRequest=undefined;return null;}
    case 'app.creator-session':{const p=validate(z.object({projectId:projectId.nullable()}).strict(),payload);await atomicWrite(path.join(root,'session.json'),JSON.stringify(p));lastProjectId=p.projectId;return null;}
    case 'project.import-builder':return importBuilderWorkspace();
    case 'agent.list':return agents.snapshot();
    case 'agent.create':{
      const p=validate(z.object({label:z.string().min(1).max(60),projectIds:z.array(projectId).max(50),allowCreate:z.boolean(),allowDeploy:z.boolean().default(false)}).strict(),payload),connection=await agents.create(p);
      const args=[...(app.isPackaged?[]:[app.getAppPath()]),'--creator-mcp','--connection',connection.connectionPath];
      const settings=JSON.stringify({mcpServers:{'bitcoin-browser-create':{command:process.execPath,args}}},null,2);
      await clipboard.writeText(settings);return {id:connection.id,settings};
    }
    case 'agent.revoke':return agents.revoke(validate(z.object({id:projectId}).strict(),payload).id);
    case 'app.close-ready':if(closeAction){const action=closeAction;closeAction=undefined;action();}return null;
    case 'app.theme':{const p=validate(z.object({theme:z.enum(['dark','light'])}).strict(),payload);await options.setTheme(p.theme);themePreference=p.theme;nativeTheme.themeSource=p.theme;return p;}
    default:return service.execute(name,payload);
  }
}

return {
  initialize,
  async command(name:string,payload:unknown){await initialize();return command(name,payload);},
  async resolveDraft(request:Request){if(!ready)return new Response('Open Create mode to preview a draft',{status:404});await ready;return preview.resolve(request);},
  async resolveAsset(request:Request){if(!ready)return new Response('Not found',{status:404});await ready;const url=new URL(request.url),match=/^\/creator-assets\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(url.pathname);if(!match||!['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404});try{const project=await store.read(match[1]),asset=Object.values(project.assets).find(a=>a.sha256===match[2]);if(!asset||!/^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mime))return new Response('Not found',{status:404});const bytes=await store.readAsset(project.id,asset.sha256);return new Response(request.method==='HEAD'?null:new Uint8Array(bytes),{headers:{'content-type':asset.mime,'content-length':String(bytes.length),'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});}catch{return new Response('Not found',{status:404});}},
  deferClose(action:()=>void){if(!ready)return false;closeAction=action;changed('closing');return true;},
  async shutdown(){if(ready)await ready.catch(()=>{});await agents?.close();await deployments?.close();await drafts.close();await compiler.close();await mergeEngine.close();await preview?.close();await store?.close();}
};
}
