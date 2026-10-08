export type MergeChoice={conflictId:string;choice:'draft'|'current'|'custom';text?:string};
export type MergeResolution={choices?:MergeChoice[];manualContent?:string};
export type MergePart={kind:'text';text:string}|{kind:'conflict';id:string;start:number;end:number;line:number;base:string|null;draft:string;current:string|null};
export type MergePlan={status:'clean'|'conflicts'|'manual'|'blocked';parts:MergePart[];reason?:string;deleteFile?:boolean;automaticEdits:number};
export type MergeInput={base:string|null;draft:string;current:string|null;currentIsAsset?:boolean};
export type MergeSnippet={text:string|null;characters:number;truncated:boolean};
export type MergeReview={
  projectId:string;id:string;path:string;baseRevision:number;revision:number;expiresAt:string;
  status:MergePlan['status'];reason?:string;automaticEdits:number;alreadyCurrent:boolean;
  baseHash:string|null;draftHash:string;currentHash:string|null;currentKind:'text'|'missing'|'asset';
  conflicts:{id:string;line:number;prefix:string;suffix:string;base:MergeSnippet;draft:MergeSnippet;current:MergeSnippet}[];
};
export type MergeSource='base'|'draft'|'current'|'merged';
export type MergePage={projectId:string;mergeId:string;revision:number;path:string;side:MergeSource;content:string|null;sha256:string|null;offset:number;totalCharacters:number;nextOffset:number|null};
export type MergeCommit=MergeResolution&{mergeId:string;path:string;resultHash:string|null};
