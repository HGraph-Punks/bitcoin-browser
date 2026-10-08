import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectStore} from '../source/core/project-store';
import {buildProject} from '../source/compiler/build';
import {updateTemplateFields} from '../source/core/templates';
const context=(p:{id:string;revision:number})=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});

test('project edits survive reopening; undo/redo use monotonic revisions and preserve custom code',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-store-'));const store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'First site',template:'website'});
  p=await store.writeFile(context(p),'index.html',p.files['index.html'].replace('</body>','<script>window.customValue=42;</script></body>'));
  p=await store.updateSettings(context(p),{headline:'A <new> beginning',name:'My site'});
  assert(p.files['index.html'].includes('A &lt;new&gt; beginning'));
  assert(p.files['index.html'].includes('window.customValue=42'));
  assert.equal(p.title,'My site');const saved=p;
  p=await store.history(context(p),'undo');assert.equal(p.revision,3);assert.equal(p.title,'First site');assert(p.canRedo);
  p=await store.history(context(p),'redo');assert.equal(p.revision,4);assert.equal(p.files['index.html'],saved.files['index.html']);
  await store.close();const reopened=new ProjectStore(root);await reopened.initialize();t.after(()=>reopened.close());
  assert.deepEqual(await reopened.read(p.id),p);
});

test('competing edits reject stale revisions and retries do not apply twice',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-conflict-'));const store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  const p=await store.create({title:'Concurrency',template:'blank'}),first=context(p),second=context(p);
  const result=await Promise.allSettled([store.updateSettings(first,{headline:'Human edit'}),store.updateSettings(second,{headline:'AI edit'})]);
  assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');
  if(result[1].status==='rejected')assert.equal(result[1].reason.code,'REVISION_CONFLICT');
  const repeated=await store.updateSettings(first,{headline:'Human edit'});assert.equal(repeated.revision,1);
  await assert.rejects(store.updateSettings(first,{headline:'Different operation'}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal((await store.read(p.id)).settings.headline,'Human edit');
});

test('safe source paths and snapshot boundaries prevent escaped reads or writes',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-paths-'));const store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  const p=await store.create({title:'Paths',template:'blank'});
  for(const name of ['../escape','/tmp/escape','.hidden','nested/../escape','C:\\escape'])assert.throws(()=>store.writeFile(context(p),name,'x'),{code:'UNSAFE_PATH'});
  const state=JSON.parse(await readFile(path.join(root,p.id,'project.btcsite'),'utf8'));
  const filename=path.join(root,p.id,'versions',state.version,'source','index.html');
  const outside=path.join(root,'outside.html');await writeFile(outside,'private');
  const {unlink}=await import('node:fs/promises');await unlink(filename);await symlink(outside,filename);
  await assert.rejects(store.read(p.id),{code:'UNSAFE_PATH'});
});

test('writer ownership prevents unsynchronized concurrent services',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-lock-'));const store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  await assert.rejects(new ProjectStore(root).initialize(),{code:'PROJECTS_IN_USE'});
});

test('build hashes are deterministic; on-chain Three core is transitive; external requests block release',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-build-'));const store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'Sculpture',template:'three'});const a=buildProject(p),b=buildProject(p);
  assert.equal(a.sha256,b.sha256);assert.equal(a.compressedBytes,b.compressedBytes);
  assert.deepEqual(a.libraries.map(l=>l.key),['three-r178','three-core-r178']);
  assert(!a.findings.some(f=>f.severity==='error'));
  p=await store.writeFile(context(p),'index.html',p.files['index.html'].replace('</head>','<script src="https://cdn.example.com/code.js"></script></head>'));
  assert(buildProject(p).findings.some(f=>f.code==='EXTERNAL_RESOURCE'&&f.severity==='error'));
});

test('visual updates refuse missing markers instead of rebuilding custom source',()=>{
  assert.throws(()=>updateTemplateFields('<h1>custom</h1>',{headline:'changed'}),{code:'VISUAL_FIELD_MISSING'});
});
