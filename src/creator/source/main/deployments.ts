import {app,BrowserWindow,dialog,safeStorage,clipboard} from 'electron';
import {readFile,mkdir,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {randomBytes} from 'node:crypto';
import {AppError,safeError} from '../core/errors';
import {validate,projectId} from '../core/validation';
import {durableWrite,DeploymentStorage,sha256,type SecretProtector} from '../deploy/storage';
import {LocalOrdBackend,localConfigSchema,type LocalOrdConfig} from '../deploy/local-ord';
import {DeploymentEngine} from '../deploy/engine';
import {recordProtector} from '../deploy/record-crypto';
import {readInputFile} from '../core/input-files';

const deploymentInput=z.object({projectId,deploymentId:z.string().uuid()}).strict();
async function secureOperation<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new AppError('SECURE_STORAGE_UNAVAILABLE','macOS secure storage did not respond. Reopen the app after unlocking your login Keychain. No inscription was prepared or submitted.')),20_000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function osProtector(root:string):Promise<SecretProtector> {
  if(!await secureOperation(safeStorage.isAsyncEncryptionAvailable())||process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text')throw new AppError('SECURE_STORAGE_REQUIRED','Unlock the operating system’s secure storage before preparing an inscription.');
  const filename=path.join(root,'vault-key.encrypted');let key:Buffer;
  try{const saved=await readInputFile(filename,4096),decoded=await secureOperation(safeStorage.decryptStringAsync(saved));key=Buffer.from(decoded.result,'base64');if(key.length!==32||key.toString('base64')!==decoded.result)throw new AppError('DEPLOYMENT_DAMAGED','The protected deployment vault key is invalid.');if(decoded.shouldReEncrypt)await durableWrite(filename,await secureOperation(safeStorage.encryptStringAsync(decoded.result)));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const existing=await readdir(path.join(root,'records')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});if(existing.length)throw new AppError('VAULT_KEY_MISSING','The deployment vault key is missing. Restore its protected key and records from the same backup before resuming.');key=randomBytes(32);try{await durableWrite(filename,await secureOperation(safeStorage.encryptStringAsync(key.toString('base64'))));}catch(error){key.fill(0);throw error;}}
  const protector=recordProtector(key);key.fill(0);return protector;
}
export class NativeDeployments {
  engine?:DeploymentEngine;
  private config?:LocalOrdConfig;
  private error?:{code:string;message:string};
  private initializing=true;
  private connections:Promise<unknown>=Promise.resolve();
  constructor(private window:BrowserWindow,private root:string,private changed:(projectId?:string)=>void,private browse:(id:string,connection:{network:string;ordUrl:string})=>void){}
  private configFile(){return path.join(this.root,'local-ord.json');}
  private defaultBinary(){return app.isPackaged?path.join(process.resourcesPath,'ord','ord'):path.join(app.getAppPath(),'.tools/ord/ord-0.29.0/ord');}
  private backend(config:LocalOrdConfig){return new LocalOrdBackend(config,config.ordBinary??this.defaultBinary(),path.join(this.root,'constructor'));}
  private connect(config:LocalOrdConfig,persist=false){
    const next=this.connections.catch(()=>{}).then(async()=>{
      const backend=this.backend(config);if(this.engine&&backend.id!==this.engine.backend.id&&this.engine.hasPending())throw new AppError('PENDING_DEPLOYMENT','Finish or cancel the current backend’s pending publications before changing its connection.');
      await this.engine?.close();this.engine=undefined;const engine=new DeploymentEngine(new DeploymentStorage(path.join(this.root,'records'),await osProtector(this.root)),backend,this.changed);
      try{await engine.initialize();const connections=path.join(this.root,'connections');await mkdir(connections,{recursive:true,mode:0o700});await durableWrite(path.join(connections,backend.id+'.json'),JSON.stringify(config));if(persist)await durableWrite(this.configFile(),JSON.stringify(config));}
      catch(error){await engine.close();throw error;}
      this.engine=engine;this.config=config;this.error=undefined;this.changed();
    });this.connections=next;return next;
  }
  async initialize(){try{await mkdir(this.root,{recursive:true,mode:0o700});const config=validate(localConfigSchema,JSON.parse(await readFile(this.configFile(),'utf8')));await this.connect(config);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.error=safeError(error);}finally{this.initializing=false;this.changed();}}
  status(){return {initializing:this.initializing,configured:!!this.engine,config:this.config?{network:this.config.network,rpcUrl:this.config.rpcUrl,ordUrl:this.config.ordUrl,wallet:this.config.wallet}:undefined,capabilities:this.engine?.backend.capabilities(),error:this.error};}
  async command(name:string,payload:unknown){
    if(name==='backend.status'){validate(z.object({}).strict(),payload);return this.status();}
    if(name==='backend.configure'){
      if(this.initializing)throw new AppError('BACKEND_STARTING','Wait for the saved backend connection to finish opening before choosing another node.');
      const p=validate(localConfigSchema.omit({cookieFile:true,ordBinary:true}),payload);
      const selection=await dialog.showOpenDialog(this.window,{title:'Select this '+p.network+' node’s RPC cookie',buttonLabel:'Connect node',properties:['openFile','showHiddenFiles']});if(selection.canceled)return {canceled:true};
      let ordBinary=this.config?.ordBinary;try{await access(ordBinary??this.defaultBinary());}catch{const binary=await dialog.showOpenDialog(this.window,{title:'Select the qualified Ord 0.29.0 executable',buttonLabel:'Use Ord executable',properties:['openFile']});if(binary.canceled||!binary.filePaths[0])return {canceled:true};ordBinary=binary.filePaths[0];}
      const config={...p,cookieFile:selection.filePaths[0],...(ordBinary?{ordBinary}:{})},backend=this.backend(config);await backend.qualify();await this.connect(config,true);return {canceled:false,...this.status()};
    }
    if(!this.engine)throw new AppError('BACKEND_NOT_CONFIGURED','Connect a local Bitcoin Core / Ord backend in the Inscribe screen first.');
    if(name==='backend.receive'){validate(z.object({}).strict(),payload);return {address:await this.engine.backend.receive()};}
    if(name==='deployment.authorize'||name==='deployment.resume-owner'){
      const p=validate(deploymentInput.extend({quoteId:z.string().uuid(),planHash:z.string().regex(/^[a-f0-9]{64}$/),protocolAcknowledged:z.boolean().optional()}).strict(),payload);return name==='deployment.authorize'?this.engine.authorizeFromOwner(p.projectId,p.deploymentId,p.quoteId,p.planHash,p.protocolAcknowledged):this.engine.resumeFromOwner(p.projectId,p.deploymentId,p.quoteId,p.planHash);
    }
    const p=validate(deploymentInput,payload),record=this.engine.status(p.projectId,p.deploymentId);
    if(name==='deployment.refresh')return this.engine.refresh(p.projectId,p.deploymentId);
    if(name==='deployment.copy-id'){if(record.state!=='complete'||!record.receipt)throw new AppError('NOT_PUBLISHED','The root has not completed chain and content verification.');clipboard.writeText(record.receipt.rootId);return {copied:true};}
    if(name==='deployment.open'){
      if(record.state!=='complete'||!record.receipt)throw new AppError('NOT_PUBLISHED','Verify the published root before opening it.');
      // Only a constructed URL on the selected loopback explorer may leave the shell.
      this.browse(record.receipt.rune?'rune:'+record.receipt.rune.name:record.receipt.rootId,{network:this.engine.backend.config.network,ordUrl:this.engine.backend.ordUrl});return {opened:true};
    }
    if(name==='deployment.export-receipt'){
      const selection=await dialog.showSaveDialog(this.window,{title:'Export publication receipt',defaultPath:'bitcoin-website-receipt.json',filters:[{name:'JSON receipt',extensions:['json']}]});if(selection.canceled||!selection.filePath)return {canceled:true};
      const buildManifest=JSON.parse(await readFile(path.resolve(__dirname,'build-manifest.json'),'utf8'));
      const application={version:app.getVersion(),payloadSha256:sha256(Buffer.from(JSON.stringify(buildManifest.payload)))};
      await durableWrite(selection.filePath,JSON.stringify({...record,application},null,2));return {canceled:false};
    }
    throw new AppError('UNKNOWN_COMMAND','Unknown deployment action.');
  }
  async close(){await this.connections.catch(()=>{});await this.engine?.close();}
}
