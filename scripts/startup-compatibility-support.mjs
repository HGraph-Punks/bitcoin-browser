// Diagnostic fixture only. No Electron import or native execution occurs on import.
export const COMPATIBILITY_HOST = 'app://startup-compatibility/host';
export const COMPATIBILITY_CHILD = 'app://startup-compatibility/child';
export const COMPATIBILITY_DOCUMENTS = Object.freeze([
  { id: 'committed-blank', owner: 'blank', url: 'about:blank', committed: true },
  { id: 'held-host', owner: 'host', url: COMPATIBILITY_HOST, committed: true },
  { id: 'child-initial-blank', owner: 'child', url: 'about:blank', committed: false },
  { id: 'child-navigated', owner: 'child', url: COMPATIBILITY_CHILD, committed: true }
]);
export const COMPATIBILITY_CHANNEL = 'startup-compatibility:preload';
export const COMPATIBILITY_PAGE_PROBE = `(() => ({
  href: location.href,
  contextId: globalThis.startupCompatibility?.contextId,
  requireAbsent: typeof globalThis.require === 'undefined',
  processAbsent: typeof globalThis.process === 'undefined',
  moduleAbsent: typeof globalThis.module === 'undefined',
  bufferAbsent: typeof globalThis.Buffer === 'undefined'
}))()`;

const positive = value => Number.isSafeInteger(value) && value > 0;
const contextIdValid = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
const failure = code => Object.assign(new Error(code), { code });
const observedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications',
  'fullscreen', 'automatic-fullscreen', 'window-management', 'local-fonts', 'persistent-storage',
  'media', 'geolocation', 'pointerLock', 'keyboardLock', 'sensors', 'unknown']);

export function validateCompatibilityReport(report) {
  if (!report || report.schemaVersion !== 1 || report.fixtureComplete !== true
    || report.debuggerUsed !== false || report.security?.sandbox !== true
    || report.security?.contextIsolation !== true || report.security?.nodeIntegration !== false
    || report.security?.webSecurity !== true || report.cleanup?.listenersRemaining !== 0
    || report.cleanup?.windowsRemaining !== 0 || report.cleanup?.protocolRemoved !== true
    || !Array.isArray(report.failures) || report.failures.length
    || !Array.isArray(report.documents) || report.documents.length !== 4
    || !Array.isArray(report.windows) || report.windows.length !== 3
    || report.heldResponse?.released !== true || report.heldResponse?.preloadsBeforeRelease !== 0
    || !Number.isFinite(report.heldResponse?.observedMs) || report.heldResponse.observedMs < 50 || report.heldResponse.observedMs > 5000
    || !Number.isFinite(report.childBlank?.observedMs) || report.childBlank.observedMs < 50 || report.childBlank.observedMs > 5000
    || report.childBlank?.navigationRequests !== 0
    || !Array.isArray(report.permissionChecks) || report.permissionChecks.length > 128
    || report.permissionChecks.some(check => !check || check.granted !== false
      || (!observedPermissions.has(check.permission) && check.permission !== '[other]')
      || !['blank', 'host', 'child', '[unowned]'].includes(check.owner)
      || (check.webContentsId !== null && !positive(check.webContentsId)))) return false;
  const owners = new Map();
  for (const window of report.windows) {
    if (!window || !['blank', 'host', 'child'].includes(window.owner) || owners.has(window.owner)
      || !positive(window.webContentsId) || window.closed !== true) return false;
    owners.set(window.owner, window.webContentsId);
  }
  if (new Set(owners.values()).size !== 3
    || !Array.isArray(report.consoleEvents) || report.consoleEvents.length > 32
    || report.consoleEvents.some(event => event?.code !== 'ELECTRON_INSECURE_CSP_WARNING'
      || event.owner !== 'blank' || event.document !== 'committed-blank' || event.level !== 'warning'
      || event.mainFrame !== true || event.webContentsId !== owners.get('blank'))) return false;
  const contexts = new Set();
  for (let i = 0; i < COMPATIBILITY_DOCUMENTS.length; i++) {
    const expected = COMPATIBILITY_DOCUMENTS[i]; const doc = report.documents[i];
    if (!doc || doc.id !== expected.id || doc.owner !== expected.owner || doc.url !== expected.url
      || doc.webContentsId !== owners.get(expected.owner) || doc.preloadCount !== 1
      || !contextIdValid(doc.contextId) || contexts.has(doc.contextId)
      || !positive(doc.frameProcessId) || !positive(doc.frameRoutingId)
      || doc.sandboxed !== true || doc.contextIsolated !== true || doc.isMainFrame !== true
      || doc.page?.href !== expected.url || doc.page?.contextId !== doc.contextId
      || !['requireAbsent', 'processAbsent', 'moduleAbsent', 'bufferAbsent'].every(key => doc.page?.[key] === true)
      || (expected.committed && (doc.commitCount !== 1 || doc.loadCount !== 1))
      || (!expected.committed && (!Number.isInteger(doc.commitCount) || doc.commitCount < 0 || doc.commitCount > 1
        || !Number.isInteger(doc.loadCount) || doc.loadCount < 0 || doc.loadCount > 1))) return false;
    contexts.add(doc.contextId);
  }
  return true;
}

