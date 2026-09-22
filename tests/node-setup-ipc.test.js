import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { IPC } from '../src/shared/constants.js';
import { AppError, serializeError } from '../src/shared/errors.js';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { createNodeSetupDialogs } from '../src/main/node-setup-dialogs.js';
import { shutdownApplicationManagers } from '../src/main/local-service-manager.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const trusted={senderFrame:{url:'app://app/renderer/index.html'}};
function fixture(overrides={}) {
  const calls=[];const settings={network:'mainnet',offlineMode:false,localOnly:false};
  const manager=new NodeSetupManager({rootDirectory:'/synthetic/setup',stateStore:{get:keys=>keys[0]==='settings'?(keys.length===1?settings:settings[keys[1]]):null},
    software:{catalog:()=>({core:{kind:'core',version:'31',url:'https://example.invalid/core'}}),discover:async()=>{calls.push('discover');return {core:[],ord:[]};},install:async()=>{calls.push('install');return {};},shutdown:async()=>{}},
    pick:async kind=>{calls.push(`pick:${kind}`);return {path:null};},confirm:async()=>false,...overrides});
  const handlers=new Map();let source=fs.readFileSync(new URL('../src/main/ipc.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function registerIpc','function registerIpc');
  const register=vm.runInNewContext(`(()=>{${source};return registerIpc;})()`,{path,IPC,AppError,serializeError,URL,process,structuredClone,Buffer,
    ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler),on(){}},dialog:{},shell:{}});
  const lifecycle=register({nodeSetup:manager});
  const invoke=(payload,event=trusted)=>handlers.get(IPC.NODE_SETUP)(event,payload);
  return {manager,calls,invoke,lifecycle};
}
function preload(invoke) {
  let api;const source=fs.readFileSync(new URL('../src/main/preload.cjs',import.meta.url),'utf8');
  vm.runInNewContext(`(function(require){${source}\n})`) (()=>({contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'satBrowser');api=value;}},ipcRenderer:{invoke,on(){},removeListener(){}}}));
  return api;
}

test('actual setup IPC rejects untrusted senders before manager effects and validates action shape',async()=>{
  const f=fixture();
  for(const url of ['ord://content/fixture','https://example.invalid/','app://other/renderer/index.html']) {
    const response=await f.invoke({action:'pick',kind:'cookie'},{senderFrame:{url}});assert.equal(response.error.code,'UNTRUSTED_IPC_SENDER');
  }
  assert.deepEqual(f.calls,[]);
  for(const payload of [{action:'unknown'},{action:'inspect',extra:true},{action:'pick',kind:'unknown'}]) assert.equal((await f.invoke(payload)).error.code,'INVALID_NODE_SETUP_ACTION');
  assert.deepEqual(f.calls,[]);assert.equal((await f.invoke({action:'inspect'})).ok,true);assert.deepEqual(f.calls,['discover']);await f.manager.shutdown();
});

test('actual dispatcher preserves pick cancellation and denies software download on refused consent',async()=>{
  const f=fixture();const cancelled=await f.invoke({action:'pick',kind:'cookie'});assert.equal(cancelled.ok,true);assert.equal(cancelled.result.path,null);
  const refused=await f.invoke({action:'install',kind:'core'});assert.equal(refused.error.code,'USER_REJECTED');assert.equal(refused.error.status,499);
  assert.equal(f.calls.includes('install'),false);await f.manager.shutdown();
});

test('preload setup facade uses one channel, protects explicit action and preserves committed error details',async()=>{
  const f=fixture();const calls=[];
  const api=preload(async(channel,payload)=>{calls.push({channel,payload});return f.invoke(payload);});
  assert.deepEqual(Object.keys(api.nodeSetup),['run']);await api.nodeSetup.run('inspect',{action:'install'});
  assert.equal(calls[0].channel,IPC.NODE_SETUP);assert.equal(calls[0].payload.action,'inspect');assert.equal(f.calls.includes('install'),false);
  // Boundary collaborator deliberately throws a committed main-process outcome;
  // this checks serialization, not the manager's disk commit implementation.
  f.manager.preview=async()=>{throw new AppError('NODE_SETUP_SAVED_REFRESH_FAILED','Saved; refresh failed',{status:500,details:{setupCommitted:true,setupId:'synthetic-setup'}});};
  await assert.rejects(api.nodeSetup.run('preview',{draft:{}}),e=>e.code==='NODE_SETUP_SAVED_REFRESH_FAILED'&&e.details.setupCommitted===true&&e.details.setupId==='synthetic-setup');
  await f.manager.shutdown();
});

