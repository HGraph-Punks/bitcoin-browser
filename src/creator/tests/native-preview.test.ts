import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NativeDraftPreview} from '../source/main/native-preview';
import {ProjectStore} from '../source/core/project-store';
import {buildProject} from '../source/compiler/build';
import {libraries} from '../source/catalog/libraries';
test('native browser draft protocol binds revisions, content hashes, methods and resource ranges',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'creator-preview-')),store=new ProjectStore(root);await store.initialize();
  try{
    const project=await store.create({title:'Native draft',template:'website'}),build=buildProject(project);
    const resolver={resolve:async()=>{throw new Error('Unexpected source request');}};
    const preview=new NativeDraftPreview(()=>null,resolver,()=>({network:'mainnet'}),()=>{},(id,sha)=>store.readAsset(id,sha));
    const state=(await preview.start(build))!;
    const response=await preview.resolve(new Request(state.url));assert.equal(response.status,200);assert.equal(await response.text(),build.html);assert.match(response.headers.get('content-security-policy')!,/frame-src 'none'/);
    assert.equal((await preview.resolve(new Request(state.url,{method:'POST'}))).status,404);
    const ranged=await preview.resolve(new Request(state.url,{headers:{range:'bytes=2-8'}}));assert.equal(ranged.status,206);assert.equal(await ranged.text(),Buffer.from(build.html).subarray(2,9).toString());assert.equal(ranged.headers.get('content-range'),`bytes 2-8/${Buffer.byteLength(build.html)}`);
    const unknown=new URL(state.url);unknown.pathname='/content/'+'1'.repeat(64)+'i0';assert.equal((await preview.resolve(new Request(unknown))).status,404);assert.equal(preview.inspect()!.events.at(-1)!.type,'blocked');
    const newer={...build,id:'b'.repeat(64),revision:build.revision+1};await preview.start(newer);assert.equal((await preview.resolve(new Request(state.url))).status,404);
    await preview.stop();assert.equal((await preview.resolve(new Request(state.url))).status,404);
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
test('native sources cannot substitute catalog bytes or serve mainnet libraries on another network',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'creator-integrity-')),store=new ProjectStore(root);await store.initialize();
  try{
    const project=await store.create({title:'Physics draft',template:'physics'}),build=buildProject(project),library=build.libraries.find(l=>l.name==='Matter.js')!;assert.ok(library);
    let calls=0,network='regtest';const preview=new NativeDraftPreview(()=>null,{resolve:async()=>{calls++;return {data:Buffer.from('substituted'),status:200,headers:{}};}},()=>({network}),()=>{},()=>Promise.reject(new Error('Unexpected asset')));
    const state=(await preview.start(build))!,url=new URL(state.url);url.pathname='/content/'+library.id;
    assert.equal((await preview.resolve(new Request(url))).status,502);assert.equal(calls,0);
    network='mainnet';assert.equal((await preview.resolve(new Request(url))).status,502);assert.equal(calls,1);assert.match(preview.inspect()!.events.at(-1)!.message,/unexpected library bytes/);
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
