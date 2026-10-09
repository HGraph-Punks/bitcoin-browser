import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {chmod,lstat,mkdir,readFile,rm} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {WorkspaceService,inspectBuild,inspectProject} from '../core/service';
import {atomicWrite} from '../core/project-store';
import {AppError,safeError} from '../core/errors';
import {projectId,validate} from '../core/validation';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const grantSchema=z.object({id:z.string().uuid(),label:z.string().min(1).max(60),tokenHash:z.string().length(64),projects:z.array(projectId).max(1000),allowCreate:z.boolean(),allowDeploy:z.boolean().default(false),createdAt:z.string(),revoked:z.boolean()}).strict();
type Grant=z.infer<typeof grantSchema>;
export type AgentConnection={schemaVersion:1;endpoint:string;token:string;grantId:string};
export type AgentActivity={at:string;grantId:string;label:string;command:string;projectId?:string;ok:boolean;code?:string};
const allowed=new Set(['project.list','project.create','project.inspect','project.settings','project.file','project.patch','project.history','file.read','file.list','file.rename','file.remove','asset.import','asset.remove','asset.read','template.list','library.search','library.inspect','library.add','build.create','build.inspect','dependency.inspect','preview.start','preview.reload','preview.inspect','preview.screenshot','preview.stop']);
for(const command of ['deployment.capabilities','deployment.list','deployment.plan','deployment.quote','deployment.request-review','deployment.status','deployment.resume','operation.get','operation.cancel'])allowed.add(command);
allowed.add('deployment.requote');
const mutations=new Set(['project.settings','project.file','project.patch','project.history','library.add','file.rename','file.remove','asset.import','asset.remove']);
for(const command of ['project.history-list','project.checkpoint','project.checkpoint-remove','project.restore','project.diff','project.revision-file'])allowed.add(command);
mutations.add('project.restore');
for(const command of ['file.merge-prepare','file.merge-inspect','file.merge-read','file.merge-apply'])allowed.add(command);
mutations.add('file.merge-apply');
const publicCommands=new Set(['template.list','library.search','library.inspect','library.research']);
allowed.add('library.research');
for(const command of ['collection.configure','collection.duplicate','rune.configure','metaprotocol.configure'])allowed.add(command);

