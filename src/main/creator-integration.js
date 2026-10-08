import path from 'node:path';
import {createRequire} from 'node:module';
import {ipcMain} from 'electron';
import {createCreatorResolver} from './creator-resources.js';
import {defaultProviderCapabilitiesFor} from '../shared/constants.js';
import {CREATOR_URL,BROWSER_URL,trustedModeSender} from '../shared/creator-boundary.js';
const require=createRequire(import.meta.url);
export function startCreatorMcp(app,args){
  app.dock?.hide();
  return app.whenReady().then(async()=>{const {startStdio}=require('../creator/generated/stdio.cjs');await startStdio(args,()=>app.quit());}).catch(error=>{process.stderr.write('Create mode AI connection could not start: '+error.message+'\n');app.exit(1);});
}
export function createCreatorIntegration(options){
  let host=null,shutdownTail=Promise.resolve(),quitReady=false,stopping=false;
  const browser=options.getWindow;
  const ensure=async()=>{
    if(stopping)throw Object.assign(new Error('Bitcoin Browser is closing.'),{code:'APP_CLOSING'});
    await shutdownTail;
    if(!host){const {createCreatorHost}=require('../creator/generated/host.cjs');host=createCreatorHost({
      dataDirectory:options.dataDirectory,getWindow:browser,resolver:createCreatorResolver(options.resolver),
      settings:()=>options.stateStore.get(['settings']),theme:()=>options.stateStore.get(['settings','theme']),
      setTheme:theme=>options.stateStore.mutate(draft=>{draft.settings.theme=theme;}),
      browse:async(target,connection)=>{
        if(connection){
          // The connection comes from an already qualified completed receipt,
          // never an arbitrary renderer URL. Reuse it as a read-only ord source.
          const id='creator-ord-'+connection.network;
          await options.providerManager.upsert({id,type:'ord-server',name:'Creation node · '+connection.network,network:connection.network,baseUrl:connection.ordUrl,local:true,enabled:true,priority:0,capabilities:defaultProviderCapabilitiesFor('ord-server'),cookieFile:''});
          await options.stateStore.mutate(draft=>{draft.settings.network=connection.network;draft.settings.preferredProviderId=id;});
          options.providerManager.refresh();
        }
        const window=browser();if(!window||window.isDestroyed())throw new Error('The browser window is closed.');
        await window.loadURL(BROWSER_URL);
        if(target)options.openDeepLink(target);
      }
    });}
    await host.initialize();return host;
  };
  ipcMain.handle('creator:open',async(event)=>{
    if(!trustedModeSender(event,browser(),BROWSER_URL))return {ok:false,error:{code:'UNTRUSTED_SENDER',message:'Open Create from Bitcoin Browser.'}};
    try{await ensure();await browser().loadURL(CREATOR_URL);return {ok:true,result:{mode:'create'}};}catch(error){return {ok:false,error:{code:error.code??'CREATOR_UNAVAILABLE',message:error.message}};}
  });
  ipcMain.handle('builder:command',async(event,name,payload)=>{
    if(!trustedModeSender(event,browser(),CREATOR_URL))return {ok:false,error:{code:'UNTRUSTED_SENDER',message:'This action is available only in Create mode.'}};
    try{return {ok:true,data:await (await ensure()).command(name,payload)};}catch(error){return {ok:false,error:{code:error.code??'CREATOR_COMMAND_FAILED',message:error.message}};}
  });
  return {
    attach(window){
      let closeReady=false;
      window.on('close',event=>{
        if(closeReady||stopping||window.webContents.getURL()!==CREATOR_URL||!host)return;
        event.preventDefault();host.deferClose(()=>{closeReady=true;window.close();});
      });
      window.webContents.on('will-frame-navigate',event=>{
        if(window.webContents.getURL()===CREATOR_URL&&!event.isMainFrame&&!event.url.startsWith('ord://draft-'))event.preventDefault();
      });
      window.on('closed',()=>{const previous=host;host=null;if(previous)shutdownTail=shutdownTail.then(()=>previous.shutdown());});
    },
    resolveDraft:request=>host?host.resolveDraft(request):new Response('Draft unavailable',{status:404}),
    resolveAsset:request=>host?host.resolveAsset(request):new Response('Asset unavailable',{status:404}),
    deferQuit(event){if(quitReady||!host||browser()?.webContents.getURL()!==CREATOR_URL)return false;event.preventDefault();host.deferClose(()=>{quitReady=true;options.app.quit();});return true;},
    async shutdown(){stopping=true;ipcMain.removeHandler('creator:open');ipcMain.removeHandler('builder:command');await shutdownTail;await host?.shutdown();host=null;}
  };
}
