import {Worker} from 'node:worker_threads';
import {AppError} from '../core/errors';
import type {BuildArtifact,ProjectSnapshot} from '../shared/types';

/** A bounded worker keeps parsing and Brotli compression away from the Electron main loop. */
export class CompilerEngine{
  private active=new Set<Worker>();
  private closed=false;
  constructor(private filename:string){}
  build(project:ProjectSnapshot,signal?:AbortSignal):Promise<BuildArtifact>{
    if(this.closed)return Promise.reject(new AppError('COMPILER_CLOSED','The application is closing.'));
    if(this.active.size>=4)return Promise.reject(new AppError('COMPILER_BUSY','Wait for the current builds to finish, then try again.'));
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new AppError('CANCELED','The build was canceled.'));return;}
      const worker=new Worker(this.filename,{workerData:project,resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:32}});this.active.add(worker);let settled=false;
      const done=(error?:Error,result?:BuildArtifact)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.active.delete(worker);void worker.terminate();error?reject(error):resolve(result!);};
      const cancel=()=>done(new AppError('CANCELED','The build was canceled.'));
      const timer=setTimeout(()=>done(new AppError('BUILD_TIMEOUT','This build exceeded 30 seconds. Reduce large sources or split the site.')),30_000);
      signal?.addEventListener('abort',cancel,{once:true});
      worker.once('message',result=>result.ok?done(undefined,result.data):done(new AppError(result.error.code,result.error.message)));
      worker.once('error',()=>done(new AppError('COMPILER_FAILED','The compiler stopped. Your source is saved; simplify the failing file or retry.')));
      worker.once('exit',code=>{if(!settled)done(new AppError('COMPILER_FAILED',`The compiler stopped before returning a result (${code}).`));});
    });
  }
  async close(){this.closed=true;await Promise.all([...this.active].map(worker=>worker.terminate()));this.active.clear();}
}
