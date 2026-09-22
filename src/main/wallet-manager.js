import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserWindow, dialog } from 'electron';
import { IPC, WALLET_ORIGIN, WALLET_PARTITION } from '../shared/constants.js';
import { AppError } from '../shared/errors.js';
import { inspectPsbt } from './psbt-inspector.js';
import { sanitizeJson } from '../shared/validation.js';

function publicWalletState(value) {
  if (!value || typeof value !== 'object') return { connected: false, walletId: null, walletName: null, accounts: [], connectedAt: null };
  const walletId = typeof value.walletId === 'string' && value.walletId.length > 0 && value.walletId.length <= 120
    ? value.walletId
    : null;
  const accounts = [];
  if (Array.isArray(value.accounts)) {
    const scanLimit = Math.min(value.accounts.length, 200);
    for (let index = 0; index < scanLimit && accounts.length < 20; index += 1) {
      const account = value.accounts[index];
      if (!account || typeof account !== 'object' || Array.isArray(account)) continue;
      const address = typeof account.address === 'string' ? account.address.slice(0, 128) : '';
      if (!address) continue;
      accounts.push({
        address,
        publicKey: typeof account.publicKey === 'string' && account.publicKey ? account.publicKey.slice(0, 256) : null,
        purpose: typeof account.purpose === 'string' && account.purpose ? account.purpose.slice(0, 50) : null,
        addressType: typeof account.addressType === 'string' && account.addressType ? account.addressType.slice(0, 50) : null,
        network: typeof account.network === 'string' && account.network ? account.network.slice(0, 50) : null
      });
    }
  }
  if (!value.connected || !walletId || accounts.length === 0) {
    return { connected: false, walletId: null, walletName: null, accounts: [], connectedAt: null };
  }
  return {
    connected: true,
    walletId,
    walletName: typeof value.walletName === 'string' && value.walletName ? value.walletName.slice(0, 120) : null,
    accounts,
    connectedAt: typeof value.connectedAt === 'string' && value.connectedAt ? value.connectedAt.slice(0, 80) : null
  };
}

function publicWalletDescriptors(value) {
  if (!Array.isArray(value)) return [];
  const wallets = [];
  const seen = new Set();
  const scanLimit = Math.min(value.length, 500);
  for (let index = 0; index < scanLimit && wallets.length < 50; index += 1) {
    const wallet = value[index];
    if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) continue;
    const id = typeof wallet.id === 'string' && wallet.id.length <= 120 ? wallet.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    wallets.push({
      id,
      name: typeof wallet.name === 'string' && wallet.name ? wallet.name.slice(0, 120) : id,
      kind: typeof wallet.kind === 'string' && wallet.kind ? wallet.kind.slice(0, 80) : 'unknown',
      icon: typeof wallet.icon === 'string' && wallet.icon.startsWith('data:image/') ? wallet.icon.slice(0, 200_000) : null
    });
  }
  return wallets;
}

export class WalletManager {
  constructor(options) {
    this.walletSession = options.walletSession;
    this.preloadPath = options.preloadPath;
    this.iconPath = options.iconPath;
    this.stateStore = options.stateStore;
    this.logger = options.logger;
    this.extensionManager = options.extensionManager;
    this.mainWindow = options.mainWindow;
    this.window = null;
    this.bridgeGeneration = 0;
    this.connectionRevision = 0;
    this.extensionsChanging = false;
    this.extensionChange = null;
    this.extensionRecovery = null;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.shutdownError = null;
    this.opening = null;
    this.bridgeWaiters = new Set();
    this.retiredWindows = new Set();
    this.persisting = new Set();
    this.ready = false;
    this.pending = new Map();
    this.discovered = [];
    // Connection authority is live renderer state. Persisted accounts from a
    // previous process may be stale or refer to a removed extension.
    this.state = publicWalletState(null);
    this.signingEnabled = options.signingEnabled === true;
  }

  async open(show = true) {
    this.#assertAvailable();
    return this.#open(show);
  }

