import fs from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from '../../src/main/state-store.js';

const [directory, mode] = process.argv.slice(2);
if (!directory || !['interrupt-write', 'committed-write'].includes(mode)) {
  process.stderr.write('usage: state-crash.mjs <directory> <interrupt-write|committed-write>\n');
  process.exit(2);
}

const store = new StateStore(directory, null);
await store.init();
await store.updateSettings({ theme: 'light' });
await store.flush();
process.stdout.write('BASELINE\n');

const selfDeadline = setTimeout(() => process.exit(3), 10_000);
const originalRename = fs.rename.bind(fs);
if (mode === 'interrupt-write') {
  fs.rename = async (source, destination) => {
    const sourceName = path.basename(String(source));
    const exactFinal = path.resolve(String(destination)) === path.resolve(directory, 'state.json');
    const ownedTemporary = new RegExp(`^state\\.json\\.${process.pid}\\.\\d+\\.tmp$`).test(sourceName);
    if (exactFinal && ownedTemporary) {
      process.stdout.write(`RENAME_BLOCKED ${sourceName}\n`);
      await new Promise(() => {});
    }
    return originalRename(source, destination);
  };
}

process.stdin.setEncoding('utf8');
for await (const input of process.stdin) {
  if (!input.includes('go')) continue;
  process.stdout.write('STARTING\n');
  if (mode === 'interrupt-write') {
    await store.mutate((draft) => {
      draft.settings.theme = 'dark';
    });
  } else {
    await store.updateSettings({ theme: 'dark' });
  }
  process.stdout.write('COMMITTED\n');
  clearTimeout(selfDeadline);
  setInterval(() => {}, 60_000);
  break;
}
