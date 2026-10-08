import React,{useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {AlertTriangle,Check,Plus} from 'lucide-react';
import type {Library,ResearchLibrary} from '../shared/types';
import {needsLibraryWarning,researchKey} from '../shared/library-warning';
import './LibraryWarning.css';
export type LibraryAddOptions={acceptWarning:true;format?:'classic'|'esm'|'stylesheet'|'asset'};
type Props={library?:Library;research?:ResearchLibrary;added:boolean;disabled:boolean;className?:string;label?:string;onAdd:(key:string,options?:LibraryAddOptions)=>Promise<unknown>};
export default function LibraryAddButton({library,research,added,disabled,className='button small',label='Add',onAdd}:Props){
  const [warning,setWarning]=useState(false),[working,setWorking]=useState(false),[failure,setFailure]=useState('');
  const key=library?.key??researchKey(research!.id),name=library?.name??research!.name,review=added&&!!library&&needsLibraryWarning(library)&&!library.userAcknowledgement;
  const add=async(options?:LibraryAddOptions)=>{setWorking(true);setFailure('');try{await onAdd(key,options);setWarning(false)}catch(error){setFailure((error as Error).message)}finally{setWorking(false)}};
  return <><button className={className} disabled={disabled||added&&!review||working} onClick={()=>{setFailure('');if(!library||needsLibraryWarning(library))setWarning(true);else void add()}}>{review?<><AlertTriangle size={14}/>Review warning</>:added?<><Check size={14}/>Included in this project</>:<><Plus size={14}/>{label}</>}</button>{failure&&!warning&&<p role="alert" className="library-add-error">{failure}</p>}{warning&&createPortal(<LibraryWarning name={name} id={library?.id??research!.id} research={research} licensePending={!library?.licenseReviewed} runtimePending={!library?.runtimeTested} working={working} failure={failure} onCancel={()=>{if(!working){setWarning(false);setFailure('')}}} onAccept={format=>void add({acceptWarning:true,...(research?{format}:{})})}/>,document.body)}</>;
}
function LibraryWarning({name,id,research,licensePending,runtimePending,working,failure,onCancel,onAccept}:{name:string;id:string;research?:ResearchLibrary;licensePending:boolean;runtimePending:boolean;working:boolean;failure:string;onCancel:()=>void;onAccept:(format:NonNullable<LibraryAddOptions['format']>)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),[accepted,setAccepted]=useState(false),[format,setFormat]=useState<NonNullable<LibraryAddOptions['format']>>(research?.category==='styles'?'stylesheet':'classic');
  useLayoutEffect(()=>{const node=dialog.current!;node.showModal();cancel.current?.focus();return()=>node.close();},[]);
  return <dialog ref={dialog} className="library-warning" aria-labelledby="library-warning-title" aria-describedby="library-warning-description" onCancel={event=>{event.preventDefault();event.stopPropagation();onCancel()}}>
    <div className="library-warning-icon"><AlertTriangle size={25}/></div><span className="tiny-label">REVIEW BEFORE INCLUDING</span><h2 id="library-warning-title">Add an unqualified library?</h2><p id="library-warning-description"><strong>{name}</strong> has not completed all catalog checks. Adding it includes third-party code or resources in your website.</p>
    <ul><li>Security and compatibility are not guaranteed.{runtimePending?' This artifact has no qualified runtime recipe.':''}</li><li>{licensePending?'License permissions and required notices have not been fully reviewed.':'Reviewed notices will be retained.'} You are responsible for permission to use and distribute it.</li><li>{research?'The native browser will fetch and pin the exact bytes.':'The existing content pin will be retained.'} Missing dependencies or unsupported APIs may still prevent it from working.</li></ul>
    {research&&<div className="library-warning-report"><strong>From the research report</strong><p>{research.notes}</p></div>}
    <code className="library-warning-id">{id}</code>
    {research&&<label className="library-warning-format">Include as<select aria-label="Library include format" value={format} disabled={working} onChange={e=>setFormat(e.target.value as typeof format)}><option value="classic">Classic JavaScript script</option><option value="esm">JavaScript module</option><option value="stylesheet">CSS stylesheet</option><option value="asset">Resource (preload, no script execution)</option></select><small>Choose the format this inscription actually provides. You can edit its include in Code.</small></label>}
    <label className="library-warning-accept"><input type="checkbox" checked={accepted} disabled={working} onChange={e=>setAccepted(e.target.checked)}/><span>I understand these risks and accept responsibility for using this library.</span></label>
    <p className="library-warning-footnote">Acceptance does not qualify this library or approve an inscription transaction.{licensePending&&' Libraries with pending license review can be added and tested, but cannot be inscribed yet.'}</p>{failure&&<p role="alert" className="library-add-error">{failure}</p>}
    <div className="library-warning-actions"><button ref={cancel} className="button" disabled={working} onClick={onCancel}>Cancel</button><button className="button primary" disabled={!accepted||working} onClick={()=>onAccept(format)}>{working?'Adding library…':'Accept warning and add'}</button></div>
  </dialog>;
}