  async #open(show, lease = null) {
    this.#assertAvailable(lease);
    if (this.window && !this.window.isDestroyed()) {
      const window = this.window;
      const generation = this.bridgeGeneration;
      if (this.opening?.window === window) await this.opening.promise;
      this.#assertAvailable(lease);
      this.#assertBridge(window, generation);
      if (show) window.show();
      return window;
    }
    this.ready = false;
    const walletWindow = new BrowserWindow({
      width: 520,
      height: 690,
      minWidth: 420,
      minHeight: 560,
      show: false,
      parent: this.mainWindow?.() ?? undefined,
      modal: false,
      title: 'Wallet Bridge — Bitcoin Browser',
      icon: this.iconPath,
      backgroundColor: '#0b0d10',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        partition: WALLET_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false
      }
    });
    this.window = walletWindow;
    this.bridgeGeneration += 1;
    const generation = this.bridgeGeneration;
    walletWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    walletWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${WALLET_ORIGIN}/`)) event.preventDefault();
    });
    walletWindow.webContents.on('render-process-gone', (_event, details) => {
      if (this.window !== walletWindow) return;
      this.#bridgeLost(new AppError('WALLET_BRIDGE_CRASHED', `Wallet bridge renderer exited: ${details.reason}`, { status: 503 }));
    });
    walletWindow.on('closed', () => {
      if (this.window !== walletWindow) return;
      this.#bridgeLost(new AppError('WALLET_BRIDGE_CLOSED', 'Wallet bridge was closed', { status: 499 }));
    });
    const opening = { window: walletWindow, promise: null };
    this.opening = opening;
    // Register cancellation before loadURL can synchronously trigger a lifecycle
    // event. A late native promise settlement must never show an obsolete bridge.
    opening.promise = this.#waitForBridge(walletWindow, generation, (resolve, reject) => {
      try { Promise.resolve(walletWindow.loadURL(`${WALLET_ORIGIN}/index.html`)).then(resolve, reject); }
      catch (error) { reject(error); }
    }, false);
    try {
      await opening.promise;
      this.#assertAvailable(lease);
      this.#assertBridge(walletWindow, generation);
      if (show) walletWindow.show();
      return walletWindow;
    } catch (error) {
      if (this.window === walletWindow) this.#bridgeLost(error);
      throw error;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  handleReady(sender) {
    if (this.shuttingDown || !this.window || this.window.isDestroyed() || sender.id !== this.window.webContents.id) return false;
    this.ready = true;
    for (const waiter of [...this.bridgeWaiters]) if (waiter.ready) waiter.resolve();
    sender.send(IPC.WALLET_BRIDGE_COMMAND, { requestId: null, action: 'refresh', payload: { extensionCount: this.extensionManager.list().filter((extension) => extension.loaded).length } });
    return true;
  }

  async handleBridgeEvent(sender, event) {
    if (this.shuttingDown || !this.window || this.window.isDestroyed() || sender.id !== this.window.webContents.id || !event || typeof event !== 'object') return false;
    if (event.type === 'discovered') {
      const previousIds = new Set(this.discovered.map((wallet) => wallet.id));
      const discovered = publicWalletDescriptors(event.wallets);
      const nextIds = new Set(discovered.map((wallet) => wallet.id));
      const removedPendingConnect = [...this.pending.values()].some((pending) => (
        pending.action === 'connect' && previousIds.has(pending.walletId) && !nextIds.has(pending.walletId)
      ));
      this.discovered = discovered;
      if (removedPendingConnect) {
        ++this.connectionRevision;
        this.#rejectConnectionCommands(new AppError('WALLET_PROVIDER_CHANGED', 'Selected wallet was removed before connection completed', { status: 409, retryable: true }));
      }
      this.#notify();
      return true;
    }
    if (event.type === 'state') {
      if (this.extensionsChanging || this.extensionRecovery) return false;
      const error = this.#connectionChangedError();
      const revision = ++this.connectionRevision;
      this.#rejectConnectionCommands(error);
      const state = publicWalletState(event.state);
      this.state = state;
      await this.#persistState(state);
      if (revision === this.connectionRevision) this.#notify();
      return true;
    }
    if (event.type === 'result') {
      const pending = this.pending.get(event.requestId);
      if (!pending) return false;
      this.pending.delete(event.requestId);
      clearTimeout(pending.timer);
      if (event.ok) pending.resolve(sanitizeJson(event.result, { maxDepth: 12, maxKeys: 10_000 }));
      else pending.reject(new AppError(event.error?.code ?? 'WALLET_ERROR', event.error?.message ?? 'Wallet request failed', { status: 502, details: sanitizeJson(event.error) }));
      return true;
    }
    return false;
  }

  snapshot() {
    return {
      state: this.state,
      discovered: this.discovered,
      extensions: this.extensionManager.list(),
      bridgeOpen: Boolean(this.window && !this.window.isDestroyed()),
      extensionsChanging: this.extensionsChanging,
      extensionRecovery: this.extensionRecovery ? { ...this.extensionRecovery } : null,
      signingEnabled: this.signingEnabled
    };
  }

  async discover() {
    this.#assertAvailable(null, true);
    if (this.extensionRecovery) return this.endExtensionChange(this.beginExtensionChange());
    await this.#discover();
    return this.snapshot();
  }

  async #discover(lease = null) {
    const window = await this.#open(false, lease);
    const generation = this.bridgeGeneration;
    await this.#waitUntilReady(window, generation);
    this.#assertAvailable(lease);
    this.#assertBridge(window, generation);
    window.webContents.send(IPC.WALLET_BRIDGE_COMMAND, { requestId: null, action: 'refresh', payload: { extensionCount: this.extensionManager.list().filter((extension) => extension.loaded).length } });
  }

  beginExtensionChange() {
    this.#assertAvailable(null, true);
    let finish;
    const token = Object.freeze({});
    const done = new Promise((resolve) => { finish = resolve; });
    this.extensionChange = { token, done, finish, settling: false };
    this.extensionsChanging = true;
    const error = new AppError('WALLET_EXTENSIONS_CHANGED', 'Wallet extensions changed before the request completed', { status: 409 });
    this.extensionRecovery = this.#recoveryDetails(error);
    const cleanupError = this.#invalidateBridge(error);
    if (cleanupError) {
      this.extensionRecovery = this.#recoveryDetails(cleanupError);
      this.#releaseExtensionChange(cleanupError);
      this.#notify();
      throw cleanupError;
    }
    return token;
  }

  async endExtensionChange(token, { refresh = true } = {}) {
    const change = this.extensionChange;
    if (!change || change.token !== token || change.settling) {
      throw new AppError('WALLET_EXTENSIONS_CHANGED', 'Wallet extension change lease is not active', { status: 409 });
    }
    change.settling = true;
    let failure;
    try {
      await this.#persistState(publicWalletState(null));
      if (refresh && !this.shuttingDown) await this.#discover(token);
      this.extensionRecovery = null;
    } catch (error) {
      if (error === this.shutdownError) {
        // Cancelling our own refresh is normal quit sequencing, not a failed
        // extension commit. Shutdown separately reports disposal/save failures.
        if (this.retiredWindows.size === 0) this.extensionRecovery = null;
      } else {
        failure = error;
        const cleanupError = this.#invalidateBridge(error);
        this.extensionRecovery = this.#recoveryDetails(cleanupError ?? error);
        throw error;
      }
    } finally {
      this.#releaseExtensionChange(failure);
      this.#notify();
    }
    return this.snapshot();
  }

  async extensionsChanged() {
    return this.endExtensionChange(this.beginExtensionChange());
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const change = this.extensionChange;
    const error = new AppError('WALLET_SHUTTING_DOWN', 'Wallet bridge is shutting down', { status: 409 });
    this.shutdownError = error;
    const cleanupError = this.#invalidateBridge(error);
    this.#persistState(publicWalletState(null));
    const leaseDrain = change?.done.then((failure) => { if (failure) throw failure; });
    this.shutdownPromise = Promise.allSettled([...this.persisting, leaseDrain]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (cleanupError) failures.push(cleanupError);
      if (failures.length) {
        this.extensionRecovery = this.#recoveryDetails(failures[0]);
        this.#notify();
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, 'Wallet shutdown did not drain cleanly');
      }
    });
    return this.shutdownPromise;
  }

  async connect(walletId) {
    if (typeof walletId !== 'string' || walletId.length === 0 || walletId.length > 120) {
      throw new AppError('VALIDATION_ERROR', 'Wallet id must contain 1-120 characters', { status: 400 });
    }
    this.#assertAvailable();
    const revision = ++this.connectionRevision;
    this.#rejectConnectionCommands(this.#connectionChangedError());
    const authority = { revision };
    const result = await this.#command('connect', { walletId }, 180_000, true, authority);
    if (revision !== this.connectionRevision || this.window !== authority.window || this.bridgeGeneration !== authority.generation || authority.window.isDestroyed()) {
      throw new AppError('WALLET_BRIDGE_UNAVAILABLE', 'Wallet bridge closed before the connection was established', { status: 503 });
    }
    const state = publicWalletState(result);
    if (!state.connected || state.walletId !== walletId) {
      throw new AppError('WALLET_INVALID_STATE', 'Wallet bridge returned state for a different wallet', { status: 502 });
    }
    this.state = state;
    await this.#persistState(state);
    if (revision !== this.connectionRevision) throw this.#connectionChangedError();
    this.#notify();
    return this.state;
  }

  async disconnect() {
    this.#assertAvailable();
    return this.#disconnect(this.#connectionChangedError(), true);
  }

  async signPsbt(input) {
    if (!this.signingEnabled) throw new AppError('FEATURE_DISABLED', 'Wallet signing is disabled in this beta build pending compatibility validation', { status: 403 });
    if (!this.state.connected) throw new AppError('WALLET_NOT_CONNECTED', 'Connect a wallet before signing', { status: 409 });
    const psbt = String(input.psbt ?? '').trim();
    const network = this.stateStore.get(['settings', 'network']);
    const preview = inspectPsbt(psbt, network);
    const lines = [
      `${preview.inputCount} input${preview.inputCount === 1 ? '' : 's'} → ${preview.outputCount} output${preview.outputCount === 1 ? '' : 's'}`,
      `Outputs: ${preview.totalOutput} sats`,
      preview.feeKnown ? `Fee: ${preview.fee} sats` : 'Fee: unknown — missing input data',
      ...preview.outputs.slice(0, 6).map((output) => `${output.value} sats → ${output.address ?? output.scriptType}`),
      ...(preview.outputs.length > 6 ? [`…and ${preview.outputs.length - 6} more outputs`] : []),
      ...preview.warnings
    ];
    const parent = this.mainWindow?.();
    const confirmation = await dialog.showMessageBox(parent ?? undefined, {
      type: preview.feeKnown && preview.unknownOutputCount === 0 ? 'question' : 'warning',
      buttons: ['Cancel', 'Continue to wallet'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Review PSBT signing request',
      message: 'Bitcoin Browser never signs this transaction. Your connected wallet will ask for final approval.',
      detail: lines.join('\n')
    });
    if (confirmation.response !== 1) throw new AppError('USER_REJECTED', 'Signing request was cancelled', { status: 499 });
    const result = await this.#command('signPsbt', {
      walletId: this.state.walletId,
      psbt,
      options: sanitizeJson(input.options ?? {}, { maxDepth: 4, maxKeys: 100 })
    }, 300_000, true);
    return { result, preview };
  }

  async signMessage(input) {
    if (!this.signingEnabled) throw new AppError('FEATURE_DISABLED', 'Wallet signing is disabled in this beta build pending compatibility validation', { status: 403 });
    if (!this.state.connected) throw new AppError('WALLET_NOT_CONNECTED', 'Connect a wallet before signing', { status: 409 });
    const message = String(input.message ?? '');
    const address = String(input.address ?? '').slice(0, 128);
    if (!message || message.length > 10_000) throw new AppError('VALIDATION_ERROR', 'Message must contain 1-10,000 characters', { status: 400 });
    const confirmation = await dialog.showMessageBox(this.mainWindow?.() ?? undefined, {
      type: 'question',
      buttons: ['Cancel', 'Continue to wallet'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Review message signing request',
      message: `Sign with ${address || 'the selected wallet account'}?`,
      detail: message.length > 1_000 ? `${message.slice(0, 1_000)}\n\n[message truncated in preview]` : message
    });
    if (confirmation.response !== 1) throw new AppError('USER_REJECTED', 'Message signing was cancelled', { status: 499 });
    return this.#command('signMessage', { walletId: this.state.walletId, message, address, protocol: input.protocol ?? null }, 180_000, true);
  }

  async #command(action, payload, timeoutMs, show, authority = null, existingOnly = false) {
    this.#assertAvailable();
    let window = this.window;
    let generation = this.bridgeGeneration;
    if (existingOnly) {
      if (!window || window.isDestroyed() || !this.ready) throw new AppError('WALLET_BRIDGE_UNAVAILABLE', 'Wallet bridge is not available', { status: 503 });
    } else {
      window = await this.open(show);
      generation = this.bridgeGeneration;
      await this.#waitUntilReady(window, generation);
    }
    this.#assertAvailable();
    this.#assertBridge(window, generation);
    if (authority?.revision !== undefined && authority.revision !== this.connectionRevision) throw this.#connectionChangedError();
    if (authority) {
      authority.window = window;
      authority.generation = generation;
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AppError('WALLET_TIMEOUT', 'Wallet did not respond before the request timed out', { status: 504, retryable: true }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, action, revision: authority?.revision, walletId: payload?.walletId ?? null });
      try {
        window.webContents.send(IPC.WALLET_BRIDGE_COMMAND, { requestId, action, payload });
        if (show) window.show();
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #waitUntilReady(window, generation) {
    return this.#waitForBridge(window, generation, (resolve) => { if (this.ready) resolve(); }, true);
  }

  #waitForBridge(window, generation, start, ready) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.bridgeWaiters.delete(waiter);
        if (!error) {
          try { this.#assertBridge(window, generation); } catch (ownershipError) { error = ownershipError; }
        }
        if (error) reject(error);
        else resolve();
      };
      const waiter = { ready, resolve: () => settle(), reject: (error) => settle(error) };
      this.bridgeWaiters.add(waiter);
      timer = setTimeout(() => settle(new AppError('WALLET_BRIDGE_TIMEOUT', ready ? 'Wallet bridge did not initialize' : 'Wallet bridge did not load', { status: 504, retryable: true })), 15_000);
      try {
        this.#assertBridge(window, generation);
        start(waiter.resolve, waiter.reject);
      } catch (error) { settle(error); }
    });
  }

  #persistState(state = this.state) {
    let operation;
    try {
      operation = Promise.resolve(this.stateStore.mutate((draft) => {
        draft.wallet = { ...state, accounts: state.accounts, connectedAt: state.connectedAt };
      }));
    } catch (error) { operation = Promise.reject(error); }
    this.persisting.add(operation);
    void operation.then(() => this.persisting.delete(operation), () => this.persisting.delete(operation));
    return operation;
  }

  #notify() {
    try {
      const window = this.mainWindow?.();
      if (window && !window.isDestroyed()) window.webContents.send(IPC.WALLET_STATE, this.snapshot());
    } catch (error) { this.#logResetFailure(error); }
  }

  #assertAvailable(lease = null, recovering = false) {
    if (this.shuttingDown) throw this.shutdownError;
    if (this.extensionsChanging && (!lease || lease !== this.extensionChange?.token)) {
      throw new AppError('WALLET_EXTENSIONS_CHANGED', 'Wallet extensions are changing', { status: 409, retryable: true });
    }
    if (this.extensionRecovery && !recovering && (!lease || lease !== this.extensionChange?.token)) {
      throw new AppError('WALLET_RECOVERY_REQUIRED', 'Refresh extensions and wallets before reconnecting', { status: 503, retryable: true });
    }
  }

  #assertBridge(window, generation) {
    if (this.shuttingDown) throw this.shutdownError;
    if (!window || this.window !== window || this.bridgeGeneration !== generation || window.isDestroyed()) {
      throw new AppError('WALLET_BRIDGE_UNAVAILABLE', 'Wallet bridge is no longer available', { status: 503, retryable: true });
    }
  }

  #releaseExtensionChange(error) {
    const change = this.extensionChange;
    this.extensionChange = null;
    this.extensionsChanging = false;
    change?.finish(error);
  }

  #recoveryDetails(error) {
    return { code: typeof error?.code === 'string' ? error.code : 'WALLET_REFRESH_FAILED', message: 'Wallet connection was cleared. Refresh extensions and wallets to recover.' };
  }

  #invalidateBridge(error) {
    const window = this.window;
    this.window = null;
    this.opening = null;
    ++this.bridgeGeneration;
    this.ready = false;
    ++this.connectionRevision;
    this.#rejectAll(error);
    for (const waiter of [...this.bridgeWaiters]) waiter.reject(error);
    this.state = publicWalletState(null);
    this.discovered = [];
    if (window) this.retiredWindows.add(window);
    this.#notify();
    const failures = [];
    for (const retired of this.retiredWindows) {
      try {
        if (!retired.isDestroyed()) retired.destroy();
        if (!retired.isDestroyed()) throw new Error('Wallet bridge remained open after destruction');
        this.retiredWindows.delete(retired);
      } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length) return new AppError('WALLET_BRIDGE_DISPOSAL_FAILED', 'Wallet bridge cleanup failed; connection remains revoked', {
      status: 503, retryable: true, cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Wallet bridge cleanup failed')
    });
    return null;
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #connectionChangedError() {
    return new AppError('WALLET_CONNECTION_CHANGED', 'Wallet connection changed before the request completed', { status: 409, retryable: true });
  }

  #rejectConnectionCommands(error) {
    for (const [requestId, pending] of this.pending) {
      if (pending.action !== 'connect' && pending.action !== 'disconnect') continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  async #disconnect(error, waitForRemote) {
    const previous = this.state;
    const hadPendingConnection = [...this.pending.values()].some((pending) => pending.action === 'connect' || pending.action === 'disconnect');
    const revision = ++this.connectionRevision;
    this.#rejectConnectionCommands(error);
    const state = publicWalletState(null);
    this.state = state;
    const persistence = this.#persistState(state);
    this.#notify();

    const window = this.window;
    const shouldSend = Boolean((previous.connected || hadPendingConnection) && this.ready && window && !window.isDestroyed());
    let remote = Promise.resolve();
    if (shouldSend) {
      remote = this.#command('disconnect', { walletId: previous.walletId }, 30_000, false, null, true)
        .catch(() => {});
    }
    await persistence;
    if (waitForRemote) await remote;
    else void remote;
    if (waitForRemote && revision !== this.connectionRevision) throw this.#connectionChangedError();
    return state;
  }

  #bridgeLost(error) {
    const cleanupError = this.#invalidateBridge(error);
    if (cleanupError) this.extensionRecovery = this.#recoveryDetails(cleanupError);
    void this.#persistState()
      .catch((persistError) => {
        this.extensionRecovery = this.#recoveryDetails(persistError);
        this.#notify();
        this.#logResetFailure(persistError);
      });
  }

  #logResetFailure(error) {
    try { void Promise.resolve(this.logger?.warn('wallet.state_reset_failed', { message: error.message })).catch(() => {}); } catch {}
  }
}
