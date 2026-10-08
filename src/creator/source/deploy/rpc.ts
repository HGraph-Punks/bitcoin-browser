import {readInputFile} from '../core/input-files';
import {AppError} from '../core/errors';

export class RpcError extends AppError {constructor(readonly rpcCode:number,method:string){super('NODE_REJECTED',`Bitcoin Core rejected ${method} (code ${rpcCode}). The existing transaction material is preserved.`);}}
export async function boundedResponse(response:Response,limit:number){
  if(!response.body)throw new AppError('PROVIDER_UNAVAILABLE','The local provider returned an empty response.');
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new AppError('RESPONSE_TOO_LARGE','The local provider exceeded its response limit.');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(parts);
}
export function loopbackUrl(value:string){let url:URL;try{url=new URL(value);}catch{throw new AppError('INVALID_BACKEND','Use an HTTP endpoint on 127.0.0.1.');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.port)throw new AppError('INVALID_BACKEND','This local backend requires an explicit port on http://127.0.0.1.');return url.origin;}
export class CoreRpc {
  readonly url:string;
  constructor(url:string,readonly cookieFile:string,readonly wallet:string){this.url=loopbackUrl(url);if(!/^[a-zA-Z0-9_-]{1,64}$/.test(wallet))throw new AppError('INVALID_BACKEND','Use a wallet name containing letters, digits, underscores, or hyphens.');}
  async call<T=any>(method:string,params:unknown[]=[],wallet=false):Promise<T>{
    const cookie=(await readInputFile(this.cookieFile,4096)).toString('utf8').trim();if(!/^[^:\s]+:[^\s]+$/.test(cookie))throw new AppError('INVALID_BACKEND','The selected Bitcoin Core cookie is invalid.');
    let response:Response;try{response=await fetch(this.url+(wallet?'/wallet/'+encodeURIComponent(this.wallet):''),{method:'POST',headers:{authorization:'Basic '+Buffer.from(cookie).toString('base64'),'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:AbortSignal.timeout(15_000)});}catch{throw new AppError('PROVIDER_UNAVAILABLE','Bitcoin Core did not respond. Reconcile the saved transaction IDs before retrying.');}
    let body:{result:T;error?:{code:number}};try{body=JSON.parse((await boundedResponse(response,6_000_000)).toString());}catch{throw new AppError('PROVIDER_UNAVAILABLE','Bitcoin Core returned an invalid response.');}
    if(body.error)throw new RpcError(body.error.code,method);if(!response.ok||!Object.hasOwn(body,'result'))throw new AppError('PROVIDER_UNAVAILABLE','Bitcoin Core authentication or response validation failed.');return body.result;
  }
}
/** Core amounts have eight fractional decimal places. Sum only integer sats. */
export function toSats(btc:number){if(!Number.isFinite(btc)||btc<0||btc>21_000_000)throw new AppError('INVALID_TRANSACTION','The transaction has an invalid amount.');const [whole,fraction]=btc.toFixed(8).split('.');const sats=Number(BigInt(whole)*100_000_000n+BigInt(fraction));if(!Number.isSafeInteger(sats))throw new AppError('INVALID_TRANSACTION','The transaction amount is not exact.');return sats;}
