import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBoundedOutput } from './startup-diagnostic-support.mjs';
import { readShellDocumentLoaded } from './packaged-startup-readiness.mjs';
import { DiagnosticCdp, discoverTargets } from './packaged-diagnostic-cdp.mjs';
import { SHUTDOWN_CASES, startShutdownFixture, classifyShutdown, shutdownCaseProbe, shutdownFrameExpression } from './packaged-shutdown-support.mjs';
import { OBSERVER_MODES, observeOwnedSecurityPrompt } from './owned-security-prompt-observer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const arg of args) if (!/^--(?:case|repeat|executable|report|os-prompt)=/.test(arg) && arg !== '--sample-slow-shutdown') throw new Error(`Unknown option ${arg}`);
const osPromptMode = option('os-prompt') ?? null;
if (osPromptMode && !OBSERVER_MODES.includes(osPromptMode)) throw new Error('Invalid OS prompt observation mode');
const cases = option('case') ? option('case').split(',') : [...SHUTDOWN_CASES];
if (!cases.length || new Set(cases).size !== cases.length || cases.some((value) => !SHUTDOWN_CASES.includes(value))) throw new Error('Invalid/duplicate diagnostic case');
const repeat = Number(option('repeat') ?? 2);
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 3) throw new Error('repeat must be 1–3');
const executable = option('executable') ?? path.join(root, 'release/developer/mac-arm64/Bitcoin Browser.app/Contents/MacOS/Bitcoin Browser');
if (!path.isAbsolute(executable)) throw new Error('Expected an absolute developer executable');
if (process.platform !== 'darwin') throw new Error('This native shutdown isolator currently targets macOS');
const reportName = option('report') ?? `packaged-shutdown-isolation-${Date.now()}.json`;
if (!/^packaged-shutdown-isolation-[a-zA-Z0-9-]+\.json$/.test(reportName)) throw new Error('Invalid diagnostic report basename');
const reportFile = path.join(root, 'release', reportName);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const shellPageExpression = '({ target: document.querySelector("#omnibox")?.value?.slice(0, 256), busy: document.querySelector("#app")?.getAttribute("aria-busy"), inert: document.querySelector("#app")?.inert, heading: document.querySelector("#page h1")?.textContent?.slice(0, 160), errors: document.querySelectorAll(".toast.error").length, errorMessages: [...document.querySelectorAll(".toast.error")].slice(0, 4).map(node => node.textContent.slice(0, 400)) })';
const shellPageMatches = (value, target) => value?.target === target && value.busy === 'false' && value.inert === false
  && value.heading === (target === 'satnav://bookmarks' ? 'Bookmarks' : 'Data sources')
  && !value.errorMessages?.some(message => /^(Bitcoin Browser could not start|Invalid navigation target|Could not save tab session)/.test(message));

async function bounded(promise, ms, fallback) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { clearTimeout(timer); }
}

