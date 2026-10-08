import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';
const allowed=new Set(['app.browse','preview.loaded','app.creator-session','project.import-builder','app.bootstrap','project.create','project.read','project.settings','project.file','project.history','project.export','project.open-dialog','project.import-folder','file.list','file.copy-path','file.rename','file.remove','asset.import-dialog','asset.remove','library.add','library.open-source','library.copy','library.open','build.create','build.export','preview.start','preview.reload','preview.bounds','preview.inspect','preview.screenshot','app.theme','app.close-ready','agent.list','agent.create','agent.revoke']);
for(const command of ['backend.status','backend.configure','backend.receive','deployment.list','deployment.plan','deployment.quote','deployment.request-review','deployment.status','deployment.resume','deployment.authorize','deployment.refresh','deployment.copy-id','deployment.open','deployment.export-receipt','operation.get','operation.cancel'])allowed.add(command);
allowed.add('deployment.requote');allowed.add('deployment.resume-owner');
for(const command of ['project.history-list','project.checkpoint','project.checkpoint-remove','project.restore','project.diff','project.revision-file','project.export-draft'])allowed.add(command);
for(const command of ['file.merge-prepare','file.merge-inspect','file.merge-read','file.merge-apply'])allowed.add(command);
allowed.add('project.inspect');
for(const command of ['collection.configure','collection.duplicate','collection.import-images','collection.import-metadata','rune.configure'])allowed.add(command);
for(const command of ['draft.save','draft.list','draft.remove'])allowed.add(command);
const api:DesktopAPI={
  invoke(command,payload){if(!allowed.has(command))return Promise.resolve({ok:false,error:{code:'UNKNOWN_COMMAND',message:'This command is not available.'}});return ipcRenderer.invoke('builder:command',command,payload);},
  onChange(listener){const handler=(_event:unknown,value:{type:string;projectId?:string})=>listener(value);ipcRenderer.on('builder:changed',handler);return()=>ipcRenderer.removeListener('builder:changed',handler);}
};
if(location.href==='app://app/creator/generated/renderer/index.html')contextBridge.exposeInMainWorld('builder',api);