// These collaborators make orchestration testable without Electron. Native runs
// still use real BrowserWindow/frame objects and the actual fixture preload.
export async function runStartupCompatibility({ electron, preloadPath, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => performance.now(), timeoutMs = 5000 }) {
  const { app, BrowserWindow, ipcMain, protocol, session } = electron;
  const report = { schemaVersion: 1, fixtureComplete: false, debuggerUsed: false,
    security: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    documents: [], windows: [], failures: [], permissionChecks: [], consoleEvents: [], heldResponse: { released: false, preloadsBeforeRelease: 0, observedMs: 0 },
    childBlank: { observedMs: 0, navigationRequests: 0 },
    cleanup: { listenersRemaining: null, windowsRemaining: null, protocolRemoved: false } };
  const listeners = []; const owned = new Map(); const seenContexts = new Set(); const unexpected = new Set();
  let stopping = false;
  let expectedCreation = null; let popupAllowed = false; let childWindow = null; let targetSession;
  let activeDocument = null; let wake = () => {}; let fatalResolve;
  const fatal = new Promise(resolve => { fatalResolve = resolve; });
  const fail = code => { if (!report.failures.includes(code)) report.failures.push(code); fatalResolve(failure(code)); wake(); };
  const listen = (emitter, event, listener) => {
    emitter.on(event, listener);
    listeners.push({ emitter, event, listener });
  };
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, fatal.then(error => { throw error; }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('COMPATIBILITY_TIMEOUT')), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  const check = () => { if (report.failures.length) throw failure(report.failures[0]); };
  const waitUntil = async predicate => {
    while (!predicate()) await bounded(new Promise(resolve => { wake = resolve; }));
    wake = () => {}; check();
  };
  const currentFor = contents => {
    const owner = owned.get(contents);
    if (!owner || !activeDocument || activeDocument.owner !== owner.owner) { fail('COMPATIBILITY_DOCUMENT_OWNER'); return null; }
    return activeDocument;
  };
  function registerContents(_event, contents) {
    if (!expectedCreation || !positive(contents.id) || [...owned.values()].some(item => item.owner === expectedCreation)) {
      unexpected.add(contents); fail('COMPATIBILITY_UNEXPECTED_WINDOW'); return;
    }
    const record = { owner: expectedCreation, webContentsId: contents.id, closed: false, window: null };
    expectedCreation = null; owned.set(contents, record);
    contents.setWindowOpenHandler(details => {
      if (record.owner !== 'host' || !popupAllowed || childWindow || expectedCreation
        || details.url !== 'about:blank' || details.frameName !== 'startup-owned-child') {
        fail('COMPATIBILITY_UNEXPECTED_WINDOW'); return { action: 'deny' };
      }
      popupAllowed = false; expectedCreation = 'child';
      return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: preferences() } };
    });
    listen(contents, 'did-create-window', (win, details) => {
      const child = owned.get(win.webContents);
      if (record.owner !== 'host' || child?.owner !== 'child' || childWindow
        || details.url !== 'about:blank' || details.frameName !== 'startup-owned-child') {
        unexpected.add(win.webContents); fail('COMPATIBILITY_CHILD_OWNER'); return;
      }
      childWindow = win; bindWindow(child, win); wake();
    });
    const guardNavigation = (event, url) => {
      const doc = currentFor(contents);
      const target = typeof url === 'string' ? url : event.url;
      if (!doc || target !== doc.url || event.isMainFrame === false) {
        event.preventDefault?.(); fail('COMPATIBILITY_UNEXPECTED_NAVIGATION');
      }
    };
    listen(contents, 'will-navigate', guardNavigation);
    listen(contents, 'will-frame-navigate', guardNavigation);
    listen(contents, 'did-start-navigation', event => {
      guardNavigation(event);
      if (activeDocument?.id === 'child-initial-blank' && report.childBlank.started) {
        report.childBlank.navigationRequests++; fail('COMPATIBILITY_BLANK_CHILD_NAVIGATED');
      }
    });
    listen(contents, 'did-frame-navigate', (_event, url, _code, _text, main, processId, routingId) => {
      const doc = currentFor(contents);
      if (!doc || !main || url !== doc.url || !positive(processId) || !positive(routingId)) { fail('COMPATIBILITY_COMMIT_OWNER'); return; }
      doc.commitCount++;
      if (doc.commitCount > 1 || (doc.frameProcessId && (doc.frameProcessId !== processId || doc.frameRoutingId !== routingId))) {
        fail('COMPATIBILITY_DUPLICATE_OR_STALE_COMMIT'); return;
      }
      doc.commitIdentity = { processId, routingId }; wake();
    });
    listen(contents, 'did-finish-load', () => {
      const doc = currentFor(contents);
      if (doc && ++doc.loadCount > 1) fail('COMPATIBILITY_DUPLICATE_LOAD');
      wake();
    });
    listen(contents, 'console-message', details => {
      if (details.sourceId !== 'node:electron/js2c/sandbox_bundle') return;
      const message = typeof details.message === 'string' && details.message.length <= 4096 ? details.message : '';
      const code = /sandboxed_renderer\.bundle\.js script failed to run/i.test(message) ? 'SANDBOX_BUNDLE_SCRIPT_FAILED'
        : /startupData[^\n]{0,160}(?:is null|null)/i.test(message) ? 'SANDBOX_STARTUP_DATA_NULL'
          : /Electron Security Warning \(Insecure Content-Security-Policy\)/.test(message) ? 'ELECTRON_INSECURE_CSP_WARNING'
            : 'OTHER_ELECTRON_SANDBOX_CONSOLE';
      if (report.consoleEvents.length < 32) report.consoleEvents.push({ code, owner: record.owner,
        document: activeDocument?.owner === record.owner ? activeDocument.id : '[inactive]',
        webContentsId: contents.id, mainFrame: details.frame === contents.mainFrame,
        level: ['info', 'warning', 'error', 'debug'].includes(details.level) ? details.level : '[other]' });
      else fail('COMPATIBILITY_CONSOLE_LIMIT');
      // Explicit about:blank has no response CSP. Retain its known development
      // warning, but never accept that warning on an app document, another
      // frame, or at error severity. Bootstrap failures remain fatal.
      const expectedBlankWarning = code === 'ELECTRON_INSECURE_CSP_WARNING' && record.owner === 'blank'
        && activeDocument?.id === 'committed-blank' && activeDocument.owner === record.owner
        && details.level === 'warning' && details.frame === contents.mainFrame;
      if (!expectedBlankWarning) fail('COMPATIBILITY_SANDBOX_CONSOLE');
    });
    for (const event of ['preload-error', 'render-process-gone', 'did-fail-load', 'will-attach-webview']) {
      listen(contents, event, eventObject => { eventObject?.preventDefault?.(); fail('COMPATIBILITY_RUNTIME_FAILURE'); });
    }
  }
  function bindWindow(record, win) {
    if (!record || record.webContentsId !== win.webContents.id) {
      unexpected.add(win.webContents); throw failure('COMPATIBILITY_WINDOW_OWNER');
    }
    record.window = win;
    listen(win, 'closed', () => {
      record.closed = true;
      if (!record.closing) fail('COMPATIBILITY_UNEXPECTED_CLOSE');
      wake();
    });
  }
  function preferences() {
    return { preload: preloadPath, partition: 'startup-compatibility', ...report.security };
  }
  function begin(id) {
    const expected = COMPATIBILITY_DOCUMENTS.find(item => item.id === id);
    activeDocument = { ...expected, preloadCount: 0, commitCount: 0, loadCount: 0 };
    report.documents.push(activeDocument); return activeDocument;
  }
  async function qualify(contents) {
    const doc = activeDocument;
    await waitUntil(() => doc.preloadCount === 1 && (!doc.committed || (doc.commitCount === 1 && doc.loadCount === 1)));
    const page = await bounded(contents.executeJavaScript(COMPATIBILITY_PAGE_PROBE));
    if (contents.mainFrame.url !== doc.url || contents.mainFrame.processId !== doc.frameProcessId
      || contents.mainFrame.routingId !== doc.frameRoutingId || !page || page.href !== doc.url || page.contextId !== doc.contextId
      || !['requireAbsent', 'processAbsent', 'moduleAbsent', 'bufferAbsent'].every(key => page[key] === true)) {
      throw failure('COMPATIBILITY_PAGE_AUTHORITY');
    }
    doc.page = Object.fromEntries(['href', 'contextId', 'requireAbsent', 'processAbsent', 'moduleAbsent', 'bufferAbsent'].map(key => [key, page[key]]));
    check();
  }
  async function closeOwned(record) {
    if (!record.closed) {
      record.closing = true;
      removeConsoleObserver(record);
      record.window?.close(); await waitUntil(() => record.closed);
    }
  }
  function removeConsoleObserver(record) {
    // Electron's last console-listener removal toggles a native observer. Do
    // this while the object is alive, retaining navigation/crash guards until
    // close. Calling it after destruction removes JS listeners then throws.
    const contents = record.window?.webContents;
    for (const { emitter, event, listener } of listeners) {
      if (emitter !== contents || event !== 'console-message') continue;
      try { if (emitter.listeners(event).includes(listener)) emitter.removeListener(event, listener); }
      catch { fail('COMPATIBILITY_LISTENER_CLEANUP'); }
    }
  }
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
  listen(app, 'window-all-closed', () => {});
  listen(app, 'web-contents-created', registerContents);
  listen(ipcMain, COMPATIBILITY_CHANNEL, (event, marker) => {
    const doc = currentFor(event.sender); const frame = event.senderFrame;
    if (!doc || frame !== event.sender.mainFrame || frame?.url !== doc.url || marker?.href !== doc.url
      || marker.sandboxed !== true || marker.contextIsolated !== true || marker.isMainFrame !== true
      || !contextIdValid(marker.contextId) || seenContexts.has(marker.contextId)
      || !positive(frame?.processId) || !positive(frame?.routingId)
      || (doc.commitIdentity && (doc.commitIdentity.processId !== frame.processId || doc.commitIdentity.routingId !== frame.routingId))) {
      fail('COMPATIBILITY_PRELOAD_OWNER'); return;
    }
    if (++doc.preloadCount !== 1) { fail('COMPATIBILITY_DUPLICATE_PRELOAD'); return; }
    if (doc.id === 'held-host' && !report.heldResponse.released) report.heldResponse.preloadsBeforeRelease++;
    seenContexts.add(marker.contextId);
    Object.assign(doc, { webContentsId: event.sender.id, contextId: marker.contextId, frameProcessId: frame.processId,
      frameRoutingId: frame.routingId, sandboxed: true, contextIsolated: true, isMainFrame: true }); wake();
  });
  try {
    await bounded(app.whenReady());
    targetSession = session.fromPartition('startup-compatibility', { cache: false });
    targetSession.setPermissionRequestHandler((_wc, _permission, callback) => { callback(false); fail('COMPATIBILITY_PERMISSION_REQUEST'); });
    targetSession.setPermissionCheckHandler((contents, permission) => {
      // Chromium may check capabilities while creating a document. A denied
      // check is not a grant or a page permission request. Retain it, bounded,
      // without recording origins/details, and keep the deny policy unchanged.
      if (report.permissionChecks.length >= 128) fail('COMPATIBILITY_PERMISSION_CHECK_LIMIT');
      else report.permissionChecks.push({ permission: observedPermissions.has(permission) ? permission : '[other]',
        webContentsId: positive(contents?.id) ? contents.id : null,
        owner: owned.get(contents)?.owner ?? '[unowned]', granted: false });
      return false;
    });
    targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const owner = [...owned.values()].find(record => record.webContentsId === details.webContentsId);
      const allowed = owner?.owner === activeDocument?.owner && details.url === activeDocument?.url
        && [COMPATIBILITY_HOST, COMPATIBILITY_CHILD].includes(details.url)
        && details.resourceType === 'mainFrame' && details.method === 'GET';
      callback({ cancel: !allowed }); if (!allowed) fail('COMPATIBILITY_UNEXPECTED_REQUEST');
    });
    await bounded(Promise.resolve(targetSession.protocol.handle('app', async request => {
      if (![COMPATIBILITY_HOST, COMPATIBILITY_CHILD].includes(request.url) || activeDocument?.url !== request.url) {
        fail('COMPATIBILITY_PROTOCOL_OWNER'); return new Response('', { status: 403 });
      }
      if (request.url === COMPATIBILITY_HOST) {
        const started = now(); await pause(75);
        if (stopping) return new Response('', { status: 403 });
        report.heldResponse.observedMs = now() - started;
        report.heldResponse.released = true;
      }
      return new Response('<!doctype html><title>Startup compatibility fixture</title>', { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      } });
    })));
    begin('committed-blank'); expectedCreation = 'blank';
    const blank = new BrowserWindow({ show: false, webPreferences: preferences() }); bindWindow(owned.get(blank.webContents), blank);
    await bounded(blank.loadURL('about:blank')); await qualify(blank.webContents); await closeOwned(owned.get(blank.webContents));
    begin('held-host'); expectedCreation = 'host';
    const host = new BrowserWindow({ show: false, webPreferences: preferences() }); bindWindow(owned.get(host.webContents), host);
    await bounded(host.loadURL(COMPATIBILITY_HOST)); await qualify(host.webContents);
    begin('child-initial-blank'); popupAllowed = true;
    await bounded(host.webContents.executeJavaScript("window.open('about:blank', 'startup-owned-child') !== null"));
    await waitUntil(() => childWindow !== null); await qualify(childWindow.webContents);
    report.childBlank.started = true;
    const started = now(); await bounded(pause(75)); report.childBlank.observedMs = now() - started;
    check();
    begin('child-navigated');
    await bounded(childWindow.loadURL(COMPATIBILITY_CHILD)); await qualify(childWindow.webContents);
    await closeOwned(owned.get(childWindow.webContents)); await closeOwned(owned.get(host.webContents));
  } catch (error) { fail(/^COMPATIBILITY_[A-Z_]+$/.test(error?.code) ? error.code : 'COMPATIBILITY_OPERATION_FAILED'); }
  finally {
    stopping = true;
    for (const record of owned.values()) {
      if (!record.closed && record.window) {
        try { record.closing = true; removeConsoleObserver(record); record.window.destroy(); } catch { fail('COMPATIBILITY_WINDOW_CLEANUP'); }
      }
    }
    for (const contents of unexpected) { try { if (!contents.isDestroyed()) contents.close(); } catch { fail('COMPATIBILITY_WINDOW_CLEANUP'); } }
    for (const { emitter, event, listener } of [...listeners].reverse()) {
      try { emitter.removeListener(event, listener); } catch { fail('COMPATIBILITY_LISTENER_CLEANUP'); }
    }
    report.cleanup.listenersRemaining = listeners.filter(({ emitter, event, listener }) => {
      try { return emitter.listeners(event).includes(listener); } catch { return true; }
    }).length;
    if (report.cleanup.listenersRemaining) fail('COMPATIBILITY_LISTENERS_REMAIN');
    if (targetSession) {
      try {
        targetSession.protocol.unhandle('app'); targetSession.webRequest.onBeforeRequest(null);
        targetSession.setPermissionRequestHandler(null); targetSession.setPermissionCheckHandler(null);
        report.cleanup.protocolRemoved = true;
      } catch { fail('COMPATIBILITY_SESSION_CLEANUP'); }
    }
    report.windows = [...owned.values()].map(({ owner, webContentsId, closed }) => ({ owner, webContentsId, closed }));
    report.cleanup.windowsRemaining = [...owned.values()].filter(record => !record.closed).length
      + [...unexpected].filter(contents => !contents.isDestroyed()).length;
    if (report.cleanup.windowsRemaining) fail('COMPATIBILITY_WINDOWS_REMAIN');
    report.fixtureComplete = report.failures.length === 0;
    if (report.fixtureComplete && !validateCompatibilityReport(report)) { fail('COMPATIBILITY_EVIDENCE_INVALID'); report.fixtureComplete = false; }
  }
  return report;
}
