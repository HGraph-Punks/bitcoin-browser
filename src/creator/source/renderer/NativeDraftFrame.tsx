import React from 'react';
import type {PreviewState} from '../shared/types';
import {Loader2} from 'lucide-react';
export default function NativeDraftFrame({preview,onLoaded}:{preview:PreviewState|null;onLoaded:(id:string,failed:boolean)=>void}){
  if(!preview)return <div className="loading-state"><Loader2 className="spin"/>Preparing your website…</div>;
  return <iframe className="native-draft-frame" key={preview.url} src={preview.url} title="Website preview" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock" referrerPolicy="no-referrer" allow="" onLoad={()=>onLoaded(preview.buildId,false)} onError={()=>onLoaded(preview.buildId,true)}/>;
}
