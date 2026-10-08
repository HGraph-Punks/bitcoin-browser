import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
const execute=promisify(execFile);
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function port():Promise<number>{const s=net.createServer();return new Promise((resolve,reject)=>{s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const value=(s.address() as net.AddressInfo).port;s.close(()=>resolve(value));});});}

// Disposable development infrastructure. Never targets the user's node or wallet.
export class RegtestEnvironment {
  private core?:ChildProcess;
  private ord?:ChildProcess;
  private rpcPort=0;
  private ordPort=0;
  private minerAddress='';
  readonly coreDir:string;
  readonly ordDir:string;
  constructor(readonly root:string,readonly tools=path.resolve('.tools')){this.coreDir=path.join(root,'core-data');this.ordDir=path.join(root,'ord-data');}
  get ordUrl(){return `http://127.0.0.1:${this.ordPort}`;}
  get rpcUrl(){return `http://127.0.0.1:${this.rpcPort}`;}
  private coreBinary(){return path.join(this.tools,'core/bitcoin-31.1/bin/bitcoind');}
  private ordBinary(){return path.join(this.tools,'ord/ord-0.29.0/ord');}
  private ordArgs(rpcUrl=this.rpcUrl){const url=new URL(rpcUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('The disposable regtest RPC must stay on loopback.');return ['--regtest','--bitcoin-data-dir',this.coreDir,'--bitcoin-rpc-url',rpcUrl,'--cookie-file',path.join(this.coreDir,'regtest/.cookie'),'--data-dir',this.ordDir,'--config-dir',path.join(this.root,'ord-config'),'--index-sats','--index-runes','--index-addresses','--index-cache-size','33554432'];}
  async rpc<T=any>(method:string,params:unknown[]=[],wallet?:string):Promise<T>{
    const cookie=await readFile(path.join(this.coreDir,'regtest/.cookie'),'utf8');
    const response=await fetch(`http://127.0.0.1:${this.rpcPort}${wallet?'/wallet/'+encodeURIComponent(wallet):''}`,{method:'POST',headers:{authorization:'Basic '+Buffer.from(cookie.trim()).toString('base64'),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20_000)});
    const body=await response.json() as {result:T;error?:{code:number;message:string}};
    if(body.error)throw new Error(`${method}: ${body.error.message}`);return body.result;
  }
  async runOrd<T=any>(args:string[],options:{rpcUrl?:string}={}):Promise<T>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ORD_')));
    const {stdout}=await execute(this.ordBinary(),[...this.ordArgs(options.rpcUrl),...args],{timeout:120_000,maxBuffer:4_000_000,env});
    return JSON.parse(stdout);
  }
  async wallet<T=any>(args:string[],options:{rpcUrl?:string}={}){return this.runOrd<T>(['wallet','--name','builder-regtest','--server-url',this.ordUrl,...args],options);}
  async receive(){
    const result=await this.wallet<{addresses:string[]}>(['receive']);
    const address=result.addresses?.[0];
    if(typeof address!=='string'||!address.startsWith('bcrt1'))throw new Error('Ord did not return a regtest receive address.');
    return address;
  }
  private async launch(binary:string,args:string[],name:string):Promise<ChildProcess>{
    const log=await open(path.join(this.root,name+'.log'),'a',0o600);
    const process=spawn(binary,args,{stdio:['ignore',log.fd,log.fd]});
    const launched=new Promise<void>((resolve,reject)=>{process.once('spawn',resolve);process.once('error',reject);});
    await log.close();await launched;return process;
  }
  private async startCore(){
    this.core=await this.launch(this.coreBinary(),['-regtest',`-datadir=${this.coreDir}`,`-conf=${path.join(this.coreDir,'bitcoin.conf')}`,`-rpcport=${this.rpcPort}`,'-server=1','-listen=0','-connect=0','-dnsseed=0','-discover=0','-txindex=1','-rest=1','-fallbackfee=0.00001','-dbcache=64','-printtoconsole=1'],'bitcoind');
    await this.until(async()=>{const info=await this.rpc('getblockchaininfo');if(info.chain!=='regtest')throw new Error('Wrong network');return true;},this.core);
  }
  private async startOrd(){this.ord=await this.launch(this.ordBinary(),[...this.ordArgs(),'server','--address','127.0.0.1','--http-port',String(this.ordPort),'--polling-interval','100ms'],'ord');await this.waitForIndex();}
  async start(){
    await mkdir(this.coreDir,{recursive:true,mode:0o700});await mkdir(this.ordDir,{recursive:true,mode:0o700});await mkdir(path.join(this.root,'ord-config'),{recursive:true});
    await writeFile(path.join(this.coreDir,'bitcoin.conf'),'');
    this.rpcPort=await port();this.ordPort=await port();
    await this.startCore();
    await this.rpc('createwallet',['builder-miner']);this.minerAddress=await this.rpc('getnewaddress',[],'builder-miner');
    await this.rpc('generatetoaddress',[101,this.minerAddress]);
    await this.startOrd();
    // The disposable seed returned here is deliberately neither logged nor exported.
    await this.wallet(['create']);
    const address=await this.receive();
    await this.rpc('sendtoaddress',[address,1],'builder-miner');await this.mine(1);
    return {chain:'regtest',coreVersion:31.1,ordVersion:'0.29.0',height:await this.rpc('getblockcount')};
  }
  private async until(check:()=>Promise<boolean>,child?:ChildProcess){
    const end=Date.now()+30_000;let last:unknown;
    while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error(`Child process exited with ${child.exitCode}; inspect owned logs in ${this.root}`);try{if(await check())return;}catch(error){last=error;}await wait(100);}
    throw new Error(`Regtest readiness timed out: ${last instanceof Error?last.message:'index did not catch up'}`);
  }
  async waitForIndex(){
    const height=await this.rpc<number>('getblockcount'),hash=await this.rpc<string>('getblockhash',[height]);
    await this.until(async()=>{
      const response=await fetch(this.ordUrl+'/r/blockheight',{signal:AbortSignal.timeout(3000)});if(!response.ok||await response.json()!==height)return false;
      const anchor=await fetch(this.ordUrl+'/r/blockhash',{signal:AbortSignal.timeout(3000)});return anchor.ok&&await anchor.json()===hash;
    },this.ord);
  }
  async mine(count=1){await this.rpc('generatetoaddress',[count,this.minerAddress]);await this.waitForIndex();}
  /** Restart only this harness's processes on the same owned chain and ports. */
  async restart(){await this.stop();await this.startCore();const wallets=await this.rpc<string[]>('listwallets');for(const name of ['builder-miner','builder-regtest'])if(!wallets.includes(name))await this.rpc('loadwallet',[name]);await this.startOrd();}
  async stop(){
    if(this.ord&&this.ord.exitCode===null){const child=this.ord;child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    if(this.core&&this.core.exitCode===null){try{await this.rpc('stop');}catch{}const child=this.core;await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(5000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  }
}
