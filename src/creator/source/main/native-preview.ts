import {createHash} from 'node:crypto';
import type {BrowserWindow,Rectangle} from 'electron';
import type {BuildArtifact,PreviewEvent,PreviewState} from '../shared/types';
import {AppError} from '../core/errors';

const headers={'access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'no-store'};
// Drafts use the browser's ord protocol and opaque inscription iframe. Even if
// ordinary inscriptions allow HTTPS, draft dependencies remain locked to a build.
const csp="default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'self' 'unsafe-inline' blob: data:; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
type NativeResolver={resolve:(url:string,options?:Record<string,unknown>)=>Promise<{data:Buffer;status:number;headers:Record<string,string>}>};
export class NativeDraftPreview {
  private build?:BuildArtifact;
  private state?:PreviewState;
  private bounds:Rectangle|null=null;
  private epoch=0;
  private consoleListener=(_event:unknown,details:any)=>{
    if(this.state&&typeof details.sourceId==='string'&&details.sourceId.startsWith(this.origin+'/'))this.record({type:'console',level:String(details.level),message:String(details.message),url:details.sourceId});
  };
  constructor(private getWindow:()=>BrowserWindow|null,private resolver:NativeResolver,private settings:()=>{network:string},private changed:()=>void,private readAsset:(id:string,sha:string)=>Promise<Buffer>){}
  private get origin(){return this.build?`ord://draft-${this.build.projectId}-${this.build.id}`:'';}
  attach(window:BrowserWindow){window.webContents.on('console-message',this.consoleListener);}
  private record(event:Omit<PreviewEvent,'at'>){if(!this.state)return;this.state.events.push({...event,message:event.message.slice(0,2000),url:event.url?.slice(0,1000),at:new Date().toISOString()});this.state.events=this.state.events.slice(-200);this.changed();}
  async start(build:BuildArtifact,force=false){
    if(build.rune||build.metaprotocol)throw new AppError('PROTOCOL_NO_PREVIEW','Protocol creations use native editors instead of website previews.');
    if(!force&&this.build?.id===build.id&&this.build.revision===build.revision&&this.state?.status!=='error')return this.inspect();
    this.build=build;this.epoch++;
    this.state={url:`${this.origin}/content/${build.previewId}?view=${this.epoch}`,projectId:build.projectId,revision:build.revision,buildId:build.id,profile:'ord-emulation',events:[],status:'loading'};
    this.changed();return this.inspect();
  }
  inspect(){return this.state?structuredClone(this.state):null;}
  setBounds(rect:Rectangle|null){this.bounds=rect;}
  loaded(buildId:string,failed=false){if(this.state?.buildId===buildId){this.state.status=failed?'error':'ready';if(failed)this.record({type:'error',message:'The native browser could not load this draft.'});this.changed();}}
  async screenshot(){const window=this.getWindow();if(!window||!this.state||!this.bounds)throw new AppError('PREVIEW_NOT_VISIBLE','Open the preview before capturing it.');const zoom=window.webContents.getZoomFactor(),r=this.bounds;const image=await window.webContents.capturePage({x:Math.round(r.x*zoom),y:Math.round(r.y*zoom),width:Math.max(1,Math.round(r.width*zoom)),height:Math.max(1,Math.round(r.height*zoom))});return {dataUrl:image.toDataURL(),...image.getSize(),buildId:this.state.buildId};}
  async stop(){this.build=undefined;this.state=undefined;this.bounds=null;this.changed();}
  async close(){await this.stop();}
  async resolve(request:Request):Promise<Response>{
    const url=new URL(request.url),build=this.build;
    if(!build||`${url.protocol}//${url.host}`!==this.origin||!['GET','HEAD'].includes(request.method))return new Response('Draft unavailable',{status:404,headers});
    let body:Buffer,mime:string;
    try{
      if(url.pathname===`/content/${build.previewId}`){body=Buffer.from(build.html);mime='text/html;charset=utf-8';}
      else {
        const local=build.resources.find(r=>url.pathname===`/content/${r.previewId}`);
        const library=build.libraries.find(l=>url.pathname===`/content/${l.id}`);
        if(local){body=local.kind==='text'?Buffer.from(local.text!):await this.readAsset(build.projectId,local.asset!.sha256);mime=local.mime;this.record({type:'resource',message:`Local draft · ${local.path} · ${body.length.toLocaleString()} bytes`,url:url.pathname});}
        else if(library){
          if(this.settings().network!=='mainnet')throw new AppError('LIBRARY_NETWORK','This library catalog contains mainnet inscriptions. Select mainnet sources in Browse settings to preview these libraries. Regtest publication still uses its own explicit connection.');
          const resource=await this.resolver.resolve(`/content/${library.id}`,{maxBytes:8_000_000,signal:request.signal});
          if(resource.status!==200||createHash('sha256').update(resource.data).digest('hex')!==library.sha256)throw new AppError('INTEGRITY_MISMATCH','The selected browser source returned unexpected library bytes.');
          body=resource.data;mime=library.key.startsWith('research-')?(library.format==='stylesheet'?'text/css':library.format==='classic'||library.format==='esm'?'text/javascript':library.mime):library.mime;this.record({type:'resource',message:`${library.name} ${library.version} · native browser source · content hash matches`,url:url.pathname});
        }else if(['/r/blockheight','/r/blockhash','/r/blocktime'].includes(url.pathname)){
          const resource=await this.resolver.resolve(url.pathname,{maxBytes:256,signal:request.signal});if(resource.status!==200)throw new AppError('CHAIN_DATA_UNAVAILABLE','The selected browser source could not return chain data.');
          const value=JSON.parse(resource.data.toString());if(url.pathname==='/r/blockhash'?!/^[0-9a-f]{64}$/.test(value):!Number.isSafeInteger(value))throw new AppError('CHAIN_DATA_INVALID','The selected browser source returned invalid chain data.');
          body=resource.data;mime='application/json';this.record({type:'resource',message:`Live chain data · ${this.settings().network} · native browser source`,url:url.pathname});
        }else{this.record({type:'blocked',message:'This resource is outside the current draft dependency lock.',url:url.pathname});return new Response('Resource outside draft lock',{status:404,headers});}
      }
      if(this.build!==build)return new Response('Draft changed',{status:410,headers});
      const responseHeaders={...headers,'content-type':mime,'content-security-policy':csp,'permissions-policy':'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()','accept-ranges':'bytes'};
      const range=request.headers.get('range'),total=body.length;
      if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);let start=Number(m?.[1]??0),end=m?.[2]?Number(m[2]):body.length-1;if(m&&!m[1]&&m[2]){start=Math.max(0,body.length-Number(m[2]));end=body.length-1;}if(!m||(!m[1]&&!m[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=body.length||end<start)return new Response(null,{status:416,headers:{...responseHeaders,'content-range':`bytes */${body.length}`}});end=Math.min(end,body.length-1);body=body.subarray(start,end+1);return new Response(request.method==='HEAD'?null:new Uint8Array(body),{status:206,headers:{...responseHeaders,'content-length':String(body.length),'content-range':`bytes ${start}-${end}/${total}`}});}
      return new Response(request.method==='HEAD'?null:new Uint8Array(body),{headers:{...responseHeaders,'content-length':String(body.length)}});
    }catch(error){this.record({type:'error',message:error instanceof Error?error.message:'Draft resource unavailable',url:url.pathname});return new Response('Draft resource unavailable',{status:502,headers:{...headers,'content-type':'text/plain','content-security-policy':"default-src 'none'"}});}
  }
}
