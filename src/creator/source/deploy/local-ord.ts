import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {brotliDecompressSync} from 'node:zlib';
import path from 'node:path';
import {z} from 'zod';
import {AppError} from '../core/errors';
import {readInputFile} from '../core/input-files';
import {CoreRpc,RpcError,boundedResponse,loopbackUrl,toSats} from './rpc';
import {objectHash,sha256} from './storage';
import {PreparationBroker,type PreparationMaterial} from './prepare-broker';
import type {BackendCapabilities,ChainAnchor,FundingInput,InscriptionQuote,PlannedOutput} from '../shared/deployment';
import type {Library} from '../shared/types';
import {checkChain,checkRelayFees,networkPolicy} from './network-policy';

const execute=promisify(execFile);
const ORD_SHA256='412e7763abd7325405f69d5e9693c8ce38e6fcabbea3373a08bf6f347f91b033';
export const localConfigSchema=z.object({network:z.enum(['mainnet','regtest']),rpcUrl:z.string().max(200),ordUrl:z.string().max(200),cookieFile:z.string().min(1).max(1000),ordBinary:z.string().min(1).max(1000).optional(),wallet:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),protectedOutputs:z.array(z.string().regex(/^[a-f0-9]{64}:\d{1,10}$/)).max(1000).default([])}).strict();
export type LocalOrdConfig=z.infer<typeof localConfigSchema>;
const mimeExtensions:Record<string,string>={'text/html;charset=utf-8':'html','text/css':'css','text/javascript':'js','application/json':'json','image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg','text/plain;charset=utf-8':'txt'};
export type PrepareRequest={deploymentId:string;projectId:string;buildId:string;revision:number;path:string;resourceNumber:number;resourceCount:number;mime:string;bytes:Buffer;sha256:string;dependencies:{path:string;id:string;sha256:string}[];destination:string;feeRate:number;postageSats:number};
export type CompleteMaterial=PreparationMaterial&{unsignedCommit:string;reveal:string;recovery:NonNullable<PreparationMaterial['recovery']>};
type DecodedTx={txid:string;weight:number;vsize:number;vin:{txid:string;vout:number;sequence:number;scriptSig:{hex:string};txinwitness?:string[]}[];vout:{n:number;value:number;scriptPubKey:{hex:string;type:string;address?:string}}[];locktime:number;version:number};
function requireThat(condition:unknown,message:string):asserts condition{if(!condition)throw new AppError('INVALID_TRANSACTION',message);}

