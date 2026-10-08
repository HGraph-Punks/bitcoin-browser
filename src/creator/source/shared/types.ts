export type TemplateId = 'website' | 'gallery' | 'three' | 'sketch' | 'sketch2' | 'game' | 'audio' | 'webgl' | 'blocks' | 'blank' | 'physics' | 'motion' | 'chart' | 'collection' | 'runes' | 'image' | 'pixel' | 'generative' | 'recursive' | 'story' | 'artifact';
export type LibraryCategory = 'art'|'games'|'motion'|'sound'|'data'|'styles'|'utilities'|'ordinals'|'frameworks';
export type ResearchLibrary = {id:string;name:string;aliases:string[];category:LibraryCategory;status:'pending'|'restricted'|'historical';notes:string;sourceLine:number;source:string;verification:string};
export type Network = 'mainnet' | 'signet' | 'regtest';
export type SiteSettings = { name: string; eyebrow: string; headline: string; description: string; accent: string; heroImage?:string; imageAlt?:string };
export type SourceAsset = { path:string;sha256:string;bytes:number;mime:string;originalName:string;importedAt:string;origin:{type:'local'}|{type:'inscription';id:string;network:Network;gateway:string} };
export type ProjectSnapshot = {
  schemaVersion: 2;
  id: string;
  revision: number;
  template: TemplateId;
  title: string;
  createdAt: string;
  updatedAt: string;
  settings: SiteSettings;
  libraries: string[];
  libraryAcceptances?: LibraryAcceptance[];
  files: Record<string, string>;
  assets: Record<string,SourceAsset>;
  canUndo: boolean;
  canRedo: boolean;
  change?:import('./history').ProjectChange;
};
export type ProjectSummary = Pick<ProjectSnapshot, 'id' | 'title' | 'template' | 'revision' | 'updatedAt'>;
export type Mutation = { projectId: string; expectedRevision: number; idempotencyKey: string };
export type LibraryAcceptance = {key:string;id:string;sha256:string;mime:string;bytes:number;format:'classic'|'esm'|'stylesheet'|'asset';acceptedAt:string;warningVersion:1};
export type Library = {
  userAcknowledgement?: LibraryAcceptance;
  key: string; name: string; version: string; purpose: string; description: string;
  network:Network; id: string; sha256: string; mime: string; bytes: number; storedBytes: number;
  dependencies: string[]; format: 'esm' | 'classic' | 'stylesheet' | 'asset'; global?: string;
  upstream: string; upstreamComparison: string; runtimeTested: boolean; licenseReviewed: boolean;
  catalogVersion:string;packageName:string;contentCheckedAt:string;chainIndependentlyVerified:false;
  license:{identifier:string;reviewStatus:'reviewed'|'pending';scope:string;sourceCode:string;sources:{name:string;url:string;sha256:string;text:string}[]};
  templates:TemplateId[];compatibility:string[];
  runtime:{profile:string;checkedAt:string;evidence:string;recipe:string;limitations:string[]}[];
};
export type Finding = { code: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string; file?: string; line?: number };
export type ReferenceContainer={start:number;end:number;source:string;attribute:string};
export type ResourceReference = {start:number;end:number;url:string;target:string;suffix:string;format:'js'|'css'|'raw';container?:string;context:'resource'|'navigation'|'module'|'fetch'|'worker';};
export type BuildResource = {
  path:string;mime:string;kind:'text'|'binary';sourceSha256:string;sha256:string;bytes:number;compressedBytes:number;previewId:string;
  stage:number;dependencies:string[];references:ResourceReference[];containers:Record<string,ReferenceContainer>;source?:string;text?:string;asset?:SourceAsset;
  duplicateOf?:string;
};
export type PublicationStage = {index:number;paths:string[]};
export type BuildArtifact = {
  collection?:import('./ordinals').CollectionSpec;
  rune?:import('./ordinals').RuneSpec;
  sourceCheckpointId?:string;
  id: string; projectId: string; revision: number; html: string; sha256: string;
  bytes: number; compressedBytes: number; libraries: Library[]; findings: Finding[];
  previewId: string; createdAt: string;
  compilerVersion:string;resources:BuildResource[];stages:PublicationStage[];unpublishedFiles:string[];totalNewBytes:number;hasUnresolvedDependencies:boolean;
};
export type PreviewEvent = { type: 'console' | 'blocked' | 'resource' | 'error'; level?: string; message: string; url?: string; at: string };
export type PreviewState = { url: string; projectId:string;revision:number;buildId: string; profile: 'ord-emulation'; events: PreviewEvent[]; status: 'loading' | 'ready' | 'error' };
export type AppResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; currentRevision?: number } };
export type DesktopAPI = {
  invoke<T = unknown>(command: string, payload?: unknown): Promise<AppResult<T>>;
  onChange(listener: (event: { projectId?: string; type: string; deploymentId?:string }) => void): () => void;
};
declare global { interface Window { builder: DesktopAPI } }
