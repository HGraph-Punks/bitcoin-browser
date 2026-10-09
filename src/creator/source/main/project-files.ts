import {isProtocolCreation} from '../shared/metaprotocols';
import {dialog,Menu,type BrowserWindow} from 'electron';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {ProjectStore,atomicWrite} from '../core/project-store';
import {AppError} from '../core/errors';
import {validate,projectId,mutationSchema,safeRelativePath} from '../core/validation';
import {encodeProject,decodeProject,readWebsiteFolder,exportWebsiteFolder,MAX_ARCHIVE_BYTES} from '../core/portable';
import {libraries} from '../catalog/libraries';
import {readTemplateSettings,initialSettings} from '../core/templates';
import {readInputFile} from '../core/input-files';
import {prepareResource} from '../compiler/build';
import {readCollection,collectionItemSchema} from '../shared/ordinals';
import type {BuildArtifact,ProjectSnapshot} from '../shared/types';

type Format='archive'|'folder'|'html'|'payload';
const slug=(title:string)=>title.replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,80)||'Bitcoin website';

/** Host paths originate only from native dialogs; MCP cannot call this boundary. */
export class NativeProjectFiles {
  constructor(private window:BrowserWindow,private store:ProjectStore,private compile:(project:ProjectSnapshot)=>Promise<BuildArtifact>){}
  async exportDraft(payload:unknown){
    const p=validate(z.object({projectId,path:z.string().max(240),content:z.string().max(8_000_000)}).strict(),payload);safeRelativePath(p.path);await this.store.read(p.projectId);
    if(Buffer.byteLength(p.content)>8_000_000)throw new AppError('DRAFT_TOO_LARGE','Export source drafts up to 8 MB.');
    const name=path.posix.parse(p.path),selection=await dialog.showSaveDialog(this.window,{title:'Save your unsaved source draft',defaultPath:name.name+'.draft'+name.ext});
    if(selection.canceled||!selection.filePath)return {canceled:true};
    await atomicWrite(selection.filePath,p.content);return {canceled:false,filename:path.basename(selection.filePath)};
  }
  async openArchive(payload:unknown){
    validate(z.object({}).strict(),payload??{});
    const selection=await dialog.showOpenDialog(this.window,{title:'Open a project archive',properties:['openFile'],filters:[{name:'Bitcoin Website Builder project',extensions:['btcsite']}]});
    if(selection.canceled||!selection.filePaths[0])return {canceled:true};
    const data=decodeProject(await readInputFile(selection.filePaths[0],MAX_ARCHIVE_BYTES));
    return {canceled:false,project:await this.store.create({title:data.title,template:data.template},undefined,data)};
  }
  async importFolder(payload:unknown){
    validate(z.object({}).strict(),payload??{});
    const selection=await dialog.showOpenDialog(this.window,{title:'Choose the folder containing index.html',properties:['openDirectory']});
    if(selection.canceled||!selection.filePaths[0])return {canceled:true};
    const folder=selection.filePaths[0],data=await readWebsiteFolder(folder);
    const sources=data.entries.filter(e=>/\.(?:html?|css|m?js)$/i.test(e.path)).map(e=>e.bytes.toString('utf8'));
    const selected=libraries.filter(l=>sources.some(text=>text.includes('/content/'+l.id))).map(l=>l.key);
    const title=path.basename(folder).slice(0,80)||'Imported website';
    const settings=readTemplateSettings(data.entries.find(e=>e.path==='index.html')!.bytes.toString('utf8'),initialSettings('blank',title));
    const project=await this.store.create({title:settings.name,template:'blank'},undefined,{entries:data.entries,libraries:selected,settings});
    return {canceled:false,project,skipped:data.skipped};
  }
  async importAssets(payload:unknown,collection=false){
    const p=validate(mutationSchema,payload),project=await this.store.read(p.projectId);
    const selection=await dialog.showOpenDialog(this.window,{title:collection?'Add images to your collection':'Add assets to your website',properties:['openFile','multiSelections'],filters:[{name:'Web assets',extensions:collection?['png','jpg','jpeg','gif','webp','svg']:['png','jpg','jpeg','gif','webp','avif','svg','ico','woff','woff2','ttf','otf','mp3','wav','ogg','mp4','webm','glb','gltf','bin','wasm','json']} ]});
    if(selection.canceled||!selection.filePaths.length)return {canceled:true};
    if(selection.filePaths.length>64)throw new AppError('IMPORT_LIMIT','Import up to 64 assets at a time.');
    const occupied=new Set([...Object.keys(project.files),...Object.keys(project.assets)].map(name=>name.normalize('NFC').toLowerCase())),entries=[];let total=0;
    for(const filename of selection.filePaths){
      const name=path.basename(filename),extension=path.extname(name),stem=name.slice(0,name.length-extension.length);let relative='assets/'+name,index=2;
      while(occupied.has(relative.normalize('NFC').toLowerCase()))relative=`assets/${stem}-${index++}${extension}`;
      occupied.add(relative.normalize('NFC').toLowerCase());const bytes=await readInputFile(filename,8_000_000);total+=bytes.length;if(total>64_000_000)throw new AppError('IMPORT_LIMIT','Import up to 64 MB of assets at a time.');entries.push({path:relative,bytes});
    }
    return {canceled:false,project:collection?await this.store.importCollection(p,entries):await this.store.importFiles(p,entries)};
  }
  async importCollectionMetadata(payload:unknown){
    const p=validate(mutationSchema,payload),project=await this.store.read(p.projectId),spec=readCollection(project.files);if(!spec)throw new AppError('COLLECTION_PROJECT_REQUIRED','Open an image collection first.');
    const choice=await dialog.showOpenDialog(this.window,{title:'Import collection metadata',properties:['openFile'],filters:[{name:'JSON metadata',extensions:['json']}]});if(choice.canceled||!choice.filePaths[0])return {canceled:true};
    let parsed:unknown;try{parsed=JSON.parse((await readInputFile(choice.filePaths[0],1_000_000)).toString('utf8'));}catch{throw new AppError('INVALID_METADATA','Choose a JSON array of {file, name, description, attributes} records.');}
    const records=validate(z.array(z.object({file:z.string().min(1).max(240),name:collectionItemSchema.shape.name,description:collectionItemSchema.shape.description,attributes:collectionItemSchema.shape.attributes}).strict()).max(128),parsed),matches=new Map<string,typeof records[number]>();
    for(const record of records){const candidates=spec.items.filter(item=>item.path===record.file||path.posix.basename(item.path)===record.file);if(candidates.length!==1||matches.has(candidates[0].path))throw new AppError('METADATA_MATCH_FAILED',`Match ${record.file} to exactly one imported image, once. Use its full project path if filenames repeat.`);matches.set(candidates[0].path,record);}
    const items=spec.items.map(item=>{const record=matches.get(item.path);return record?{path:item.path,name:record.name,description:record.description,attributes:record.attributes}:item;});
    return {canceled:false,project:await this.store.configureCollection(p,{...spec,items})};
  }
  async exportProtocol(payload:unknown){const p=validate(z.object({projectId}).strict(),payload),project=await this.store.read(p.projectId);if(!isProtocolCreation(project.template))throw new AppError('PROTOCOL_PROJECT_REQUIRED','Open a protocol creation.');const build=await this.compile(project);if(build.findings.some(f=>f.severity==='error'))throw new AppError('BUILD_BLOCKED','Complete your protocol design before exporting it.');const resource=build.resources[0],extension=resource.path.endsWith('.json')?'json':'txt',selection=await dialog.showSaveDialog(this.window,{title:'Save exact inscription payload',defaultPath:slug(project.title)+'.'+extension,filters:[{name:'Inscription payload',extensions:[extension]}]});if(selection.canceled||!selection.filePath)return {canceled:true};await atomicWrite(selection.filePath,resource.text!);return {canceled:false,sha256:resource.sha256,filename:path.basename(selection.filePath)};}
  async export(payload:unknown){
    const p=validate(z.object({projectId,format:z.enum(['archive','folder','html','payload','choose']).default('choose')}).strict(),payload);
    const project=await this.store.read(p.projectId);let format:Format|undefined=p.format==='choose'?undefined:p.format;
    if(p.format==='choose')format=await new Promise<Format|undefined>(resolve=>{
      let choice:Format|undefined;
      const menu=Menu.buildFromTemplate(isProtocolCreation(project.template)?[{label:'Creation archive (.btcsite)',click:()=>{choice='archive';}},{label:'Exact inscription payload…',click:()=>{choice='payload';}}]:[{label:'Project archive (.btcsite)',click:()=>{choice='archive';}},{label:'Website source folder',click:()=>{choice='folder';}},{type:'separator'},{label:'Final root HTML…',click:()=>{choice='html';}}]);
      menu.popup({window:this.window,callback:()=>resolve(choice)});
    });
    if(!format)return {canceled:true};
    if(format==='payload')return this.exportProtocol({projectId:project.id});
    if(isProtocolCreation(project.template)&&format!=='archive')throw new AppError('PROTOCOL_EXPORT_FORMAT','Export a creation archive or the exact inscription payload.');
    if(format==='folder'){
      const selection=await dialog.showOpenDialog(this.window,{title:'Choose where to save the website folder',properties:['openDirectory','createDirectory']});
      if(selection.canceled||!selection.filePaths[0])return {canceled:true};
      const destination=await mkdtemp(path.join(selection.filePaths[0],slug(project.title)+'-'));
      try{await exportWebsiteFolder(project,destination,this.store);}catch(error){await rm(destination,{recursive:true,force:true});throw error;}
      return {canceled:false,filename:path.basename(destination),format};
    }
    let body:Buffer|string,sha256:string|undefined;
    if(format==='archive')body=await encodeProject(project,(id,sha)=>this.store.readAsset(id,sha));
    else {
      const build=await this.compile(project);
      if(build.hasUnresolvedDependencies)throw new AppError('DEPENDENCIES_UNPUBLISHED','This website has local resources. Export a project archive or website folder; final root HTML requires their published inscription IDs.');
      const final=prepareResource(build,'index.html',{});body=final.text!;sha256=final.sha256;
    }
    const extension=format==='archive'?'btcsite':'html',selection=await dialog.showSaveDialog(this.window,{title:format==='archive'?'Export portable project':'Export final root HTML',defaultPath:slug(project.title)+'.'+extension,filters:[{name:format==='archive'?'Bitcoin Website Builder project':'HTML website',extensions:[extension]}]});
    if(selection.canceled||!selection.filePath)return {canceled:true};
    await atomicWrite(selection.filePath,body);return {canceled:false,filename:path.basename(selection.filePath),format,sha256};
  }
}
