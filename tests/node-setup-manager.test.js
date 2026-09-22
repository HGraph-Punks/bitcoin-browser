import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeSetupManager } from '../src/main/node-setup-manager.js';
import { defaultNodeSetupDraft } from '../src/main/node-setup-plan.js';
import { StateStore } from '../src/main/state-store.js';
import { ProviderManager } from '../src/main/provider-manager.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('guided setup rejects a durable pending provider cleanup before creating node files', async t => {
  const f = await fixture(t); const preview = await f.preview();
  const id = preview.providers[0].id;
  await f.store.beginProviderCleanup({ id, generation: '11111111-1111-4111-8111-111111111111' }, null);
  await assert.rejects(f.manager.run({ action: 'apply', token: preview.token }), { code: 'PROVIDER_CLEANUP_REQUIRED' });
  for (const directory of preview.directories) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.deepEqual(f.store.get(['providers']), []);
  assert.equal(f.store.getProviderCleanups()[0].id, id);
});

// Real owned storage; synthetic RPC and service lifecycle only. process.execPath
// is checked as an existing executable but is never executed by this fixture.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'satoshi-node-setup-manager-'));
  let manager; const gates = [];
  t.after(async () => { for (const gate of gates) gate.resolve(); try { await manager?.shutdown(); } finally { await fs.rm(root, { recursive:true, force:true }); } });
  const store = new StateStore(path.join(root, 'state'), null); await store.init();
  await store.mutate(state => { state.providers=[]; state.localServices=[]; state.settings.offlineMode=false; state.settings.localOnly=false; state.settings.network='mainnet'; });
  const calls = [], processStates = new Map(), timers = new Set();
  const behavior = { confirm:true, syncing:false, indexed:true, ordHeight:100, failStop:null, failRefresh:false, rpcGate:null, failSave:null };
  const providerManager = { providerMutations:new Set(), blockedProviders:new Set(),
    cleanupRecords: () => store.getProviderCleanups(), assertNoPendingCleanup: ProviderManager.prototype.assertNoPendingCleanup,
    invalidateRouting() { calls.push('invalidate'); }, refresh() { if(behavior.failRefresh) throw new Error('synthetic refresh failure'); calls.push('refresh'); }, list:()=>store.get(['providers']) };
  const services = { editing:new Map(), starting:new Map(), stopping:new Map(), removing:new Map(), processes:new Map(),
    list:()=>store.get(['localServices']).map(s=>({...s,status:processStates.get(s.id)??'stopped'})),
    async start(id) { calls.push(`start:${id}`); processStates.set(id,'running'); },
    async stop(id) { calls.push(`stop:${id}`); if(behavior.failStop===id) throw new Error('synthetic stop failure'); processStates.set(id,'stopped'); } };
  const software = { catalog:()=>({core:{version:'31',url:'synthetic'},ord:{version:'0.29'}}), discover:async()=>({core:[],ord:[]}),
    async install(kind) { calls.push(`install:${kind}`); return {executable:'/synthetic/never-run'}; }, async shutdown() { calls.push('software:shutdown'); } };
  manager = new NodeSetupManager({ stateStore:store,providerManager,localServiceManager:services,software,rootDirectory:path.join(root,'nodes'),
    confirm:async action=>{calls.push(`confirm:${action}`);return typeof behavior.confirm==='function'?behavior.confirm(action):behavior.confirm;},
    coreFactory:()=>({rpc:async method=>{calls.push(`rpc:${method}`);if(behavior.rpcGate) await behavior.rpcGate.promise;return {result:method==='getindexinfo'?{txindex:{synced:behavior.indexed}}:{chain:'main',blocks:100,headers:behavior.syncing?101:100,initialblockdownload:behavior.syncing,verificationprogress:.9,pruned:false}};}}),
    ordFactory:()=>({health:async()=>{calls.push('ord:health');return {ok:true,height:behavior.ordHeight};}}),
    restProbe:async()=>{calls.push('rest:probe');return {chain:'main'};},
    setTimer:fn=>{timers.add(fn);return fn;},clearTimer:fn=>timers.delete(fn) });
  const draft = defaultNodeSetupDraft({rootDirectory:path.join(root,'nodes')}); draft.core.executable=process.execPath;draft.ord.executable=process.execPath;
  const preview = value=>manager.run({action:'preview',draft:value??draft});
  const apply = async value=>{const p=await preview(value);return manager.run({action:'apply',token:p.token});};
  return {root,store,manager,draft,preview,apply,calls,behavior,providerManager,services,software,timers,gates,processStates};
}

