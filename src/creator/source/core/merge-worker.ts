import {parentPort,workerData} from 'node:worker_threads';
import {prepareSourceMerge} from './source-merge';
import {safeError} from './errors';
try{parentPort?.postMessage({ok:true,data:prepareSourceMerge(workerData)});}catch(error){parentPort?.postMessage({ok:false,error:safeError(error)});}
