import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readdir,readFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const creatorRequire=createRequire(path.resolve('src/creator/package.json'));
const {_electron:electron,expect}=creatorRequire('@playwright/test');
type ElectronApplication=any;
const {Client}=creatorRequire('@modelcontextprotocol/sdk/client/index.js');
type Client=any;
const {StdioClientTransport}=creatorRequire('@modelcontextprotocol/sdk/client/stdio.js');
import {RegtestEnvironment} from '../src/creator/source/deploy/regtest';
import {launchPackagedRenderer} from './creator-qualification/packaged-driver';
import {BridgeClient,readConnection} from '../src/creator/source/agent/client';

const packaged=process.argv.includes('--packaged');
const tools=process.argv.find(v=>v.startsWith('--tools-dir='))?.slice('--tools-dir='.length);if(!tools||!path.isAbsolute(tools))throw new Error('Provide --tools-dir=/absolute/path to the qualified Core 31.1.0 and Ord 0.29.0 tools.');
const unavailableStorage=process.argv.includes('--unavailable-storage');
if(packaged&&unavailableStorage)throw new Error('The injected storage failure fixture runs against development Electron only; package fuses remain enabled.');
const metadata=JSON.parse(await readFile('package.json','utf8'));
const manifest=packaged?JSON.parse(await readFile(path.join('release',metadata.version,'release-manifest.json'),'utf8')):undefined;
const executablePath=manifest?path.resolve(manifest.appPath,'Contents/MacOS/Bitcoin Browser'):undefined;
const root=await mkdtemp(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),packaged?'btc-create-packaged-':'btc-create-engine-')),environment=new RegtestEnvironment(root,tools),profile=path.join(root,'desktop');
let application:ElectronApplication|undefined,client:Client|undefined,stderr='';
async function closeApplication(){
  const current=application;if(!current)return true;const child=current.process();let graceful=false;
  const closing=current.close().then(()=>{graceful=true;}).catch(error=>{stderr+='Desktop close failed: '+String(error)+'\n';});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([closing,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{if(timer)clearTimeout(timer);}
  if(!graceful&&child.exitCode===null&&child.signalCode===null){stderr+='Forced termination of this owned test application after close timeout.\n';child.kill('SIGKILL');}
  application=undefined;return graceful;
}
async function launch(){
  const env=Object.fromEntries(Object.entries({...process.env,}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));delete env.ELECTRON_RUN_AS_NODE;
  if(packaged)env.PATH='/usr/bin:/bin:/usr/sbin:/sbin';
  application=packaged?await launchPackagedRenderer(executablePath!,profile,process.cwd()):await electron.launch({executablePath:executablePath??createRequire(path.resolve('package.json'))('electron'),args:[...(executablePath?[]:[path.resolve('.')]),'--user-data-dir='+profile],env,timeout:30_000});application.process().stderr?.on('data',value=>{stderr+=value.toString();});
  if(!packaged)await application.evaluate(({safeStorage})=>{for(const name of ['isAsyncEncryptionAvailable','encryptStringAsync','decryptStringAsync']){const api=safeStorage as unknown as Record<string,(...args:unknown[])=>Promise<unknown>>,original=api[name];api[name]=(...args:unknown[])=>{process.stderr.write('Release-test secure storage: '+name+' started\n');return original.apply(api,args).then(result=>{process.stderr.write('Release-test secure storage: '+name+' completed\n');return result;},error=>{process.stderr.write('Release-test secure storage: '+name+' rejected\n');throw error;});};}});
  if(unavailableStorage)await application.evaluate(({safeStorage})=>{safeStorage.isAsyncEncryptionAvailable=()=>new Promise<boolean>(()=>{});});
  const page=await application.firstWindow();await expect(page.locator('#app')).toHaveAttribute('aria-busy','false',{timeout:20000});await page.locator('#enter-create-mode').click();await expect(page).toHaveURL('app://app/creator/generated/renderer/index.html');await expect.poll(async()=>{const r=await page.evaluate(()=>window.builder.invoke('app.bootstrap'));return r.ok?r.data.projects.length:-1;}).toBeGreaterThanOrEqual(0);return page;
}
try{
  const config=await environment.start();
  if(packaged){await mkdir(path.join(profile,'creator/deployments'),{recursive:true,mode:0o700});await writeFile(path.join(profile,'creator/deployments/local-ord.json'),JSON.stringify({network:'regtest',rpcUrl:environment.rpcUrl,ordUrl:environment.ordUrl,wallet:'builder-regtest',cookieFile:path.join(environment.coreDir,'regtest/.cookie'),ordBinary:path.join(tools,'ord/ord-0.29.0/ord'),protectedOutputs:[]}),{mode:0o600});}
  let page=await launch();await expect(page.getByText('Make your mark on Bitcoin.')).toBeVisible();
  // Configure through the actual trusted UI and native file grant. Only the OS
  // chooser's returned owned fixture path is supplied by the harness.
  await page.getByRole('button',{name:/Blank canvas/}).click();await page.getByLabel('Project name').fill('Native reviewed inscription');await page.getByRole('button',{name:'Create website',exact:true}).click();
  await page.getByRole('button',{name:'3 Inscribe',exact:true}).click();
  if(!packaged){
  await page.getByLabel('Bitcoin Core RPC').fill(environment.rpcUrl);await page.getByLabel('Ord explorer',{exact:true}).fill(environment.ordUrl);await page.getByLabel('Loaded Ord wallet').fill('builder-regtest');
  await application!.evaluate(({dialog},files)=>{dialog.showOpenDialog=async(...args:unknown[])=>{const options=args.at(-1) as {title?:string};return {canceled:false,filePaths:[options.title?.includes('Ord 0.29.0')?files.ordBinary:files.cookieFile]};};},{cookieFile:path.join(environment.coreDir,'regtest/.cookie'),ordBinary:path.join(tools,'ord/ord-0.29.0/ord')});
  await page.getByRole('button',{name:'Choose RPC cookie & connect',exact:true}).click();
  }
  if(unavailableStorage){
    await expect(page.getByRole('alert')).toContainText('macOS secure storage did not respond',{timeout:30000});await expect(page.getByRole('button',{name:'Choose RPC cookie & connect',exact:true})).toBeEnabled();
    assert.deepEqual(await environment.rpc('getrawmempool'),[]);await assert.rejects(access(path.join(profile,'creator','deployments/vault-key.encrypted')),{code:'ENOENT'});
    await page.getByRole('button',{name:'All projects',exact:true}).click();await expect(page.getByText('Make your mark on Bitcoin.')).toBeVisible();await page.getByRole('button',{name:/Native reviewed inscription/}).click();await expect(page.getByRole('button',{name:'Test website',exact:true})).toBeVisible();
    const graceful=await closeApplication();assert.equal(graceful,true);
    await writeFile('docs/evidence/creator-native-storage-unavailable.json',JSON.stringify({checkedAt:new Date().toISOString(),applicationVersion:metadata.version,archiveSha256:manifest?.sha256,packaged,scope:'Injected unavailable async secure storage; no OS credential store read by this failure fixture.',checks:{boundedFailure:true,noVaultCreated:true,noBroadcast:true,authoringRemainsAvailable:true,gracefulClose:true},localEvidence:path.relative(process.cwd(),root)},null,2)+'\n');
    console.log('Unavailable secure storage safely stopped publication and preserved authoring.');
  }else{
  await expect(page.getByText('Prepare your publication',{exact:true})).toBeVisible({timeout:60000});
  await page.getByRole('button',{name:'AI connection',exact:true}).click();await page.getByLabel('Allow publication planning, status, and resuming exact plans I approve').check();await page.getByRole('button',{name:'Create connection & copy settings',exact:true}).click();
  const settings=JSON.parse(await page.getByLabel('MCP connection settings').inputValue()),definition=settings.mcpServers['bitcoin-browser-create'];await page.getByRole('button',{name:'Close AI connections'}).click();
  client=new Client({name:'native-publication-test',version:'1.0.0'});await client.connect(new StdioClientTransport({command:definition.command,args:definition.args,stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client!.callTool({name,arguments:args});const data=result.structuredContent as any;if(!data.ok)throw new Error(name+': '+JSON.stringify(data.error));return data.data;};
  const projects=await call('project_list'),projectId=projects[0].id;
  let project=await call('project_inspect',{projectId});
  project=await call('file_write',{projectId,expectedRevision:project.revision,idempotencyKey:randomUUID(),path:'index.html',content:'<!doctype html><meta charset="utf-8"><title>Native recursive publication</title><h1 id="result">Starting</h1><script src="./app.js"></script>'});
  project=await call('file_write',{projectId,expectedRevision:project.revision,idempotencyKey:randomUUID(),path:'app.js',content:'document.querySelector("#result").textContent="Built with MCP. Reviewed by its owner.";'});
  await call('preview_start',{projectId,expectedRevision:project.revision});const build=await call('build_create',{projectId,expectedRevision:project.revision});
  const destination=await environment.receive(),deployment=await call('deployment_plan',{projectId,buildId:build.id,destination,feeRate:1,postageSats:10000,idempotencyKey:'native-first'});
  const identity={projectId,deploymentId:deployment.id};
  await expect.poll(async()=>(await call('operation_get',identity)).state,{timeout:30000}).toBe('quoted');let state=await call('deployment_status',identity);const first=state.steps[0].quote;
  const connectionFile=definition.args[definition.args.indexOf('--connection')+1],bridge=new BridgeClient(await readConnection(connectionFile));
  const denied=await bridge.call('deployment.authorize',{...identity,quoteId:first.id,planHash:first.planHash});assert.equal(denied.ok,false);if(!denied.ok)assert.equal(denied.error.code,'COMMAND_DENIED');
  const bypass=await client.callTool({name:'deployment_request_review',arguments:{...identity,quoteId:first.id,approved:true}});assert.equal(bypass.isError,true);
  await call('deployment_request_review',{...identity,quoteId:first.id});await expect(page.getByRole('heading',{name:'Your approval is needed'})).toBeVisible();
  assert.deepEqual(await environment.rpc('getrawmempool'),[]);
  const packageFile=path.join(profile,'creator','deployments','records',deployment.id,`package-${first.id}.sealed`),originalPackage=await readFile(packageFile),tamperedPackage=Buffer.from(originalPackage);tamperedPackage[tamperedPackage.length-1]^=1;await writeFile(packageFile,tamperedPackage);
  await page.getByRole('button',{name:/Inscribe with test coins/}).click();await expect(page.getByRole('alert')).toContainText('encrypted deployment record could not be verified');assert.deepEqual(await environment.rpc('getrawmempool'),[]);await writeFile(packageFile,originalPackage);await page.getByRole('button',{name:'Dismiss publication error'}).click();
  await page.screenshot({path:path.join(root,'exact-review.png')});
  await client.close();client=undefined;if(!await closeApplication())throw new Error('The owned desktop did not close gracefully for the restart qualification.');page=await launch();
  await expect(page.locator('.project-identity strong')).toHaveText('Native reviewed inscription',{timeout:15000});await page.getByRole('button',{name:'3 Inscribe',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your approval is needed'})).toBeVisible();
  // This password belongs only to the harness's disposable wallet. It is never
  // given to the builder, its renderer, or its MCP client.
  await environment.rpc('encryptwallet',['owned-release-fixture-only'],'builder-regtest');
  await page.getByRole('button',{name:/Inscribe with test coins/}).click();await expect(page.getByRole('alert')).toContainText('Unlock the selected wallet in Bitcoin Core',{timeout:30000});assert.deepEqual(await environment.rpc('getrawmempool'),[]);
  await environment.rpc('walletpassphrase',['owned-release-fixture-only',120],'builder-regtest');
  await page.getByRole('button',{name:'Reconcile & resume',exact:true}).click();await expect(page.getByRole('heading',{name:'Waiting for confirmation'})).toBeVisible({timeout:30000});await environment.mine();
  await expect(page.getByRole('heading',{name:'Ready for your review'})).toBeVisible({timeout:30000});await expect(page.locator('.quote-heading h3')).toHaveText('index.html');
  await page.getByRole('button',{name:/Inscribe with test coins/}).click();await expect(page.getByRole('heading',{name:'Waiting for confirmation'})).toBeVisible({timeout:30000});await environment.mine();await expect(page.getByRole('heading',{name:'Published and verified'})).toBeVisible({timeout:30000});
  const result=await page.evaluate(async identity=>window.builder.invoke<any>('deployment.status',identity),identity);assert.equal(result.ok,true);if(!result.ok)throw new Error('Missing receipt');state=result.data;assert.equal(state.state,'complete');
  await page.getByRole('button',{name:'Copy ID',exact:true}).click();assert.equal(await application!.evaluate(({clipboard})=>clipboard.readText()),state.receipt.rootId);
  let exportedReceipt:any;
  if(!packaged){
  const publicReceiptPath=path.join(root,'public-receipt.json');await application!.evaluate(({dialog},filename)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:filename});},publicReceiptPath);
  await page.getByRole('button',{name:'Save receipt',exact:true}).click();await expect.poll(async()=>{try{return JSON.parse(await readFile(publicReceiptPath,'utf8')).application?.version;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}).toBe(metadata.version);
  exportedReceipt=JSON.parse(await readFile(publicReceiptPath,'utf8'));
  const buildManifest=JSON.parse(await readFile('src/creator/generated/build-manifest.json','utf8'));
  assert.equal(exportedReceipt.application.payloadSha256,createHash('sha256').update(JSON.stringify(buildManifest.payload)).digest('hex'));assert.equal(exportedReceipt.receipt.rootId,state.receipt.rootId);assert.ok(!JSON.stringify(exportedReceipt).includes('rawtr('));
  }else{exportedReceipt=state;assert.ok(!JSON.stringify(exportedReceipt).includes('rawtr('));}
  await page.screenshot({path:path.join(root,'published-receipt.png')});
  // The user-facing publication action must enter the existing native browser,
  // resolve through the receipt's local source and run the recursive script.
  await page.getByRole('button',{name:'View in Bitcoin Browser',exact:true}).click();await expect(page).toHaveURL('app://app/renderer/index.html');
  await expect(page.locator('.inscription-stage iframe')).toHaveCount(1,{timeout:15000});
  await expect(page.frameLocator('.inscription-stage iframe').locator('#result')).toHaveText('Built with MCP. Reviewed by its owner.',{timeout:20000});
  const runtime=await page.frameLocator('.inscription-stage iframe').locator('body').evaluate(()=>({text:document.querySelector('#result')?.textContent,node:typeof process,bridge:typeof window.builder,browser:typeof window.satBrowser}));
  assert.equal(runtime.node,'undefined');assert.equal(runtime.bridge,'undefined');assert.equal(runtime.browser,'undefined');
  await page.screenshot({path:path.join(root,'native-published-browser.png')});await page.locator('#enter-create-mode').click();await expect(page.locator('.project-identity strong')).toHaveText('Native reviewed inscription');
  await page.getByRole('button',{name:'3 Inscribe',exact:true}).click();
  const encrypted=await readFile(path.join(profile,'creator','deployments','records',deployment.id,`package-${first.id}.sealed`));assert.ok(!encrypted.includes(Buffer.from('rawtr(')));assert.ok(!encrypted.includes(Buffer.from(first.revealTxid)));
  client=new Client({name:'native-publication-reconnect',version:'1.0.0'});await client.connect(new StdioClientTransport({command:definition.command,args:definition.args,stderr:'pipe'}));const laterBuild=await call('build_create',{projectId,expectedRevision:project.revision}),unapproved=await call('deployment_plan',{projectId,buildId:laterBuild.id,destination,feeRate:1,postageSats:10000,idempotencyKey:'cancel-on-revoke'});
  await expect.poll(async()=>(await call('operation_get',{projectId,deploymentId:unapproved.id})).state,{timeout:30000}).toBe('quoted');
  await page.getByRole('button',{name:'AI connection',exact:true}).click();await page.getByRole('button',{name:'Revoke',exact:true}).click();
  await expect.poll(async()=>{const result=await page.evaluate(identity=>window.builder.invoke<any>('deployment.status',identity),{projectId,deploymentId:unapproved.id});return result.ok?result.data.state:'error';},{timeout:20000}).toBe('canceled');
  const revoked=await client.callTool({name:'project_list',arguments:{}});assert.equal((revoked.structuredContent as any).error.code,'ACCESS_DENIED');
  assert.deepEqual(await environment.rpc('listlockunspent',[],'builder-regtest'),[]);
  const evidence={checkedAt:new Date().toISOString(),applicationVersion:metadata.version,packaged,driver:packaged?'renderer-cdp-with-main-inspection-disabled':'playwright-electron-development',archiveSha256:manifest?.sha256,config,localEvidence:path.relative(process.cwd(),root),checks:{encryptedFundingWallet:true,lockedWalletDeniedBeforeBroadcast:true,externalCoreUnlockResumedExactPlan:true,publicReceiptMatchesPayload:!packaged,nativeReceiptExportDialog:!packaged,ownedFixtureProfileConnection:packaged,nativeCookieGrant:!packaged,nativeOrdBinaryGrant:!packaged,actualMcpPlanning:true,explicitPublicationGrant:true,mcpApprovalDenied:true,reviewRequestedInGui:true,noBroadcastBeforeApproval:true,osProtectedVaultKey:true,authenticatedRecordTamperDenied:true,osEncryptedRecovery:true,desktopRestartPreservedReview:true,ownerClickedEachExactReview:true,grantRevocationCanceledUnapprovedWork:true,reservationsReleasedOnRevocation:true,actualRecursiveRuntime:runtime},receipt:state.receipt};
  await writeFile(packaged?'docs/evidence/creator-packaged-regtest.json':'docs/evidence/creator-native-regtest.json',JSON.stringify(evidence,null,2)+'\n');console.log('Native owner review + real MCP + publication passed:',state.receipt.rootId);
  }
}catch(error){console.error('Native publication failed:',error);if(application){try{const failedPage=await application.firstWindow();console.error('Native failure document:',failedPage.url(),'Frames:',failedPage.frames().map((frame:any)=>frame.url()));await failedPage.screenshot({path:path.join(root,'failure.png')});}catch{}}await writeFile(path.join(root,'application.log'),stderr);process.exitCode=1;}
finally{try{await client?.close();await closeApplication();}finally{await environment.stop();}}