test('guided apply atomically persists providers, services and setup and survives actual StateStore reopen', async t=>{
  const f=await fixture(t); const p=await f.preview(); assert.equal(f.store.get(['nodeSetup']),undefined); assert.equal(f.calls.some(c=>c.startsWith('start:')),false);
  const result=await f.manager.run({action:'apply',token:p.token}); assert.equal(result.committed,true);
  assert.equal(f.store.get(['providers']).length,2);assert.equal(f.store.get(['localServices']).length,2);
  assert.ok(f.store.get(['localServices']).every(s=>s.autoStart===false));
  for(const file of p.files) assert.equal(await fs.readFile(file.path,'utf8'),file.content);
  const reopened=new StateStore(f.store.directory,null);await reopened.init();
  assert.equal(reopened.get(['nodeSetup']).id,result.setupId);assert.deepEqual(reopened.get(['providers']),f.store.get(['providers']));
  assert.equal(f.manager.saved(result.setupId).id,result.setupId);
  assert.equal(f.providerManager.providerMutations.size,0); assert.equal(f.services.editing.size,0);
});

test('save collision after preview preserves preexisting definitions and creates no node directories',async t=>{
  const f=await fixture(t);const p=await f.preview();
  await f.store.mutate(s=>s.localServices.push({...p.services[0],name:'User owned'}));
  await assert.rejects(f.manager.run({action:'apply',token:p.token}),{code:'NODE_SETUP_COLLISION'});
  assert.equal(f.store.get(['localServices'])[0].name,'User owned');assert.equal(f.store.get(['nodeSetup']),undefined);
  await assert.rejects(fs.stat(p.directories[0]),{code:'ENOENT'});
});

test('real state rename failure rolls back only created configuration and permits explicit retry',async t=>{
  const f=await fixture(t);const p=await f.preview();const original=f.store.file;
  const blocked=path.join(f.root,'rename-block');await fs.mkdir(blocked);f.store.file=blocked;
  let failure;try{await f.manager.run({action:'apply',token:p.token});}catch(e){failure=e;}finally{f.store.file=original;}
  assert.equal(failure.syscall,'rename');assert.equal(f.store.get(['nodeSetup']),undefined);assert.deepEqual(f.store.get(['providers']),[]);
  for(const dir of p.directories) await assert.rejects(fs.stat(dir),{code:'ENOENT'});
  assert.equal(f.services.editing.size,0);assert.equal(f.providerManager.providerMutations.size,0);
  assert.equal((await f.manager.run({action:'apply',token:p.token})).committed,true);
});

test('postcommit refresh failure acknowledges saved setup and prohibits save replay',async t=>{
  const f=await fixture(t);const p=await f.preview();f.behavior.failRefresh=true;
  await assert.rejects(f.manager.run({action:'apply',token:p.token}),e=>e.code==='NODE_SETUP_SAVED_REFRESH_FAILED'&&e.details.setupCommitted===true);
  assert.ok(f.store.get(['nodeSetup']).id);assert.equal(f.store.get(['providers']).length,2);
  await assert.rejects(f.manager.run({action:'apply',token:p.token}),{code:'NODE_SETUP_PREVIEW_EXPIRED'});
});

