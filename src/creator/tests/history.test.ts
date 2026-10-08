import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectStore} from '../source/core/project-store';
import {WorkspaceService} from '../source/core/service';
import type {ProjectSnapshot} from '../source/shared/types';
import {compareProjects} from '../source/core/project-diff';

const mutation=(p:Pick<ProjectSnapshot,'id'|'revision'>)=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-history-')),store=new ProjectStore(path.join(root,'projects'));await store.initialize();return {root,store,close:async()=>{await store.close();await rm(root,{recursive:true,force:true});}};}

test('checkpoints persist through restart; restore and undo retain source, assets, attribution and every committed revision',async()=>{
  const f=await fixture();let store=f.store;
  try{
    const initial=await store.create({title:'History',template:'website'}),request=mutation(initial),checkpoint=await store.checkpoint(request,'Before the redesign');
    assert.equal((await store.checkpoint(request,'Before the redesign')).checkpoint?.id,checkpoint.checkpoint?.id);assert.equal((await store.read(initial.id)).revision,0);
    await assert.rejects(store.checkpoint(request,'Different label'),{code:'IDEMPOTENCY_CONFLICT'});
    const actor={kind:'agent' as const,label:'Studio assistant',id:randomUUID()};
    let p=await store.runAs(actor,()=>store.updateSettings(mutation(initial),{headline:'A changed design'}));assert.equal(p.change?.actor.label,actor.label);assert.equal(p.change?.beforeCheckpointId,'revision:0');
    p=await store.importFiles(mutation(p),[{path:'assets/pixel.bin',bytes:Buffer.from([1,2,3])}]);
    const beforeRestore=p;const history=await store.listHistory(p.id);assert.deepEqual(history.revisions.map(r=>r.revision),[2,1,0]);assert.equal(history.revisions[0].actor.kind,'user');assert.ok(history.checkpoints.some(c=>c.id==='revision:0'&&c.kind==='before-agent'));
    const difference=await store.diff(p.id,0,2);assert.ok(difference.settings.some(s=>s.field==='headline'&&s.after==='A changed design'));assert.ok(difference.files.some(file=>file.path==='assets/pixel.bin'&&file.status==='added'));assert.ok(difference.files.some(file=>file.hunks?.some(h=>h.lines.some(l=>l.kind==='added'&&l.text.includes('A changed design')))));
    await store.close();store=new ProjectStore(path.join(f.root,'projects'));await store.initialize();
    const restoreRequest=mutation(beforeRestore);p=await store.restore(restoreRequest,checkpoint.checkpoint!.id);assert.equal(p.revision,3);assert.deepEqual(p.files,initial.files);assert.deepEqual(p.assets,{});assert.equal(p.change?.beforeCheckpointId,'revision:2');
    assert.equal((await store.restore(restoreRequest,checkpoint.checkpoint!.id)).revision,3);
    p=await store.history(mutation(p),'undo');assert.equal(p.revision,4);assert.equal(p.settings.headline,'A changed design');assert.deepEqual(await store.readAsset(p.id,p.assets['assets/pixel.bin'].sha256),Buffer.from([1,2,3]));
    assert.equal((await store.readRevision(p.id,2)).files['index.html'],beforeRestore.files['index.html']);
    assert.deepEqual((await store.listHistory(p.id,{limit:2})).revisions.map(r=>r.revision),[4,3]);assert.equal((await store.listHistory(p.id,{before:3,limit:2})).nextBefore,1);
    const removed=await store.removeCheckpoint(mutation(p),checkpoint.checkpoint!.id);assert.equal(removed.revision,4);await assert.rejects(store.restore(mutation(p),checkpoint.checkpoint!.id),{code:'CHECKPOINT_NOT_FOUND'});
    assert.equal((await store.restore(mutation(p),'revision:0')).settings.headline,initial.settings.headline);
  }finally{await store.close();await rm(f.root,{recursive:true,force:true});}
});

