import {Worker} from 'node:worker_threads';
import {AppError} from './errors';
import type {MergeInput,MergePlan} from '../shared/merge';

export class MergeEngine{
  private active=new Map<Worker,()=>void>();private closed=false;
  constructor(private filename:string){}
  prepare(input:MergeInput,signal?:AbortSignal):Promise<MergePlan>{
    if(this.closed)return Promise.reject(new AppError('MERGE_CLOSED','The application is closing.'));
    if(this.active.size>=2)return Promise.reject(new AppError('MERGE_BUSY','Wait for the current source comparisons to finish, then retry.'));
    if(signal?.aborted)return Promise.reject(new AppError('CANCELED','The comparison was canceled.'));
    return new Promise((resolve,reject)=>{
      const worker=new Worker(this.filename,{workerData:input,resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:24}});let settled=false;
      const done=(error?:Error,plan?:MergePlan)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.active.delete(worker);void worker.terminate();error?reject(error):resolve(plan!);};
      const cancel=()=>done(new AppError('CANCELED','The comparison was canceled.'));
      const timer=setTimeout(()=>done(new AppError('MERGE_TIMEOUT','The source comparison exceeded five seconds.')),5000);
      this.active.set(worker,cancel);signal?.addEventListener('abort',cancel,{once:true});
      worker.once('message',result=>result.ok?done(undefined,result.data):done(new AppError(result.error.code,result.error.message)));
      worker.once('error',()=>done(new AppError('MERGE_FAILED','The comparison worker stopped.')));
      worker.once('exit',()=>{if(!settled)done(new AppError('MERGE_FAILED','The comparison worker stopped before returning a result.'));});
    });
  }
  async close(){this.closed=true;const workers=[...this.active.keys()];for(const cancel of this.active.values())cancel();await Promise.all(workers.map(worker=>worker.terminate()));this.active.clear();}
}