test('failed setup preserves foreign files and reports retained folders instead of recursive cleanup', async t => {
  const f = await fixture(t); const p = await f.preview();
  const original = f.store.mutate.bind(f.store);
  f.store.mutate = async () => { await fs.writeFile(path.join(p.directories[0], 'foreign.txt'), 'user fixture', { flag: 'wx' }); throw Object.assign(new Error('synthetic save failure'), { code: 'EIO' }); };
  try {
    await assert.rejects(f.manager.run({ action: 'apply', token: p.token }), e => e.code === 'NODE_SETUP_CLEANUP_REQUIRED' && e.details.setupCommitted === false && e.details.retainedDirectories.includes(p.directories[0]));
    assert.equal(await fs.readFile(path.join(p.directories[0], 'foreign.txt'), 'utf8'), 'user fixture');
    assert.equal(f.store.get(['nodeSetup']), undefined);
  } finally { f.store.mutate = original; }
});

test('none and existing-only never create managed directories or start external processes',async t=>{
  const f=await fixture(t);f.draft.choice='none';const none=await f.preview();assert.equal(none.token,null);assert.equal(f.store.get(['nodeSetup']),undefined);
  f.draft.choice='ord';f.draft.ord.mode='existing';f.draft.ord.serverUrl='http://localhost:80';
  const saved=await f.apply();assert.equal(saved.setup.plan.services.length,0);assert.deepEqual(saved.setup.plan.directories,[]);
  const status=await f.manager.run({action:'start',setupId:saved.setupId});assert.equal(status.ord.phase,'connected');
  assert.equal(f.calls.some(c=>c.startsWith('start:')||c.startsWith('rpc:')),false);
});

test('download/apply/start require consent and privacy is rechecked after download confirmation',async t=>{
  const f=await fixture(t);f.behavior.confirm=false;
  await assert.rejects(f.manager.run({action:'install',kind:'core'}),{code:'USER_REJECTED'});
  const p=await f.preview();await assert.rejects(f.manager.run({action:'apply',token:p.token}),{code:'USER_REJECTED'});
  assert.equal(f.store.get(['nodeSetup']),undefined);
  f.behavior.confirm=true;const saved=await f.manager.run({action:'apply',token:p.token});f.behavior.confirm=false;
  await assert.rejects(f.manager.run({action:'start',setupId:saved.setupId}),{code:'USER_REJECTED'});
  f.behavior.confirm=async()=>{await f.store.updateSettings({offlineMode:true});return true;};
  await assert.rejects(f.manager.run({action:'install',kind:'ord'}),{code:'SOFTWARE_DOWNLOAD_BLOCKED'});
  assert.equal(f.calls.some(c=>c.startsWith('install:')||c.startsWith('start:')),false);
});

test('guided status distinguishes startup, permission failures, and rejected credentials', async t => {
  const f = await fixture(t); f.draft.choice = 'core'; f.draft.core.storage = 'pruned';
  const saved = await f.apply(); f.processStates.set('guided-core-mainnet', 'running');
  for (const [code, phase, message] of [
    ['PROVIDER_COOKIE_UNAVAILABLE', 'starting', /no password change/],
    ['PROVIDER_WARMING_UP', 'starting', /loading its blockchain/],
    ['PROVIDER_COOKIE_ACCESS_DENIED', 'error', /folder permissions/],
    ['PROVIDER_COOKIE_READ_FAILED', 'error', /could not be read/],
    ['PROVIDER_AUTH_ERROR', 'error', /rejected the connection/]
  ]) {
    f.manager.coreFactory = () => ({ rpc: async () => { throw Object.assign(new Error('Synthetic private details'), { code }); } });
    const status = await f.manager.run({ action: 'status', setupId: saved.setupId });
    assert.equal(status.core.phase, phase); assert.match(status.core.message, message);
    assert.doesNotMatch(status.core.message, /Synthetic private/);
  }
});

