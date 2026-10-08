import type {Network,PublicationStage} from './types';

export type DeploymentState = 'preparing'|'quoted'|'awaiting-review'|'awaiting-signature'|'signed'|'broadcast-unknown'|'commit-broadcast'|'reveal-broadcast'|'confirming'|'indexing'|'ready-for-next'|'complete'|'expired'|'conflict'|'recovery-required'|'provider-unavailable'|'canceled'|'reorg';
export type ChainAnchor={height:number;hash:string};
export type FundingInput={txid:string;vout:number;sats:number;script:string};
export type PlannedOutput={index:number;sats:number;address:string;script:string;role:'recovery'|'change'|'inscription'};
export type InscriptionQuote={
  schemaVersion:1;id:string;deploymentId:string;projectId:string;buildId:string;revision:number;backendId:string;network:Network;
  path:string;resourceNumber:number;resourceCount:number;contentSha256:string;mime:string;decodedBytes:number;storedBytes:number;encoding:'br'|null;
  dependencies:{path:string;id:string;sha256:string}[];createdAt:string;expiresAt:string;source:'Local Bitcoin Core / Ord';
  destination:string;postageSats:number;feeRate:number;commitFeeSats:number;revealFeeSats:number;backendFeeSats:0;totalFeeSats:number;totalRequiredSats:number;
  inputs:FundingInput[];commitOutputs:PlannedOutput[];revealOutputs:PlannedOutput[];commitTxid:string;revealTxid:string;inscriptionId:string;
  unsignedCommitSha256:string;revealSha256:string;commitVsizeEstimate:number;revealVsize:number;anchor:ChainAnchor;planHash:string;
};
export type DeploymentStep={
  quote:InscriptionQuote;reviewId?:string;authorizedAt?:string;signedAt?:string;commitSubmittedAt?:string;revealSubmittedAt?:string;
  commitAttempts:number;revealAttempts:number;confirmations:number;verified?:{at:string;blockHash:string;anchor:ChainAnchor;sha256:string};
  invalidatedAt?:string;
};
export type DeploymentView={
  schemaVersion:1;id:string;projectId:string;title:string;revision:number;buildId:string;backendId:string;network:Network;destination:string;
  createdAt:string;updatedAt:string;state:DeploymentState;cancelRequested:boolean;operationId:string;stages:PublicationStage[];paths:string[];
  steps:DeploymentStep[];currentStep:number;error?:{code:string;message:string};events:{at:string;state:DeploymentState;message:string}[];
  receipt?:{rootId:string;network:Network;sourceRevision:number;buildId:string;compilerVersion:string;totalFeeSats:number;totalPostageSats:number;resources:{path:string;id:string;sha256:string;commit:string;reveal:string;blockHash:string}[]};
};
export type DeploymentSummary=Pick<DeploymentView,'id'|'projectId'|'title'|'revision'|'buildId'|'network'|'createdAt'|'updatedAt'|'state'|'cancelRequested'|'currentStep'>;
export type BackendCapabilities={
  id:string;name:string;network:Network;available:boolean;qualification:string;reason?:string;
  versions:{core:string;ord:string};supports:{prepare:boolean;ownerReview:boolean;resume:boolean;compression:boolean;protectedInputs:boolean;mainnet:boolean};
  limits:{maxDecodedBytes:number;minConfirmations:number;reviewPerResource:boolean;fundingScript:'native-taproot';supportedMime:string[]};
};
