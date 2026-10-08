import {createHash} from 'node:crypto';
import {diffChars} from 'diff';
import {AppError} from './errors';
import type {MergeInput,MergePart,MergePlan,MergeResolution} from '../shared/merge';

type Edit={start:number;end:number;text:string;side:'draft'|'current'};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflict(base:string|null,draft:string,current:string|null,start=0,end=base?.length??0,line=1):MergePart{
  return {kind:'conflict',id:hash({start,end,base,draft,current}),start,end,line,base,draft,current};
}
function replacement(base:string,start:number,end:number,edits:Edit[]){
  let position=start,result='';
  for(const edit of edits){result+=base.slice(position,edit.start)+edit.text;position=edit.end;}
  return result+base.slice(position,end);
}
function edits(base:string,next:string,side:Edit['side']):Edit[]|undefined{
  const changes=diffChars(base,next,{maxEditLength:4000,timeout:120});if(!changes)return;
  const result:Edit[]=[];let position=0,pending:Edit|undefined;
  for(const change of changes){
    if(!change.added&&!change.removed){if(pending){result.push(pending);pending=undefined;}position+=change.value.length;continue;}
    pending??={start:position,end:position,text:'',side};
    if(change.added)pending.text+=change.value;else{position+=change.value.length;pending.end=position;}
  }
  if(pending)result.push(pending);return result;
}
/** An insertion touching another edit is conservatively treated as overlapping. */
function overlaps(a:Edit,b:Edit){
  if(a.start===a.end||b.start===b.end)return a.start<=b.end&&b.start<=a.end;
  return a.start<b.end&&b.start<a.end;
}
export function manualSourceMerge(input:MergeInput,reason:string):MergePlan{
  return input.currentIsAsset?{status:'blocked',parts:[],automaticEdits:0,reason:'This path now contains a binary asset. Export the draft or choose another source path.'}:{status:'manual',parts:[conflict(input.base,input.draft,input.current)],automaticEdits:0,reason};
}

/** Text-level three-way merge. No whitespace normalization or fuzzy patch placement. */
export function prepareSourceMerge({base,draft,current,currentIsAsset}:MergeInput):MergePlan{
  if(currentIsAsset)return {status:'blocked',parts:[],automaticEdits:0,reason:'This path now contains a binary asset. Export the draft or choose another source path.'};
  if(draft===current||draft===base)return {status:'clean',parts:current===null?[]:[{kind:'text',text:current}],deleteFile:current===null,automaticEdits:0};
  if(base===current)return {status:'clean',parts:[{kind:'text',text:draft}],automaticEdits:1};
  if(base===null||current===null)return {status:'conflicts',parts:[conflict(base,draft,current)],automaticEdits:0,reason:base===null?'Both versions independently created this file. Choose the content to keep.':'This file was removed or renamed. Keeping the draft recreates its original path; other files and links stay unchanged.'};
  const manual=(reason:string):MergePlan=>({status:'manual',parts:[conflict(base,draft,current)],automaticEdits:0,reason});
  if(base.length+draft.length+current.length>600_000)return manual('This source exceeds the automatic comparison size limit. Review and edit a complete result.');
  const mine=edits(base,draft,'draft'),theirs=edits(base,current,'current');
  if(!mine||!theirs)return manual('The comparison exceeded its work limit. Review and edit a complete result.');
  const all=[...mine,...theirs].sort((a,b)=>a.start-b.start||a.end-b.end),groups:Edit[][]=[];
  // Connected overlap groups keep chained changes together. Edits on each side
  // are disjoint by construction; conservative grouping cannot drop either side.
  for(const edit of all){const group=groups.at(-1);if(group?.some(previous=>overlaps(previous,edit)))group.push(edit);else groups.push([edit]);}
  const parts:MergePart[]=[];let position=0,automaticEdits=0,conflicts=0;
  for(const group of groups){
    const start=group[0].start,end=Math.max(...group.map(edit=>edit.end));
    if(start>position)parts.push({kind:'text',text:base.slice(position,start)});
    const draftEdits=group.filter(edit=>edit.side==='draft'),currentEdits=group.filter(edit=>edit.side==='current');
    const left=replacement(base,start,end,draftEdits),right=replacement(base,start,end,currentEdits);
    if(!draftEdits.length||!currentEdits.length||left===right){parts.push({kind:'text',text:draftEdits.length?left:right});automaticEdits+=group.length;}
    else{parts.push(conflict(base.slice(start,end),left,right,start,end,base.slice(0,start).split('\n').length));conflicts++;}
    position=end;
  }
  if(position<base.length)parts.push({kind:'text',text:base.slice(position)});
  if(conflicts>64)return manual('There are more than 64 overlapping changes. Review and edit a complete result.');
  return {status:conflicts?'conflicts':'clean',parts,automaticEdits};
}

export function resolveSourceMerge(plan:MergePlan,resolution:MergeResolution={}):string|null{
  if(plan.status==='blocked')throw new AppError('MERGE_BLOCKED',plan.reason!);
  const choices=resolution.choices??[];
  if(resolution.manualContent!==undefined){if(choices.length)throw new AppError('INVALID_RESOLUTION','Choose individual changes or one complete result.');return checked(resolution.manualContent);}
  const known=new Set(plan.parts.filter(part=>part.kind==='conflict').map(part=>part.id)),selected=new Map<string,typeof choices[number]>();
  for(const choice of choices){if(!known.has(choice.conflictId)||selected.has(choice.conflictId))throw new AppError('INVALID_RESOLUTION','A conflict choice is duplicated or does not belong to this review.');selected.set(choice.conflictId,choice);}
  if(plan.deleteFile)return null;
  const output:string[]=[];let bytes=0;
  for(const part of plan.parts){
    let text:string|null;
    if(part.kind==='text')text=part.text;
    else{const choice=selected.get(part.id);if(!choice)throw new AppError('MERGE_UNRESOLVED','Choose a result for every overlapping change before saving.');text=choice.choice==='draft'?part.draft:choice.choice==='current'?part.current:choice.text??'';}
    if(text===null){if(plan.parts.length!==1)throw new AppError('INVALID_RESOLUTION','A removed file cannot be combined with source fragments.');return null;}
    bytes+=Buffer.byteLength(text);if(bytes>2_000_000)throw new AppError('FILE_TOO_LARGE','The merged source exceeds 2 MB.');output.push(text);
  }
  return output.join('');
}
function checked(text:string){if(Buffer.byteLength(text)>2_000_000)throw new AppError('FILE_TOO_LARGE','The merged source exceeds 2 MB.');return text;}
