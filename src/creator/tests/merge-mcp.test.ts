import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ProjectStore} from '../source/core/project-store';
import {WorkspaceService} from '../source/core/service';
import {AgentBridge} from '../source/agent/bridge';

test('real MCP merge tools and resources preserve scoped drafts, exact reviewed results, actor attribution and reconnect retries',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-merge-mcp-')),store=new ProjectStore(path.join(root,'projects'));await store.initialize();
  const service=new WorkspaceService(store),bridge=new AgentBridge(path.join(root,'agents'),service,()=>{});await bridge.initialize();
  const project=await store.create({title:'Shared studio',template:'blank'}),privateProject=await store.create({title:'Not granted',template:'blank'});
  const connection=await bridge.create({label:'Merge assistant',projectIds:[project.id],allowCreate:false});
  const transport=()=>new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('source/mcp/entry.ts'),'--connection',connection.connectionPath],stderr:'pipe'});
  let client=new Client({name:'merge-contract',version:'1.0.0'});
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args})).structuredContent as any;
  try{
    await client.connect(transport());const listed=(await client.listTools()).tools;
    for(const name of ['file_merge_prepare','file_merge_read'])assert.equal(listed.find(t=>t.name===name)?.annotations?.readOnlyHint,true);
    assert.equal(listed.find(t=>t.name==='file_merge_apply')?.annotations?.destructiveHint,true);assert.equal(listed.find(t=>t.name==='file_merge_apply')?.annotations?.idempotentHint,true);
    const draft=project.files['index.html'].replace('</body>','<p>AI draft</p></body>');
    const current=await store.updateSettings({projectId:project.id,expectedRevision:0,idempotencyKey:randomUUID()},{headline:'A person’s saved headline'});
    const prepared=await call('file_merge_prepare',{projectId:project.id,path:'index.html',baseRevision:0,draft});assert.equal(prepared.ok,true);assert.equal(prepared.data.status,'clean');const mergeId=prepared.data.id;
    assert.equal((await call('file_merge_prepare',{projectId:privateProject.id,path:'index.html',baseRevision:0,draft})).error.code,'ACCESS_DENIED');
    assert.equal((await call('file_merge_read',{projectId:privateProject.id,mergeId,side:'draft'})).error.code,'ACCESS_DENIED');
    const uri=`btcsite://projects/${project.id}/merges/${mergeId}`;
    const resource=await client.readResource({uri});assert.equal(JSON.parse((resource.contents[0] as any).text).revision,1);
    const draftResource=await client.readResource({uri:uri+'/draft'});assert.equal(JSON.parse((draftResource.contents[0] as any).text).content,draft);
    await assert.rejects(client.readResource({uri:`btcsite://projects/${privateProject.id}/merges/${mergeId}/draft`}),/ACCESS_DENIED/);
    const first=(await call('file_merge_read',{projectId:project.id,mergeId,side:'merged',limit:100})).data;assert.equal(first.content.length,100);assert.equal(first.nextOffset,100);
    const result=(await call('file_merge_read',{projectId:project.id,mergeId,side:'merged'})).data;assert.ok(result.content.includes('AI draft'));assert.ok(result.content.includes('A person’s saved headline'));assert.equal(result.sha256,first.sha256);
    assert.equal((await client.callTool({name:'file_merge_read',arguments:{projectId:project.id,mergeId,side:'merged',limit:64001}})).isError,true);
    assert.equal((await client.callTool({name:'file_merge_apply',arguments:{projectId:project.id,mergeId,expectedRevision:1,idempotencyKey:randomUUID(),path:'index.html',resultHash:result.sha256,manualContent:'wrong',choices:[{conflictId:'a'.repeat(64),choice:'draft'}]}})).isError,true);
    const request={projectId:project.id,mergeId,expectedRevision:current.revision,idempotencyKey:randomUUID(),path:'index.html',resultHash:result.sha256};
    assert.equal((await call('file_merge_apply',{...request,resultHash:'a'.repeat(64)})).error.code,'MERGE_RESULT_CHANGED');
    const committed=await call('file_merge_apply',request);assert.equal(committed.ok,true);assert.equal(committed.revision,2);assert.equal(committed.data.change.actor.label,'Merge assistant');assert.equal(committed.data.change.actor.kind,'agent');assert.equal(committed.data.change.beforeCheckpointId,'revision:1');assert.ok(Array.isArray(committed.data.files));
    assert.equal((await store.read(project.id)).files['index.html'],result.content);
    await client.close();client=new Client({name:'merge-reconnected',version:'1.0.0'});await client.connect(transport());assert.equal((await call('file_merge_apply',request)).revision,2);
    assert.equal((await call('file_merge_apply',{...request,idempotencyKey:randomUUID()})).error.code,'REVISION_CONFLICT');
    await bridge.revoke(connection.id);await assert.rejects(client.readResource({uri:uri+'/draft'}),/ACCESS_DENIED/);assert.equal((await call('file_merge_apply',request)).error.code,'ACCESS_DENIED');
  }finally{await client.close();await bridge.close();await store.close();await rm(root,{recursive:true,force:true});}
});
