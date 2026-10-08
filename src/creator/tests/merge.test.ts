import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareSourceMerge,resolveSourceMerge} from '../source/core/source-merge';
import {SourceMergeService} from '../source/core/merge-service';
import {ProjectStore} from '../source/core/project-store';
import {WorkspaceService} from '../source/core/service';
import {AppError} from '../source/core/errors';
import type {MergeReview,MergePage} from '../source/shared/merge';
import type {ProjectSnapshot} from '../source/shared/types';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const mutation=(p:Pick<ProjectSnapshot,'id'|'revision'>)=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-merge-')),store=new ProjectStore(path.join(root,'projects'));await store.initialize();return {root,store,service:new WorkspaceService(store),close:async()=>{await store.close();await rm(root,{recursive:true,force:true});}};}

test('three-way text merge preserves separate edits, Unicode, CRLF, spacing and final newlines exactly',()=>{
  for(const [base,draft,current,expected] of [
    ['<h1>Hello</h1><p>world</p>','<h1>Welcome</h1><p>world</p>','<h1>Hello</h1><p>everyone</p>','<h1>Welcome</h1><p>everyone</p>'],
    ['😀 one\r\n🧡 two\r\nend','😀 THREE\r\n🧡 two\r\nend','😀 one\r\n🧡 FOUR\r\nend','😀 THREE\r\n🧡 FOUR\r\nend'],
    ['  A\n  B\n','\tA\n  B\n','  A\n  C','\tA\n  C'],
    ['base','base','saved','saved'],['base','draft','base','draft'],['base','same','same','same'],
    ['', 'hello', '', 'hello'],['hello','','hello','']
  ]){const plan=prepareSourceMerge({base,draft,current});assert.equal(plan.status,'clean');assert.equal(resolveSourceMerge(plan),expected);}
});

test('overlapping edits require an explicit complete resolution while compatible saved edits survive every choice',()=>{
  const plan=prepareSourceMerge({base:'start:111111|tail:222222',draft:'start:333333|tail:222222',current:'start:444444|tail:555555'});
  assert.equal(plan.status,'conflicts');const conflict=plan.parts.find(p=>p.kind==='conflict')!;assert.equal(conflict.kind,'conflict');
  assert.throws(()=>resolveSourceMerge(plan),{code:'MERGE_UNRESOLVED'});
  assert.equal(resolveSourceMerge(plan,{choices:[{conflictId:conflict.id,choice:'draft'}]}),'start:333333|tail:555555');
  assert.equal(resolveSourceMerge(plan,{choices:[{conflictId:conflict.id,choice:'current'}]}),'start:444444|tail:555555');
  assert.equal(resolveSourceMerge(plan,{choices:[{conflictId:conflict.id,choice:'custom',text:'777777'}]}),'start:777777|tail:555555');
  assert.throws(()=>resolveSourceMerge(plan,{choices:[{conflictId:'bad',choice:'draft'}]}),{code:'INVALID_RESOLUTION'});
  assert.throws(()=>resolveSourceMerge(plan,{choices:[{conflictId:conflict.id,choice:'draft'},{conflictId:conflict.id,choice:'current'}]}),{code:'INVALID_RESOLUTION'});
  assert.throws(()=>resolveSourceMerge(plan,{choices:[{conflictId:conflict.id,choice:'draft'}],manualContent:'whole'}),{code:'INVALID_RESOLUTION'});
  assert.equal(resolveSourceMerge(plan,{manualContent:'My complete result\n'}),'My complete result\n');
  const samePoint=prepareSourceMerge({base:'ab',draft:'aXYb',current:'aZWb'});assert.equal(samePoint.status,'conflicts');
});