test('IPC shutdown rejects new setup requests and drains a held admitted manager operation',async t=>{
  const gate=deferred(),entered=deferred();t.after(()=>gate.resolve({path:null}));
  const f=fixture({pick:async()=>{entered.resolve();return gate.promise;}});
  const picking=f.invoke({action:'pick',kind:'directory'});await entered.promise;
  let closed=false;const drain=f.lifecycle.shutdown();void drain.then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  assert.equal((await f.invoke({action:'inspect'})).error.code,'APP_SHUTTING_DOWN');
  gate.resolve({path:null});assert.equal((await picking).result.path,null);await drain;await f.manager.shutdown();
});

test('native dialog factory scopes four pickers, cancellation and unknown kind without native execution',async()=>{
  const calls=[];let canceled=false;const window={owned:true};
  const dialogs=createNodeSetupDialogs({showOpenDialog:async(owner,options)=>{assert.equal(owner,window);calls.push(options);return {canceled,filePaths:['/synthetic/selected']};}},()=>window);
  for(const kind of ['core-executable','ord-executable','directory','cookie']) assert.equal((await dialogs.pick(kind)).path,'/synthetic/selected');
  assert.deepEqual(calls[2].properties,['openDirectory','createDirectory']);
  for(const i of [0,1,3]) assert.deepEqual(calls[i].properties,['openFile','showHiddenFiles']);
  assert.match(calls[0].title,/not Bitcoin-Qt/);assert.match(calls[3].title,/cookie/);
  canceled=true;assert.equal((await dialogs.pick('cookie')).path,null);const count=calls.length;
  await assert.rejects(dialogs.pick('__proto__'));assert.equal(calls.length,count);
});

test('native confirmations default to Cancel and disclose download, automatic activity, P2P and cookie use',async()=>{
  const calls=[];let response=0;const dialogs=createNodeSetupDialogs({showMessageBox:async(owner,options)=>{assert.equal(owner,undefined);calls.push(options);return {response};}},()=>null);
  const plan={draft:{network:'signet',rootDirectory:'/synthetic/storage',autoStart:true},services:[{}],providers:[{},{}]};
  assert.equal(await dialogs.confirm('install',{kind:'core',version:'31',url:'https://example.invalid/core'}),false);
  response=1;assert.equal(await dialogs.confirm('apply',plan),true);assert.equal(await dialogs.confirm('start',plan),true);
  for(const options of calls){assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.equal(options.buttons[0],'Cancel');assert.equal(options.noLink,true);}
  assert.match(calls[0].detail,/https:\/\/example.invalid\/core/);assert.match(calls[0].detail,/Publisher signature verification is not performed/);assert.match(calls[0].detail,/Nothing starts yet/);
  assert.match(calls[1].detail,/automatically on future browser launches/);assert.match(calls[1].detail,/No process starts now/);
  assert.match(calls[2].detail,/selected Core cookie/);assert.match(calls[2].detail,/do not stop node peer traffic/);assert.match(calls[2].detail,/no funds/);
  await dialogs.confirm('start',{...plan,services:[]});assert.equal(calls.at(-1).buttons[1],'Check connections');
  const count=calls.length;await assert.rejects(dialogs.confirm('unknown',plan));assert.equal(calls.length,count);
});

test('easy setup requires one Cancel-default native consent with bounded, honest resource and network disclosures', async () => {
  let shown;
  const dialogs = createNodeSetupDialogs({ showMessageBox: async (_, options) => { shown = options; return { response: 0 }; } }, () => null);
  assert.equal(await dialogs.confirm('easy-start', { descriptor: { version: '31.1', url: 'https://example.invalid/core' },
    plan: { draft: { rootDirectory: '/owned/nodes', core: { dbCacheMiB: 512, validationThreads: 2 }, autoStart: false } } }), false);
  assert.equal(shown.defaultId, 0); assert.equal(shown.cancelId, 0); assert.deepEqual(shown.buttons, ['Cancel', 'Set up and start']);
  for (const phrase of [/mainnet/, /30 GiB/, /storage can grow/, /pinned SHA-256/, /Publisher signatures are not verified/,
    /OS launch protections/, /no router ports/, /no.*funds/i, /authentication cookie internally/, /do not stop that traffic/, /not start automatically/, /not an operating-system startup service/]) assert.match(shown.detail, phrase);
});

test('easy-node actions retain the trusted-shell-only IPC boundary and reject consent injection', async () => {
  const f = fixture();
  for (const action of ['capacity', 'easy-preview', 'easy-start', 'easy-status', 'easy-cancel']) {
    assert.equal((await f.invoke({ action }, { senderFrame: { url: 'ord://content/fixture' } })).error.code, 'UNTRUSTED_IPC_SENDER');
    assert.equal((await f.invoke({ action, consented: true })).error.code, 'INVALID_NODE_SETUP_ACTION');
  }
  assert.deepEqual(f.calls, []); await f.manager.shutdown();
});

