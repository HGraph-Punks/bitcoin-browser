import {startStdio} from './stdio';
import {safeError} from '../core/errors';
void startStdio(process.argv.slice(2)).catch(error=>{process.stderr.write(safeError(error).message+'\n');process.exitCode=1;});