async function poll(action, predicate, ms, label, child) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Process exited during ${label}`);
    const value = await action();
    if (predicate(value)) return value;
    await pause(75);
  }
  throw new Error(`Timed out: ${label}`);
}

async function waitForShellPage(cdp, target, label, child) {
  let lastSnapshot = null;
  try {
    return await poll(async () => (lastSnapshot = await cdp.evaluate(shellPageExpression)),
      (value) => shellPageMatches(value, target), 5000, label, child);
  } catch (error) {
    // These fields are limited to the synthetic internal route and its known
    // page heading; no arbitrary renderer console or browsing data is read.
    error.evidence = { target, lastSnapshot };
    throw error;
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readOwnedLogs(profile, pid) {
  const handle = await fs.open(path.join(profile, 'logs/satoshi-browser.jsonl'), 'r');
  try {
    const stat = await handle.stat();
    assert(stat.isFile(), 'Generated log is not a regular file');
    const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const records = [];
    let malformed = false;
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.pid !== pid || !['app.shutdown', 'renderer.bootstrap'].includes(entry.event)) continue;
        records.push({ event: entry.event, phase: typeof entry.phase === 'string' ? entry.phase.slice(0, 80) : null,
          code: typeof entry.code === 'string' ? entry.code.slice(0, 80) : null,
          elapsedMs: Number.isSafeInteger(entry.elapsedMs) ? entry.elapsedMs : null });
      } catch { malformed = true; }
    }
    return { records: records.slice(0, 100), truncated: stat.size > bytesRead || records.length > 100 || malformed };
  } finally { await handle.close(); }
}

async function sampleOwned(child, profile, run) {
  if (process.platform !== 'darwin' || child.exitCode !== null || child.signalCode !== null) return null;
  const file = path.join(profile, `shutdown-sample-${run}-${child.pid}.txt`);
  return new Promise((resolve) => execFile('/usr/bin/sample', [String(child.pid), '1', '1', '-mayDie', '-file', file],
    { timeout: 10_000, maxBuffer: 64 * 1024 }, async (error) => {
      let sha256 = null;
      try { await fs.chmod(file, 0o600); sha256 = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); } catch {}
      resolve({ file, exitCode: error ? error.code ?? null : 0, sha256, privacy: 'Raw stack; not reviewed for external sharing' });
    }));
}

async function readProbe(cdp, port, needle) {
  let frameId;
  const frames = (tree) => [tree.frame, ...(tree.childFrames ?? []).flatMap(frames)];
  const topology = await poll(async () => {
    const tree = frames((await cdp.send('Page.getFrameTree')).frameTree);
    const frame = tree.find((item) => item.url.includes(needle));
    if (frame && cdp.contexts.has(frame.id)) return { connection: cdp, contextId: cdp.contexts.get(frame.id) };
    frameId = frame?.id;
    const target = (await discoverTargets(port)).find((item) => item.type === 'iframe' && item.url.includes(needle));
    return target ? { target } : null;
  }, Boolean, 5000, `fixture frame ${frameId ?? ''}`);
  let connection = topology.connection;
  try {
    if (!connection) {
      connection = new DiagnosticCdp(topology.target.webSocketDebuggerUrl, port);
      await connection.open();
    }
    return await poll(() => connection.evaluate('window.shutdownProbe ?? null', topology.contextId), (value) => value?.done === true, 5000, 'bounded fixture operation');
  } finally {
    if (connection && connection !== cdp) {
      cdp.fixtureExceptionCount = (cdp.fixtureExceptionCount ?? 0) + connection.exceptionCount;
      cdp.fixtureTruncated = cdp.fixtureTruncated || connection.eventsTruncated;
      await connection.close();
    }
  }
}

async function exercise(name, cdp, fixture, port, run) {
  if (name === 'idle') return { action: 'none' };
  if (name === 'shell-cold-link') {
    const value = await waitForShellPage(cdp, 'satnav://bookmarks', 'cold-start deep-link destination');
    return { action: 'argv-deep-link-after-restored-state-bootstrap', target: value.target, heading: value.heading,
      seededActiveTarget: 'satnav://history', argvScheme: run === 1 ? 'satnav' : 'SATNAV', deliveryMultiplicity: 'Not instrumented in this packaged check' };
  }
  if (name === 'settings-roundtrip') {
    for (const settings of [
      { localOnly: false, contentNetworkPolicy: 'https-only', offlineMode: false },
      { offlineMode: true }, { offlineMode: false }, { localOnly: true, contentNetworkPolicy: 'blocked' }
    ]) await cdp.evaluate(`window.satBrowser.settings.update(${JSON.stringify(settings)})`);
    return { action: 'four-settings-transitions', networkOperations: 0 };
  }
  await cdp.evaluate(`window.satBrowser.providers.upsert(${JSON.stringify(fixture.provider)})`);
  await cdp.evaluate('window.satBrowser.settings.update({ offlineMode: false, localOnly: true })');
  if (name === 'provider-only') {
    const value = await cdp.evaluate('(async () => ({ health: await window.satBrowser.providers.health(), result: await window.satBrowser.navigation.resolve("sat:0") }))()');
    assert(value.result.entity?.source?.id === fixture.provider.id && value.health.some((item) => item.ok), 'Provider operation did not succeed');
    return { action: 'node-provider-health-and-resolution' };
  }
  const alternateFrame = name.startsWith('frame-');
  const credentialless = name.endsWith('-credentialless');
  const allowed = alternateFrame || ['content-https', 'content-https-include', 'content-wss'].includes(name);
  await cdp.evaluate(`window.satBrowser.settings.update({ contentNetworkPolicy: ${JSON.stringify(allowed ? 'https-only' : 'blocked')} })`);
  const connectionStart = fixture.connections.length;
  const id = `${'d'.repeat(64)}i${run}`;
  let frame = null;
  if (alternateFrame) {
    frame = await cdp.evaluate(shutdownFrameExpression(id, credentialless));
    assert(frame.credentialless === credentialless && frame.sandbox === 'allow-scripts allow-forms allow-modals allow-pointer-lock'
      && frame.referrerPolicy === 'no-referrer' && frame.src === `ord://content/${id}`, 'Diagnostic frame policy mismatch');
  } else await cdp.evaluate(`(() => { const input = document.querySelector('#omnibox'); input.value = 'inscription:${id}'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  const result = await readProbe(cdp, port, `/content/${id}`);
  assert(result.probe === shutdownCaseProbe(name), 'Wrong probe executed');
  if (alternateFrame) assert(result.credentialless === credentialless, 'Fixture document did not enter the requested credentialless mode');
  assert(result.attempted === (name !== 'content-none'), 'Probe attempt state mismatch');
  assert(fixture.requests.some((item) => item.path === `/content/${id}`), 'Content did not load through the real provider');
  if (!allowed) assert(fixture.connections.length === 0, 'Blocked control emitted native TLS');
  return { action: alternateFrame ? 'diagnostic-only-frame-composition' : 'single-iframe-operation', result, allowed, frame,
    actualProductNavigation: !alternateFrame, leftContentOpenAtQuit: true,
    expectedNetworkObserved: !allowed || fixture.connections.slice(connectionStart).some((item) => item.clientHello) };
}

async function secondInstance(profile, deepLink) {
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--disable-breakpad', deepLink],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
  const output = createBoundedOutput();
  child.stdout.on('data', (chunk) => output.append(chunk));
  child.stderr.on('data', (chunk) => output.append(chunk));
  let error = null;
  child.once('error', (value) => { error = value.code ?? 'SPAWN_FAILED'; });
  const close = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const result = await bounded(close, 5000, null);
  if (!result && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const closed = result ?? await bounded(close, 3000, null);
  if (!closed) {
    const failure = new Error('Second-instance close is unconfirmed');
    failure.ownedCloseUnconfirmed = true;
    throw failure;
  }
  assert(result && closed.code === 0 && closed.signal === null && !error && !output.truncated, 'Second-instance delivery did not exit cleanly');
  assert(!/Uncaught Exception|sandboxed_renderer\.bundle\.js script failed|Unable to load preload/i.test(output.text), 'Second instance emitted a startup failure');
  return { pid: child.pid, code: closed.code, signal: closed.signal, outputBytes: output.totalBytesSeen };
}

async function recreateShell(initialCdp, profile, port, child) {
  let cdp = initialCdp;
  const generations = [];
  try {
    for (const targetUrl of ['satnav://bookmarks', 'satnav://providers']) {
      assert(cdp.exceptionCount === 0 && !cdp.eventsTruncated, 'Prior renderer emitted diagnostics or truncated events');
      const oldTarget = (await discoverTargets(port)).find((item) => item.url === 'app://app/renderer/index.html');
      assert(oldTarget, 'Missing shell before native window closure');
      await cdp.send('Page.close');
      await cdp.close();
      await poll(async () => (await discoverTargets(port)).every((item) => item.id !== oldTarget.id), Boolean, 5000, 'old shell window gone', child);
      const reopenStartedAt = Date.now();
      const delivered = await secondInstance(profile, targetUrl === 'satnav://providers' ? 'SATNAV://providers' : targetUrl);
      await poll(() => readShellDocumentLoaded(path.join(profile, 'logs/satoshi-browser.jsonl'), child.pid, reopenStartedAt), Boolean, 8000, 'recreated shell document milestone', child);
      const target = await poll(async () => (await discoverTargets(port)).find((item) => item.type === 'page' && item.url === 'app://app/renderer/index.html' && item.id !== oldTarget.id), Boolean, 5000, 'new shell generation', child);
      cdp = new DiagnosticCdp(target.webSocketDebuggerUrl, port);
      await cdp.open();
      const visible = await waitForShellPage(cdp, targetUrl, 'recreated shell deep-link destination', child);
      generations.push({ oldTargetId: oldTarget.id, newTargetId: target.id, target: visible.target, heading: visible.heading, secondInstance: delivered });
      assert(cdp.exceptionCount === 0 && !cdp.eventsTruncated, 'Recreated renderer emitted diagnostics or truncated events');
    }
    return { cdp, operation: { action: 'close-main-window-and-deliver-second-instance-link', generations } };
  } catch (error) {
    await cdp.close().catch(() => {});
    throw error;
  }
}

async function launchOnce(name, profile, fixture, run) {
  const port = await reservePort();
  const startedAt = Date.now();
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--disable-breakpad', ...(name === 'shell-cold-link' ? [run === 1 ? 'satnav://bookmarks' : 'SATNAV://bookmarks'] : [])],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
  // Opt-in only, under explicit OS-prompt authority. Starts concurrently with
  // the owned launch so model/tool latency cannot miss the active request.
  const promptController = new AbortController();
  const promptObservation = osPromptMode ? observeOwnedSecurityPrompt({ mode: osPromptMode, signal: promptController.signal })
    : Promise.resolve(null);
  const stdout = createBoundedOutput();
  const stderr = createBoundedOutput();
  child.stdout.on('data', (chunk) => stdout.append(chunk));
  child.stderr.on('data', (chunk) => stderr.append(chunk));
  let spawnError = null;
  let closed = false;
  child.once('error', (error) => { spawnError = error.code ?? 'SPAWN_FAILED'; });
  const close = new Promise((resolve) => child.once('close', (code, signal) => { closed = true; promptController.abort(); resolve({ code, signal }); }));
  const observation = { case: name, run, pid: child.pid ?? null, operationCompleted: false, operation: null, error: null };
  let cdp;
  let sample = Promise.resolve(null);
  let sampleTimer;
  let stopStartedAt;
  let forced = false;
  try {
    await poll(() => readShellDocumentLoaded(path.join(profile, 'logs/satoshi-browser.jsonl'), child.pid, startedAt), Boolean, 15_000, 'passive shell document loaded', child);
    const target = await poll(async () => (await discoverTargets(port)).find((item) => item.type === 'page' && item.url === 'app://app/renderer/index.html'), Boolean, 5000, 'shell debugger target', child);
    cdp = new DiagnosticCdp(target.webSocketDebuggerUrl, port);
    await cdp.open();
    await poll(() => cdp.evaluate('({ api: Boolean(window.satBrowser), busy: document.querySelector("#app")?.getAttribute("aria-busy"), children: document.querySelector("#page")?.children.length })'),
      (value) => value?.api && value.busy === 'false' && value.children > 0, 5000, 'IPC and visible shell readiness', child);
    if (name === 'shell-recreate') {
      const recreated = await recreateShell(cdp, profile, port, child);
      cdp = recreated.cdp;
      observation.operation = recreated.operation;
    } else observation.operation = await exercise(name, cdp, fixture, port, run);
    assert(observation.operation.expectedNetworkObserved !== false, 'Allowed probe did not emit a new TLS ClientHello');
    observation.operationCompleted = true;
    // Match observation residence across controls; this does not delay startup.
    await pause(Math.max(0, 5000 - (Date.now() - startedAt)));
  } catch (error) {
    observation.error = String(error.message).slice(0, 1200);
    if (error.evidence) observation.evidence = error.evidence;
    observation.ownedCloseUnconfirmed = error.ownedCloseUnconfirmed === true;
  }
  finally {
    try { await cdp?.close(); }
    catch (error) { observation.operationCompleted = false; observation.error = error.code ?? 'CDP_CLOSE_FAILED'; }
    stopStartedAt = Date.now();
    if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (args.includes('--sample-slow-shutdown')) sampleTimer = setTimeout(() => { sample = sampleOwned(child, profile, run); }, 2000);
    const exited = await bounded(close, 15_000, null);
    clearTimeout(sampleTimer);
    if (!exited && child.exitCode === null && child.signalCode === null) { forced = true; child.kill('SIGKILL'); }
    await bounded(close, 3000, null);
  }
  const stopDurationMs = Date.now() - stopStartedAt;
  let logs;
  try { logs = await readOwnedLogs(profile, child.pid); }
  catch (error) { logs = { records: [], truncated: true, error: error.code ?? 'LOG_READ_FAILED' }; }
  const diagnostics = logs.records.filter((item) => item.event === 'renderer.bootstrap').length
    + (stderr.text.match(/sandboxed_renderer\.bundle\.js script failed to run|binding\.startupData[^\n]{0,160}(?:is null|null)|Unable to load preload script|Error occurred while loading preload script/gi) ?? []).length;
  const osPrompt = await promptObservation;
  if (osPrompt && (osPrompt.acted === null || ['observer-error', 'exec-timeout', 'ambiguous', 'unsupported-platform'].includes(osPrompt.status))) {
    observation.operationCompleted = false;
    observation.error = observation.error ?? 'OS_PROMPT_OBSERVATION_INCOMPLETE';
  }
  return { ...observation, osPrompt, stopDurationMs, durationMs: Date.now() - startedAt, code: child.exitCode, signal: child.signalCode, forced, closed, spawnError,
    exceptionCount: (cdp?.exceptionCount ?? 0) + (cdp?.fixtureExceptionCount ?? 0), diagnostics,
    truncated: stdout.truncated || stderr.truncated || logs.truncated || Boolean(cdp?.eventsTruncated || cdp?.fixtureTruncated) || Boolean(fixture?.observationsTruncated),
    outputBytes: { stdout: stdout.totalBytesSeen, stderr: stderr.totalBytesSeen }, logs, sample: await sample };
}

async function main() {
  await fs.access(executable);
  try { await fs.access(reportFile); throw new Error('Diagnostic report already exists; choose a new --report basename'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const asar = path.join(path.dirname(executable), '../Resources/app.asar');
  const report = { generatedAt: null, platform: process.platform, arch: process.arch,
    executable, asarSha256: crypto.createHash('sha256').update(await fs.readFile(asar)).digest('hex'),
    purpose: 'Operation isolation on an unchanged packaged app, not full beta qualification',
    limitations: 'Raw TLS sink; no valid certificate or HTTPS/WSS success assertion. No credentials inspected. Minimal profiles contain no extensions or services.',
    requestedCases: cases, repeat, osPromptMode, cases: [] };
  let reportCreated = false;
  for (const name of cases) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), `satoshi-shutdown-${name}-`));
    await fs.chmod(profile, 0o700);
    let fixture;
    let launchInProgress = false;
    const launches = [];
    try {
      await fs.mkdir(path.join(profile, 'state'), { mode: 0o700 });
      await fs.writeFile(path.join(profile, 'state/state.json'), JSON.stringify({ schemaVersion: 3, settings: { localOnly: true }, providers: [], extensions: [] }), { flag: 'wx', mode: 0o600 });
      if (!['idle', 'shell-cold-link', 'shell-recreate', 'settings-roundtrip'].includes(name)) fixture = await startShutdownFixture(shutdownCaseProbe(name));
      for (let run = 1; run <= repeat; run++) {
        if (name === 'shell-cold-link') {
          // Re-seed only this owned profile after confirmed process closure, so
          // a reused run cannot pass merely by restoring its prior destination.
          await fs.writeFile(path.join(profile, 'state/state.json'), JSON.stringify({ schemaVersion: 3,
            settings: { localOnly: true }, providers: [], extensions: [],
            tabs: [{ id: 'competing-restored-tab', title: 'History', target: 'satnav://history', history: ['satnav://history'], historyIndex: 0 }],
            activeTabId: 'competing-restored-tab' }), { flag: 'w', mode: 0o600 });
        }
        const requestStart = fixture?.requests.length ?? 0;
        const connectionStart = fixture?.connections.length ?? 0;
        launchInProgress = true;
        const result = await launchOnce(name, profile, fixture, run);
        launchInProgress = false;
        launches.push({ ...result, passed: classifyShutdown(result), requests: fixture?.requests.slice(requestStart) ?? [], connections: fixture?.connections.slice(connectionStart) ?? [] });
        console.log(`${name} ${run}/${repeat}: operation=${result.operationCompleted} exit=${result.code ?? result.signal} forced=${result.forced} stop=${result.stopDurationMs}ms error=${result.error ?? 'none'}`);
        if (!result.closed) throw new Error('Owned process close is unconfirmed; retaining profile and stopping the matrix');
      }
    } finally {
      await fixture?.close();
      const retain = launchInProgress || launches.some((item) => !item.closed || item.ownedCloseUnconfirmed || item.sample?.sha256);
      if (!retain) await fs.rm(profile, { recursive: true });
      report.cases.push({ name, profile: retain ? profile : '[removed]', profileRemoved: !retain, launches });
      report.generatedAt = new Date().toISOString();
      const all = report.cases.flatMap((item) => item.launches);
      report.summary = { expected: cases.length * repeat, completed: all.length, passing: all.filter((item) => item.passed).length,
        forced: all.filter((item) => item.forced).length, operationFailures: all.filter((item) => !item.operationCompleted).length,
        complete: all.length === cases.length * repeat };
      await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: reportCreated ? 'w' : 'wx', mode: 0o600 });
      reportCreated = true;
    }
  }
  console.log(`Diagnostic report: ${reportFile}`);
  if (!report.summary.complete || report.summary.passing !== report.summary.expected) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