// A filesystem-protected local socket is separate from every renderer session.
// Tokens authorize only named projects and optional creation in the owned store.
export class AgentBridge {
  private grants:Grant[]=[];
  private activity:AgentActivity[]=[];
  private lastSeen=new Map<string,string>();
  private counts=new Map<string,{start:number;count:number;active:number}>();
  private server?:net.Server;
  private sockets=new Set<net.Socket>();
  private writes:Promise<unknown>=Promise.resolve();
  private endpoint='';
  constructor(private directory:string,private service:WorkspaceService,private changed:()=>void,private openProject:(id:string,deploymentId?:string)=>void=()=>{}){}
  private get registry(){return path.join(this.directory,'grants.json');}
  private connectionPath(id:string){return path.join(this.directory,id+'.connection.json');}
  private save(){const value=JSON.stringify(this.grants,null,2);const next=this.writes.catch(()=>{}).then(()=>atomicWrite(this.registry,value));this.writes=next;return next;}
  async initialize(){
    await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
    try{this.grants=validate(z.array(grantSchema).max(1000),JSON.parse(await readFile(this.registry,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const socketKey=hash(this.directory).slice(0,20);
    if(process.platform==='win32')this.endpoint=`\\\\.\\pipe\\btcsite-${socketKey}`;
    else{
      const socketDirectory=path.join(os.tmpdir(),`btcsite-${process.getuid?.()??'user'}-${socketKey}`);
      await mkdir(socketDirectory,{recursive:true,mode:0o700});const stat=await lstat(socketDirectory);
      if(stat.isSymbolicLink()||!stat.isDirectory()||process.getuid&&stat.uid!==process.getuid())throw new AppError('UNSAFE_BRIDGE','The agent socket directory is not owned by this user.');
      await chmod(socketDirectory,0o700);this.endpoint=path.join(socketDirectory,'service.sock');await rm(this.endpoint,{force:true});
    }
    this.server=net.createServer(socket=>this.accept(socket));
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.endpoint,resolve);});
    if(process.platform!=='win32')await chmod(this.endpoint,0o600);
  }
  snapshot(){return {connections:this.grants.filter(g=>!g.revoked).map(({tokenHash,...g})=>({...g,lastSeen:this.lastSeen.get(g.id),scopes:['project:read','project:edit','preview:run','build:create',...(g.allowDeploy?['deploy:prepare','deploy:observe','deploy:resume-authorized']:[])]})),activity:this.activity.slice(-30)};}
  async create(input:{label:string;projectIds:string[];allowCreate:boolean;allowDeploy?:boolean}){
    const p=validate(z.object({label:z.string().trim().min(1).max(60),projectIds:z.array(projectId).max(50),allowCreate:z.boolean(),allowDeploy:z.boolean().default(false)}).strict(),input);
    if(!p.projectIds.length&&!p.allowCreate)throw new AppError('EMPTY_GRANT','Choose a project or allow new projects.');
    for(const id of p.projectIds)await this.service.store.read(id);
    if(this.grants.filter(g=>!g.revoked).length>=20||this.grants.length>=1000)throw new AppError('CONNECTION_LIMIT','This workspace has reached its AI connection limit.');
    const token=randomBytes(32).toString('base64url'),id=randomUUID();
    const grant:Grant={id,label:p.label,tokenHash:hash(token),projects:[...new Set(p.projectIds)],allowCreate:p.allowCreate,allowDeploy:p.allowDeploy,createdAt:new Date().toISOString(),revoked:false};
    const config:AgentConnection={schemaVersion:1,endpoint:this.endpoint,token,grantId:id};
    this.grants.push(grant);await this.save();await atomicWrite(this.connectionPath(id),JSON.stringify(config));this.changed();
    return {id,connectionPath:this.connectionPath(id)};
  }
  async revoke(id:string){validate(projectId,id);const grant=this.grants.find(g=>g.id===id);if(!grant)throw new AppError('GRANT_NOT_FOUND','This connection no longer exists.');grant.revoked=true;await this.save();await rm(this.connectionPath(id),{force:true});this.changed();await this.service.revokeScope(id);return {revoked:true};}
  private accept(socket:net.Socket){
    this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(120_000,()=>socket.destroy());
    let input=Buffer.alloc(0),started=false;
    socket.on('data',chunk=>{
      if(started){socket.destroy();return;}input=Buffer.concat([input,Buffer.from(chunk)]);
      if(input.length>3_000_000){socket.destroy();return;}
      const newline=input.indexOf(10);if(newline===-1)return;started=true;
      if(newline!==input.length-1){socket.destroy();return;}
      void this.handle(input.subarray(0,newline)).then(result=>{if(!socket.destroyed)socket.end(JSON.stringify(result)+'\n');});
    });
  }
  private async handle(input:Buffer){
    let grant:Grant|undefined,command='',requestedProject:string|undefined,count:{start:number;count:number;active:number}|undefined,ok=false,code:string|undefined;
    try{
      const request=validate(z.object({token:z.string().min(40).max(64),grantId:projectId,command:z.string().max(60),payload:z.record(z.string(),z.unknown())}).strict(),JSON.parse(input.toString('utf8')));
      const candidate=this.grants.find(g=>g.id===request.grantId&&!g.revoked);
      if(!candidate||!timingSafeEqual(Buffer.from(candidate.tokenHash,'hex'),Buffer.from(hash(request.token),'hex')))throw new AppError('ACCESS_DENIED','This AI connection is unavailable or was revoked. Reconnect from the app.');
      grant=candidate;command=request.command;const payload=request.payload;
      if(!allowed.has(command))throw new AppError('COMMAND_DENIED','This command is outside the AI connection’s authoring scope.');
      if((command.startsWith('deployment.')||command.startsWith('operation.'))&&!grant.allowDeploy)throw new AppError('DEPLOYMENT_DENIED','This connection has no publication planning or observation grant. Enable it when creating an AI connection in the app.');
      count=this.counts.get(grant.id);if(!count||Date.now()-count.start>60_000){count={start:Date.now(),count:0,active:0};this.counts.set(grant.id,count);}
      if(count.count>=300||count.active>=4){count=undefined;throw new AppError('RATE_LIMIT','Wait for the current operations to finish before retrying.');}count.count++;count.active++;
      this.lastSeen.set(grant.id,new Date().toISOString());
      if(command==='project.list'){
        validate(z.object({}).strict(),payload);const items=await this.service.store.list();ok=true;return {ok:true,data:items.filter(p=>grant!.projects.includes(p.id))};
      }
      if(command==='project.create'){
        if(!grant.allowCreate)throw new AppError('ACCESS_DENIED','This connection may edit its selected project but cannot create projects.');
        if(grant.projects.length>=1000)throw new AppError('PROJECT_LIMIT','This connection has reached its project limit.');
        if(typeof payload.idempotencyKey!=='string')throw new AppError('INVALID_INPUT','Project creation requires an idempotency key.');
      }else if(!publicCommands.has(command)){
        requestedProject=validate(projectId,payload.projectId);
        if(!grant.projects.includes(requestedProject))throw new AppError('ACCESS_DENIED','This project is outside the connection’s grant.');
      }
      const result=await this.service.execute(command,payload,grant.id,{kind:'agent',label:grant.label,id:grant.id});
      if(grant.revoked&&command.startsWith('deployment.')){await this.service.revokeScope(grant.id);throw new AppError('ACCESS_DENIED','This publication request lost its grant. Unapproved work was canceled.');}
      if(command==='project.create'){
        if(!grant.projects.includes(result.id)){grant.projects.push(result.id);await this.save();}
        requestedProject=result.id;this.openProject(result.id);
      }
      if(command==='preview.start')this.openProject(requestedProject!);
      if(command==='deployment.request-review')this.openProject(requestedProject!,result.id);
      const data=command==='project.create'||mutations.has(command)?inspectProject(result):command==='build.create'?inspectBuild(result):result;
      ok=true;return {ok:true,projectId:requestedProject,revision:data?.revision,data};
    }catch(error){code=safeError(error).code;return {ok:false,error:{...safeError(error),retryable:error instanceof AppError&&['REVISION_CONFLICT','RATE_LIMIT'].includes(error.code)}};}
    finally{
      if(count)count.active--;
      if(grant){this.activity.push({at:new Date().toISOString(),grantId:grant.id,label:grant.label,command,projectId:requestedProject,ok,code});this.activity=this.activity.slice(-100);this.changed();}
    }
  }
  async close(){for(const socket of this.sockets)socket.destroy();await this.writes.catch(()=>{});if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));if(this.endpoint&&process.platform!=='win32')await rm(this.endpoint,{force:true});}
}