test('application shutdown closes setup immediately and drains it before persistence and logger',async t=>{
  const gate=deferred(),entered=deferred();t.after(()=>gate.resolve());const calls=[];
  const f=fixture();const admitted=f.manager.track(()=>{entered.resolve();return gate.promise;});await entered.promise;let done=false;
  const drain=shutdownApplicationManagers({shutdownNodeSetup:()=>{calls.push('setup');return f.manager.shutdown();},shutdownProvider:()=>calls.push('provider'),shutdownIpc:()=>f.lifecycle.shutdown(),
    shutdownServices:()=>calls.push('services'),persistenceTasks:[()=>calls.push('state')],finalTasks:[()=>calls.push('logger')]});void drain.then(()=>{done=true;});
  assert.equal(f.manager.stopping,true);assert.deepEqual(calls,['setup','provider','services']);
  await Promise.resolve();await Promise.resolve();assert.equal(done,false);assert.equal(calls.includes('state'),false);
  gate.resolve();await admitted;await drain;
  assert.equal(done,true);assert.deepEqual(calls.slice(-2),['state','logger']);
});

test('native regtest confirmations disclose disabled peers only for an explicitly isolated managed Core', async () => {
  const calls = [];
  const dialogs = createNodeSetupDialogs({ showMessageBox: async (_, options) => { calls.push(options); return { response: 0 }; } }, () => null);
  const plan = { draft: { network: 'regtest', core: { peerConnections: 'disabled' }, rootDirectory: '/fixture', autoStart: false }, core: { managed: true }, services: [{}], providers: [{}] };
  for (const action of ['apply', 'start']) {
    assert.equal(await dialogs.confirm(action, plan), false);
    assert.match(calls.at(-1).detail, /not an OS firewall/);
    assert.match(calls.at(-1).detail, /DNS seeding/);
    assert.equal(calls.at(-1).defaultId, 0);
  }
  assert.doesNotMatch(calls.at(-1).detail, /download hundreds of gigabytes/);
  assert.match(calls.at(-1).detail, /authenticated Core RPC can change network activity/);
  await dialogs.confirm('start', { ...plan, core: { managed: false } });
  assert.doesNotMatch(calls.at(-1).detail, /regtest Core starts with peer connections and DNS seeding off/);
  await dialogs.confirm('start', { ...plan, draft: { ...plan.draft, core: {} } });
  assert.doesNotMatch(calls.at(-1).detail, /regtest Core starts with peer connections and DNS seeding off/);
});

test('native confirmations describe test-chain and existing-service storage accurately', async () => {
  const calls = [];
  const dialogs = createNodeSetupDialogs({ showMessageBox: async (_, options) => { calls.push(options); return { response: 0 }; } }, () => null);
  for (const network of ['regtest', 'signet', 'testnet']) {
    const draft = { choice: 'both', network, rootDirectory: '/unused', autoStart: false,
      core: { mode: 'managed', storage: 'archive' }, ord: { mode: 'managed', indexSats: false } };
    await dialogs.confirm('start', { draft, core: { managed: true }, ord: { managed: true }, services: [{}, {}], providers: [{}, {}] });
    assert.doesNotMatch(calls.at(-1).detail, /hundreds of gigabytes|Syncing can take days|1\.5 TiB/);
    assert.match(calls.at(-1).detail, /2 GiB/);
    draft.core.mode = 'existing'; draft.ord.mode = 'existing';
    const existing = { draft, core: { managed: false }, ord: { managed: false }, services: [], providers: [{}, {}] };
    await dialogs.confirm('apply', existing);
    assert.doesNotMatch(calls.at(-1).detail, /Storage: \/unused|creates fresh dedicated configuration/);
    await dialogs.confirm('start', existing);
    assert.equal(calls.at(-1).buttons[1], 'Check connections');
    assert.match(calls.at(-1).detail, /No new node data folders/);
    assert.doesNotMatch(calls.at(-1).detail, /hundreds of gigabytes|Syncing can take days|2 GiB/);
  }
});

test('setup shutdown failure survives shared orchestration while all persistence/final stages run',async()=>{
  const primary=new Error('synthetic setup shutdown failure');const calls=[];
  await assert.rejects(shutdownApplicationManagers({shutdownNodeSetup:()=>Promise.reject(primary),shutdownServices:()=>calls.push('services'),persistenceTasks:[()=>calls.push('state')],finalTasks:[()=>calls.push('logger')]}),e=>e instanceof AggregateError&&e.errors.includes(primary));
  assert.deepEqual(calls,['services','state','logger']);
});
