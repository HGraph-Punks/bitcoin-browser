import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AppError} from '../core/errors';
import {CoreRpc} from './rpc';
import {networkPolicy,type LocalNetwork} from './network-policy';

export type PreparationMaterial={unsignedCommit?:string;reveal?:string;recovery?:{desc:string;timestamp:'now';active:false;internal:false;label:string}[];signedCommit?:string};
const isHex=(value:unknown):value is string=>typeof value==='string'&&value.length>20&&value.length<=2_000_000&&value.length%2===0&&/^[0-9a-f]+$/.test(value);
const noParams=(params:unknown[])=>params.length===0;

/**
 * A single-use constructor capability, not a generic RPC proxy. The child only
 * receives a random broker cookie. No Core credential or wallet signing method
 * is supplied. Sensitive constructor output is sealed before acknowledging it.
 */
export class PreparationBroker {
  private server?:http.Server;
  private auth=Buffer.alloc(0);
  private port=0;
  private inFlight=false;
  private calls=0;
  readonly material:PreparationMaterial={};
  readonly trace:string[]=[];
  stoppedAtBroadcast=false;
  private failure?:string;
  constructor(private rpc:CoreRpc,private eligible:any[],private save:(material:PreparationMaterial)=>Promise<void>,private network:LocalNetwork='regtest'){}
  get url(){return `http://127.0.0.1:${this.port}`;}
  async start(workDirectory:string){
    const cookie='builder-prepare:'+randomBytes(32).toString('hex');this.auth=Buffer.from('Basic '+Buffer.from(cookie).toString('base64'));
    const cookieFile=path.join(workDirectory,'constructor.cookie');await writeFile(cookieFile,cookie,{mode:0o600,flag:'wx'});
    this.server=http.createServer((req,res)=>void this.handle(req,res));this.server.requestTimeout=15_000;this.server.headersTimeout=10_000;
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});this.port=(this.server.address() as AddressInfo).port;return cookieFile;
  }
  private reply(response:http.ServerResponse,id:unknown,result:unknown,error?:{code:number;message:string}){const bytes=Buffer.from(JSON.stringify({result:error?null:result,error:error??null,id}));response.writeHead(error?500:200,{'content-type':'application/json','content-length':bytes.length});response.end(bytes);}
  private async handle(request:http.IncomingMessage,response:http.ServerResponse){
    const auth=Buffer.from(request.headers.authorization??'');
    if(request.method!=='POST'||request.headers.origin||request.headers.host!==`127.0.0.1:${this.port}`||auth.length!==this.auth.length||!timingSafeEqual(auth,this.auth)||!['/','/wallet/'+encodeURIComponent(this.rpc.wallet)].includes(request.url??'')||this.inFlight||++this.calls>100){response.writeHead(403);response.end();return;}
    this.inFlight=true;let id:unknown=null;
    try{
      let size=0;const chunks:Buffer[]=[];for await(const chunk of request){size+=chunk.length;if(size>3_000_000)throw new Error('request-too-large');chunks.push(Buffer.from(chunk));}
      const call=JSON.parse(Buffer.concat(chunks).toString());id=call.id;
      if(!call||typeof call.method!=='string'||!Array.isArray(call.params)||!['string','number'].includes(typeof id))throw new Error('invalid-request');
      const method=call.method,params:unknown[]=call.params;this.trace.push(method);
      const result=await this.dispatch(method,params);this.reply(response,id,result);
    }catch(error){this.failure=(error instanceof AppError?error.code:'CONSTRUCTOR_DENIED');this.reply(response,id,null,{code:-32001,message:'Builder preparation boundary refused this operation.'});}
    finally{this.inFlight=false;}
  }
  private async dispatch(method:string,params:unknown[]):Promise<unknown>{
    const wallet=this.rpc.wallet;
    const recoveryKey=new RegExp('^rawtr\\('+networkPolicy(this.network).wifPrefix+'[1-9A-HJ-NP-Za-km-z]{50,51}\\)$'),recoveryDescriptor=new RegExp('^rawtr\\('+networkPolicy(this.network).wifPrefix+'[1-9A-HJ-NP-Za-km-z]{50,51}\\)#[a-z0-9]{8}$');
    if(['getnetworkinfo','getblockchaininfo','getblockcount'].includes(method)&&noParams(params))return this.rpc.call(method);
    if(method==='listwallets'&&noParams(params))return [wallet];
    if(method==='getwalletinfo'&&noParams(params))return this.rpc.call(method,[],true);
    if(method==='listdescriptors'&&(noParams(params)||params.length===1&&(params[0]===null||params[0]===false)))return this.rpc.call(method,[false],true);
    if(method==='listunspent'&&noParams(params))return this.eligible;
    if(method==='listlockunspent'&&noParams(params))return [];
    // Ord sees only already-checked cardinal inputs. It may ask to lock an empty
    // list; never forward broad unlock/lock operations from the constructor.
    if(method==='lockunspent'&&params.length===2&&params[0]===false&&Array.isArray(params[1])&&params[1].length===0)return true;
    if(method==='getrawchangeaddress'&&params.length===1&&params[0]==='bech32m')return this.rpc.call(method,params,true);
    if(method==='gettxout'&&params.length>=2&&params.length<=3&&this.eligible.some(coin=>coin.txid===params[0]&&coin.vout===params[1]))return this.rpc.call(method,params);
    if(method==='getrawtransaction'&&params.length<=2&&this.eligible.some(coin=>coin.txid===params[0]))return this.rpc.call(method,params);
    if(method==='signrawtransactionwithwallet'&&isHex(params[0])&&params.length<=3){
      if(!this.material.unsignedCommit){if(params.length>1&&params[1]!=null)throw new Error('unexpected-commit-inputs');this.material.unsignedCommit=params[0];}
      else if(!this.material.reveal){this.material.reveal=params[0];}
      else throw new Error('extra-signing-call');
      await this.save(this.material);return {hex:params[0],complete:true};
    }
    if(method==='getdescriptorinfo'&&params.length===1&&typeof params[0]==='string'&&recoveryKey.test(params[0])&&this.material.reveal)return this.rpc.call(method,params);
    if(method==='importdescriptors'&&params.length===1&&Array.isArray(params[0])&&params[0].length===1&&this.material.reveal&&!this.material.recovery){
      const entry=params[0][0];if(!entry||typeof entry.desc!=='string'||!recoveryDescriptor.test(entry.desc)||entry.timestamp!=='now'||entry.active!==false||entry.internal!==false||entry.label!=='commit tx recovery key'||Object.keys(entry).some(k=>!['desc','timestamp','active','internal','label'].includes(k)))throw new Error('unexpected-descriptor');
      this.material.recovery=[entry];await this.save(this.material);return [{success:true}];
    }
    if(method==='sendrawtransaction'&&params[0]===this.material.unsignedCommit&&this.material.reveal&&this.material.recovery){this.stoppedAtBroadcast=true;throw new AppError('PREPARED_WITHOUT_BROADCAST','Prepared without broadcasting.');}
    throw new AppError('CONSTRUCTOR_METHOD_DENIED',`Pinned constructor requested an unsupported method: ${method.slice(0,60)}.`);
  }
  assertComplete(){if(!this.stoppedAtBroadcast||this.failure!=='PREPARED_WITHOUT_BROADCAST'||!this.material.unsignedCommit||!this.material.reveal||!this.material.recovery)throw new AppError('PREPARATION_FAILED',`The pinned Ord constructor did not produce a complete candidate. Allowed-call trace: ${this.trace.join(', ').slice(0,600)}.`);}
  async close(){this.server?.closeAllConnections();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.auth.fill(0);}
}