test('Core starts first; Ord waits through sync and txindex then starts once ready, stop reverses dependency order',async t=>{
  const f=await fixture(t);const saved=await f.apply();f.behavior.syncing=true;
  const status=await f.manager.run({action:'start',setupId:saved.setupId});assert.equal(status.core.phase,'syncing');assert.equal(status.ord.phase,'stopped');assert.equal(f.timers.size,1);
  assert.deepEqual(f.calls.filter(c=>c.startsWith('start:')),['start:guided-core-mainnet']);
  f.behavior.syncing=false;f.behavior.indexed=false;await f.manager.advance(f.manager.saved(saved.setupId));
  assert.equal(f.calls.includes('start:guided-ord-mainnet'),false);
  f.behavior.indexed=true;await f.manager.advance(f.manager.saved(saved.setupId));await f.manager.advance(f.manager.saved(saved.setupId));
  assert.equal(f.calls.filter(c=>c==='start:guided-ord-mainnet').length,1);assert.equal(f.timers.size,0);
  await f.manager.run({action:'stop',setupId:saved.setupId});
  assert.deepEqual(f.calls.filter(c=>c.startsWith('stop:')),['stop:guided-ord-mainnet','stop:guided-core-mainnet']);
});

test('stop suppresses delayed dependency start and still attempts Core stop after Ord stop failure',async t=>{
  const f=await fixture(t);const saved=await f.apply();f.behavior.syncing=true;await f.manager.run({action:'start',setupId:saved.setupId});
  f.behavior.syncing=false;const gate=deferred();f.gates.push(gate);f.behavior.rpcGate=gate;
  const advancing=f.manager.advance(f.manager.saved(saved.setupId));await Promise.resolve();
  f.behavior.failStop='guided-ord-mainnet';const stopping=f.manager.run({action:'stop',setupId:saved.setupId});await Promise.resolve();await Promise.resolve();
  gate.resolve();await advancing;await assert.rejects(stopping,{code:'NODE_SETUP_STOP_FAILED'});
  assert.equal(f.calls.includes('start:guided-ord-mainnet'),false);assert.ok(f.calls.includes('stop:guided-core-mainnet'));assert.equal(f.timers.size,0);
});

test('shutdown closes admission, aborts and drains held tracked readiness without starting Ord',async t=>{
  const f=await fixture(t);const saved=await f.apply();f.processStates.set('guided-core-mainnet','running');
  const gate=deferred();f.gates.push(gate);f.behavior.rpcGate=gate;
  const status=f.manager.run({action:'status',setupId:saved.setupId});const observed=status.catch(e=>e);
  for(let i=0;i<10&&!f.calls.includes('rpc:getblockchaininfo');i++)await Promise.resolve();
  let settled=false;const shutdown=f.manager.shutdown();assert.equal(shutdown,f.manager.shutdown());void shutdown.then(()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);assert.equal(f.manager.controller.signal.aborted,true);
  await assert.rejects(f.manager.run({action:'inspect'}),{code:'APP_SHUTTING_DOWN'});
  gate.resolve();assert.equal((await observed).code,'APP_SHUTTING_DOWN');await shutdown;
  assert.equal(f.calls.some(c=>c.startsWith('start:')),false);
});

test('ownership changes and concurrent apply cannot overwrite or launch revised configuration',async t=>{
  const f=await fixture(t);const p=await f.preview();const gate=deferred();f.gates.push(gate);f.behavior.confirm=()=>gate.promise;
  const first=f.manager.run({action:'apply',token:p.token});await Promise.resolve();await Promise.resolve();
  await assert.rejects(f.manager.run({action:'apply',token:p.token}),{code:'NODE_SETUP_BUSY'});
  gate.resolve(true);const saved=await first;f.behavior.confirm=true;
  await f.store.mutate(s=>{s.localServices[0].args.push('-user-edited=1');});
  await assert.rejects(f.manager.run({action:'start',setupId:saved.setupId}),{code:'NODE_SETUP_CHANGED'});
  assert.equal(f.calls.some(c=>c.startsWith('start:')),false);
});

test('unavailable REST blocks managed Ord even after Core RPC and transaction index are ready',async t=>{
  const f=await fixture(t);const saved=await f.apply();
  f.manager.restProbe=async()=>{throw new Error('synthetic REST unavailable');};
  const status=await f.manager.run({action:'start',setupId:saved.setupId});
  assert.notEqual(status.core.phase,'ready');assert.equal(f.calls.includes('start:guided-ord-mainnet'),false);
  await f.manager.run({action:'stop',setupId:saved.setupId});
});

