import {parentPort,workerData} from 'node:worker_threads';
import {buildProject} from './build';
import {safeError} from '../core/errors';
try{parentPort?.postMessage({ok:true,data:buildProject(workerData)});}catch(error){parentPort?.postMessage({ok:false,error:safeError(error)});}