test('missing files, independent creation, binary paths and bounded manual fallback cannot silently discard source',()=>{
  const removed=prepareSourceMerge({base:'old',draft:'edited',current:null});assert.equal(removed.status,'conflicts');
  const part=removed.parts[0];assert.equal(part.kind,'conflict');
  assert.equal(resolveSourceMerge(removed,{choices:[{conflictId:part.id,choice:'current'}]}),null);
  assert.equal(resolveSourceMerge(removed,{choices:[{conflictId:part.id,choice:'draft'}]}),'edited');
  assert.equal(resolveSourceMerge(prepareSourceMerge({base:'old',draft:'old',current:null})),null);
  assert.equal(prepareSourceMerge({base:null,draft:'mine',current:'theirs'}).status,'conflicts');
  assert.equal(resolveSourceMerge(prepareSourceMerge({base:null,draft:'mine',current:null})),'mine');
  const blocked=prepareSourceMerge({base:'old',draft:'mine',current:null,currentIsAsset:true});assert.throws(()=>resolveSourceMerge(blocked,{manualContent:'force'}),{code:'MERGE_BLOCKED'});
  const large=prepareSourceMerge({base:'a'.repeat(210_000),draft:'b'.repeat(210_000),current:'c'.repeat(210_000)});assert.equal(large.status,'manual');assert.equal(resolveSourceMerge(large,{manualContent:'Reviewed'}),'Reviewed');
  const expensive=prepareSourceMerge({base:'a'.repeat(5000),draft:'b'.repeat(5000),current:'c'.repeat(5000)});assert.equal(expensive.status,'manual');
  assert.throws(()=>resolveSourceMerge(large,{manualContent:'😀'.repeat(500_001)}),{code:'FILE_TOO_LARGE'});
});

test('review is read-only; commit binds exact revision, path and result hash, persists retry, and remains undoable',async()=>{
  const f=await fixture();try{
    let p=await f.store.create({title:'Merge me',template:'website'});const base=p,draft=p.files['index.html'].replace(base.settings.headline,'A person’s headline');
    p=await f.store.updateSettings(mutation(p),{description:'A saved description from another editor.'});
    const pointer=path.join(f.store.root,p.id,'project.btcsite'),before=await readFile(pointer,'utf8');
    const review:MergeReview=await f.service.execute('file.merge-prepare',{projectId:p.id,path:'index.html',baseRevision:0,draft});assert.equal(review.status,'clean');
    const page:MergePage=await f.service.execute('file.merge-read',{projectId:p.id,mergeId:review.id,side:'merged'});assert.ok(page.content?.includes('A person’s headline'));assert.ok(page.content?.includes('A saved description from another editor.'));
    assert.equal(await readFile(pointer,'utf8'),before);
    const commit={...mutation(p),path:review.path,mergeId:review.id,resultHash:page.sha256};
    await assert.rejects(f.service.execute('file.merge-apply',{...commit,resultHash:sha('forged')}),{code:'MERGE_RESULT_CHANGED'});
    await assert.rejects(f.service.execute('file.merge-apply',{...commit,path:'other.html'}),{code:'MERGE_MISMATCH'});
    p=await f.service.execute('file.merge-apply',commit);assert.equal(p.revision,2);assert.equal(p.settings.headline,'A person’s headline');assert.equal(p.settings.description,'A saved description from another editor.');assert.equal(p.change?.beforeCheckpointId,'revision:1');
    assert.ok((await f.store.listHistory(p.id)).checkpoints.some(c=>c.kind==='before-merge'&&c.revision===1));
    const restartedService=new WorkspaceService(f.store);assert.equal((await restartedService.execute('file.merge-apply',commit)).revision,2);
    await assert.rejects(restartedService.execute('file.merge-apply',{...commit,resultHash:sha('different')}),{code:'IDEMPOTENCY_CONFLICT'});
    p=await f.store.history(mutation(p),'undo');assert.equal(p.files['index.html'],(await f.store.readRevision(p.id,1)).files['index.html']);
    p=await f.store.history(mutation(p),'redo');assert.equal(p.settings.headline,'A person’s headline');
    p=await f.store.writeFile(mutation(p),'index.html',p.files['index.html'].replace(/(<title[^>]*>)[^<]*(<\/title>)/,'$1Renamed in source$2'));assert.equal(p.settings.name,'Renamed in source');assert.equal(p.title,'Renamed in source');
  }finally{await f.close();}
});

