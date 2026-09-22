import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function actual(start, end) {
  const a = source.indexOf(start); const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
const inscriptionA = `${'a'.repeat(64)}i0`;
const inscriptionB = `${'b'.repeat(64)}i1`;
const saved = { filePath: '/synthetic/content.txt', bytes: 3, mime: 'text/plain', sha256: null };
function fixture() {
  const content = []; const diagnostics = []; const toasts = [];
  let selected = inscriptionA; let pageEffects = 0;
  const request = (list, id) => new Promise((resolve, reject) => list.push({ id, resolve, reject }));
  const actions = vm.runInNewContext(`(() => {
    const pendingContentSaves = new Set(); let diagnosticsExportPending = false;
    ${actual('async function exportDiagnostics()', '\nasync function revealPath(')}
    ${actual('async function saveContent(', '\nasync function openWalletBridge(')}
    return { saveContent, exportDiagnostics };
  })()`, {
    api: { content: { save: (id) => request(content, id) }, diagnostics: { export: () => request(diagnostics) } },
    toast: (...args) => toasts.push(args),
    state: () => ({ selected }), currentResult: () => ({ target: { value: selected } }),
    patch: () => { pageEffects++; }, renderPage: () => { pageEffects++; }, closeModal: () => { pageEffects++; }
  });
  return { ...actions, content, diagnostics, toasts, navigate: (id) => { selected = id; }, pageEffects: () => pageEffects };
}

test('duplicate same-inscription Save submits once and explicitly reports not sent', async () => {
  const f = fixture(); const first = f.saveContent(inscriptionA); const second = f.saveContent(inscriptionA);
  const count = f.content.length;
  for (const request of f.content) request.resolve(saved);
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.ok(f.toasts.some(([, message]) => /not sent/i.test(message)));
});

test('duplicate diagnostics export submits once and explicitly reports not sent', async () => {
  const f = fixture(); const first = f.exportDiagnostics(); const second = f.exportDiagnostics();
  const count = f.diagnostics.length;
  for (const request of f.diagnostics) request.resolve('/synthetic/diagnostics.json');
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.ok(f.toasts.some(([, message]) => /not sent/i.test(message)));
});

test('distinct inscription Saves and diagnostics remain independently admitted', async () => {
  const f = fixture(); const a = f.saveContent(inscriptionA); const b = f.saveContent(inscriptionB); const diagnostics = f.exportDiagnostics();
  assert.deepEqual(f.content.map((request) => request.id), [inscriptionA, inscriptionB]);
  assert.equal(f.diagnostics.length, 1);
  f.content[1].resolve(saved); f.diagnostics[0].resolve('/synthetic/diagnostics.json');
  await Promise.all([b, diagnostics]);
  f.content[0].resolve(saved); await a;
  assert.equal(f.toasts.filter(([title]) => title === 'Inscription content saved').length, 2);
});

test('content success, cancellation and write failure all release admission for explicit retry', async () => {
  for (const outcome of ['success', 'cancel', 'failure']) {
    const f = fixture(); const first = f.saveContent(inscriptionA);
    if (outcome === 'success') f.content[0].resolve(saved);
    else f.content[0].reject({ code: outcome === 'cancel' ? 'USER_REJECTED' : 'CONTENT_SAVE_FAILED', message: 'Synthetic save failure', details: { stage: 'write', contentMutationCommitted: false, filesystemCode: 'EIO' } });
    await first;
    if (outcome === 'cancel') assert.equal(f.toasts.length, 0);
    else assert.deepEqual(f.toasts[0], outcome === 'success'
      ? ['Inscription content saved', '3 bytes · /synthetic/content.txt', 'success']
      : ['Could not save content', 'Synthetic save failure', 'error']);
    assert.equal(f.content.length, 1, 'Settlement does not automatically replay');
    const retry = f.saveContent(inscriptionA); assert.equal(f.content.length, 2); f.content[1].resolve(saved); await retry;
  }
});

test('diagnostics success, cancellation and failure all release admission for explicit retry', async () => {
  for (const outcome of ['success', 'cancel', 'failure']) {
    const f = fixture(); const first = f.exportDiagnostics();
    if (outcome === 'success') f.diagnostics[0].resolve('/synthetic/diagnostics.json');
    else f.diagnostics[0].reject({ code: outcome === 'cancel' ? 'USER_REJECTED' : 'EIO', message: 'Synthetic export failure' });
    await first;
    if (outcome === 'cancel') assert.equal(f.toasts.length, 0);
    else assert.deepEqual(f.toasts[0], outcome === 'success'
      ? ['Diagnostics exported', '/synthetic/diagnostics.json', 'success']
      : ['Diagnostics export failed', 'Synthetic export failure', 'error']);
    assert.equal(f.diagnostics.length, 1, 'Settlement does not automatically replay');
    const retry = f.exportDiagnostics(); assert.equal(f.diagnostics.length, 2); f.diagnostics[1].resolve('/synthetic/retry.json'); await retry;
  }
});

test('delayed Save retains click-time inscription and never repaints or closes a replacement page/modal', async () => {
  const f = fixture(); const save = f.saveContent(inscriptionA); f.navigate(inscriptionB);
  f.content[0].resolve(saved); await save;
  assert.equal(f.content[0].id, inscriptionA);
  assert.equal(f.pageEffects(), 0);
});
