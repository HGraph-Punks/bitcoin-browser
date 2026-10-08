import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import path from 'node:path';
const execute=promisify(execFile);
/** Drive only the owned package's renderer over Chromium's loopback debugging
 * endpoint. Main-process inspection remains disabled by the release fuses.
 * The small facade below maps the shared experience harness to real frame/CDP
 * operations; it never evaluates code in or exposes the Electron main process. */
export async function launchPackagedRenderer(executable:string,profile:string,root:string){
  const require=createRequire(path.join(root,'src/creator/package.json')),{chromium}=require('playwright');
  const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));
  const child=spawn(executable,['--remote-debugging-port='+port,'--user-data-dir='+profile],{cwd:root,env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-32000);});
  try{
    const deadline=Date.now()+30000;let ready=false,readyTarget:any;
    while(Date.now()<deadline){if(child.exitCode!==null||child.signalCode!==null)throw new Error('Owned package exited during startup: '+stderr);try{const result=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});if(result.ok){const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();readyTarget=targets.find((target:any)=>target.type==='page'&&target.url==='app://app/renderer/index.html');if(readyTarget){ready=true;break;}}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    if(!ready)throw new Error('Owned package renderer endpoint did not start: '+stderr);
    // /json/list reports the requested URL before the first document commits.
    // Wait through the page CDP endpoint for actual app readiness before
    // Playwright creates its isolated world; never inspect Electron main.
    const target=readyTarget;
    const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',reject,{once:true});});
    let next=0;const pending=new Map<number,(result:any)=>void>();
    socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}});
    try{let loaded=false;while(Date.now()<deadline){const id=++next;const result:any=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Owned shell readiness probe timed out'));},3000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:"location.href==='app://app/renderer/index.html' && document.readyState==='complete' && typeof window.satBrowser==='object'",returnByValue:true}}));});if(result.result?.result?.value===true){loaded=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}if(!loaded)throw new Error('Owned browser shell did not become ready.');}finally{socket.close();}
    const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`),context=browser.contexts()[0];
    let page=context.pages().find((p:any)=>p.url().startsWith('app://app/'));
    while(!page&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));page=context.pages().find((p:any)=>p.url().startsWith('app://app/'));}
    if(!page)throw new Error('Owned package did not create its native browser shell: '+stderr);
    const cdp=await context.newCDPSession(page);
    const contents:any={id:1,focus:()=>page.bringToFront(),executeJavaScript:(source:string)=>page.evaluate(source),debugger:{isAttached:()=>true,attach:()=>{},sendCommand:async(method:string,params:any)=>{
      if(method==='Emulation.setEmulatedMedia'){const reduced=params.features?.find((f:any)=>f.name==='prefers-reduced-motion')?.value;return page.emulateMedia({reducedMotion:reduced==='reduce'?'reduce':'no-preference'});}
      return cdp.send(method,params);
    }}};
    Object.defineProperty(contents,'mainFrame',{get:()=>({url:page.url(),framesInSubtree:page.frames().map((frame:any)=>({url:frame.url(),executeJavaScript:(source:string)=>frame.evaluate(source)}))})});
    const window={webContents:contents,focus:()=>page.bringToFront()};
    const facade={webContents:{fromId:(id:number)=>{if(id!==1)throw new Error('Unknown owned renderer');return contents;}},BrowserWindow:{getAllWindows:()=>[window]},app:{focus:()=>page.bringToFront()},clipboard:{readText:async()=>{const result=await execute('/usr/bin/pbpaste',[],{maxBuffer:3_000_000});return result.stdout;}}};
    return {firstWindow:async()=>page,windows:()=>context.pages(),process:()=>child,evaluate:async(fn:any,arg?:any)=>fn(facade,arg),driver:'renderer-cdp-with-main-inspection-disabled',
      close:async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned package did not quit gracefully: '+stderr)),15000);})]);}finally{if(timer)clearTimeout(timer);}}await browser.close();}};
  }catch(error){console.error('Owned package launch diagnostics: '+stderr);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');throw error;}
}
