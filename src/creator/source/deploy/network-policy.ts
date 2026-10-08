import {AppError} from '../core/errors';

export type LocalNetwork='mainnet'|'regtest';
export function networkPolicy(network:LocalNetwork){return network==='mainnet'
  ?{coreChain:'main',ordChain:'mainnet',addressPrefix:'bc1',taprootPrefix:'bc1p',rpcPort:8332,wifPrefix:'[KL]'}
  :{coreChain:'regtest',ordChain:'regtest',addressPrefix:'bcrt1',taprootPrefix:'bcrt1p',rpcPort:18443,wifPrefix:'[c9]'};}
export function checkChain(network:LocalNetwork,chain:{chain:string;initialblockdownload?:boolean;blocks:number;headers?:number;warnings?:unknown}){
  if(chain.chain!==networkPolicy(network).coreChain)throw new AppError('WRONG_NETWORK','Bitcoin Core is not on the selected '+network+' network. No transaction will be signed.');
  if(network==='mainnet'&&(chain.initialblockdownload!==false||!Number.isSafeInteger(chain.blocks)||chain.blocks<0||chain.headers!==chain.blocks))throw new AppError('NODE_NOT_SYNCED','Wait for Bitcoin Core to finish synchronizing before preparing or submitting mainnet transactions.');
  if(network==='mainnet'&&(!Array.isArray(chain.warnings)||chain.warnings.length))throw new AppError('NODE_WARNING','Resolve Bitcoin Core’s chain warnings before using this mainnet connection.');
}
export function checkRelayFees(rate:number,mempool:{mempoolminfee:number;minrelaytxfee:number}){
  const minimum=Math.max(mempool.mempoolminfee,mempool.minrelaytxfee)*100_000;
  if(!Number.isFinite(minimum)||minimum<0)throw new AppError('FEE_UNAVAILABLE','Bitcoin Core could not establish its minimum relay fee.');
  if(rate+1e-8<minimum)throw new AppError('FEE_TOO_LOW',`The node currently requires at least ${Math.ceil(minimum)} sat/vB. Choose a new fee rate and prepare a fresh review.`);
}
