import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  detachUnconfirmedPackagedChild,
  observePackagedChild,
  requireConfirmedChildClose,
  shutdownPackagedChild
} from '../../scripts/packaged-smoke-child-lifecycle.mjs';

const send = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve());
});

// Independent safety deadline covers even a wrapper failure before PID delivery.
// These pipes belong to the wrapper, never to the outer test process.
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], {
  stdio: ['ignore', 'pipe', 'pipe']
});
const observation = observePackagedChild(child);
await once(child, 'spawn');
await send({ kind: 'owned-child', pid: child.pid });
child.kill = () => { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); };
const result = await shutdownPackagedChild(child, observation, { timeoutMs: 25, postKillMs: 25 });
let replacementLaunches = 0;
let blockedCode = null;
try {
  requireConfirmedChildClose(result);
  replacementLaunches += 1;
} catch (error) {
  blockedCode = error.code;
}
// Flush evidence before releasing references; do not use process.exit here.
await send({ kind: 'result', pid: child.pid, result, replacementLaunches, blockedCode,
  closeObservedBeforeDetach: observation.closeConfirmed });
const detached = detachUnconfirmedPackagedChild(child);
await send({ kind: 'detached', detached });
process.disconnect();
