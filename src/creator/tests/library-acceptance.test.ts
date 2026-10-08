import {test} from 'node:test';
import {LocalOrdBackend} from '../source/deploy/local-ord';
import {AppError} from '../source/core/errors';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectStore} from '../source/core/project-store';
import {WorkspaceService} from '../source/core/service';
import {buildProject,prepareResource} from '../source/compiler/build';
import {encodeProject,decodeProject} from '../source/core/portable';
import {includeLibrary} from '../source/main/library-inclusions';
import {NativeDraftPreview} from '../source/main/native-preview';
import {researchKey} from '../source/catalog/library-acceptance';
import research from '../source/catalog/research-catalog.json';
const context=(p:{id:string;revision:number})=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});
async function fixture(t:any){const root=await mkdtemp(path.join(os.tmpdir(),'creator-library-warning-')),store=new ProjectStore(root);await store.initialize();t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true})});return store;}

test('unqualified additions require desktop warning acceptance before fetching or changing source',async t=>{
  const store=await fixture(t),project=await store.create({title:'Explicit consent',template:'blank'});let fetches=0;
  const resolver={resolve:async()=>{fetches++;return {status:200,data:Buffer.from('window.researchWorks=42'),headers:{'content-type':'text/javascript'}}}};
  const record=research.entries.find(r=>r.status==='restricted')!,key=researchKey(record.id);
  await assert.rejects(includeLibrary(store,resolver,()=>({network:'mainnet'}),{...context(project),key}),{code:'LIBRARY_WARNING_REQUIRED'});
  await assert.rejects(store.addLibrary(context(project),'jszip-3.10.1'),{code:'LIBRARY_WARNING_REQUIRED'});
  const service=new WorkspaceService(store);
  await assert.rejects(service.execute('library.add',{...context(project),key,acceptWarning:true},undefined,{kind:'agent',label:'Fixture agent'}));
  assert.equal(fetches,0);assert.deepEqual(await store.read(project.id),project);
  const supported=await includeLibrary(store,resolver,()=>({network:'mainnet'}),{...context(project),key:'jszip-3.10.1',acceptWarning:true});
  assert.equal(fetches,0);assert.equal(buildProject(supported).libraries[0].licenseReviewed,false);assert.ok(buildProject(supported).libraries[0].userAcknowledgement);assert.match(supported.files['index.html'],/Permission is hereby granted/);
});

test('accepted restricted library is pinned, previews safely, survives history and archive, and rejects byte substitution',async t=>{
  const store=await fixture(t),initial=await store.create({title:'Research experience',template:'blank'}),record=research.entries.find(r=>r.status==='restricted')!,key=researchKey(record.id),bytes=Buffer.from('window.researchWorks=42;');
  let response=bytes;
  const resolver={resolve:async()=>({status:200,data:response,headers:{'content-type':'text/javascript; charset=utf-8'}})};
  const project=await includeLibrary(store,resolver,()=>({network:'mainnet'}),{...context(initial),key,acceptWarning:true,format:'classic'}),build=buildProject(project),pin=project.libraryAcceptances![0];
  assert.equal(pin.mime,'text/javascript; charset=utf-8');assert.equal(build.libraries[0].storedBytes,0);
  assert.equal(pin.sha256,createHash('sha256').update(bytes).digest('hex'));assert.match(project.files['index.html'],new RegExp('src="/content/'+record.id+'"'));
  assert.equal(build.findings.some(f=>f.severity==='error'),false);assert.equal(build.libraries[0].runtimeTested,false);assert.equal(build.libraries[0].licenseReviewed,false);assert.ok(build.findings.some(f=>f.code==='LIBRARY_WARNING_ACCEPTED'));
  assert.ok(prepareResource(build,'index.html',{},'mainnet').text!.includes(record.id));assert.throws(()=>prepareResource(build,'index.html',{},'regtest'),{code:'WRONG_NETWORK'});
  const preview=new NativeDraftPreview(()=>null,resolver,()=>({network:'mainnet'}),()=>{},(id,sha)=>store.readAsset(id,sha)),state=(await preview.start(build))!,url=new URL(state.url);url.pathname='/content/'+record.id;
  assert.equal((await preview.resolve(new Request(url))).status,200);response=Buffer.from('substituted');assert.equal((await preview.resolve(new Request(url))).status,502);
  const undone=await store.history(context(project),'undo');assert.equal(undone.libraries.length,0);assert.equal(undone.libraryAcceptances,undefined);
  const redone=await store.history(context(undone),'redo');assert.deepEqual(redone.libraryAcceptances,project.libraryAcceptances);
  const data=decodeProject(await encodeProject(redone,(id,sha)=>store.readAsset(id,sha))),copy=await store.create({title:data.title,template:data.template},undefined,data);
  assert.deepEqual(copy.libraryAcceptances,project.libraryAcceptances);assert.equal(buildProject(copy).sha256,build.sha256);
  await assert.rejects(store.create({title:'Tampered acceptance',template:'blank'},undefined,{...data,libraryAcceptances:[{...pin,key:'jszip-3.10.1'}],libraries:['jszip-3.10.1']}),{code:'LIBRARY_ACCEPTANCE_MISMATCH'});
});