test('concurrent edits and checkpoint requests preserve revision checks and idempotency boundaries',async()=>{
  const f=await fixture();try{
    const p=await f.store.create({title:'Concurrency',template:'blank'}),context=mutation(p);
    const outcomes=await Promise.allSettled([f.store.updateSettings(context,{headline:'First'}),f.store.checkpoint({...context,idempotencyKey:randomUUID()},'Stale checkpoint')]);
    assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');if(outcomes[1].status==='rejected')assert.equal(outcomes[1].reason.code,'REVISION_CONFLICT');
    const current=await f.store.read(p.id);await assert.rejects(f.store.checkpoint({...context,expectedRevision:current.revision},'Reused edit key'),{code:'IDEMPOTENCY_CONFLICT'});
    const checkpointRequest=mutation(current);await f.store.checkpoint(checkpointRequest,'A valid point');await assert.rejects(f.store.writeFile(checkpointRequest,'data.json','{}'),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(f.store.restore({...mutation(current),expectedRevision:0},'revision:0'),{code:'REVISION_CONFLICT'});
    const service=new WorkspaceService(f.store);const build=await service.execute('build.create',{projectId:p.id,expectedRevision:current.revision});assert.equal(build.sourceCheckpointId,'revision:1');assert.equal((await f.store.read(p.id)).revision,1);
    const record=await f.store.listHistory(p.id);assert.ok(record.checkpoints.some(c=>c.kind==='before-build'&&c.revision===1));
    const before=JSON.stringify(record);await service.execute('build.create',{projectId:p.id,expectedRevision:1});assert.equal(JSON.stringify(await f.store.listHistory(p.id)),before);
  }finally{await f.close();}
});

test('legacy history starts honestly at its known revision, uncommitted records stay invisible, and failed writes cannot advance it',async()=>{
  const f=await fixture();try{
    const created=await f.store.create({title:'Legacy',template:'blank'}),directory=path.join(f.store.root,created.id),file=path.join(directory,'project.btcsite'),pointer=JSON.parse(await readFile(file,'utf8'));
    delete pointer.historyStart;delete pointer.checkpoints;delete pointer.checkpointOperations;pointer.schemaVersion=1;pointer.revision=7;await writeFile(file,JSON.stringify(pointer));await rm(path.join(directory,'revisions'),{recursive:true});
    const history=await f.store.listHistory(created.id);assert.equal(history.availableFrom,7);assert.deepEqual(history.revisions.map(r=>r.revision),[7]);await assert.rejects(f.store.readRevision(created.id,6),{code:'REVISION_NOT_AVAILABLE'});
    const migrated=await f.store.writeFile({...mutation(created),expectedRevision:7},'data.json','{"ready":true}');assert.equal(migrated.revision,8);assert.equal((await f.store.listHistory(created.id)).availableFrom,7);
    await writeFile(path.join(directory,'revisions','9.json'),'{incomplete orphan');await assert.rejects(f.store.readRevision(created.id,9),{code:'REVISION_NOT_AVAILABLE'});
    const save=(f.store as any).saveRecord;(f.store as any).saveRecord=async()=>{throw new Error('Injected record write failure')};
    await assert.rejects(f.store.writeFile(mutation(migrated),'data.json','{"ready":false}'),/Injected/);(f.store as any).saveRecord=save;
    assert.equal((await f.store.read(created.id)).revision,8);assert.equal((await f.store.read(created.id)).files['data.json'],'{"ready":true}');
    const final=await f.store.writeFile(mutation(migrated),'data.json','{"ready":"again"}');assert.equal(final.revision,9);assert.deepEqual((await f.store.listHistory(created.id)).revisions.map(r=>r.revision),[9,8,7]);
  }finally{await f.close();}
});

test('automatic checkpoint retention keeps named labels and older source restorable; diffs and revision paths are bounded',async()=>{
  const f=await fixture();try{
    let p=await f.store.create({title:'Many edits',template:'blank'});const named=await f.store.checkpoint(mutation(p),'Keep forever');
    for(let index=0;index<203;index++)p=await f.store.runAs({kind:'agent',label:'Batch editor'},()=>f.store.writeFile(mutation(p),'data.json',JSON.stringify({index})));
    const history=await f.store.listHistory(p.id);assert.ok(history.checkpoints.some(c=>c.id===named.checkpoint!.id));assert.equal(history.checkpoints.filter(c=>c.kind!=='named').length,200);
    assert.equal((await f.store.restore(mutation(p),'revision:0')).files['data.json'],undefined);p=await f.store.read(p.id);
    p=await f.store.writeFile(mutation(p),'long.js','const value="'+'a'.repeat(500_000)+'";');const diff=await f.store.diff(p.id,0,p.revision,{maxCharacters:1000,maxLines:20});assert.equal(diff.truncated,true);assert.ok(diff.files.find(f=>f.path==='long.js')?.afterUri);
    await assert.rejects(f.store.diff(p.id,0,p.revision,{path:'../private'}),{code:'UNSAFE_PATH'});
    const second=await f.store.create({title:'Other project',template:'blank'}),firstRecords=path.join(f.store.root,p.id,'revisions');await rm(firstRecords,{recursive:true});await symlink(path.join(f.store.root,second.id,'revisions'),firstRecords);
    await assert.rejects(f.store.readRevision(p.id,0),{code:'UNSAFE_PATH'});
  }finally{await f.close();}
});

test('line comparisons retain end-of-file newline changes and explicit output limits',()=>{
  const source={assets:{},libraries:[],settings:{} as ProjectSnapshot['settings'],files:{'data.json':'{"value":1}\n'}};
  const difference=compareProjects(randomUUID(),0,1,source,{...source,files:{'data.json':'{"value":1}'}});
  const lines=difference.files[0].hunks?.flatMap(hunk=>hunk.lines)??[];assert.ok(lines.some(line=>line.kind==='added'&&line.noNewline));assert.notEqual(difference.files[0].before?.sha256,difference.files[0].after?.sha256);
  const manyLines=Array.from({length:300},(_,i)=>'line '+i).join('\n');const limited=compareProjects(randomUUID(),0,1,{...source,files:{}},{...source,files:{'notes.txt':manyLines}},{maxLines:20,maxCharacters:1000});
  assert.equal(limited.truncated,true);assert.equal(limited.files[0].hunks?.flatMap(h=>h.lines).length,20);assert.ok(limited.files[0].afterUri);
});

test('valid Unicode paths remain restorable when full-project changes exceed the normal history page budget',async()=>{
  const f=await fixture();try{
    let p=await f.store.create({title:'Unicode history',template:'blank'});const directory='漢'.repeat(70);
    const entries=Array.from({length:255},(_,index)=>({path:directory+'/'+directory+'/'+'文'.repeat(60)+'-'+index+'.txt',bytes:Buffer.from('Saved source\n')}));
    p=await f.store.importFiles(mutation(p),entries);const checkpoint=(await f.store.checkpoint(mutation(p),'Before reorganizing')).checkpoint!;
    const files=Object.fromEntries(Object.entries(p.files).map(([name,content])=>[name==='index.html'?name:name.replace(directory,'字'.repeat(70)),content]));
    p=await f.store.replaceFiles(mutation(p),files,{}, {type:'reorganize-source'});
    const records=await f.store.listHistory(p.id,{limit:50});assert.equal(records.revisions.length,1);assert.equal(records.nextBefore,2);assert.ok(Buffer.byteLength(JSON.stringify(records.revisions[0]))>300_000);
    assert.deepEqual((await f.store.listHistory(p.id,{before:records.nextBefore})).revisions.map(record=>record.revision),[1,0]);
    p=await f.store.restore(mutation(p),checkpoint.id);assert.equal(p.revision,3);assert.equal(p.files[entries[0].path],'Saved source\n');assert.equal(Object.keys(p.files).length,256);
  }finally{await f.close();}
});
