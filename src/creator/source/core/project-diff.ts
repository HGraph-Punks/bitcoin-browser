import {createHash} from 'node:crypto';
import {structuredPatch} from 'diff';
import {mimeFor} from './assets';
import type {ProjectSnapshot} from '../shared/types';
import type {ChangeSummary,DiffHunk,FileIdentity,ProjectDiff} from '../shared/history';

type Source=Pick<ProjectSnapshot,'files'|'assets'|'settings'|'libraries'>;
function identity(source:Source,path:string):FileIdentity|undefined{
  const asset=source.assets[path];if(asset)return {kind:'asset',sha256:asset.sha256,bytes:asset.bytes,mime:asset.mime};
  const text=source.files[path];return text===undefined?undefined:{kind:'text',sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),mime:mimeFor(path)};
}
export function summarizeChanges(before:Source,after:Source):ChangeSummary{
  const files:ChangeSummary['files']=[];
  for(const path of [...new Set([...Object.keys(before.files),...Object.keys(before.assets),...Object.keys(after.files),...Object.keys(after.assets)])].sort()){
    const old=identity(before,path),next=identity(after,path);if(old?.sha256===next?.sha256&&old?.kind===next?.kind&&old?.mime===next?.mime)continue;
    files.push({path,status:!old?'added':!next?'removed':'modified',before:old,after:next});
  }
  return {files,settings:[...new Set([...Object.keys(before.settings),...Object.keys(after.settings)])].filter(key=>before.settings[key as keyof typeof before.settings]!==after.settings[key as keyof typeof after.settings]),librariesAdded:after.libraries.filter(key=>!before.libraries.includes(key)),librariesRemoved:before.libraries.filter(key=>!after.libraries.includes(key))};
}

/** Bounded line comparisons. Large/minified files keep exact hashes and paginated source links. */
export function compareProjects(projectId:string,fromRevision:number,toRevision:number,before:Source,after:Source,options:{path?:string;maxCharacters?:number;maxLines?:number}={}):ProjectDiff{
  const changes=summarizeChanges(before,after),result:ProjectDiff={projectId,fromRevision,toRevision,changes,settings:changes.settings.map(field=>({field,before:before.settings[field as keyof typeof before.settings],after:after.settings[field as keyof typeof after.settings]})),files:[],truncated:false};
  let characters=options.maxCharacters??48_000,lines=options.maxLines??800;
  const deadline=performance.now()+120;
  for(const change of changes.files.filter(file=>!options.path||file.path===options.path)){
    const file:ProjectDiff['files'][number]={...change};result.files.push(file);
    if(change.before)file.beforeUri=`btcsite://projects/${projectId}/revisions/${fromRevision}/files/${encodeURIComponent(change.path)}`;
    if(change.after)file.afterUri=`btcsite://projects/${projectId}/revisions/${toRevision}/files/${encodeURIComponent(change.path)}`;
    if(change.before?.kind==='asset'||change.after?.kind==='asset')continue;
    const old=before.files[change.path]??'',next=after.files[change.path]??'';
    if(performance.now()>=deadline||old.length+next.length>400_000||old.split('\n').length+next.split('\n').length>12_000||Math.max(...old.split('\n').slice(0,12_001).map(l=>l.length),...next.split('\n').slice(0,12_001).map(l=>l.length))>12_000||characters<=0||lines<=0){file.truncated=true;file.reason='This file exceeds the inline diff limit. Read either revision through its source link.';result.truncated=true;continue;}
    const patch=structuredPatch(change.path,change.path,old,next,undefined,undefined,{context:3,maxEditLength:1800,timeout:40});
    if(!patch){file.truncated=true;file.reason='This comparison exceeded its work limit. Exact source and hashes remain available.';result.truncated=true;continue;}
    file.hunks=[];
    for(const source of patch.hunks){
      const hunk:DiffHunk={oldStart:source.oldStart,oldLines:source.oldLines,newStart:source.newStart,newLines:source.newLines,lines:[]};let oldLine=source.oldStart,newLine=source.newStart;
      for(const line of source.lines){
        if(line.startsWith('\\')){const previous=hunk.lines.at(-1);if(previous)previous.noNewline=true;continue;}const text=line.slice(1),kind=line[0]==='+'?'added':line[0]==='-'?'removed':'context';
        if(text.length>characters||lines<=0){file.truncated=true;result.truncated=true;break;}
        hunk.lines.push({kind,text,oldLine:kind==='added'?undefined:oldLine++,newLine:kind==='removed'?undefined:newLine++});characters-=text.length;lines--;
      }
      if(hunk.lines.length)file.hunks.push(hunk);if(file.truncated){file.reason='Only part of this diff fits inline. Read the source links for the complete files.';break;}
    }
  }
  return result;
}
