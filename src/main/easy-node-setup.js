import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { validateProviderMutation } from '../shared/validation.js';
import { buildNodeSetupPlan, defaultNodeSetupDraft } from './node-setup-plan.js';
import { inspectNodeCapacity, recommendEasyNode } from './node-capacity.js';

const fail = (code, message, details) => new AppError(code, message, { status: 409, details });

// One native consent covers ONLY this main-owned, fixed compact-mainnet plan.
// Renderer requests cannot supply programs, commands, sources, or consent flags.
export class EasyNodeSetup {
  constructor(manager, inspectCapacity = inspectNodeCapacity) {
    this.manager = manager; this.inspectCapacity = inspectCapacity; this.record = null;
  }
  async recommendation(rootDirectory = this.manager.rootDirectory) {
    const capacity = await this.inspectCapacity(rootDirectory);
    return recommendEasyNode(capacity, { descriptor: this.manager.software.catalog().core,
      settings: this.manager.stateStore.get(['settings']), existing: Boolean(this.manager.stateStore.get(['nodeSetup'])) });
  }
  async prepare({ rootDirectory = this.manager.rootDirectory, autoStart = false }) {
    const m = this.manager;
    if (typeof autoStart !== 'boolean') throw fail('INVALID_NODE_SETUP', 'Invalid automatic-start choice.');
    const recommendation = await this.recommendation(rootDirectory);
    if (!recommendation.eligible) throw fail('EASY_NODE_REVIEW_REQUIRED', recommendation.reasons.join(' '));
    const descriptor = structuredClone(m.software.catalog().core);
    const draft = defaultNodeSetupDraft({ rootDirectory: recommendation.rootDirectory, network: 'mainnet' });
    Object.assign(draft, { choice: 'core', autoStart });
    Object.assign(draft.core, { executable: m.software.destination('core'), storage: 'pruned', dbCacheMiB: recommendation.dbCacheMiB, validationThreads: recommendation.validationThreads });
    const plan = buildNodeSetupPlan(draft, { platform: m.platform });
    plan.providers = plan.providers.map(validateProviderMutation);
    await m.validateFresh(plan, { skipExecutableCheck: true });
    m.assertRunning();
    const token = crypto.randomUUID();
    this.record = { token, plan, descriptor, recommendation, network: m.stateStore.get(['settings', 'network']),
      expires: m.now() + 15 * 60_000, phase: 'review', controller: new AbortController(), canCancel: true };
    return { token };
  }
  current(token) {
    if (typeof token !== 'string' || !this.record || token !== this.record.token) throw fail('EASY_NODE_CHANGED', 'This setup is no longer current. Check your recommendation again.');
    return this.record;
  }
  status(token) {
    const record = this.current(token);
    return { phase: record.phase, canCancel: record.canCancel, setupId: record.setupId ?? null };
  }
  cancel(token) {
    const record = this.current(token);
    const cancelled = record.canCancel;
    if (cancelled) {
      record.controller.abort(fail('USER_REJECTED', 'Setup was cancelled before saving. No node was started. A verified program, if already downloaded, can be reused later.'));
      record.phase = 'cancelling'; record.canCancel = false;
    }
    return { cancelled, ...this.status(token) };
  }
  async check(record, signal) {
    const m = this.manager;
    signal.throwIfAborted(); m.assertRunning();
    const current = await this.recommendation(record.plan.draft.rootDirectory);
    signal.throwIfAborted(); m.assertRunning();
    if (!current.eligible) throw fail('EASY_NODE_REVIEW_REQUIRED', current.reasons.join(' '));
    if (current.rootDirectory !== record.plan.draft.rootDirectory) throw fail('NODE_SETUP_DIRECTORY_CHANGED', 'Storage was redirected. Choose your folder again.');
    if (m.stateStore.get(['settings', 'network']) !== record.network || JSON.stringify(m.software.catalog().core) !== JSON.stringify(record.descriptor)) {
      throw fail('EASY_NODE_CHANGED', 'The network or software selection changed. Review setup again.');
    }
    await m.validateFresh(record.plan, { skipExecutableCheck: true });
    signal.throwIfAborted();
  }
  async start(token) {
    const m = this.manager, record = this.current(token);
    if (record.phase !== 'review' || m.now() > record.expires) throw fail('NODE_SETUP_PREVIEW_EXPIRED', 'Check the recommendation again before starting setup.');
    const signal = AbortSignal.any([m.controller.signal, record.controller.signal]);
    record.phase = 'confirming'; m.downloads.add(record.controller);
    try {
      await this.check(record, signal);
      if (!await m.confirm('easy-start', { plan: record.plan, descriptor: record.descriptor, recommendation: record.recommendation })) {
        throw fail('USER_REJECTED', 'Setup was cancelled. Nothing was installed or started.');
      }
      await this.check(record, signal);
      record.phase = 'downloading';
      const installed = await m.software.install('core', { signal });
      await this.check(record, signal);
      if (installed?.executable !== record.plan.draft.core.executable) throw fail('EASY_NODE_CHANGED', 'The installed program did not match this setup. Review it in Customize setup.');
      await m.validateFresh(record.plan);
      signal.throwIfAborted();
      // Cancellation is no longer safe once persistence begins. From here,
      // failures preserve a resumable setup, never silently retry installation.
      record.canCancel = false; record.phase = 'saving';
      m.previewRecord = { token: record.token, plan: record.plan, expires: m.now() + 15 * 60_000 };
      const result = await m.apply(record.token, { consented: true });
      record.setupId = result.setupId; record.phase = 'starting';
      let status = null, startWarning = null;
      try {
        signal.throwIfAborted();
        status = await m.start(result.setupId, { consented: true });
      } catch {
        startWarning = 'Your setup is saved, but startup or its status check did not complete. Refresh status before trying Start services. Check Local node logs if it remains stopped; do not install again.';
      }
      record.phase = 'saved';
      return { ...result, status, startWarning, services: m.localServiceManager.list(), providers: m.providerManager.list(), settings: m.stateStore.get(['settings']) };
    } catch (cause) {
      record.phase = record.setupId || cause?.details?.setupCommitted ? 'saved' : 'failed';
      if (cause?.details?.setupId) record.setupId = cause.details.setupId;
      if (record.setupId && !cause?.details?.setupCommitted) throw fail('NODE_SETUP_SAVED_REFRESH_FAILED', 'Setup was saved, but its latest status could not be read. Resume it; do not install again.', { setupCommitted: true, setupId: record.setupId });
      throw cause;
    } finally { record.canCancel = false; m.downloads.delete(record.controller); }
  }
}
