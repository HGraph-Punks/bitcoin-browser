import {createHash} from 'node:crypto';
import type {ProjectStore} from './project-store';
import {AppError} from './errors';
import {safeRelativePath} from './validation';
import {isTextFile} from './assets';
import {manualSourceMerge,prepareSourceMerge,resolveSourceMerge} from './source-merge';
import type {MergeCommit,MergeInput,MergePage,MergePlan,MergeResolution,MergeReview,MergeSource} from '../shared/merge';
import type {ProjectSnapshot} from '../shared/types';

const sha=(text:string|null)=>text===null?null:createHash('sha256').update(text).digest('hex');
type Review={summary:MergeReview;input:MergeInput;plan:MergePlan;bytes:number};
const snippet=(text:string|null)=>({text:text===null?null:text.slice(0,1000),characters:text?.length??0,truncated:(text?.length??0)>1000});

/** Ephemeral, bounded review data. Source commits and their retry records belong to ProjectStore. */
export class SourceMergeService{
  private reviews=new Map<string,Review>();
  constructor(private store:ProjectStore,private compute:(input:MergeInput)=>Promise<MergePlan>=async input=>prepareSourceMerge(input),private now:()=>number=Date.now){}
  private key(projectId:string,id:string){return projectId+':'+id;}
  private prune(){for(const [key,review] of this.reviews)if(Date.parse(review.summary.expiresAt)<=this.now())this.reviews.delete(key);}
  private get(projectId:string,id:string){this.prune();const key=this.key(projectId,id),review=this.reviews.get(key);if(!review)throw new AppError('MERGE_EXPIRED','This merge review is unavailable or expired. Prepare it again from your draft.');this.reviews.delete(key);this.reviews.set(key,review);return review;}
  async prepare(projectId:string,relative:string,baseRevision:number,draft:string):Promise<MergeReview>{
    safeRelativePath(relative);if(!isTextFile(relative))throw new AppError('TEXT_FILE_REQUIRED','Merge an HTML, CSS, JavaScript, JSON, SVG or other supported text file.');
    if(Buffer.byteLength(draft)>2_000_000)throw new AppError('FILE_TOO_LARGE','Keep the source draft within 2 MB, or export it separately.');
    const current=await this.store.read(projectId);if(baseRevision>current.revision)throw new AppError('INVALID_BASE','The draft cannot start from a future project revision.');
    const base=await this.store.readRevision(projectId,baseRevision);if(base.assets[relative])throw new AppError('TEXT_FILE_REQUIRED','The starting revision contains an asset at this path, not text source.');
    const input:MergeInput={base:base.files[relative]??null,draft,current:current.files[relative]??null,currentIsAsset:!!current.assets[relative]};
    let plan:MergePlan;
    try{plan=await this.compute(input);}catch(error){if(!(error instanceof AppError)||!['MERGE_TIMEOUT','MERGE_FAILED'].includes(error.code))throw error;plan=manualSourceMerge(input,'The automatic comparison stopped. Your draft is intact; review and edit a complete result.');}
    const baseHash=sha(input.base),draftHash=sha(draft)!,currentHash=input.currentIsAsset?current.assets[relative].sha256:sha(input.current);
    const id=createHash('sha256').update(JSON.stringify({version:1,projectId,path:relative,baseRevision,revision:current.revision,baseHash,draftHash,currentHash,plan})).digest('hex');
    const conflicts:MergeReview['conflicts']=[];
    for(let index=0;index<plan.parts.length;index++){const part=plan.parts[index];if(part.kind!=='conflict')continue;const previous=plan.parts[index-1],next=plan.parts[index+1];conflicts.push({id:part.id,line:part.line,prefix:previous?.kind==='text'?previous.text.slice(-120):'',suffix:next?.kind==='text'?next.text.slice(0,120):'',base:snippet(part.base),draft:snippet(part.draft),current:snippet(part.current)});}
    const summary:MergeReview={projectId,id,path:relative,baseRevision,revision:current.revision,expiresAt:new Date(this.now()+30*60_000).toISOString(),status:plan.status,reason:plan.reason,automaticEdits:plan.automaticEdits,alreadyCurrent:plan.status==='clean'&&resolveSourceMerge(plan)===input.current,baseHash,draftHash,currentHash,currentKind:input.currentIsAsset?'asset':input.current===null?'missing':'text',conflicts};
    const bytes=Buffer.byteLength(JSON.stringify({input,plan,summary}));if(bytes>24_000_000)throw new AppError('MERGE_TOO_LARGE','This review exceeds its memory limit. Export the draft for manual comparison.');
    this.prune();const key=this.key(projectId,id);this.reviews.delete(key);this.reviews.set(key,{summary,input,plan,bytes});
    let total=[...this.reviews.values()].reduce((n,review)=>n+review.bytes,0);
    while(this.reviews.size>8||total>24_000_000){const oldest=this.reviews.keys().next().value!;total-=this.reviews.get(oldest)!.bytes;this.reviews.delete(oldest);}
    return structuredClone(summary);
  }
  inspect(projectId:string,id:string){return structuredClone(this.get(projectId,id).summary);}
  read(projectId:string,id:string,side:MergeSource,resolution:MergeResolution={},offset=0,limit=64_000,conflictId?:string):MergePage{
    const review=this.get(projectId,id);let content:string|null;
    if(side==='merged'){if(conflictId)throw new AppError('INVALID_INPUT','Read a complete result without a conflict ID.');content=resolveSourceMerge(review.plan,resolution);}
    else if(conflictId){const part=review.plan.parts.find(part=>part.kind==='conflict'&&part.id===conflictId);if(!part||part.kind!=='conflict')throw new AppError('INVALID_RESOLUTION','That conflict does not belong to this review.');content=part[side];}
    else{if(side==='current'&&review.input.currentIsAsset)throw new AppError('TEXT_FILE_REQUIRED','The current path contains a binary asset.');content=review.input[side];}
    return {projectId,mergeId:id,revision:review.summary.revision,path:review.summary.path,side,content:content===null?null:content.slice(offset,offset+limit),sha256:sha(content),offset,totalCharacters:content?.length??0,nextOffset:content!==null&&offset+limit<content.length?offset+limit:null};
  }
  resolve(project:Pick<ProjectSnapshot,'id'|'revision'|'files'|'assets'>,request:MergeCommit){
    const review=this.get(project.id,request.mergeId);
    if(review.summary.path!==request.path)throw new AppError('MERGE_MISMATCH','The review belongs to a different source path.');
    if(review.summary.revision!==project.revision)throw new AppError('REVISION_CONFLICT','The saved source changed. Prepare and review the merge again.',project.revision);
    const hash=project.assets[request.path]?.sha256??sha(project.files[request.path]??null);
    if(hash!==review.summary.currentHash||!!project.assets[request.path]!==!!review.input.currentIsAsset)throw new AppError('FILE_CONFLICT','This source differs from the reviewed version. Prepare the merge again.');
    const text=resolveSourceMerge(review.plan,request);if(sha(text)!==request.resultHash)throw new AppError('MERGE_RESULT_CHANGED','The result differs from the previewed content. Review it again before saving.');return text;
  }
}
