import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ProjectStore} from '../source/core/project-store';
import {importLegacyProjects} from '../source/main/import-legacy';
test('builder project import preserves identities, revisions and checkpoints, skips duplicates and rejects active writers',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'creator-import-')),source=path.join(root,'source'),destination=path.join(root,'destination'),old=new ProjectStore(source),next=new ProjectStore(destination);await old.initialize();await next.initialize();
  try{
    let project=await old.create({title:'Original website',template:'website'});
    project=await old.writeFile({projectId:project.id,expectedRevision:project.revision,idempotencyKey:'source-edit'},'custom.js','window.original=true;');
    const checkpoint=await old.checkpoint({projectId:project.id,expectedRevision:project.revision,idempotencyKey:'checkpoint'},'Before migration');
    await assert.rejects(importLegacyProjects(source,destination),(e:any)=>e.code==='SOURCE_IN_USE');await old.close();
    const result=await importLegacyProjects(source,destination);assert.deepEqual(result.imported,[project.id]);assert.deepEqual(await next.read(project.id),JSON.parse(JSON.stringify(project)));assert.equal((await next.listHistory(project.id)).checkpoints.some(c=>c.label==='Before migration'),true);
    const repeated=await importLegacyProjects(source,destination);assert.deepEqual(repeated.imported,[]);assert.deepEqual(repeated.skipped,[project.id]);
  }finally{await old.close();await next.close();await rm(root,{recursive:true,force:true});}
});
test('builder project import rejects links and storage outside the project-only grant',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'creator-import-boundary-')),source=path.join(root,'source'),destination=path.join(root,'destination'),store=new ProjectStore(source);await store.initialize();await mkdir(destination);
  try{const project=await store.create({title:'Linked source',template:'blank'});await store.close();await symlink(root,path.join(source,project.id,'external'));await assert.rejects(importLegacyProjects(source,destination),(e:any)=>e.code==='UNSAFE_IMPORT');}
  finally{await store.close();await rm(root,{recursive:true,force:true});}
});