test('a newer expected revision cannot bypass an old review; rebasing a completed result preserves it',async()=>{
  const f=await fixture();try{
    let p=await f.store.create({title:'Rebase',template:'blank'});p=await f.store.writeFile(mutation(p),'data.txt','name:111111|value:222222|end:333333');const base=p;
    p=await f.store.writeFile(mutation(p),'data.txt','name:444444|value:222222|end:333333');
    const review=await f.service.merges.prepare(p.id,'data.txt',base.revision,'name:555555|value:222222|end:333333');assert.equal(review.status,'conflicts');
    const resolution={manualContent:'name:My manual choice|value:222222|end:333333'},result=f.service.merges.read(p.id,review.id,'merged',resolution);
    p=await f.store.writeFile(mutation(p),'data.txt','name:444444|value:666666|end:333333');
    const request={...mutation(p),path:'data.txt',mergeId:review.id,resultHash:result.sha256,...resolution};
    await assert.rejects(f.service.execute('file.merge-apply',{...request,expectedRevision:review.revision}),{code:'REVISION_CONFLICT'});
    await assert.rejects(f.service.execute('file.merge-apply',request),{code:'REVISION_CONFLICT'});assert.equal((await f.store.read(p.id)).revision,p.revision);
    const refreshed=await f.service.merges.prepare(p.id,'data.txt',review.revision,result.content!);assert.equal(refreshed.status,'clean');const combined=f.service.merges.read(p.id,refreshed.id,'merged');assert.equal(combined.content,'name:My manual choice|value:666666|end:333333');
    p=await f.service.execute('file.merge-apply',{...mutation(p),path:'data.txt',mergeId:refreshed.id,resultHash:combined.sha256});assert.equal(p.files['data.txt'],combined.content);
  }finally{await f.close();}
});

test('merge cache expiry, eviction and project boundaries are explicit; paged reads retain the full hash',async()=>{
  const f=await fixture();try{
    const p=await f.store.create({title:'Paging',template:'blank'}),other=await f.store.create({title:'Private',template:'blank'});let now=1000;
    const service=new SourceMergeService(f.store,undefined,()=>now),draft='😀'.repeat(40_000),review=await service.prepare(p.id,'data.txt',0,draft);
    const first=service.read(p.id,review.id,'merged',{},0,64_000),last=service.read(p.id,review.id,'merged',{},first.nextOffset!);assert.equal(first.content!+last.content!,draft);assert.equal(first.sha256,sha(draft));assert.equal(first.sha256,last.sha256);assert.equal(last.nextOffset,null);
    assert.throws(()=>service.inspect(other.id,review.id),{code:'MERGE_EXPIRED'});
    for(let i=0;i<8;i++)await service.prepare(p.id,'data.txt',0,'entry '+i);assert.throws(()=>service.inspect(p.id,review.id),{code:'MERGE_EXPIRED'});
    const latest=await service.prepare(p.id,'data.txt',0,'expires');now+=30*60_000;assert.throws(()=>service.read(p.id,latest.id,'draft'),{code:'MERGE_EXPIRED'});
    await assert.rejects(service.prepare(p.id,'../private.txt',0,'x'),{code:'UNSAFE_PATH'});await assert.rejects(service.prepare(p.id,'data.txt',1,'x'),{code:'INVALID_BASE'});
    await assert.rejects(service.prepare(p.id,'data.txt',0,'😀'.repeat(500_001)),{code:'FILE_TOO_LARGE'});
    const fallback=new SourceMergeService(f.store,async()=>{throw new AppError('MERGE_TIMEOUT','Injected worker timeout');});const safe=await fallback.prepare(p.id,'index.html',0,p.files['index.html']+'\n');assert.equal(safe.status,'manual');assert.equal(fallback.read(p.id,safe.id,'draft').content,p.files['index.html']+'\n');
  }finally{await f.close();}
});
