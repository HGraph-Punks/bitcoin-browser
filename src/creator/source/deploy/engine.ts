import {randomUUID} from 'node:crypto';
import {AppError,safeError} from '../core/errors';
import {prepareResource,type PublishedBinding} from '../compiler/build';
import type {BuildArtifact,Network} from '../shared/types';
import type {DeploymentView,DeploymentState,InscriptionQuote,DeploymentStep} from '../shared/deployment';
import {DeploymentStorage,objectHash,sha256} from './storage';
import {LocalOrdBackend,type CompleteMaterial} from './local-ord';
import type {PreparationMaterial} from './prepare-broker';

type Frozen={build:BuildArtifact;title:string;destination:string;feeRate:number;postageSats:number;assets:Record<string,string>};
type Authorization={planHash:string;quoteId:string;deploymentId:string;backendId:string;network:Network;authorizedAt:string;expiresAt:string;maxFeeSats:number;totalRequiredSats:number};
type Package={quote:InscriptionQuote;material:CompleteMaterial};
type Registry=Record<string,{hash:string;id:string;quoteId?:string}>;
const registryId='00000000-0000-0000-0000-000000000000';
const now=()=>new Date().toISOString();

/** Durable domain engine. Approval is deliberately absent from WorkspaceService/MCP. */
export class DeploymentEngine {
  private records=new Map<string,DeploymentView>();
  private registry:Registry={};
  private sponsors=new Map<string,string>();
  private revokedScopes=new Set<string>();
  private queue:Promise<unknown>=Promise.resolve();
  private running=new Set<string>();
  private closed=false;
  private timer?:ReturnType<typeof setInterval>;
  private polling=false;
  constructor(readonly storage:DeploymentStorage,readonly backend:LocalOrdBackend,private changed:(projectId:string)=>void=()=>{}){}
  async initialize(poll=true){
    await this.storage.initialize();const ids=await this.storage.ids();if(!ids.includes(registryId))await this.storage.create(registryId);
    if(await this.storage.exists(registryId,'registry.sealed'))this.registry=await this.storage.read(registryId,'registry.sealed');
    for(const id of ids.filter(id=>id!==registryId)){if(await this.storage.exists(id,'state.sealed')){const state=await this.storage.read<DeploymentView>(id,'state.sealed');if(state.id!==id||state.schemaVersion!==1)throw new AppError('DEPLOYMENT_DAMAGED','A deployment identity does not match its saved record.');if(await this.storage.exists(id,'cancellation.sealed')){const intent=await this.storage.read<{cancelRequested:boolean}>(id,'cancellation.sealed');state.cancelRequested=intent.cancelRequested;}this.records.set(id,state);}}
    for(const id of this.records.keys())if(await this.storage.exists(id,'sponsor.sealed'))this.sponsors.set(id,(await this.storage.read<{scope:string}>(id,'sponsor.sealed')).scope);
    // Restart never fabricates a new commit or assumes that an authorization
    // means a previous submission failed. Polling observes only; resume is explicit.
    if(poll){this.timer=setInterval(()=>{if(this.polling||this.closed)return;this.polling=true;void this.refreshAll().finally(()=>{this.polling=false;});},4000);this.timer.unref();}
  }
  private exclusive<T>(action:()=>Promise<T>):Promise<T>{if(this.closed)return Promise.reject(new AppError('APP_CLOSING','The application is closing. Saved deployments remain recoverable.'));const next=this.queue.catch(()=>{}).then(action);this.queue=next;return next;}
  private background(id:string,action:()=>Promise<void>){
    if(this.running.has(id)||this.closed)return;this.running.add(id);
    void this.exclusive(action).catch(async error=>{const record=this.records.get(id);if(!record)return;const detail=safeError(error);const state:DeploymentState=detail.code==='QUOTE_EXPIRED'?'expired':detail.code==='INPUT_UNAVAILABLE'?'conflict':record.state==='broadcast-unknown'?'broadcast-unknown':record.steps.some(step=>step.commitSubmittedAt)?'recovery-required':'provider-unavailable';await this.update(record,state,detail.message,detail);}).catch(()=>{const record=this.records.get(id);if(record){record.state='recovery-required';record.error={code:'DEPLOYMENT_STORAGE_UNAVAILABLE',message:'Publication stopped because its durable journal could not be saved. Restore private storage and reconcile the existing transaction IDs.'};this.changed(record.projectId);}}).finally(()=>this.running.delete(id));
  }
  private record(projectId:string,id:string){const record=this.records.get(id);if(!record||record.projectId!==projectId)throw new AppError('DEPLOYMENT_NOT_FOUND','This deployment does not belong to the granted project.');return record;}
  private async update(record:DeploymentView,state:DeploymentState,message:string,error?:DeploymentView['error']){
    record.state=state;record.updatedAt=now();record.error=error;record.events.push({at:record.updatedAt,state,message});record.events=record.events.slice(-200);
    await this.storage.write(record.id,'state.sealed',record);this.changed(record.projectId);
  }
  list(projectId:string){return [...this.records.values()].filter(record=>record.projectId===projectId).map(({id,projectId,title,revision,buildId,network,createdAt,updatedAt,state,cancelRequested,currentStep})=>({id,projectId,title,revision,buildId,network,createdAt,updatedAt,state,cancelRequested,currentStep})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  hasPending(){return [...this.records.values()].some(record=>record.backendId===this.backend.id&&!['complete','canceled'].includes(record.state));}
  status(projectId:string,id:string){return structuredClone(this.record(projectId,id));}
  quote(projectId:string,id:string){const record=this.record(projectId,id),step=record.steps[record.currentStep];if(!step)throw new AppError('QUOTE_PENDING','The current resource is still being prepared.');return structuredClone(step.quote);}
  async create(input:{build:BuildArtifact;title:string;destination:string;feeRate:number;postageSats:number;idempotencyKey:string;scope:string},readAsset:(sha:string)=>Promise<Buffer>){
    return this.exclusive(async()=>{
      if(this.revokedScopes.has(input.scope))throw new AppError('ACCESS_DENIED','This publication-planning grant was revoked.');
      const {build}=input;if(build.findings.some(f=>f.severity==='error'))throw new AppError('BUILD_BLOCKED','Resolve the build errors before publication.');
      if(build.libraries.some(library=>library.network!==this.backend.config.network))throw new AppError('WRONG_NETWORK','The selected backend cannot reuse libraries from another Bitcoin network. Use a self-contained project or same-network libraries.');
      const limits=this.backend.capabilities().limits;
      for(const resource of build.resources)if(!limits.supportedMime.includes(resource.mime)||resource.bytes>limits.maxDecodedBytes)throw new AppError('UNSUPPORTED_RESOURCE',`${resource.path} exceeds this backend’s qualified MIME or decoded-size limits. Resolve every resource before starting publication.`);
      const key=objectHash({scope:input.scope,key:input.idempotencyKey,projectId:build.projectId}),hash=objectHash({buildId:build.id,backendId:this.backend.id,destination:input.destination,feeRate:input.feeRate,postageSats:input.postageSats});
      const previous=this.registry[key];if(previous){if(previous.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','That deployment key was already used for different content or costs.');if(this.records.has(previous.id))return this.status(build.projectId,previous.id);throw new AppError('DEPLOYMENT_DAMAGED','An interrupted creation is preserved. Use a new key only after inspecting its saved records.');}
      if(this.records.size>=100)throw new AppError('DEPLOYMENT_LIMIT','This development workspace supports up to 100 saved deployments.');
      if(Object.keys(this.registry).length>=2000)throw new AppError('OPERATION_LIMIT','The development workspace reached its durable operation limit. Existing plans remain inspectable and recoverable.');
      await this.backend.qualify();await this.backend.destination(input.destination);
      await this.backend.verifyLibraries(build.libraries);
      if(this.revokedScopes.has(input.scope))throw new AppError('ACCESS_DENIED','This publication-planning grant was revoked before preparation.');
      const paths=build.stages.flatMap(stage=>stage.paths).filter(name=>!build.resources.find(resource=>resource.path===name)?.duplicateOf);
      if(!paths.length||paths.at(-1)!=='index.html')throw new AppError('BUILD_BLOCKED','The publication graph must end with the root index.html.');
      const assets:Record<string,string>={};for(const resource of build.resources){if(resource.asset&&!assets[resource.asset.sha256]){const bytes=await readAsset(resource.asset.sha256);if(sha256(bytes)!==resource.sourceSha256)throw new AppError('INVALID_ARTIFACT','An asset changed while freezing publication.');assets[resource.asset.sha256]=bytes.toString('base64');}}
      const id=randomUUID(),createdAt=now(),record:DeploymentView={schemaVersion:1,id,projectId:build.projectId,title:input.title,revision:build.revision,buildId:build.id,backendId:this.backend.id,network:this.backend.config.network,destination:input.destination,createdAt,updatedAt:createdAt,state:'preparing',cancelRequested:false,operationId:id,stages:structuredClone(build.stages),paths,steps:[],currentStep:0,events:[]};
      await this.storage.create(id);await this.storage.write(id,'frozen.sealed',{build,title:input.title,destination:input.destination,feeRate:input.feeRate,postageSats:input.postageSats,assets} satisfies Frozen);
      await this.storage.write(id,'sponsor.sealed',{scope:input.scope});this.sponsors.set(id,input.scope);
      this.registry[key]={id,hash};await this.storage.write(registryId,'registry.sealed',this.registry);this.records.set(id,record);await this.update(record,'preparing','Freezing content and preparing the first resource without wallet signatures.');
      if(this.revokedScopes.has(input.scope)){record.cancelRequested=true;await this.storage.write(id,'cancellation.sealed',{cancelRequested:true,at:now()});await this.update(record,'canceled','The planning grant was revoked before transaction preparation.');}else this.background(id,()=>this.prepareNext(record));return structuredClone(record);
    });
  }
  private checkBackend(record:DeploymentView){if(record.backendId!==this.backend.id||record.network!==this.backend.config.network)throw new AppError('BACKEND_CHANGED','Reconnect the exact backend and Bitcoin network used by this deployment before resuming it.');}
  private async savedPackage(record:DeploymentView,step:DeploymentStep):Promise<Package>{
    const saved=await this.storage.read<Package>(record.id,`package-${step.quote.id}.sealed`),{planHash,...body}=saved.quote;
    if(objectHash(body)!==planHash||objectHash(saved.quote)!==objectHash(step.quote)||sha256(Buffer.from(saved.material.unsignedCommit,'hex'))!==saved.quote.unsignedCommitSha256||sha256(Buffer.from(saved.material.reveal,'hex'))!==saved.quote.revealSha256)throw new AppError('PLAN_CHANGED','The stored plan no longer matches its immutable review.');return saved;
  }
  private async verifiedHistory(record:DeploymentView){
    for(const step of record.steps.filter(step=>step.verified)){
      const tx=await this.backend.transaction(step.quote.revealTxid);
      if(!tx||tx.confirmations<1){step.confirmations=tx?.confirmations??0;await this.update(record,'reorg','A previously verified inscription lost confirmation. Dependent publication is paused.');return false;}
      step.confirmations=tx.confirmations;if(tx.blockhash!==step.verified!.blockHash)step.verified=await this.backend.verifyContent(step.quote);
    }
    return true;
  }
  private async prepareNext(record:DeploymentView){
    this.checkBackend(record);if(record.cancelRequested)return;if(!await this.verifiedHistory(record))return;
    if(record.steps[record.currentStep])return;
    await this.update(record,'preparing','Preparing exact transaction bytes for the next resource.');
    const frozen=await this.storage.read<Frozen>(record.id,'frozen.sealed'),bindings:Record<string,PublishedBinding>={};
    await this.backend.verifyLibraries(frozen.build.libraries);
    for(const step of record.steps){if(!step.verified)throw new AppError('DEPENDENCY_UNVERIFIED','Confirm and verify every earlier resource before preparing a dependent one.');bindings[step.quote.path]={network:record.network,id:step.quote.inscriptionId,sha256:step.quote.contentSha256,mime:step.quote.mime};}
    const resource=prepareResource(frozen.build,record.paths[record.currentStep],bindings,record.network);
    const bytes=resource.text!==undefined?Buffer.from(resource.text):Buffer.from(frozen.assets[resource.asset!.sha256],'base64');
    const id=randomUUID(),prepared=await this.backend.prepare({deploymentId:record.id,projectId:record.projectId,buildId:record.buildId,revision:record.revision,path:resource.path,resourceNumber:record.currentStep+1,resourceCount:record.paths.length,mime:resource.mime,bytes,sha256:resource.sha256,dependencies:resource.dependencies,destination:frozen.destination,feeRate:frozen.feeRate,postageSats:frozen.postageSats},material=>this.storage.write(record.id,`partial-${id}.sealed`,material));
    const createdAt=now(),totalFeeSats=prepared.facts.commitFeeSats+prepared.facts.revealFeeSats;
    const body:Omit<InscriptionQuote,'planHash'>={schemaVersion:1,id,deploymentId:record.id,projectId:record.projectId,buildId:record.buildId,revision:record.revision,backendId:this.backend.id,network:record.network,path:resource.path,resourceNumber:record.currentStep+1,resourceCount:record.paths.length,contentSha256:resource.sha256,mime:resource.mime,decodedBytes:bytes.length,dependencies:resource.dependencies,createdAt,expiresAt:new Date(Date.now()+15*60_000).toISOString(),source:'Local Bitcoin Core / Ord',destination:frozen.destination,postageSats:frozen.postageSats,feeRate:frozen.feeRate,backendFeeSats:0,totalFeeSats,totalRequiredSats:totalFeeSats+frozen.postageSats,...prepared.facts};
    const quote:InscriptionQuote={...body,planHash:objectHash(body)};
    await this.storage.write(record.id,`package-${id}.sealed`,{quote,material:prepared.material} satisfies Package);
    // Persist which inputs belong to this plan before placing persistent locks.
    record.steps.push({quote,commitAttempts:0,revealAttempts:0,confirmations:0});await this.update(record,'preparing','Saving the exact candidate and reserving its funding inputs.');
    await this.backend.reserve(quote.inputs);await this.update(record,'quoted','Exact content, destination, inputs, fees, change, and postage are ready for review. No funding wallet signature or broadcast has occurred.');
  }
  async requestReview(projectId:string,id:string,quoteId:string){return this.exclusive(async()=>{const record=this.record(projectId,id),step=record.steps[record.currentStep];if(!step||step.quote.id!==quoteId)throw new AppError('QUOTE_MISMATCH','Review the current resource quote.');if(step.authorizedAt)return structuredClone(record);if(record.cancelRequested)throw new AppError('CANCELED','This deployment was canceled by its owner.');await this.savedPackage(record,step);this.checkExpiry(step.quote);step.reviewId??=randomUUID();await this.update(record,'awaiting-review','Owner review requested in the desktop application.');return structuredClone(record);});}
  private checkExpiry(quote:InscriptionQuote){if(Date.now()>=Date.parse(quote.expiresAt))throw new AppError('QUOTE_EXPIRED','This quote expired. Cancel its unbroadcast plan and prepare a fresh review.');}
  /** Called only by trusted GUI IPC, never by WorkspaceService or the agent bridge. */
  async authorizeFromOwner(projectId:string,id:string,quoteId:string,planHash:string){
    return this.exclusive(async()=>{
      const record=this.record(projectId,id),step=record.steps[record.currentStep];this.checkBackend(record);
      if(!step||step.quote.id!==quoteId||step.quote.planHash!==planHash)throw new AppError('REVIEW_MISMATCH','The displayed review is stale. Review the current exact plan.');
      if(record.cancelRequested)throw new AppError('CANCELED','The owner canceled this deployment.');
      if(step.invalidatedAt)throw new AppError('REVIEW_MISMATCH','This resource quote was superseded. Prepare a fresh review.');
      if(step.authorizedAt){this.background(id,()=>this.executeCurrent(record));return structuredClone(record);}
      if(!['quoted','awaiting-review'].includes(record.state))throw new AppError('REVIEW_UNAVAILABLE','This publication is not waiting for owner approval.');
      this.checkExpiry(step.quote);await this.savedPackage(record,step);if(!await this.verifiedHistory(record))throw new AppError('DEPENDENCY_REORG','A dependency lost confirmation.');
      const authorization:Authorization={planHash,quoteId,deploymentId:id,backendId:this.backend.id,network:record.network,authorizedAt:now(),expiresAt:step.quote.expiresAt,maxFeeSats:step.quote.totalFeeSats,totalRequiredSats:step.quote.totalRequiredSats};
      await this.storage.write(id,`authorization-${quoteId}.sealed`,authorization);step.authorizedAt=authorization.authorizedAt;await this.update(record,'awaiting-signature','The owner approved this exact plan and spend bound.');this.background(id,()=>this.executeCurrent(record));return structuredClone(record);
    });
  }
  private async authorization(record:DeploymentView,step:DeploymentStep){
    if(step.invalidatedAt||!step.authorizedAt||!await this.storage.exists(record.id,`authorization-${step.quote.id}.sealed`))throw new AppError('OWNER_REVIEW_REQUIRED','Only the owner can authorize this exact plan in the desktop review.');
    const auth=await this.storage.read<Authorization>(record.id,`authorization-${step.quote.id}.sealed`);
    if(auth.planHash!==step.quote.planHash||auth.quoteId!==step.quote.id||auth.deploymentId!==record.id||auth.backendId!==this.backend.id||auth.network!==record.network||auth.maxFeeSats!==step.quote.totalFeeSats||auth.totalRequiredSats!==step.quote.totalRequiredSats||auth.authorizedAt!==step.authorizedAt)throw new AppError('AUTHORIZATION_MISMATCH','The saved authorization does not cover this exact publication.');return auth;
  }
  private async executeCurrent(record:DeploymentView){
    this.checkBackend(record);if(record.cancelRequested)return;if(!await this.verifiedHistory(record))return;
    const step=record.steps[record.currentStep];if(!step){await this.prepareNext(record);return;}
    if(step.verified){await this.observe(record);return;}
    await this.authorization(record,step);const saved=await this.savedPackage(record,step),quote=step.quote;
    const frozen=await this.storage.read<Frozen>(record.id,'frozen.sealed');await this.backend.verifyLibraries(frozen.build.libraries);
    // Exact IDs are queried before every retry, including interrupted signing.
    const [commit,reveal]=await Promise.all([this.backend.transaction(quote.commitTxid),this.backend.transaction(quote.revealTxid)]);
    if(reveal){step.revealSubmittedAt??=now();await this.observe(record);return;}
    if(!saved.material.signedCommit&&!commit){
      this.checkExpiry(quote);await this.update(record,'awaiting-signature','Rechecking protected inputs and asking the wallet to sign the reviewed commit.');
      saved.material.signedCommit=await this.backend.sign(quote,saved.material);
      await this.storage.write(record.id,`package-${quote.id}.sealed`,saved);step.signedAt=now();await this.update(record,'signed','Signed transaction bytes and recovery material are durably encrypted.');
    }
    if(record.cancelRequested)return;
    if(!commit){
      if(!saved.material.signedCommit)throw new AppError('RECOVERY_REQUIRED','The signed commit is missing. Keep the saved recovery record.');
      // A signed plan may outlive its quote. It can only submit these exact bytes,
      // with the same fees; never rebuild or reprice it under old authorization.
      await this.backend.revalidate(quote,saved.material);step.commitAttempts++;await this.update(record,'broadcast-unknown','Commit submission intent saved. A missing response must be reconciled by transaction ID.');
      await this.backend.broadcast(saved.material.signedCommit,quote.commitTxid);step.commitSubmittedAt??=now();await this.update(record,'commit-broadcast','The node accepted the reviewed commit.');
    }else{step.commitSubmittedAt??=now();await this.update(record,'commit-broadcast','The existing commit was found. Reusing its saved reveal.');}
    if(record.cancelRequested){await this.update(record,'recovery-required','The commit was submitted. Future work is stopped; its reveal is preserved for recovery.');return;}
    step.revealAttempts++;await this.update(record,'broadcast-unknown','Reveal submission intent saved. Reconcile this exact ID if the response is lost.');
    await this.backend.broadcast(saved.material.reveal,quote.revealTxid);step.revealSubmittedAt??=now();await this.update(record,'confirming','Both transactions were accepted. Waiting for a block and exact content verification.');
  }
  async resume(projectId:string,id:string,idempotencyKey:string,scope:string){
    return this.exclusive(async()=>{const record=this.record(projectId,id);this.checkBackend(record);if(record.cancelRequested)throw new AppError('CANCELED','This deployment was canceled by its owner; AI cannot undo that decision.');
      const step=record.steps[record.currentStep];if(step&&!step.authorizedAt&&!step.verified)throw new AppError('OWNER_REVIEW_REQUIRED','Resume cannot approve an unreviewed plan.');
      const key=objectHash({scope,idempotencyKey,projectId,command:'resume'}),hash=objectHash({id});const previous=this.registry[key];if(previous&&previous.hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This resume key was used for another deployment.');if(previous&&previous.quoteId!==step?.quote.id)return structuredClone(record);if(!previous&&Object.keys(this.registry).length>=2000)throw new AppError('OPERATION_LIMIT','Use the existing resume key; this workspace reached its durable operation limit.');this.registry[key]={hash,id,quoteId:step?.quote.id};await this.storage.write(registryId,'registry.sealed',this.registry);
      if(record.state!=='complete')this.background(id,()=>this.executeCurrent(record));return structuredClone(record);
    });
  }
  private async observe(record:DeploymentView){
    this.checkBackend(record);if(!await this.verifiedHistory(record))return;
    const step=record.steps[record.currentStep];if(!step||!step.authorizedAt)return;
    const reveal=await this.backend.transaction(step.quote.revealTxid);if(!reveal){if(record.state==='complete')await this.update(record,'reorg','The published root is no longer confirmed.');return;}
    step.revealSubmittedAt??=now();step.confirmations=reveal.confirmations;
    if(reveal.confirmations<1){if(record.state!=='confirming')await this.update(record,'confirming','The reveal is in the node. Waiting for confirmation.');return;}
    try{step.verified=await this.backend.verifyContent(step.quote);}catch(error){if(error instanceof AppError&&['INDEX_BEHIND','NOT_INDEXED','CHAIN_CHANGED'].includes(error.code)){if(record.state!=='indexing')await this.update(record,'indexing',error.message);return;}throw error;}
    if(record.currentStep<record.paths.length-1){
      record.currentStep++;await this.update(record,'ready-for-next','The published resource matches its frozen bytes. Its actual inscription ID is ready for dependent content.');
      if(!record.cancelRequested&&!this.closed)await this.prepareNext(record);return;
    }
    const frozen=await this.storage.read<Frozen>(record.id,'frozen.sealed');record.receipt={rootId:step.quote.inscriptionId,network:record.network,sourceRevision:record.revision,buildId:record.buildId,compilerVersion:frozen.build.compilerVersion,totalFeeSats:record.steps.reduce((sum,value)=>sum+value.quote.totalFeeSats,0),totalPostageSats:record.steps.reduce((sum,value)=>sum+value.quote.postageSats,0),resources:record.steps.map(value=>({path:value.quote.path,id:value.quote.inscriptionId,sha256:value.quote.contentSha256,commit:value.quote.commitTxid,reveal:value.quote.revealTxid,blockHash:value.verified!.blockHash}))};
    if(record.state!=='complete')await this.update(record,'complete','The root and every dependency are confirmed, indexed, and byte-verified.');
  }
  async refresh(projectId:string,id:string){return this.exclusive(async()=>{const record=this.record(projectId,id);try{await this.observe(record);}catch(error){const detail=safeError(error);await this.update(record,'provider-unavailable',detail.message,detail);}return structuredClone(record);});}
  private async refreshAll(){for(const record of this.records.values()){if(this.closed)break;if(record.backendId!==this.backend.id||this.running.has(record.id)||!record.steps.some(step=>step.authorizedAt))continue;await this.refresh(record.projectId,record.id).catch(()=>{});}}
  async cancel(projectId:string,id:string){
    // Set intent immediately, including while a network request is in flight.
    const record=this.record(projectId,id);record.cancelRequested=true;
    await this.storage.write(id,'cancellation.sealed',{cancelRequested:true,at:now()});
    return this.exclusive(async()=>{await this.update(record,record.state,'The owner requested cancellation of future unbroadcast work.');const step=record.steps[record.currentStep];
      if(step){const [commit,reveal]=await Promise.all([this.backend.transaction(step.quote.commitTxid),this.backend.transaction(step.quote.revealTxid)]);
        if(commit||reveal||step.commitAttempts||step.revealAttempts){await this.observe(record);if(record.state!=='complete')await this.update(record,'recovery-required','Submitted or uncertain transactions are preserved. Cancellation cannot reverse them.');return structuredClone(record);}
        await this.backend.release(step.quote.inputs);
      }
      await this.update(record,'canceled','Unbroadcast work stopped and its reserved inputs released. Saved transaction material remains private.');return structuredClone(record);
    });
  }
  async requote(projectId:string,id:string,quoteId:string){return this.exclusive(async()=>{
    const record=this.record(projectId,id),step=record.steps[record.currentStep];this.checkBackend(record);
    if(record.cancelRequested)throw new AppError('CANCELED','Start a new deployment after cancellation. Completed inscriptions remain recorded.');
    if(!step||step.quote.id!==quoteId||step.verified||this.running.has(id))throw new AppError('QUOTE_MISMATCH','The current resource is busy or no longer matches this quote.');
    const saved=await this.savedPackage(record,step);if(saved.material.signedCommit||step.commitAttempts||step.revealAttempts||await this.backend.transaction(step.quote.commitTxid)||await this.backend.transaction(step.quote.revealTxid))throw new AppError('RECOVERY_REQUIRED','A signed or submitted plan cannot be silently replaced. Reconcile its exact transactions.');
    step.invalidatedAt=now();await this.update(record,'preparing','Invalidating the old unbroadcast review. Completed dependencies remain reusable.');
    await this.backend.release(step.quote.inputs);record.steps.pop();await this.update(record,'preparing','Preparing a fresh review of this resource with the same verified dependencies.');this.background(id,()=>this.prepareNext(record));return structuredClone(record);
  });}
  async resumeFromOwner(projectId:string,id:string,quoteId:string,planHash:string){return this.exclusive(async()=>{
    const record=this.record(projectId,id),step=record.steps[record.currentStep];this.checkBackend(record);
    if(!step||step.quote.id!==quoteId||step.quote.planHash!==planHash||!record.cancelRequested)throw new AppError('REVIEW_MISMATCH','Review the current preserved transaction before resuming.');
    await this.savedPackage(record,step);await this.authorization(record,step);
    if(!step.commitAttempts&&!step.revealAttempts)throw new AppError('REVIEW_UNAVAILABLE','No submitted transaction needs recovery. Prepare a new publication instead.');
    await this.storage.write(id,'cancellation.sealed',{cancelRequested:false,at:now()});record.cancelRequested=false;
    await this.update(record,'recovery-required','The owner requested completion of the preserved, previously approved resource.');this.background(id,()=>this.executeCurrent(record));return structuredClone(record);
  });}
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);await this.queue.catch(()=>{});}
  async revokeScope(scope:string){
    this.revokedScopes.add(scope);
    for(const record of this.records.values())if(this.sponsors.get(record.id)===scope&&!record.cancelRequested&&!['complete','canceled'].includes(record.state)&&!record.steps[record.currentStep]?.authorizedAt)await this.cancel(record.projectId,record.id);
  }
  async idle(){await this.queue.catch(()=>{});}
}
