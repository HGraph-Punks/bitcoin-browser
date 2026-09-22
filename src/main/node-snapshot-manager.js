import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AppError } from '../shared/errors.js';
import { isQuickStart, parseCoreChainstates, SNAPSHOT_RECOMMENDED_FREE_BYTES } from '../shared/node-snapshot.js';
import { inspectSnapshotFile } from './node-snapshot-file.js';

const error = (code, message) => new AppError(code, message, { status: 409 });
const LIMIT = { timeoutMs: 5_000, maxBytes: 64 * 1024 };
const UNKNOWN = 'The import outcome is not confirmed. Core may still be working. Refresh status; do not retry automatically. If no snapshot appears, stop and restart managed Core before choosing a file again.';

export class NodeSnapshotManager {
  constructor(owner) { this.owner = owner; this.selection = null; this.operation = null; this.observer = null; this.feedback = null; this.activeSetupId = null; }
  record(id) {
    if (typeof id !== 'string' || !id || id.length > 100) throw error('NODE_SNAPSHOT_SETUP_REQUIRED', 'Select the current saved setup.');
    const record = this.owner.saved(id);
    if (!record || !isQuickStart(record.plan.draft)) throw error('NODE_SNAPSHOT_SETUP_REQUIRED', 'Save a Quick-start compact mainnet setup first.');
    this.owner.assertRunning(); this.owner.assertOwned(record);
    return record;
  }
  guard(record) {
    const current = this.record(record.id);
    if (current.planHash !== record.planHash) throw error('NODE_SETUP_CHANGED', 'The selected setup changed.');
    if (this.owner.stateStore.get(['settings', 'offlineMode'])) throw error('NODE_SETUP_OFFLINE', 'Go online to communicate with local Core. Browser offline mode does not stop Core importing or syncing.');
    const service = this.owner.localServiceManager.list().find(row => row.id === record.plan.core.serviceId);
    const owned = this.owner.localServiceManager.processes.get(record.plan.core.serviceId);
    if (service?.status !== 'running' || !Number.isSafeInteger(service.pid) || service.pid <= 0 || owned?.pid !== service.pid) throw error('NODE_SNAPSHOT_CORE_STOPPED', 'Start the app-managed Core process before selecting or importing a snapshot.');
    return service.pid;
  }
  async preflight(record, file) {
    const pid = this.guard(record);
    await this.owner.assertFiles(record); this.guard(record);
    const core = this.owner.coreFactory(this.owner.coreConfig(record.plan));
    const opts = { ...LIMIT, signal: this.owner.controller.signal };
    const rpc = async (method, params = []) => {
      const value = (await core.rpc(method, params, opts)).result;
      if (this.guard(record) !== pid) throw error('NODE_SNAPSHOT_PROCESS_CHANGED', 'Core restarted during the snapshot check. Choose the file again.');
      return value;
    };
    const version = await rpc('getnetworkinfo');
    if (!Number.isSafeInteger(version?.version) || version.version < 310000 || version.version >= 320000) throw error('NODE_SNAPSHOT_VERSION', 'This workflow is reviewed for Bitcoin Core 31.x. Choose the supported Core program.');
    const info = await rpc('getblockchaininfo');
    if (info?.chain !== 'main' || info.pruned !== true) throw error('NODE_SNAPSHOT_CORE_MODE', 'Quick start requires a mainnet Core process running in compact (pruned) mode.');
    const chain = parseCoreChainstates(await rpc('getchainstates'));
    if (chain.hasSnapshot) throw error('NODE_SNAPSHOT_ALREADY_LOADED', 'Core already has a snapshot. Follow its current and historical validation progress.');
    const prior = this.owner.saved(record.id).snapshotAttempt;
    if (prior?.pid === pid) throw error('NODE_SNAPSHOT_OUTCOME_UNKNOWN', UNKNOWN);
    if (file) {
      if (chain.active.blocks >= file.baseHeight) throw error('NODE_SNAPSHOT_NOT_NEEDED', 'Core has already reached this snapshot height through normal sync. Choose a newer supported snapshot or continue normal sync.');
      if (chain.headers < file.baseHeight) throw error('NODE_SNAPSHOT_HEADERS_PENDING', 'Core is still downloading block headers. Wait, refresh status, then load this snapshot.');
      const header = await rpc('getblockheader', [file.baseHash]);
      if (header?.hash !== file.baseHash || header.height !== file.baseHeight) throw error('NODE_SNAPSHOT_BASE_MISMATCH', 'Core could not confirm the selected snapshot base header.');
    }
    return { pid, core };
  }
  async select(id) {
    if (this.operation) throw error('NODE_SNAPSHOT_BUSY', 'A snapshot import is already being observed.');
    this.selection = null;
    const record = this.record(id); this.guard(record);
    const selected = await this.owner.pick('snapshot');
    this.guard(record);
    if (!selected?.path) return { selection: null };
    const file = await inspectSnapshotFile(selected.path); this.guard(record);
    const token = crypto.randomUUID();
    this.selection = { token, setupId: id, planHash: record.planHash, file, expires: this.owner.now() + 15 * 60_000 };
    return { selection: { token, name: file.name, bytes: file.bytes, baseHeight: file.baseHeight, baseHash: file.baseHash,
      message: 'Header recognized only. Core must verify the complete UTXO commitment during import.' } };
  }
  async persist(record, attempt) {
    await this.owner.stateStore.mutate(state => {
      if (state.nodeSetup?.id !== record.id || state.nodeSetup.planHash !== record.planHash) throw error('NODE_SETUP_CHANGED', 'The saved setup changed during import.');
      state.nodeSetup.snapshotAttempt = attempt;
    });
  }
  async load(id, token) {
    if (this.operation) throw error('NODE_SNAPSHOT_BUSY', 'A snapshot import is already being observed.');
    const record = this.record(id), selection = this.selection;
    if (!selection || token !== selection.token || selection.setupId !== id || selection.planHash !== record.planHash || this.owner.now() > selection.expires) throw error('NODE_SNAPSHOT_SELECTION_EXPIRED', 'Choose the snapshot file again before importing.');
    const checkFile = async () => {
      const actual = await inspectSnapshotFile(selection.file.path);
      if (JSON.stringify(actual) !== JSON.stringify(selection.file)) throw error('NODE_SNAPSHOT_FILE_CHANGED', 'The selected snapshot file changed. Choose it again.');
    };
    await checkFile();
    await this.preflight(record, selection.file);
    const checkDisk = async () => {
      let availableBytes = null;
      try { const disk = await fs.statfs(record.plan.summary.coreDataDirectory); availableBytes = disk.bavail * disk.bsize; } catch {}
      if (availableBytes !== null && availableBytes < Math.max(2 * 1024 ** 3, selection.file.bytes * 2)) throw error('NODE_SNAPSHOT_DISK_LOW', 'Not enough snapshot workspace: free at least twice the snapshot size (and at least 2 GiB). Actual usage may be higher; 60 GiB free is recommended.');
      return availableBytes;
    };
    const availableBytes = await checkDisk();
    if (!await this.owner.confirm('snapshot', { ...selection.file, network: 'mainnet', availableBytes, recommendedBytes: SNAPSHOT_RECOMMENDED_FREE_BYTES })) throw error('USER_REJECTED', 'Snapshot import was cancelled.');
    if (this.selection !== selection || this.owner.now() > selection.expires) throw error('NODE_SNAPSHOT_SELECTION_EXPIRED', 'Snapshot selection expired. Choose it again.');
    await checkFile();
    await checkDisk();
    const { core, pid } = await this.preflight(record, selection.file);
    const attempt = { phase: 'loading', pid, baseHeight: selection.file.baseHeight, baseHash: selection.file.baseHash, startedAt: new Date(this.owner.now()).toISOString() };
    // Persist intent BEFORE dispatch. A lost reply/restart must never replay a
    // mutating RPC silently. No local snapshot path is retained in app state.
    await this.persist(record, attempt);
    this.selection = null;
    if (this.guard(record) !== pid) throw error('NODE_SNAPSHOT_PROCESS_CHANGED', 'Core restarted before import. Choose the file again.');
    this.observer = new AbortController();
    this.activeSetupId = record.id;
    const signal = AbortSignal.any([this.owner.controller.signal, this.observer.signal]);
    this.feedback = { phase: 'loading', message: 'Core is importing and checking the snapshot. This can take several minutes; you can keep browsing. No percentage is available during import.' };
    const operation = this.owner.track(async () => {
      let outcome;
      try {
        const loaded = (await core.rpc('loadtxoutset', [selection.file.path], { timeoutMs: 30 * 60_000, maxBytes: 64 * 1024, signal })).result;
        if (signal.aborted || this.guard(record) !== pid || loaded?.tip_hash !== attempt.baseHash || loaded.base_height !== attempt.baseHeight
          || !Number.isSafeInteger(loaded.coins_loaded) || loaded.coins_loaded <= 0 || String(loaded.coins_loaded) !== selection.file.coins) throw error('NODE_SNAPSHOT_RESULT_UNKNOWN', UNKNOWN);
        outcome = { ...attempt, phase: 'accepted' };
        this.feedback = { phase: 'accepted', message: 'Core accepted the snapshot commitment. Historical validation is not complete until Core reports it below.' };
      } catch {
        outcome = { ...attempt, phase: 'unknown' };
        this.feedback = { phase: 'unknown', message: UNKNOWN };
      }
      try { await this.persist(record, outcome); }
      catch { this.feedback = { phase: 'unknown', message: 'Import status could not be saved. Refresh Core status; do not automatically retry the import.' }; }
    });
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) { this.operation = null; this.observer = null; } }).catch(() => {});
    return { snapshot: { ...this.feedback } };
  }
  status(record) {
    if (this.activeSetupId === record.id && this.feedback) return { ...this.feedback };
    const phase = record.snapshotAttempt?.phase;
    return phase ? { phase: phase === 'accepted' ? 'accepted' : 'unknown', message: phase === 'accepted'
      ? 'A snapshot was accepted previously. Refresh Core status to check historical validation.' : UNKNOWN }
      : { phase: 'not-loaded', message: 'Start Core, allow its headers to synchronize, then choose a supported snapshot. You can also let normal compact synchronization continue.' };
  }
  abortObservation() {
    this.selection = null;
    this.observer?.abort(error('NODE_SNAPSHOT_OBSERVATION_STOPPED', 'RPC observation stopped; this does not cancel Core’s import.'));
  }
}