test('shutdown during file verification prevents Core admission after that await',async t=>{
  const f=await fixture(t);const saved=await f.apply();const gate=deferred(),entered=deferred();f.gates.push(gate);
  const original=f.manager.assertFiles.bind(f.manager);f.manager.assertFiles=async record=>{await original(record);entered.resolve();await gate.promise;};
  const starting=f.manager.run({action:'start',setupId:saved.setupId});const outcome=starting.catch(e=>e);await entered.promise;
  const shutdown=f.manager.shutdown();gate.resolve();assert.equal((await outcome).code,'APP_SHUTTING_DOWN');await shutdown;
  assert.equal(f.calls.some(c=>c.startsWith('start:')),false);
});

test('privacy transition aborts an admitted synthetic download and allows a later explicit retry',async t=>{
  const f=await fixture(t);const entered=deferred();let signal;
  f.software.install=async(_kind,options)=>{signal=options.signal;entered.resolve();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
  const install=f.manager.run({action:'install',kind:'core'});const outcome=install.catch(e=>e);await entered.promise;
  await f.store.updateSettings({offlineMode:true});f.manager.settingsChanged(f.store.get(['settings']));
  assert.equal(signal.aborted,true);assert.equal((await outcome).code,'SOFTWARE_DOWNLOAD_BLOCKED');assert.equal(f.manager.downloads.size,0);
  await f.store.updateSettings({offlineMode:false});f.software.install=async()=>({executable:'/synthetic/retry'});
  assert.equal((await f.manager.run({action:'install',kind:'core'})).executable,'/synthetic/retry');
});

test('software shutdown failure propagates unchanged and stable while draining admitted work',async()=>{
  const primary=new Error('synthetic software shutdown failure');let calls=0;
  const manager=new NodeSetupManager({software:{shutdown:async()=>{calls++;throw primary;}}});
  const gate=deferred();let entered;const admission=new Promise(resolve=>{entered=resolve;});
  const work=manager.track(async()=>{entered();await gate.promise;});await admission;
  const shutdown=manager.shutdown();assert.equal(shutdown,manager.shutdown());let settled=false;
  const outcome=shutdown.catch(e=>{settled=true;return e;});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  gate.resolve();await work;assert.equal(await outcome,primary);assert.equal(calls,1);
});

test('existing-only preview, save and connection checks never probe unused storage', async t => {
  for (const choice of ['core', 'ord', 'both']) await t.test(choice, async t => {
    const f = await fixture(t);
    const unused = path.join(f.root, 'unused-node-storage');
    Object.assign(f.draft, { choice, rootDirectory: unused });
    f.draft.core.mode = 'existing'; f.draft.core.cookieFile = '/synthetic/never-read.cookie';
    f.draft.ord.mode = 'existing';
    for (const name of ['lstat', 'stat', 'realpath', 'statfs', 'access', 'mkdir']) {
      const original = fs[name].bind(fs);
      t.mock.method(fs, name, async (target, ...args) => {
        assert.notEqual(String(target), unused, `Existing services must not call ${name} for unused storage`);
        return original(target, ...args);
      });
    }
    const preview = await f.preview();
    assert.deepEqual(preview.disk, { availableBytes: null, requiredBytes: 0 });
    assert.deepEqual(preview.directories, []); assert.deepEqual(preview.services, []);
    const result = await f.manager.run({ action: 'apply', token: preview.token });
    assert.equal(result.committed, true);
    await f.manager.run({ action: 'start', setupId: result.setupId });
    assert.equal(f.calls.some(call => call.startsWith('start:')), false);
    assert.equal(f.manager.saved(result.setupId).plan.draft.rootDirectory, unused);
  });
});

test('existing-only blank storage uses internal metadata without asking for a node folder', async t => {
  const f = await fixture(t);
  f.draft.choice = 'ord'; f.draft.ord.mode = 'existing'; f.draft.rootDirectory = '';
  const preview = await f.preview();
  assert.equal(preview.draft.rootDirectory, f.manager.rootDirectory);
  assert.deepEqual(preview.directories, []);
});

test('test-chain previews give no invented capacity recommendation and retain the compiled plan', async t => {
  const f = await fixture(t);
  for (const network of ['regtest', 'signet', 'testnet']) {
    const input = { ...f.draft, network };
    const preview = await f.preview(input);
    assert.equal(preview.disk.requiredBytes, null);
    assert.equal(preview.requiredBytes, 1536 * 1024 ** 3);
    assert.doesNotMatch(preview.warnings.join(' '), /hours or days|conservative recommendation|larger drive before a full synchronization/);
    assert.match(preview.warnings.join(' '), /not a node P2P firewall/);
    assert.equal(f.manager.previewRecord.plan.requiredBytes, preview.requiredBytes);
    assert.match(f.manager.previewRecord.plan.warnings.join(' '), /hours or days/);
  }
});

test('managed storage still requires canonical checks and two GiB available at startup', async t => {
  const f = await fixture(t);
  const original = fs.lstat.bind(fs);
  const probe = t.mock.method(fs, 'lstat', async (target, ...args) => {
    if (String(target) === f.draft.rootDirectory) throw Object.assign(new Error('synthetic storage denied'), { code: 'EACCES' });
    return original(target, ...args);
  });
  await assert.rejects(f.preview(), { code: 'EACCES' });
  probe.mock.restore();
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1, bsize: 1024 ** 3 }));
  const preview = await f.preview();
  assert.match(preview.warnings.join(' '), /below the conservative recommendation/);
  const saved = await f.manager.run({ action: 'apply', token: preview.token });
  await assert.rejects(f.manager.run({ action: 'start', setupId: saved.setupId }), { code: 'NODE_SETUP_DISK_LOW' });
  assert.equal(f.calls.some(call => call.startsWith('start:')), false);
});

