import React,{Suspense,lazy,useEffect,useMemo,useRef,useState} from 'react';
import {Check,Download,GitMerge,Loader2,RefreshCw} from 'lucide-react';
import type {MergePage,MergeResolution,MergeReview,MergeSource} from '../shared/merge';
import './MergePanel.css';
const CodeEditor=lazy(()=>import('./CodeEditor'));
export type MergeDraft={id:string;projectId:string;path:string;baseRevision:number;draft:string};
type Result={content:string|null;hash:string|null;reviewId:string;resolution:MergeResolution};
type FullConflict={base:string|null;draft:string|null;current:string|null};
async function invoke<T>(command:string,payload:unknown):Promise<T>{const result=await window.builder.invoke<T>(command,payload);if(!result.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.data;}
async function readAll(review:MergeReview,side:MergeSource,resolution:MergeResolution={},conflictId?:string){
  let offset=0,content='',hash:string|null=null;
  do{const page=await invoke<MergePage>('file.merge-read',{projectId:review.projectId,mergeId:review.id,side,conflictId,...resolution,offset,limit:64_000});
    if(page.content===null)return {content:null,hash:null};
    if(offset&&page.sha256!==hash)throw new Error('The result changed while it was being read. Review it again.');
    hash=page.sha256;content+=page.content;if(page.nextOffset===null)return {content,hash};offset=page.nextOffset;
  }while(offset<=2_000_000);
  throw new Error('The source exceeds the review limit.');
}

export default function MergePanel({draft,open,onClose,onSave,onExport}:{draft:MergeDraft;open:boolean;onClose:()=>void;onSave:(review:MergeReview,resolution:MergeResolution,resultHash:string|null)=>Promise<void>;onExport:(content:string)=>Promise<{canceled:boolean;filename?:string}>}){
  const dialog=useRef<HTMLDialogElement>(null),alive=useRef(true),prepareGeneration=useRef(0),resultGeneration=useRef(0),anchor=useRef({baseRevision:draft.baseRevision,draft:draft.draft});
  const [review,setReview]=useState<MergeReview>();
  const [choices,setChoices]=useState<Record<string,'draft'|'current'>>({}),[manual,setManual]=useState<string>(),[result,setResult]=useState<Result>();
  const [loading,setLoading]=useState(true),[reading,setReading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[latestRevision,setLatestRevision]=useState<number>();
  const [full,setFull]=useState<Record<string,FullConflict>>({});
  const resolution=useMemo<MergeResolution>(()=>manual!==undefined?{manualContent:manual}:{choices:Object.entries(choices).map(([conflictId,choice])=>({conflictId,choice}))},[choices,manual]);
  const unresolved=review?.conflicts.filter(conflict=>!choices[conflict.id]).length??0;
  const ready=!!review&&review.status!=='blocked'&&(manual!==undefined||unresolved===0);
  const currentResult=result?.reviewId===review?.id&&result?.resolution===resolution?result:undefined;
  const stale=!!review&&latestRevision!==undefined&&latestRevision!==review.revision;
  const changedChoices=Object.keys(choices).length>0;
  const checkLatest=async()=>{try{const current=await invoke<{revision:number}>('project.inspect',{projectId:draft.projectId});if(alive.current)setLatestRevision(previous=>Math.max(previous??0,current.revision));}catch(e){if(alive.current)setError((e as Error).message);}};
  const prepare=async(next=anchor.current)=>{
    const generation=++prepareGeneration.current;setLoading(true);setError('');setNotice('');
    try{const nextReview=await invoke<MergeReview>('file.merge-prepare',{projectId:draft.projectId,path:draft.path,...next});if(!alive.current||generation!==prepareGeneration.current)return;
      anchor.current=next;setReview(nextReview);setChoices({});setManual(undefined);setResult(undefined);setFull({});await checkLatest();
    }catch(e){if(alive.current&&generation===prepareGeneration.current)setError((e as Error).message);}finally{if(alive.current&&generation===prepareGeneration.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;void prepare();const stop=window.builder.onChange(event=>{if(event.type==='project'&&event.projectId===draft.projectId)void checkLatest();});return()=>{alive.current=false;prepareGeneration.current++;resultGeneration.current++;stop();};},[draft.id]);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open)dialog.current?.close();},[open]);
  useEffect(()=>{
    const generation=++resultGeneration.current;if(!review||!ready){setReading(false);return;}setReading(true);
    const timer=setTimeout(()=>{void readAll(review,'merged',resolution).then(value=>{if(alive.current&&generation===resultGeneration.current)setResult({...value,reviewId:review.id,resolution});}).catch(e=>{if(alive.current&&generation===resultGeneration.current)setError(e.message);}).finally(()=>{if(alive.current&&generation===resultGeneration.current)setReading(false);});},manual===undefined?0:150);
    return()=>clearTimeout(timer);
  },[review,ready,resolution]);
  const choose=(id:string,choice:'draft'|'current')=>{setChoices(previous=>({...previous,[id]:choice}));setError('');};
  const editComplete=async()=>{if(!review)return;setBusy(true);setError('');try{
    const initial=currentResult??await readAll(review,'merged',{choices:review.conflicts.map(conflict=>({conflictId:conflict.id,choice:choices[conflict.id]??'draft'}))});
    setManual(initial.content??anchor.current.draft);setNotice('Edit the complete result below. It will be saved only when you choose Save merged source.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const readConflict=async(id:string)=>{if(!review)return;setBusy(true);setError('');try{const values=await Promise.all((['base','draft','current'] as const).map(async side=>[side,(await readAll(review,side,{},id)).content] as const));setFull(previous=>({...previous,[id]:Object.fromEntries(values) as FullConflict}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const refresh=async()=>{
    // A completed, edited result becomes a draft against the version just reviewed.
    // This retains manual work while allowing later saved edits to be combined.
    const content=manual??currentResult?.content;
    await prepare(review&&typeof content==='string'?{baseRevision:review.revision,draft:content}:anchor.current);
  };
  const save=async()=>{if(!review||!currentResult||stale)return;setBusy(true);setError('');try{await onSave(review,resolution,currentResult.hash);}catch(e){setError((e as Error).message);await checkLatest();}finally{if(alive.current)setBusy(false);}};
  const exportSource=async()=>{setBusy(true);setError('');try{const exported=await onExport(manual??currentResult?.content??anchor.current.draft);if(!exported.canceled)setNotice(`Saved a copy as ${exported.filename}.`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const close=()=>{if(!busy){dialog.current?.close();onClose();}};
  const disabled=busy||loading;
  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-title" aria-describedby="merge-description" onCancel={event=>{event.preventDefault();close();}}>
    <header className="merge-heading"><span className="round-icon"><GitMerge size={20}/></span><div><h2 id="merge-title">Merge your draft</h2><p>{draft.path}{review&&` · Reviewing saved revision ${review.revision}`}</p></div></header>
    <div className="merge-scroll">
      <p className="merge-intro" id="merge-description">Keep your work and the saved changes together. Nothing is saved until you review the result below.</p>
      {stale&&<div className="merge-stale" role="status"><strong>The saved source changed again.</strong><p>{ready?'Refresh to combine your result with the newer saved version. Your completed edits are kept.':changedChoices?'Refreshing will reset these unfinished choices. Your source draft is kept.':'Refresh to compare your draft with the newer saved version.'}</p><button className="button" disabled={disabled||reading} onClick={()=>void refresh()}><RefreshCw size={14}/>{!ready&&changedChoices?'Reset choices and refresh':'Refresh review'}</button></div>}
      {error&&<div className="merge-error" role="alert"><p>{error}</p><button className="button" disabled={disabled||reading} onClick={()=>void refresh()}>{!ready&&changedChoices?'Reset choices and retry':'Review again'}</button></div>}
      {notice&&<p className="merge-notice" role="status">{notice}</p>}
      {loading?<div className="merge-loading" role="status"><Loader2 className="spin" size={18}/>Comparing your draft with saved source…</div>:review&&<>
        {review.status==='clean'?<div className="merge-clean"><Check size={17}/><div><strong>{review.alreadyCurrent?'Your draft is already represented in the saved source.':'These text changes can be combined.'}</strong><p>Review the source, then test the website after saving.</p></div></div>:<p className="merge-explanation">{review.reason??`${review.conflicts.length} overlapping ${review.conflicts.length===1?'change needs':'changes need'} your choice. Edits elsewhere are kept automatically.`}</p>}
        <div className={`merge-workspace ${!review.conflicts.length||manual!==undefined?'result-only':''}`}>
          {!!review.conflicts.length&&manual===undefined&&<section className="merge-conflicts" aria-label="Overlapping changes">{review.conflicts.map((conflict,index)=>{
            const expanded=full[conflict.id],truncated=conflict.base.truncated||conflict.draft.truncated||conflict.current.truncated;
            const text=(side:'base'|'draft'|'current')=>expanded?expanded[side]:conflict[side].text;
            return <article className="merge-conflict" key={conflict.id}><h3>Change {index+1}<span>Starting line {conflict.line}</span></h3>
              {conflict.prefix&&<pre className="merge-context" aria-label="Preceding source">{conflict.prefix}</pre>}
              <div className="merge-alternatives" role="group" aria-label={`Choose change ${index+1}`}>{(['draft','current'] as const).map(side=><div className={choices[conflict.id]===side?'merge-alternative selected':'merge-alternative'} key={side}><h4>{side==='draft'?'Your draft':'Saved source'}</h4><pre>{text(side)===null?'File removed':text(side)===''?'(empty text)':text(side)}</pre><button className="button" disabled={disabled||truncated&&!expanded} aria-pressed={choices[conflict.id]===side} onClick={()=>choose(conflict.id,side)}>{choices[conflict.id]===side&&<Check size={13}/>}Use {side==='draft'?'my draft':'saved source'}</button></div>)}</div>
              {conflict.suffix&&<pre className="merge-context" aria-label="Following source">{conflict.suffix}</pre>}
              <details><summary>Starting text</summary><pre className="merge-base">{text('base')===null?'The file did not exist.':text('base')||'(empty text)'}</pre></details>
              {truncated&&!expanded&&<div className="merge-truncated"><p>This change is abbreviated. Read it in full before choosing, or edit a complete result.</p><button className="button" disabled={disabled} onClick={()=>void readConflict(conflict.id)}>Read full change {index+1}</button></div>}
            </article>;
          })}</section>}
          {review.status!=='blocked'&&<section className="merge-result" aria-label="Merged result"><div className="merge-result-heading"><div><h3>{manual!==undefined?'Edit complete result':'Result to save'}</h3><p>{manual!==undefined?'The whole file will use this exact source.':unresolved?`Choose ${unresolved} remaining ${unresolved===1?'change':'changes'} to see the result.`:reading?'Preparing the complete result…':currentResult?.content===null?'The file stays removed.':'Compatible changes from both versions are included.'}</p></div>{manual===undefined&&<button className="button tiny" disabled={disabled} onClick={()=>void editComplete()}>Edit complete result</button>}</div>
            {manual!==undefined?<Suspense fallback={<p>Opening source editor…</p>}><CodeEditor key="manual" path={draft.path} value={manual} label="Complete merged source" onChange={setManual}/></Suspense>:currentResult?.content!==undefined&&currentResult.content!==null?<Suspense fallback={<p>Opening source preview…</p>}><CodeEditor key="result" path={draft.path} value={currentResult.content} label="Merged source preview" readOnly onChange={()=>{}}/></Suspense>:<div className="merge-result-empty">{ready?(reading?<><Loader2 size={18} className="spin"/>Preparing result…</>:'No source text will be added.'):'Select the changes to keep on the left, or edit a complete result.'}</div>}
            {manual===undefined&&unresolved>0&&<p className="merge-manual-hint">The complete editor starts with your draft for unchosen overlaps and keeps compatible saved changes.</p>}
          </section>}
        </div>
      </>}
    </div>
    <footer className="merge-footer"><p>Returning keeps your original draft. This review stays available until you edit that draft or leave the project.</p><div><button className="button subtle" disabled={busy} onClick={close}>Back to my draft</button><button className="button" disabled={disabled} onClick={()=>void exportSource()}><Download size={14}/>Save a copy</button><button className="button primary" disabled={disabled||reading||stale||!currentResult} onClick={()=>void save()}>{busy?<Loader2 className="spin" size={14}/>:<Check size={14}/>}Save merged source</button></div></footer>
  </dialog>;
}
