import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkChain,checkRelayFees,networkPolicy} from '../source/deploy/network-policy';
import {PreparationBroker} from '../source/deploy/prepare-broker';
import {CoreRpc} from '../source/deploy/rpc';
import {LocalOrdBackend} from '../source/deploy/local-ord';
import type {CompleteMaterial} from '../source/deploy/local-ord';
import type {InscriptionQuote} from '../source/shared/deployment';

test('mainnet qualification rejects wrong chains, partial synchronization, warnings and insufficient relay fees',()=>{
  const synced={chain:'main',initialblockdownload:false,blocks:900000,headers:900000,warnings:[]};
  assert.doesNotThrow(()=>checkChain('mainnet',synced));
  assert.throws(()=>checkChain('mainnet',{...synced,chain:'regtest'}),{code:'WRONG_NETWORK'});
  for(const change of [{initialblockdownload:true},{initialblockdownload:undefined},{headers:900001},{blocks:NaN}])assert.throws(()=>checkChain('mainnet',{...synced,...change}),{code:'NODE_NOT_SYNCED'});
  for(const warnings of [['fork detected'],undefined,'unknown'])assert.throws(()=>checkChain('mainnet',{...synced,warnings}),{code:'NODE_WARNING'});
  assert.doesNotThrow(()=>checkChain('regtest',{chain:'regtest',blocks:1}));
  const fees={mempoolminfee:0.000025,minrelaytxfee:0.00001};
  assert.throws(()=>checkRelayFees(2,fees),{code:'FEE_TOO_LOW'});assert.doesNotThrow(()=>checkRelayFees(2.5,fees));
  assert.throws(()=>checkRelayFees(10,{...fees,mempoolminfee:NaN}),{code:'FEE_UNAVAILABLE'});
  assert.equal(networkPolicy('mainnet').taprootPrefix,'bc1p');assert.equal(networkPolicy('regtest').coreChain,'regtest');
});

test('constructor broker accepts only network-correct recovery descriptors and never forwards funding signatures',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-mainnet-broker-')),calls:string[]=[],saved:unknown[]=[];
  class FixtureRpc extends CoreRpc{override async call<T=any>(method:string):Promise<T>{calls.push(method);return {descriptor:'public descriptor'} as T;}}
  const rpc=new FixtureRpc('http://127.0.0.1:8332',path.join(root,'unused.cookie'),'owned-fixture'),broker=new PreparationBroker(rpc,[],async material=>{saved.push(structuredClone(material));},'mainnet');
  try{
    const cookie=await readFile(await broker.start(root),'utf8');
    const request=async(method:string,params:unknown[])=>{const result=await fetch(broker.url,{method:'POST',headers:{authorization:'Basic '+Buffer.from(cookie).toString('base64'),'content-type':'application/json'},body:JSON.stringify({id:1,method,params})});return result.json() as Promise<{result:any;error:any}>;};
    const unsigned='ab'.repeat(20),reveal='cd'.repeat(20);
    assert.equal((await request('signrawtransactionwithwallet',[unsigned])).result.hex,unsigned);
    assert.equal((await request('signrawtransactionwithwallet',[reveal])).result.hex,reveal);
    // These are shape-only strings, not generated wallet keys.
    const mainnetKey='K'+'1'.repeat(51),testnetKey='c'+'1'.repeat(51);
    assert.ok((await request('getdescriptorinfo',['rawtr('+testnetKey+')'])).error);
    assert.ok((await request('getdescriptorinfo',['rawtr('+mainnetKey+')'])).result);
    const descriptor=(key:string)=>({desc:'rawtr('+key+')#abcdefgh',timestamp:'now',active:false,internal:false,label:'commit tx recovery key'});
    assert.ok((await request('importdescriptors',[[descriptor(testnetKey)]])).error);
    assert.equal((await request('importdescriptors',[[descriptor(mainnetKey)]])).result[0].success,true);
    assert.deepEqual(calls,['getdescriptorinfo']);assert.equal(saved.length,3);
    assert.ok((await request('walletpassphrase',['not-a-password',10])).error);
    assert.ok((await request('sendrawtransaction',[unsigned])).error);
    broker.assertComplete();assert.deepEqual(calls,['getdescriptorinfo']);
  }finally{await broker.close();await rm(root,{recursive:true,force:true});}
});

test('locked funding wallets fail before descriptor import or wallet signing',async()=>{
  const calls:string[]=[];
  class FixtureRpc extends CoreRpc{override async call<T=any>(method:string):Promise<T>{calls.push(method);if(method==='getwalletinfo')return {unlocked_until:0} as T;throw new Error('Unexpected wallet mutation');}}
  const rpc=new FixtureRpc('http://127.0.0.1:8332','unused.cookie','owned-fixture'),backend=new LocalOrdBackend({network:'mainnet',rpcUrl:rpc.url,ordUrl:'http://127.0.0.1:8080',cookieFile:rpc.cookieFile,wallet:rpc.wallet,protectedOutputs:[]},'unused.ord','unused.constructor',rpc);
  backend.revalidate=async()=>{};
  await assert.rejects(backend.sign({} as InscriptionQuote,{} as CompleteMaterial),{code:'WALLET_LOCKED'});
  assert.deepEqual(calls,['getwalletinfo']);
});
