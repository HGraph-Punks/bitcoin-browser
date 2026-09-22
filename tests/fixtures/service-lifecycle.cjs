'use strict';

// Harmless, bounded fixture for the packaged application's managed-service API.
// It never opens files, contacts the network, or launches another process.
const mode = process.argv[2];
if (mode === 'success') {
  process.exitCode = 0;
} else if (mode === 'failure') {
  process.exitCode = 7;
} else if (mode === 'wait') {
  const deadline = setTimeout(() => { process.exitCode = 8; }, 60_000);
  process.once('SIGTERM', () => {
    clearTimeout(deadline);
    process.stdout.write('fixture graceful shutdown\n');
  });
} else {
  process.exitCode = 64;
}
process.stdout.write(`fixture stdout ${mode}\n`);
process.stderr.write(`fixture stderr ${mode}\n`);
