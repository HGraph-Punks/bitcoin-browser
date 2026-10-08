import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {brotliCompressSync} from 'node:zlib';
import {StateStore} from '../src/main/state-store.js';
import {defaultProviderCapabilitiesFor} from '../src/shared/constants.js';
import research from '../src/creator/source/catalog/research-catalog.json';
import {researchKey} from '../src/creator/source/catalog/library-acceptance';
import {libraries} from '../src/creator/source/catalog/libraries';
import {qualifyExperience,until} from './creator-qualification/experience-runtime';
import {launchPackagedRenderer} from './creator-qualification/packaged-driver';
const root=fileURLToPath(new URL('..',import.meta.url));
const creatorRequire=createRequire(path.join(root,'src/creator/package.json'));
const rootRequire=createRequire(path.join(root,'package.json'));
const {_electron}=creatorRequire('playwright');
const {expect}=creatorRequire('@playwright/test');
const cacheArgument=process.argv.find(v=>v.startsWith('--library-cache='));
if(!cacheArgument)throw new Error('Provide --library-cache=/absolute/path to the verified library bytes named by SHA-256.');
const cache=cacheArgument.slice('--library-cache='.length);
const bodies=new Map<string,Buffer>();
for(const library of libraries){const bytes=await fs.readFile(path.join(cache,library.sha256));assert.equal(createHash('sha256').update(bytes).digest('hex'),library.sha256);bodies.set(library.id,bytes);}
const compressed=new Map([...bodies].map(([id,body])=>[id,brotliCompressSync(body)]));
const unqualifiedRecord=research.entries.find(r=>r.status==='restricted'&&r.name.includes('DOMPurify'))!,unqualifiedBody=Buffer.from('window.libraryWarningFixture=42;');
let unqualifiedFetches=0;
const fixture=createServer((request,response)=>{
  const url=new URL(request.url!,'http://127.0.0.1');
  if(url.pathname==='/content/'+unqualifiedRecord.id){unqualifiedFetches++;response.writeHead(200,{'content-type':'text/javascript','content-length':unqualifiedBody.length});response.end(unqualifiedBody);return;}
  const library=libraries.find(l=>url.pathname==='/content/'+l.id);
  if(library){if(!request.headers['accept-encoding']?.includes('br')){response.writeHead(406);response.end('Brotli encoding required');return;}const wire=compressed.get(library.id)!;response.writeHead(200,{'content-type':library.mime,'content-encoding':'br','content-length':wire.length});response.end(wire);return;}
  const id=url.pathname.startsWith('/inscription/')?url.pathname.slice(13):null;
  if(id&&bodies.has(id)){const lib=libraries.find(l=>l.id===id)!;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id,number:123,content_type:lib.mime,content_length:bodies.get(id)!.length,address:'bc1pfixture',fee:0,height:900000,timestamp:1700000000,output:'a'.repeat(64)+':0',sat:0,satpoint:'a'.repeat(64)+':0:0'}));return;}
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(url.pathname.includes('blockhash')?'a'.repeat(64):url.pathname.includes('blocktime')?1700000000:url.pathname.includes('height')?900000:{chain:'mainnet',height:900000,inscriptions:149}));
});
await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const port=(fixture.address() as any).port;
await fs.mkdir(path.join(root,'.creator-test'),{recursive:true});
const run=await fs.mkdtemp(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'btc-create-native-')),profile=path.join(run,'profile');
const logger={info:async()=>{},warn:async()=>{},error:async()=>{}};
const store=new StateStore(path.join(profile,'state'),logger);await store.init();
await store.mutate((draft:any)=>{draft.settings.theme='dark';draft.settings.contentNetworkPolicy='blocked';draft.providers=[{id:'creator-fixture',type:'ord-server',name:'Owned qualification fixture',network:'mainnet',baseUrl:`http://127.0.0.1:${port}`,enabled:true,local:true,priority:0,capabilities:defaultProviderCapabilitiesFor('ord-server'),cookieFile:''}];});await store.flush();
const packagedArgument=process.argv.find(v=>v.startsWith('--executable='));
const executablePath=packagedArgument?packagedArgument.slice('--executable='.length):rootRequire('electron');
const application=packagedArgument?await launchPackagedRenderer(executablePath,profile,root):await _electron.launch({executablePath,args:[root,'--user-data-dir='+profile],cwd:root,timeout:30000});
const checks:any[]=[];
let page:any,mainId:number;
async function call(name:string,payload:unknown={}){return page.evaluate(async({name,payload}:any)=>{const result=await (window as any).builder.invoke(name,payload);if(!result.ok)throw new Error(result.error.code+': '+result.error.message);return result.data;},{name,payload});}
async function openProject(template:string,title:string){
  const project=await call('project.create',{title,template});await call('app.creator-session',{projectId:project.id});await page.reload();
  await expect(page.locator('.project-identity strong')).toHaveText(title,{timeout:15000});
  const frame=page.frameLocator('iframe[title="Website preview"]');await expect(frame.locator('body')).toBeVisible({timeout:20000});
  await until(()=>call('preview.inspect'),(state:any)=>state?.projectId===project.id&&state.status==='ready','The native draft did not become ready');
  return {project,frame,target:{contentsId:mainId,framePath:new URL((await call('preview.inspect')).url).pathname}};
}
try{
  page=await application.firstWindow();await expect(page.locator('#app')).toHaveAttribute('aria-busy','false',{timeout:20000});
  mainId=await application.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].webContents.id);
  await page.locator('#enter-create-mode').click();await expect(page).toHaveURL('app://app/creator/generated/renderer/index.html');
  await expect(page.getByRole('heading',{name:'Make your mark on Bitcoin.'})).toBeVisible();await expect(page.locator('.template-card')).toHaveCount(13);
  await page.screenshot({path:path.join(run,'create-home.png')});checks.push({name:'Distinct native creation mode with 13 starters',passed:true});
  await page.getByRole('button',{name:'Explore library catalog'}).click();const dialog=page.getByRole('dialog',{name:'A library of possibilities.'});await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('physics');await dialog.getByRole('button',{name:/Matter.js/}).click();await expect(dialog.getByRole('heading',{name:'Matter.js 0.19.0',exact:true})).toBeVisible();await page.screenshot({path:path.join(run,'library-browser.png')});await dialog.getByRole('button',{name:'Copy example'}).click();
  const copied=await application.evaluate(({clipboard}:any)=>clipboard.readText());assert.match(copied,/Matter/);await dialog.getByRole('button',{name:'Close library browser'}).click();checks.push({name:'Library search, detail and native example clipboard',passed:true});
  const {project,frame}=await openProject('website','Mode switching test');
  assert.equal(await frame.locator('body').evaluate(()=>({node:typeof (window as any).process,creator:typeof (window as any).builder,browser:typeof (window as any).satBrowser})).then((v:any)=>v.node==='undefined'&&v.creator==='undefined'&&v.browser==='undefined'),true);
  const checkpoint=await call('project.checkpoint',{projectId:project.id,expectedRevision:project.revision,idempotencyKey:randomUUID(),label:'Before mode switch'});assert.ok(checkpoint.checkpoint);
  await page.locator('.canvas-tools').getByRole('button',{name:'Code',exact:true}).click();await page.locator('.cm-content').fill(project.files['index.html']+'\n<!-- saved before switching modes -->');
  await page.locator('.creator-mode-switch').getByRole('button',{name:'Browse',exact:true}).click();await expect(page).toHaveURL('app://app/renderer/index.html');await expect(page.locator('#app')).toHaveAttribute('aria-busy','false');
  assert.equal(await page.evaluate(()=>typeof (window as any).builder),'undefined');await page.locator('#enter-create-mode').click();await expect(page.locator('.project-identity strong')).toHaveText('Mode switching test');const saved=await call('project.read',{projectId:project.id});assert.match(saved.files['index.html'],/saved before switching modes/);checks.push({name:'Unsaved source saved on mode exit, last project restored and browser has no creator bridge',passed:true});
  const connection=await call('agent.create',{label:'Owned creator qualification',projectIds:[project.id],allowCreate:false,allowDeploy:false});const settings=JSON.parse(connection.settings),config=settings.mcpServers['bitcoin-browser-create'];
  const {Client}=creatorRequire('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=creatorRequire('@modelcontextprotocol/sdk/client/stdio.js');
  const transport=new StdioClientTransport({...config,stderr:'pipe'}),client=new Client({name:'owned-native-qualification',version:'1'});await client.connect(transport);assert.equal((await client.listTools()).tools.length,47);await client.callTool({name:'project_inspect',arguments:{projectId:project.id}});await client.close();await call('agent.revoke',{id:connection.id});checks.push({name:'47 scoped MCP tools through the actual Electron executable',passed:true});
  const warningProject=await openProject('blank','Library warning test');
  await page.getByRole('button',{name:'Libraries',exact:true}).click();await page.getByRole('button',{name:'Browse possibilities'}).click();
  const explorer=page.getByRole('dialog',{name:'A library of possibilities.'});await explorer.getByRole('button',{name:/Needs review/}).click();await explorer.getByRole('textbox').fill(unqualifiedRecord.name);
  const addResearch=explorer.getByRole('button',{name:'Add to this project',exact:true}),warning=page.getByRole('dialog',{name:'Add an unqualified library?'});
  await addResearch.click();await expect(warning).toBeVisible();await expect(warning.getByRole('button',{name:'Accept warning and add'})).toBeDisabled();await expect(warning.getByRole('checkbox')).not.toBeChecked();await expect(warning.getByRole('button',{name:'Cancel'})).toBeFocused();
  assert.equal(unqualifiedFetches,0);assert.equal((await call('project.read',{projectId:warningProject.project.id})).revision,0);
  await page.screenshot({path:path.join(run,'library-warning.png')});await warning.getByRole('button',{name:'Cancel'}).click();await expect(warning).not.toBeVisible();await expect(explorer).toBeVisible();await expect(addResearch).toBeFocused();
  await addResearch.click();await page.keyboard.press('Escape');await expect(warning).not.toBeVisible();await expect(explorer).toBeVisible();assert.equal(unqualifiedFetches,0);
  await addResearch.click();await warning.getByRole('checkbox').check();await warning.getByRole('button',{name:'Accept warning and add'}).click();await expect(warning).not.toBeVisible({timeout:15000});await expect(explorer.getByRole('button',{name:'Included in this project'})).toBeDisabled();
  const acceptedResearch=await call('project.read',{projectId:warningProject.project.id});assert.ok(acceptedResearch.libraries.includes(researchKey(unqualifiedRecord.id)));assert.equal(acceptedResearch.libraryAcceptances[0].sha256,createHash('sha256').update(unqualifiedBody).digest('hex'));
  await explorer.getByRole('button',{name:/In this project/}).click();await expect(explorer.getByRole('heading',{name:unqualifiedRecord.name,exact:true}).last()).toBeVisible();await explorer.getByRole('button',{name:'Close library browser'}).click();
  await until(()=>warningProject.frame.locator('body').evaluate(()=>({value:(window as any).libraryWarningFixture,node:typeof (window as any).process,creator:typeof (window as any).builder,browser:typeof (window as any).satBrowser})),(v:any)=>v.value===42&&v.node==='undefined'&&v.creator==='undefined'&&v.browser==='undefined','Accepted research script did not run in the native sandbox');
  const researchBuild=await call('build.create',{projectId:acceptedResearch.id,expectedRevision:acceptedResearch.revision});assert.equal(researchBuild.findings.some((f:any)=>f.severity==='error'),false);assert.ok(researchBuild.findings.some((f:any)=>f.code==='LIBRARY_WARNING_ACCEPTED'));
  checks.push({name:'Unqualified Add requires unchecked explicit consent; Cancel and Escape preserve source and focus; accepted research remains unqualified and runs in the native opaque sandbox',passed:true,fixtureScope:'Research ID served by owned loopback fixture, not qualification of the real DOMPurify inscription'});
  const experiences=[];
  for(const template of ['three','sketch','sketch2','game','audio','webgl','physics','motion','chart']){
    const item=await openProject(template,'Native '+template);const result=await qualifyExperience(application,item.target,template as any);
    const observed=await call('preview.inspect');const errors=observed.events.filter((e:any)=>e.type==='error'||e.type==='blocked'||e.type==='console'&&e.level==='error'&&!/accelerometer/.test(e.message));assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(run,template+'.png')});experiences.push({...result,buildId:observed.buildId,events:observed.events});console.log('Qualified native '+template);
  }
  checks.push({name:'Nine real interactive experiences in the native ord iframe',passed:true});
  const zip=await openProject('blank','Native JSZip');let current=zip.project;await page.getByRole('button',{name:'Libraries',exact:true}).click();await page.getByRole('textbox',{name:'Find a library'}).fill('JSZip');await page.locator('.library-card').getByRole('button',{name:'Add',exact:true}).click();await expect(warning).toBeVisible();await warning.getByRole('checkbox').check();await warning.getByRole('button',{name:'Accept warning and add'}).click();await expect(warning).not.toBeVisible();current=await call('project.read',{projectId:current.id});checks.push({name:'Sidebar Add shares mandatory warning for a supported library with pending review',passed:true});
  const html=current.files['index.html'].replace('</body>','<button id="zip">Make archive</button><p id="result"></p><script>document.getElementById("zip").onclick=async()=>{const zip=new JSZip();zip.file("hello.txt","Bitcoin Browser");const bytes=await zip.generateAsync({type:"uint8array"});document.getElementById("result").textContent="Archive bytes: "+bytes.length;};</script></body>');current=await call('project.file',{projectId:current.id,expectedRevision:current.revision,idempotencyKey:randomUUID(),path:'index.html',content:html});
  await page.reload();const zipFrame=page.frameLocator('iframe[title="Website preview"]');await zipFrame.locator('#zip').click();await expect(zipFrame.locator('#result')).toHaveText(/Archive bytes: [1-9]/);checks.push({name:'JSZip trusted click creates an archive inside native content',passed:true});
  await page.getByRole('button',{name:'Inscribe',exact:false}).first().click();await expect(page.getByRole('heading',{name:'Connect Bitcoin Core and Ord.'})).toBeVisible();checks.push({name:'Separate inscription workflow with native backend configuration and exact review',passed:true});
  const receipt={schemaVersion:1,version:JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version,packaged:Boolean(packagedArgument),driver:packagedArgument?'renderer-cdp-with-main-inspection-disabled':'playwright-electron-development',archiveSha256:packagedArgument?JSON.parse(await fs.readFile(path.resolve(path.dirname(executablePath),'../../../../release-manifest.json'),'utf8')).sha256:undefined,at:new Date().toISOString(),profile,checks,experiences,libraryHashes:libraries.map(l=>({key:l.key,id:l.id,sha256:l.sha256})),scope:'Owned loopback source with exact pinned public library bytes; no mainnet wallet or spending; production publication still requires separate qualification.'};
  await fs.writeFile(path.join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await fs.mkdir(path.join(root,'docs/evidence'),{recursive:true});await fs.writeFile(path.join(root,'docs/evidence/creator-'+(packagedArgument?'packaged':'native')+'.json'),JSON.stringify(receipt,null,2)+'\n');console.log('Native creation qualification passed. Receipt: '+path.join(run,'receipt.json'));
}catch(error){if(page)await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});console.error('Native qualification failed. Evidence: '+run);throw error;}
finally{await application.close();await new Promise<void>(resolve=>fixture.close(()=>resolve()));}