for (const network of ['regtest', 'signet', 'testnet']) test(`${network} review exposes the actual minimum and startup still enforces it`, async t => {
  const f = await fixture(t); f.draft.network = network; f.draft.choice = 'core';
  let availableGiB = 1;
  t.mock.method(fs, 'statfs', async () => ({ bavail: availableGiB, bsize: 1024 ** 3 }));
  const preview = await f.preview();
  assert.equal(preview.disk.requiredBytes, null);
  assert.match(preview.warnings.join(' '), /below the 2 GiB minimum.*cannot start/i);
  assert.doesNotMatch(f.manager.previewRecord.plan.warnings.join(' '), /below the 2 GiB minimum/);
  const saved = await f.manager.run({ action: 'apply', token: preview.token });
  await assert.rejects(f.manager.run({ action: 'start', setupId: saved.setupId }), { code: 'NODE_SETUP_DISK_LOW' });
  assert.equal(f.calls.some(call => call.startsWith('start:')), false);
  availableGiB = 2;
  f.manager.coreFactory = () => ({ rpc: async method => ({ result: method === 'getindexinfo'
    ? { txindex: { synced: true } } : { chain: { regtest: 'regtest', signet: 'signet', testnet: 'test' }[network], blocks: 100, headers: 100, initialblockdownload: false, verificationprogress: 1, pruned: false } }) });
  const status = await f.manager.run({ action: 'start', setupId: saved.setupId });
  assert.equal(status.core.phase, 'ready');
  assert.deepEqual(f.calls.filter(call => call.startsWith('start:')), [`start:guided-core-${network}`]);
});

test('mainnet capacity advice is not a startup prohibition above the actual minimum', async t => {
  const f = await fixture(t); f.draft.choice = 'core';
  t.mock.method(fs, 'statfs', async () => ({ bavail: 3, bsize: 1024 ** 3 }));
  const preview = await f.preview();
  assert.match(preview.warnings.join(' '), /below the conservative recommendation/);
  assert.doesNotMatch(preview.warnings.join(' '), /below the 2 GiB minimum/);
  const saved = await f.manager.run({ action: 'apply', token: preview.token });
  assert.equal((await f.manager.run({ action: 'start', setupId: saved.setupId })).core.phase, 'ready');
  assert.deepEqual(f.calls.filter(call => call.startsWith('start:')), ['start:guided-core-mainnet']);
});