export class LocalOrdBackend {
  readonly config:LocalOrdConfig;
  readonly rpc:CoreRpc;
  readonly id:string;
  readonly ordUrl:string;
  constructor(config:LocalOrdConfig,private binary:string,private workRoot:string,rpc?:CoreRpc){
    this.config=localConfigSchema.parse(config);this.rpc=rpc??new CoreRpc(config.rpcUrl,config.cookieFile,config.wallet);this.ordUrl=loopbackUrl(config.ordUrl);
    this.id=objectHash({...this.config,rpcUrl:loopbackUrl(config.rpcUrl),ordUrl:this.ordUrl,adapterVersion:1,ordSha256:ORD_SHA256});
  }
  capabilities(available=true,reason?:string):BackendCapabilities{return {id:this.id,name:this.config.network==='mainnet'?'Local Ord · Bitcoin mainnet':'Local Ord · test coins',network:this.config.network,available,reason,qualification:'macOS arm64 · Core 31.1.0 / Ord 0.29.0 · confirmed cardinal Taproot inputs · exact owner review per resource. Mainnet execution requires separate real-chain qualification.',versions:{core:'31.1.0',ord:'0.29.0'},supports:{prepare:true,ownerReview:true,resume:true,compression:true,protectedInputs:true,mainnet:this.config.network==='mainnet'},limits:{maxDecodedBytes:2_000_000,minConfirmations:1,reviewPerResource:true,fundingScript:'native-taproot',supportedMime:Object.keys(mimeExtensions)}};}
  private async ordJson(args:string[],directory:string){
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ORD_')));
    const {stdout}=await execute(this.binary,['--chain',this.config.network,'--bitcoin-data-dir',directory,'--config-dir',directory,'--data-dir',directory,...args],{timeout:90_000,maxBuffer:6_000_000,env});return JSON.parse(stdout);
  }
  async json(route:string,options?:{body:unknown}){
    if(!/^\/[a-z0-9/:_-]+$/.test(route))throw new AppError('INVALID_PROVIDER_REQUEST','Unsupported Ord path.');
    let response:Response;try{response=await fetch(this.ordUrl+route,{method:options?'POST':'GET',headers:{accept:'application/json',...(options?{'content-type':'application/json'}:{})},body:options?JSON.stringify(options.body):undefined,redirect:'error',signal:AbortSignal.timeout(15_000)});}catch{throw new AppError('PROVIDER_UNAVAILABLE','The local Ord index did not respond.');}
    if(!response.ok){await response.body?.cancel();throw new AppError('INDEX_UNAVAILABLE',`The local Ord index could not supply ${route.split('/')[1]} (HTTP ${response.status}).`);}
    try{return JSON.parse((await boundedResponse(response,4_000_000)).toString());}catch{throw new AppError('INDEX_UNAVAILABLE','The local Ord index returned an invalid response.');}
  }
  async anchor():Promise<ChainAnchor>{
    const chain=await this.rpc.call('getblockchaininfo');checkChain(this.config.network,chain);
    const height=chain.blocks,hash=chain.bestblockhash;
    const [indexedHeight,indexedHash]=await Promise.all([this.json('/r/blockheight'),this.json('/r/blockhash')]);
    if(!Number.isSafeInteger(height)||height<0||indexedHeight!==height||indexedHash!==hash||!/^([a-f0-9]{64})$/.test(hash))throw new AppError('INDEX_BEHIND','Wait for Ord and Bitcoin Core to agree on the current block height and hash.');
    if(await this.rpc.call('getbestblockhash')!==hash)throw new AppError('CHAIN_CHANGED','The chain changed during validation. Refresh the plan.');return {height,hash};
  }
  async qualify(){
    if(process.platform!=='darwin'||process.arch!=='arm64')throw new AppError('BACKEND_UNQUALIFIED','The local adapter currently supports the qualified macOS arm64 binaries.');
    if(sha256(await readInputFile(this.binary,100_000_000))!==ORD_SHA256)throw new AppError('BACKEND_VERSION','The Ord executable differs from the qualified 0.29.0 binary.');
    checkChain(this.config.network,await this.rpc.call('getblockchaininfo'));
    const info=await this.rpc.call('getnetworkinfo');if(info.version!==310100)throw new AppError('BACKEND_VERSION','The local adapter requires Bitcoin Core 31.1.0.');
    const wallets=await this.rpc.call('listwallets');if(!Array.isArray(wallets)||!wallets.includes(this.config.wallet))throw new AppError('WALLET_UNAVAILABLE','Load the selected Ord wallet in Bitcoin Core before connecting.');
    const wallet=await this.rpc.call('getwalletinfo',[],true);if(wallet.walletname!==this.config.wallet||!wallet.descriptors||!wallet.private_keys_enabled)throw new AppError('WALLET_UNAVAILABLE','A loaded descriptor-based Ord wallet with a local signer is required.');
    const indexes=await this.rpc.call('getindexinfo');if(!indexes.txindex?.synced)throw new AppError('INDEX_UNAVAILABLE','A synced Bitcoin Core transaction index is required for safe reconciliation.');
    const status=await this.json('/status');if(status.chain!==networkPolicy(this.config.network).ordChain||status.rune_index!==true||status.sat_index!==true||status.inscription_index!==true||status.json_api!==true||status.unrecoverably_reorged!==false)throw new AppError('ASSET_INDEX_REQUIRED','Ord must provide a healthy '+this.config.network+' index with sats, inscriptions, runes, and its JSON API.');
    // Ord 0.29.0's JSON status omits its version; the corresponding bounded HTML
    // status explicitly reports CARGO_PKG_VERSION. Check both server and CLI.
    const versionResponse=await fetch(this.ordUrl+'/status',{headers:{accept:'text/html'},redirect:'error',signal:AbortSignal.timeout(15_000)});if(!versionResponse.ok){await versionResponse.body?.cancel();throw new AppError('BACKEND_VERSION','The running Ord server version could not be checked.');}
    if(!/<dt>\s*version\s*<\/dt>\s*<dd>\s*0\.29\.0\s*<\/dd>/.test((await boundedResponse(versionResponse,32_000)).toString()))throw new AppError('BACKEND_VERSION','The running Ord explorer must report version 0.29.0.');
    await this.anchor();return this.capabilities();
  }
  async destination(address:string){const prefix=networkPolicy(this.config.network).addressPrefix;const result=await this.rpc.call('validateaddress',[address]);if(!address.startsWith(prefix)||result.isvalid!==true||typeof result.scriptPubKey!=='string')throw new AppError('WRONG_ADDRESS','Choose a valid '+this.config.network+' SegWit destination ('+prefix+'…).');return result.scriptPubKey as string;}
  async receive(){await this.qualify();return this.rpc.call<string>('getnewaddress',['Bitcoin Website Builder','bech32m'],true);}
  /** Verify pinned library bytes from the local node's confirmed transaction,
   * then compare Ord's served bytes. Public gateway cache evidence is not used. */
  async verifyLibraries(libraries:Library[]){
    if(!libraries.length)return [];
    if(libraries.some(library=>library.network!==this.config.network))throw new AppError('WRONG_NETWORK','Every reused library must belong to the selected Bitcoin network.');
    if(libraries.some(library=>!library.licenseReviewed))throw new AppError('LIBRARY_LICENSE_PENDING','A selected library still needs distribution review. Choose a reviewed library or a self-contained project.');
    await this.qualify();const anchor=await this.anchor();await mkdir(this.workRoot,{recursive:true,mode:0o700});const work=await mkdtemp(path.join(this.workRoot,'verify-library-'));
    try{
      const evidence=[];
      for(const library of libraries){
        const match=/^([a-f0-9]{64})i(0|[1-9][0-9]{0,9})$/.exec(library.id);
        if(!match||!Number.isSafeInteger(library.bytes)||library.bytes<0||library.bytes>16_000_000)throw new AppError('DEPENDENCY_MISMATCH','A library pin has an invalid identity or size.');
        const tx=await this.rpc.call('getrawtransaction',[match[1],true]);
        if(tx.txid!==match[1]||tx.confirmations<1||!tx.blockhash||typeof tx.hex!=='string'||!/^(?:[a-f0-9]{2})+$/.test(tx.hex))throw new AppError('DEPENDENCY_UNVERIFIED','A reused library is not confirmed in the selected node’s chain.');
        const filename=path.join(work,library.key+'.bin');if(!/^[a-z0-9-]+$/.test(library.key))throw new AppError('DEPENDENCY_MISMATCH','Invalid library key.');
        await writeFile(filename,Buffer.from(tx.hex,'hex'),{mode:0o600});const decoded=await this.ordJson(['decode','--file',filename,'--compact'],work),inscription=decoded.inscriptions?.[Number(match[2])];
        if(!inscription||inscription.delegate!=null||inscription.duplicate_field||inscription.incomplete_field||inscription.unrecognized_even_field||inscription.content_type!==library.mime||![null,undefined,'br'].includes(inscription.content_encoding)||typeof inscription.body!=='string'||!/^(?:[a-f0-9]{2})*$/.test(inscription.body))throw new AppError('DEPENDENCY_MISMATCH','The node’s library envelope differs from the pinned content or uses unsupported delegation.');
        const stored=Buffer.from(inscription.body,'hex'),bytes=inscription.content_encoding==='br'?brotliDecompressSync(stored,{maxOutputLength:library.bytes+1}):stored;
        if(bytes.length!==library.bytes||sha256(bytes)!==library.sha256)throw new AppError('DEPENDENCY_MISMATCH','The node’s confirmed library bytes differ from the catalog pin.');
        const response=await fetch(this.ordUrl+'/content/'+library.id,{headers:{'accept-encoding':'br, gzip, deflate'},redirect:'error',signal:AbortSignal.timeout(15_000)});
        if(!response.ok||response.headers.get('content-type')!==library.mime){await response.body?.cancel();throw new AppError('DEPENDENCY_MISMATCH','Ord cannot serve the confirmed library with its pinned MIME type.');}
        const served=await boundedResponse(response,library.bytes+1);if(!served.equals(bytes))throw new AppError('DEPENDENCY_MISMATCH','Ord serves library bytes that differ from Bitcoin Core’s confirmed transaction.');
        const current=await this.transaction(match[1]);if(!current||current.confirmations<1||current.blockhash!==tx.blockhash)throw new AppError('CHAIN_CHANGED','A library’s confirmation changed during verification.');
        evidence.push({id:library.id,network:this.config.network,sha256:library.sha256,blockHash:tx.blockhash,anchor});
      }
      if((await this.anchor()).hash!==anchor.hash)throw new AppError('CHAIN_CHANGED','The chain changed during library verification. Retry with the current chain.');return evidence;
    }finally{await rm(work,{recursive:true,force:true});}
  }
  private async inspectInputs(inputs:{txid:string;vout:number}[]):Promise<FundingInput[]>{
    const anchor=await this.anchor(),results:FundingInput[]=[];
    for(const input of inputs){
      const outpoint=`${input.txid}:${input.vout}`;if(this.config.protectedOutputs.includes(outpoint))throw new AppError('PROTECTED_INPUT','A selected input is explicitly protected.');
      const coin=await this.rpc.call('gettxout',[input.txid,input.vout,true]);if(!coin||coin.confirmations<1)throw new AppError('INPUT_UNAVAILABLE','A selected funding output is spent or unconfirmed.');
      if(coin.scriptPubKey.type!=='witness_v1_taproot')throw new AppError('UNSUPPORTED_INPUT','This prepared-transaction route requires confirmed native Taproot funding outputs.');
      const owner=await this.rpc.call('getaddressinfo',[coin.scriptPubKey.address],true);if(owner.ismine!==true||owner.iswatchonly)throw new AppError('INPUT_UNAVAILABLE','A selected funding output is outside the configured wallet.');
      const output=await this.json('/output/'+outpoint);
      if(output.outpoint!==outpoint||output.indexed!==true||output.spent!==false||!Array.isArray(output.inscriptions)||output.runes===null||typeof output.runes!=='object'||Array.isArray(output.runes)||output.value!==toSats(coin.value)||output.transaction!==input.txid)throw new AppError('ASSET_STATE_UNKNOWN','The index cannot establish the asset state of a funding output.');
      if(output.inscriptions.length||Object.keys(output.runes).length)throw new AppError('PROTECTED_INPUT','A selected funding output contains an inscription or runes.');
      results.push({txid:input.txid,vout:input.vout,sats:toSats(coin.value),script:coin.scriptPubKey.hex});
    }
    if((await this.anchor()).hash!==anchor.hash)throw new AppError('CHAIN_CHANGED','The chain changed during funding-input inspection. Retry with a fresh anchored check.');return results;
  }
  private async eligible(){
    const coins=await this.rpc.call<any[]>('listunspent',[1,9999999,[],false],true);if(!Array.isArray(coins)||coins.length>1000)throw new AppError('WALLET_LIMIT','This adapter accepts wallets with at most 1,000 available outputs.');
    const anchor=await this.anchor(),possible=coins.filter(coin=>coin.spendable&&coin.solvable&&coin.safe&&coin.confirmations>=1&&coin.address?.startsWith(networkPolicy(this.config.network).taprootPrefix)&&!this.config.protectedOutputs.includes(`${coin.txid}:${coin.vout}`));
    const outputs=possible.length?await this.json('/outputs',{body:possible.map(coin=>`${coin.txid}:${coin.vout}`)}):[];
    if(!Array.isArray(outputs)||outputs.length!==possible.length)throw new AppError('ASSET_STATE_UNKNOWN','Ord could not establish the funding outputs’ asset state.');
    const candidates=possible.filter((coin,index)=>{const output=outputs[index];if(output.outpoint!==`${coin.txid}:${coin.vout}`||output.indexed!==true||output.spent!==false||!Array.isArray(output.inscriptions)||output.runes===null||typeof output.runes!=='object'||Array.isArray(output.runes)||output.value!==toSats(coin.amount))throw new AppError('ASSET_STATE_UNKNOWN','The index cannot establish the asset state of a funding output.');return output.inscriptions.length===0&&Object.keys(output.runes).length===0;});
    if((await this.anchor()).hash!==anchor.hash)throw new AppError('CHAIN_CHANGED','The chain changed during wallet inspection.');
    if(!candidates.length)throw new AppError('INSUFFICIENT_SAFE_FUNDS','The wallet has no confirmed, unreserved Taproot outputs proven free of inscriptions and runes.');return candidates;
  }
  async reserve(inputs:FundingInput[]){await this.inspectInputs(inputs);const locked=await this.rpc.call('lockunspent',[false,inputs.map(({txid,vout})=>({txid,vout})),true],true);if(locked!==true)throw new AppError('INPUT_RESERVATION_FAILED','Funding inputs could not be reserved.');}
  async release(inputs:FundingInput[]){
    const locked=await this.rpc.call<{txid:string;vout:number}[]>('listlockunspent',[],true),owned=inputs.filter(input=>locked.some(coin=>coin.txid===input.txid&&coin.vout===input.vout));
    if(owned.length)await this.rpc.call('lockunspent',[true,owned.map(({txid,vout})=>({txid,vout}))],true);
  }
  async prepare(request:PrepareRequest,save:(value:PreparationMaterial)=>Promise<void>){
    if(!Number.isInteger(request.feeRate)||request.feeRate<1||request.feeRate>1000||!Number.isInteger(request.postageSats)||request.postageSats<10000||request.postageSats>1000000)throw new AppError('INVALID_QUOTE_INPUT','Choose an integer fee rate from 1–1,000 sat/vB and postage from 10,000–1,000,000 sats.');
    await this.qualify();await this.destination(request.destination);
    if(this.config.network==='mainnet')checkRelayFees(request.feeRate,await this.rpc.call('getmempoolinfo'));
    const extension=mimeExtensions[request.mime];if(!extension)throw new AppError('UNSUPPORTED_MIME','The local Ord adapter has not qualified this resource type: '+request.mime);
    if(request.bytes.length>2_000_000||sha256(request.bytes)!==request.sha256)throw new AppError('INVALID_ARTIFACT','The frozen resource is too large or its content hash changed.');
    const eligible=await this.eligible();await mkdir(this.workRoot,{recursive:true,mode:0o700});const work=await mkdtemp(path.join(this.workRoot,'prepare-'));
    const broker=new PreparationBroker(this.rpc,eligible,save,this.config.network);
    try{
      const filename=path.join(work,'content.'+extension);await writeFile(filename,request.bytes,{mode:0o600});
      const cookie=await broker.start(work);
      try{await this.ordJson(['--bitcoin-rpc-url',broker.url,'--cookie-file',cookie,'wallet','--name',this.config.wallet,'--server-url',this.ordUrl,'inscribe','--file',filename,'--fee-rate',String(request.feeRate),'--postage',String(request.postageSats)+'sat','--compress','--destination',request.destination],work);}catch{/* Completion is established only by the broker and independent verification below. */}
      broker.assertComplete();const material=broker.material as CompleteMaterial;
      const facts=await this.validateCandidate(request,material,work);return {material,facts};
    }finally{await broker.close();await rm(work,{recursive:true,force:true});}
  }
  private async validateCandidate(request:PrepareRequest,material:CompleteMaterial,work:string){
    const commit=await this.rpc.call<DecodedTx>('decoderawtransaction',[material.unsignedCommit]),reveal=await this.rpc.call<DecodedTx>('decoderawtransaction',[material.reveal]);
    requireThat(commit.vin.length>=1&&commit.vin.length<=100&&commit.vout.length>=1&&commit.vout.length<=3,'Unexpected commit transaction shape.');
    requireThat(commit.vin.every(input=>input.scriptSig.hex===''&&!input.txinwitness?.length),'The funding transaction was already signed during preparation.');
    requireThat(new Set(commit.vin.map(input=>`${input.txid}:${input.vout}`)).size===commit.vin.length,'The commit repeats a funding input.');
    requireThat(reveal.vin.length===1&&reveal.vin[0].txid===commit.txid&&reveal.vin[0].scriptSig.hex===''&&reveal.vin[0].txinwitness?.length===3&&reveal.vout.length===1,'The reveal must spend only the prepared recovery output and create one inscription output.');
    requireThat(commit.weight+2+66*commit.vin.length<400_000&&reveal.weight<400_000,'This resource exceeds the standard transaction weight limit. Reduce its stored size before publishing.');
    const inputs=await this.inspectInputs(commit.vin),destination=await this.destination(request.destination),recovery=commit.vout[reveal.vin[0].vout];
    requireThat(recovery&&reveal.vout[0].scriptPubKey.hex===destination&&toSats(reveal.vout[0].value)===request.postageSats,'The reveal destination or postage differs from the requested publication.');
    const descriptor=await this.rpc.call('getdescriptorinfo',[material.recovery[0].desc]);requireThat(descriptor.hasprivatekeys===true&&descriptor.isrange===false,'The recovery descriptor is incomplete.');
    const addresses=await this.rpc.call<string[]>('deriveaddresses',[descriptor.descriptor]);requireThat(addresses.length===1&&addresses[0]===recovery.scriptPubKey.address,'The encrypted recovery key does not control the commit output.');
    const commitOutputs:PlannedOutput[]=[];
    for(const output of commit.vout){requireThat(output.scriptPubKey.type==='witness_v1_taproot'&&!!output.scriptPubKey.address,'Unexpected commit output type.');const role=output.n===reveal.vin[0].vout?'recovery':'change';if(role==='change'){const owner=await this.rpc.call('getaddressinfo',[output.scriptPubKey.address],true);requireThat(owner.ismine===true,'Commit change does not belong to the configured wallet.');}commitOutputs.push({index:output.n,sats:toSats(output.value),address:output.scriptPubKey.address,script:output.scriptPubKey.hex,role});}
    const commitFeeSats=inputs.reduce((sum,input)=>sum+input.sats,0)-commitOutputs.reduce((sum,output)=>sum+output.sats,0),revealFeeSats=toSats(recovery.value)-request.postageSats;
    requireThat(Number.isSafeInteger(commitFeeSats)&&commitFeeSats>0&&revealFeeSats>0&&commitFeeSats+revealFeeSats<=1_000_000,'The transaction fees exceed the local adapter limit.');
    const revealFile=path.join(work,'reveal.bin');await writeFile(revealFile,Buffer.from(material.reveal,'hex'),{mode:0o600});const decoded=await this.ordJson(['decode','--file',revealFile,'--compact'],work);
    requireThat(decoded.runestone===null&&decoded.inscriptions?.length===1,'The transaction must contain one ordinary inscription and no runestone.');const inscription=decoded.inscriptions[0];
    requireThat(!inscription.duplicate_field&&!inscription.incomplete_field&&!inscription.unrecognized_even_field&&!inscription.parents?.length&&inscription.pointer==null&&inscription.delegate==null&&inscription.metaprotocol==null,'Advanced or nonstandard inscription envelopes are outside this adapter.');
    requireThat(inscription.content_type===request.mime&&[null,undefined,'br'].includes(inscription.content_encoding)&&typeof inscription.body==='string'&&inscription.body.length%2===0&&/^[0-9a-f]*$/.test(inscription.body),'The actual inscription MIME or encoding differs from the frozen artifact.');
    const stored=Buffer.from(inscription.body,'hex'),body=inscription.content_encoding==='br'?brotliDecompressSync(stored,{maxOutputLength:2_000_000}):stored;
    requireThat(body.equals(request.bytes)&&sha256(body)===request.sha256,'The transaction envelope differs from the frozen compiler bytes.');
    return {inputs,commitOutputs,revealOutputs:[{index:0,sats:request.postageSats,address:request.destination,script:destination,role:'inscription' as const}],commitFeeSats,revealFeeSats,commitTxid:commit.txid,revealTxid:reveal.txid,inscriptionId:reveal.txid+'i0',unsignedCommitSha256:sha256(Buffer.from(material.unsignedCommit,'hex')),revealSha256:sha256(Buffer.from(material.reveal,'hex')),commitVsizeEstimate:Math.ceil((commit.weight+2+66*commit.vin.length)/4),revealVsize:reveal.vsize,storedBytes:stored.length,encoding:inscription.content_encoding==='br'?'br' as const:null,anchor:await this.anchor()};
  }
  async revalidate(quote:InscriptionQuote,material:CompleteMaterial){
    await this.qualify();requireThat(quote.backendId===this.id&&quote.network===this.config.network,'The prepared backend changed.');
    requireThat(sha256(Buffer.from(material.unsignedCommit,'hex'))===quote.unsignedCommitSha256&&sha256(Buffer.from(material.reveal,'hex'))===quote.revealSha256,'Prepared transaction bytes changed after review.');
    const inputs=await this.inspectInputs(quote.inputs);requireThat(objectHash(inputs)===objectHash(quote.inputs),'The selected funding inputs changed.');await this.destination(quote.destination);
    const locks=await this.rpc.call<{txid:string;vout:number}[]>('listlockunspent',[],true);const missing=quote.inputs.filter(input=>!locks.some(lock=>lock.txid===input.txid&&lock.vout===input.vout));if(missing.length)await this.reserve(missing);
  }
  async sign(quote:InscriptionQuote,material:CompleteMaterial){
    await this.revalidate(quote,material);
    const wallet=await this.rpc.call('getwalletinfo',[],true);
    if(typeof wallet.unlocked_until==='number'&&wallet.unlocked_until*1000<=Date.now())throw new AppError('WALLET_LOCKED','Unlock the selected wallet in Bitcoin Core, then reconcile and resume this exact review. The app does not collect wallet passwords or seeds.');
    if(this.config.network==='mainnet'){const fees=await this.rpc.call('getmempoolinfo');checkRelayFees(quote.commitFeeSats/quote.commitVsizeEstimate,fees);checkRelayFees(quote.revealFeeSats/quote.revealVsize,fees);}
    // Only the reviewed execution path invokes this method. The descriptor was
    // sealed before preparation completed; Core provides an additional backup.
    const imported=await this.rpc.call<{success:boolean}[]>('importdescriptors',[material.recovery],true);requireThat(imported.length===1&&imported[0].success,'Core could not import the saved commit recovery key.');
    const signed=await this.rpc.call('signrawtransactionwithwallet',[material.unsignedCommit],true);requireThat(signed.complete===true&&typeof signed.hex==='string','The wallet did not fully sign the prepared commit.');
    const transaction=await this.rpc.call<DecodedTx>('decoderawtransaction',[signed.hex]);requireThat(transaction.txid===quote.commitTxid,'Wallet signing changed the reviewed transaction identity.');
    requireThat(transaction.vsize<=quote.commitVsizeEstimate+1&&transaction.vin.every(input=>input.txinwitness?.length===1),'The signed funding transaction exceeds its reviewed size assumption.');
    const accepted=await this.rpc.call<any[]>('testmempoolaccept',[[signed.hex,material.reveal]]);requireThat(accepted.length===2&&accepted.every(result=>result.allowed===true),'The node rejected the prepared commit/reveal package. Preserve this plan and inspect the node before retrying.');
    return signed.hex as string;
  }
  async transaction(txid:string):Promise<{txid:string;confirmations:number;blockhash?:string}|null>{try{const tx=await this.rpc.call('getrawtransaction',[txid,true]);requireThat(tx.txid===txid,'The node returned the wrong transaction.');return {txid,confirmations:tx.confirmations??0,blockhash:tx.blockhash};}catch(error){if(error instanceof RpcError&&error.rpcCode===-5)return null;throw error;}}
  async broadcast(hex:string,expected:string){await this.qualify();const txid=await this.rpc.call<string>('sendrawtransaction',[hex]);requireThat(txid===expected,'The node returned an unexpected transaction ID.');return txid;}
  async verifyContent(quote:InscriptionQuote){
    const tx=await this.transaction(quote.revealTxid);if(!tx||tx.confirmations<1||!tx.blockhash)throw new AppError('NOT_CONFIRMED','Wait for the reveal transaction to confirm.');const anchor=await this.anchor();
    const response=await fetch(this.ordUrl+'/content/'+quote.inscriptionId,{headers:{'accept-encoding':'br, gzip, deflate'},redirect:'error',signal:AbortSignal.timeout(15_000)});
    if(!response.ok){await response.body?.cancel();throw new AppError('NOT_INDEXED','The confirmed inscription is waiting for Ord indexing.');}
    requireThat(response.headers.get('content-type')===quote.mime,'Published content has an unexpected MIME type.');const bytes=await boundedResponse(response,quote.decodedBytes+1);
    requireThat(bytes.length===quote.decodedBytes&&sha256(bytes)===quote.contentSha256,'Published inscription bytes differ from the frozen artifact.');
    const current=await this.transaction(quote.revealTxid);if(current?.blockhash!==tx.blockhash||current.confirmations<1||(await this.anchor()).hash!==anchor.hash)throw new AppError('CHAIN_CHANGED','The chain changed while checking published content.');
    return {at:new Date().toISOString(),blockHash:tx.blockhash,anchor,sha256:quote.contentSha256};
  }
}
