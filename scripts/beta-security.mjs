import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fast, deterministic boundary checks; no funded wallets, scanners, credentials,
// or public providers. Native extension injection is covered by smoke:packaged.
const tests = [
  'application-startup-shutdown', 'wallet-manager', 'wallet-bridge-integration', 'wallet-adapters', 'wallet-discovery',
  'wallet-extension-lifecycle', 'wallet-protocol', 'extension-wallet-integration',
  'extension-manager', 'extension-state-store', 'extension-lifecycle-failures',
  'extension-ipc-recovery', 'extension-ipc-shutdown', 'ipc-contract', 'ipc-surface',
  'ipc-event-lifecycle', 'content-security', 'content-network-policy', 'mock-provider',
  'content-thumbnail', 'popular-assets', 'model-inscription', 'content-model', 'model-frame',
  'content-decoding', 'content-document', 'document-preview', 'document-frame', 'document-rendering', 'inscription-formats',
  'local-ai', 'local-ai-data', 'local-ai-recursion', 'local-ai-experience', 'local-ai-ipc', 'local-ai-ui',
  'node-capacity', 'easy-node-setup', 'easy-node-publication', 'node-setup-ipc', 'node-setup-plan', 'node-software', 'software-download-policy', 'bitcoin-core-auth',
  'after-pack', 'after-sign', 'release-policy', 'windows-signature-policy', 'release-workflow', 'beta-release', 'branding', 'donation'
].map((name) => `tests/${name}.test.js`);

const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', shell: false
});
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