test('failed source, wrong network, wrong format and revision races leave the project unchanged',async t=>{
  const store=await fixture(t),project=await store.create({title:'No partial changes',template:'blank'}),record=research.entries[0],key=researchKey(record.id);
  const args={...context(project),key,acceptWarning:true};let fetches=0;
  const resolver={resolve:async()=>{fetches++;return {status:404,data:Buffer.alloc(0),headers:{}}}};
  await assert.rejects(includeLibrary(store,resolver,()=>({network:'regtest'}),args),{code:'LIBRARY_NETWORK'});assert.equal(fetches,0);
  await assert.rejects(includeLibrary(store,resolver,()=>({network:'mainnet'}),args),{code:'LIBRARY_UNAVAILABLE'});
  await assert.rejects(includeLibrary(store,{resolve:async()=>({status:200,data:Buffer.from('<html>'),headers:{'content-type':'text/html'}})},()=>({network:'mainnet'}),args),{code:'LIBRARY_FORMAT'});assert.deepEqual(await store.read(project.id),project);
  const changed=await store.updateSettings(context(project),{headline:'Concurrent edit'});
  await assert.rejects(includeLibrary(store,{resolve:async()=>({status:200,data:Buffer.from('window.x=1'),headers:{'content-type':'text/javascript'}})},()=>({network:'mainnet'}),args),{code:'REVISION_CONFLICT'});assert.deepEqual(await store.read(project.id),changed);
});

test('accepting an unqualified library never bypasses the publication license gate',async t=>{
  const store=await fixture(t),project=await store.create({title:'Publication guards',template:'blank'});
  const included=await includeLibrary(store,{resolve:async()=>{throw new Error('Unexpected fetch')}},()=>({network:'mainnet'}),{...context(project),key:'jszip-3.10.1',acceptWarning:true}),library=buildProject(included).libraries[0];
  class UnavailableNode extends LocalOrdBackend {override async qualify():Promise<never>{throw new AppError('NODE_NOT_SYNCED','Owned fixture: no synced node');}}
  const backend=new UnavailableNode({network:'mainnet',rpcUrl:'http://127.0.0.1:8332',ordUrl:'http://127.0.0.1:8080',cookieFile:'/private/tmp/unused-library-fixture.cookie',wallet:'fixture',protectedOutputs:[]},'/private/tmp/unused-ord',store.root);
  await assert.rejects(backend.verifyLibraries([{...library,userAcknowledgement:undefined}]),{code:'LIBRARY_LICENSE_PENDING'});
  await assert.rejects(backend.verifyLibraries([library]),{code:'LIBRARY_LICENSE_PENDING'});
  await assert.rejects(backend.verifyLibraries([{...library,sha256:'a'.repeat(64)}]),{code:'LIBRARY_LICENSE_PENDING'});
});

test('accepted CSS, module and resource includes keep their format and MIME across compilation',async t=>{
  const store=await fixture(t),record=research.entries[0];
  for(const [format,mime,body,include] of [['stylesheet','text/css','body{color:red}',/rel="stylesheet"/],['esm','text/javascript','export const value=42;',/type="module"/],['asset','application/wasm','fixture resource',/as="fetch"/]] as const){
    const project=await store.create({title:'Format '+format,template:'blank'});
    const included=await includeLibrary(store,{resolve:async()=>({status:200,data:Buffer.from(body),headers:{'content-type':mime}})},()=>({network:'mainnet'}),{...context(project),key:researchKey(record.id),acceptWarning:true,format});
    assert.match(included.files['index.html'],include);const build=buildProject(included);assert.equal(build.libraries[0].format,format);assert.equal(build.libraries[0].mime,mime);assert.equal(build.findings.some(f=>f.severity==='error'),false);
  }
});
