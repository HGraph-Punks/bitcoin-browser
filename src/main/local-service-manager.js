import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../shared/errors.js';

export function localServiceEnvironment(environment, service, setup) {
  const guidedOrd = setup?.plan?.ord?.managed && setup.plan.ord.serviceId === service.id
    && setup.plan.services.some(expected => expected.id === service.id && JSON.stringify(expected) === JSON.stringify(service));
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE'].includes(key)
    && !(guidedOrd && key.startsWith('ORD_'))));
}

export function createQuitWatchdog(options) {
  const { app, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 12_000, onPhase = () => {} } = options;
  let timer = null;
  const emit = (phase) => {
    try { void Promise.resolve(onPhase(phase)).catch(() => {}); } catch {}
  };
  return {
    arm() {
      if (timer !== null) return false;
      timer = setTimer(() => {
        timer = null;
        emit('forced-fallback');
        app.exit(1);
      }, timeoutMs);
      return true;
    },
    clear() {
      if (timer === null) return false;
      clearTimer(timer);
      timer = null;
      return true;
    },
    isArmed() { return timer !== null; }
  };
}

export function createSignalShutdownHandler(options) {
  const { app, logger, consoleTarget = console, setTimer = setTimeout, now = Date.now, timeoutMs = 12_000, pid = process.pid } = options;
  let requested = false;
  return function requestSignalShutdown() {
    if (requested) return false;
    requested = true;
    const started = now();
    const phase = (name) => {
      const fields = { phase: name, pid, elapsedMs: Math.max(0, now() - started) };
      try { void Promise.resolve(logger?.info('app.shutdown', fields)).catch(() => consoleTarget.error('app.shutdown', fields)); }
      catch { consoleTarget.error('app.shutdown', fields); }
    };
    phase('signal-requested');
    // Arm before entering Electron's native quit path in case that call stalls.
    if (options.quitWatchdog) options.quitWatchdog.arm();
    else setTimer(() => {
      phase('forced-fallback');
      app.exit(1);
    }, timeoutMs);
    app.quit();
    return true;
  };
}

function safeService(input) {
  const executable = String(input.executable ?? '').trim();
  if (executable && !path.isAbsolute(executable)) throw new AppError('VALIDATION_ERROR', 'Service executable must be an absolute path', { status: 400 });
  const cwd = String(input.cwd ?? '').trim().slice(0, 4_096);
  if (cwd && !path.isAbsolute(cwd)) throw new AppError('VALIDATION_ERROR', 'Service working directory must be an absolute path', { status: 400 });
  const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg).slice(0, 4_096)).slice(0, 200) : [];
  if (args.some((arg) => arg.includes('\0'))) throw new AppError('VALIDATION_ERROR', 'Service arguments contain invalid data', { status: 400 });
  return {
    id: String(input.id ?? '').trim().slice(0, 80),
    name: String(input.name ?? 'Local service').trim().slice(0, 80),
    executable,
    args,
    cwd,
    autoStart: Boolean(input.autoStart),
    enabled: Boolean(input.enabled)
  };
}

export function handleServiceBeforeQuit(event, options) {
  const {
    app, localServiceManager, extensionManager, walletManager, defer = setImmediate, consoleTarget = console,
    timeoutMs = 12_000, logTimeoutMs = 500
  } = options;
  const shutdown = options.shutdown ?? (() => {
    const operations = [];
    try { operations.push(Promise.resolve(walletManager?.shutdown())); } catch (error) { operations.push(Promise.reject(error)); }
    try { operations.push(Promise.resolve(extensionManager?.shutdown())); } catch (error) { operations.push(Promise.reject(error)); }
    try { operations.push(Promise.resolve(localServiceManager?.shutdown())); } catch (error) { operations.push(Promise.reject(error)); }
    return Promise.allSettled(operations).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Application lifecycle shutdown failed');
    });
  });
  if (!localServiceManager && !extensionManager && !walletManager && !options.shutdown) return false;
  if (app.__servicesShutdownComplete) return false;
  if (app.__servicesStopping) {
    event.preventDefault();
    return true;
  }
  event.preventDefault();
  app.__servicesStopping = true;
  const started = (options.now ?? Date.now)();
  const phase = options.onPhase ?? (() => {});
  const emitPhase = (name, elapsedMs) => {
    try { void Promise.resolve(phase(name, elapsedMs)).catch(() => {}); } catch {}
  };
  emitPhase('before-quit-start', 0);
  const logger = options.logger ?? localServiceManager?.logger;
  let shutdownResult;
  try { shutdownResult = shutdown(); } catch (error) { shutdownResult = Promise.reject(error); }
  const operationTimeoutMs = Math.max(1, timeoutMs - logTimeoutMs);
  let shutdownTimer;
  const boundedShutdown = Promise.race([
    Promise.resolve(shutdownResult),
    new Promise((_, reject) => {
      shutdownTimer = setTimeout(() => reject(new AppError('SHUTDOWN_TIMEOUT', 'Application shutdown timed out', { status: 500 })), operationTimeoutMs);
      shutdownTimer.unref?.();
    })
  ]).finally(() => clearTimeout(shutdownTimer));
  boundedShutdown.then(
    () => {
      app.__servicesShutdownComplete = true;
      app.__servicesStopping = false;
      defer(() => {
        emitPhase('retry-quit', Math.max(0, (options.now ?? Date.now)() - started));
        app.quit();
        emitPhase('retry-quit-returned', Math.max(0, (options.now ?? Date.now)() - started));
      });
    },
    (error) => {
      consoleTarget.error('Application shutdown failed:', error);
      let logResult;
      try { logResult = logger?.error('service.shutdown_failed', { message: error.message }); } catch (logError) { logResult = Promise.reject(logError); }
      let logTimer;
      const logged = Promise.race([
        Promise.resolve(logResult),
        new Promise((resolve) => {
          logTimer = setTimeout(resolve, logTimeoutMs);
          logTimer.unref?.();
        })
      ]).finally(() => clearTimeout(logTimer));
      void logged
        .catch(() => {})
        .finally(() => {
          defer(() => {
            options.quitWatchdog?.clear();
            app.exit(1);
          });
        });
    }
  );
  return true;
}

export async function settleShutdownStages(lifecyclePromises, persistenceTasks = [], finalTasks = [], options = {}) {
  const failures = [];
  const collect = (results) => {
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
  };
  const observe = async (phase) => {
    try { await options.onPhase?.(phase); } catch {}
  };
  // Attach handlers to all already-started lifecycle work before awaiting any
  // one member, so an early rejection cannot become temporarily unhandled.
  const lifecycleResults = Promise.allSettled(lifecyclePromises.map((promise) => Promise.resolve(promise)));
  collect(await lifecycleResults);
  await observe('lifecycle-drain-done');
  const run = (tasks) => Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  collect(await run(persistenceTasks));
  await observe('persistence-done');
  collect(await run(finalTasks));
  await observe('logger-done');
  if (failures.length) throw new AggregateError(failures, 'Application shutdown did not drain cleanly');
}

export function shutdownApplicationManagers(options = {}) {
  const immediateFailures = [];
  const invoke = (action) => {
    try { return action?.(); } catch (error) { immediateFailures.push(error); return undefined; }
  };
  const startupDrain = invoke(options.shutdownStartup);
  const nodeSetupDrain = invoke(options.shutdownNodeSetup);
  const providerDrain = invoke(options.shutdownProvider);
  const ipcDrain = invoke(options.shutdownIpc);
  const walletDrain = invoke(options.shutdownWallet);
  const boundsDrain = invoke(options.flushBounds);
  const serviceDrain = invoke(options.shutdownServices);
  const extensionDrain = invoke(options.shutdownExtensions);
  return settleShutdownStages(
    [...immediateFailures.map((error) => Promise.reject(error)), startupDrain, nodeSetupDrain, providerDrain, ipcDrain, walletDrain, boundsDrain, serviceDrain, extensionDrain],
    options.persistenceTasks ?? [],
    options.finalTasks ?? [],
    { onPhase: options.onPhase }
  );
}

export class LocalServiceManager {
  constructor(stateStore, logger, onChange = () => {}) {
    this.stateStore = stateStore;
    this.logger = logger;
    this.onChange = onChange;
    this.processes = new Map();
    this.logs = new Map();
    this.statuses = new Map();
    this.starting = new Map();
    this.autoStartRequests = new WeakSet();
    this.stopping = new Map();
    this.removing = new Map();
    this.editing = new Map();
    this.completions = new WeakMap();
    this.stopRequests = new WeakMap();
    this.shuttingDown = false;
    this.shutdownPromise = null;
  }

  list() {
    return (this.stateStore.get(['localServices']) ?? []).map((service) => ({
      ...service,
      status: this.statuses.get(service.id)?.status ?? (this.processes.has(service.id) ? 'running' : 'stopped'),
      pid: this.processes.get(service.id)?.pid ?? null,
      error: this.statuses.get(service.id)?.error ?? null,
      exitCode: this.statuses.get(service.id)?.exitCode ?? null,
      signal: this.statuses.get(service.id)?.signal ?? null,
      forcedTerminationRequested: this.statuses.get(service.id)?.forcedTerminationRequested ?? false,
      logs: (this.logs.get(service.id) ?? []).slice(-100)
    }));
  }

  upsert(input) {
    let service;
    try { service = safeService(input); } catch (error) { return Promise.reject(error); }
    if (!service.id) return Promise.reject(new AppError('VALIDATION_ERROR', 'Service id is required', { status: 400 }));
    if (this.shuttingDown) return Promise.reject(new AppError('SERVICE_SHUTTING_DOWN', 'Local services are shutting down', { status: 409 }));
    if (this.removing.has(service.id)) return Promise.reject(new AppError('SERVICE_REMOVING', 'The service is being removed', { status: 409 }));
    if (this.editing.has(service.id)) return Promise.reject(new AppError('SERVICE_EDITING', 'The service configuration is being edited', { status: 409 }));
    if (this.processes.has(service.id) || this.starting.has(service.id) || this.stopping.has(service.id)) {
      return Promise.reject(new AppError('SERVICE_RUNNING', 'Stop the service before editing its configuration', { status: 409 }));
    }
    const editing = this.#upsert(service);
    this.editing.set(service.id, editing);
    void editing.finally(() => {
      if (this.editing.get(service.id) === editing) this.editing.delete(service.id);
    }).catch(() => {});
    return editing;
  }

  async #upsert(service) {
    await this.stateStore.mutate((draft) => {
      const index = draft.localServices.findIndex((item) => item.id === service.id);
      if (index >= 0) draft.localServices[index] = service;
      else draft.localServices.push(service);
    });
    return service;
  }

  remove(id) {
    const pending = this.removing.get(id);
    if (pending) return pending;
    if (this.shuttingDown) return Promise.reject(new AppError('SERVICE_SHUTTING_DOWN', 'Local services are shutting down', { status: 409 }));
    if (this.editing.has(id)) return Promise.reject(new AppError('SERVICE_EDITING', 'The service configuration is being edited', { status: 409 }));
    const removing = this.#remove(id);
    this.removing.set(id, removing);
    void removing.finally(() => {
      if (this.removing.get(id) === removing) this.removing.delete(id);
    }).catch(() => {});
    return removing;
  }

  async #remove(id) {
    const starting = this.starting.get(id);
    if (starting) {
      try { await starting; } catch {}
    }
    await this.stop(id);
    await this.stateStore.mutate((draft) => { draft.localServices = draft.localServices.filter((item) => item.id !== id); });
    this.logs.delete(id);
    this.statuses.delete(id);
  }

  start(id) {
    if (this.shuttingDown) return Promise.reject(new AppError('SERVICE_SHUTTING_DOWN', 'Local services are shutting down', { status: 409 }));
    if (this.removing.has(id)) return Promise.reject(new AppError('SERVICE_REMOVING', 'The service is being removed', { status: 409 }));
    if (this.editing.has(id)) return Promise.reject(new AppError('SERVICE_EDITING', 'The service configuration is being edited', { status: 409 }));
    if (this.stopping.has(id)) return Promise.reject(new AppError('SERVICE_STOPPING', 'Wait for the current stop request to finish before starting this service', { status: 409 }));
    const pending = this.starting.get(id);
    if (pending) return pending;
    const starting = this.#start(id).catch((error) => {
      // Publish while this attempt still owns its reservation. Tagging the
      // promise also covers autostart joining an already-pending manual start.
      if (this.autoStartRequests.has(starting) && this.starting.get(id) === starting &&
          !this.shuttingDown && !this.removing.has(id) &&
          ['VALIDATION_ERROR', 'SERVICE_EXECUTABLE_MISSING', 'SERVICE_CWD_MISSING'].includes(error.code)) {
        this.statuses.set(id, { status: 'failed', error: error.message });
        // An observer must not replace the original start validation error.
        try { this.onChange(this.list()); } catch {}
      }
      throw error;
    });
    this.starting.set(id, starting);
    void starting.finally(() => {
      if (this.starting.get(id) === starting) this.starting.delete(id);
    }).catch(() => {});
    return starting;
  }

  async #start(id) {
    if (this.processes.has(id)) return this.status(id);
    const stored = (this.stateStore.get(['localServices']) ?? []).find((item) => item.id === id);
    if (!stored) throw new AppError('NOT_FOUND', 'Local service configuration not found', { status: 404 });
    const service = safeService(stored);
    if (!service.enabled) throw new AppError('SERVICE_DISABLED', 'Local service is disabled', { status: 409 });
    if (!service.executable) throw new AppError('SERVICE_NOT_CONFIGURED', 'Select the service executable first', { status: 409 });
    try {
      const stat = await fs.stat(service.executable);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new AppError('SERVICE_EXECUTABLE_MISSING', 'Configured service executable does not exist', { status: 404 });
    }
    const cwd = service.cwd || path.dirname(service.executable);
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError('SERVICE_CWD_MISSING', 'Configured service working directory does not exist', { status: 404 });
    }
    const append = (stream, chunk) => {
      const entries = this.logs.get(id) ?? [];
      entries.push({ time: new Date().toISOString(), stream, text: chunk.toString('utf8').slice(0, 16_384) });
      this.logs.set(id, entries.slice(-1_000));
      this.onChange(this.list());
    };
    append('system', Buffer.from('Starting process'));
    let child;
    try {
      child = spawn(service.executable, service.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: localServiceEnvironment(process.env, service, this.stateStore.get(['nodeSetup']))
      });
    } catch (error) {
      this.statuses.set(id, { status: 'failed', error: error.message });
      append('error', Buffer.from(error.message));
      throw new AppError('SERVICE_START_FAILED', `Service failed to start: ${error.message}`, { status: 500, details: { id } });
    }
    this.processes.set(id, child);
    this.statuses.set(id, { status: 'starting', error: null });
    child.stdout?.on('data', (chunk) => {
      if (this.processes.get(id) === child) append('stdout', chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (this.processes.get(id) === child) append('stderr', chunk);
    });
    let didSpawn = false;
    let startupReject;
    const started = new Promise((resolve, reject) => {
      startupReject = reject;
      child.once('spawn', () => {
        didSpawn = true;
        resolve();
      });
    });
    let closeResolve;
    const closed = new Promise((resolve) => { closeResolve = resolve; });
    this.completions.set(child, closed);
    let processError = null;
    child.once('error', (error) => {
      if (this.processes.get(id) !== child) return;
      processError = error;
      if (!didSpawn) this.processes.delete(id);
      this.statuses.set(id, { status: 'failed', error: error.message });
      append('error', Buffer.from(error.message));
      this.logger?.warn(didSpawn ? 'service.process_error' : 'service.start_failed', { id, message: error.message });
      if (!didSpawn) startupReject(error);
      this.onChange(this.list());
    });
    child.once('close', (code, signal) => {
      const request = this.stopRequests.get(child);
      const forcedTerminationRequested = request?.forcedTerminationRequested ?? false;
      const expectedSignal = request?.signalSent && code === null && signal === 'SIGTERM';
      const error = processError?.message || (forcedTerminationRequested
        ? 'Service did not exit within the stop deadline; forced termination was requested. Inspect its logs before restarting.'
        : (code === 0 && signal === null) || expectedSignal ? null
          : `Process exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}`);
      const result = { status: error ? 'failed' : 'stopped', error, exitCode: code, signal, forcedTerminationRequested };
      // Keep the result tied to this exact child, even after its map entry is
      // released. A subsequent start must never replace an admitted stop result.
      closeResolve(result);
      if (this.processes.get(id) !== child) return;
      this.processes.delete(id);
      this.statuses.set(id, result);
      append('system', Buffer.from(`Process exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}`));
      this.logger?.info('service.exit', { id, code, signal });
      this.onChange(this.list());
    });
    this.onChange(this.list());
    try {
      await started;
    } catch (error) {
      throw new AppError('SERVICE_START_FAILED', `Service failed to start: ${error.message}`, { status: 500, details: { id } });
    }
    if (this.processes.get(id) === child) this.statuses.set(id, { status: 'running', error: null });
    this.logger?.info('service.start', { id, executable: service.executable, args: service.args });
    this.onChange(this.list());
    return this.status(id);
  }

  stop(id) {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    let resolve; let reject;
    const stopping = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Reserve before publishing "stopping": an observer can synchronously
    // re-enter stop/start while that publication is in progress.
    this.stopping.set(id, stopping);
    void stopping.finally(() => {
      if (this.stopping.get(id) === stopping) this.stopping.delete(id);
    }).catch(() => {});
    void this.#stop(id).then(resolve, reject);
    return stopping;
  }

  async #stop(id) {
    const starting = this.starting.get(id);
    if (starting) {
      try { await starting; } catch {}
    }
    const child = this.processes.get(id);
    if (!child) {
      return this.status(id);
    }
    this.statuses.set(id, { status: 'stopping', error: null });
    this.onChange(this.list());
    const closed = this.completions.get(child);
    const request = { signalSent: false, forcedTerminationRequested: false };
    this.stopRequests.set(child, request);
    const sendSignal = (signal) => {
      try { return child.kill(signal); } catch (cause) {
        const message = `Could not request service termination: ${cause.message}`;
        this.statuses.set(id, { status: 'failed', error: message, forcedTerminationRequested: request.forcedTerminationRequested });
        this.onChange(this.list());
        throw new AppError('SERVICE_STOP_FAILED', message, { status: 500, cause,
          details: { id, pid: child.pid, signal, forcedTerminationRequested: request.forcedTerminationRequested } });
      }
    };
    request.signalSent = sendSignal('SIGTERM');
    let didClose = await this.#waitForClose(closed, 5_000);
    if (!didClose) {
      request.forcedTerminationRequested = true;
      sendSignal('SIGKILL');
      didClose = await this.#waitForClose(closed, 5_000);
    }
    if (!didClose) {
      const error = 'Service did not exit after forced termination';
      this.statuses.set(id, { status: 'failed', error, forcedTerminationRequested: true });
      this.onChange(this.list());
      throw new AppError('SERVICE_STOP_FAILED', error, { status: 500, details: { id, pid: child.pid, forcedTerminationRequested: true } });
    }
    const result = await closed;
    if (result.status === 'failed') {
      throw new AppError('SERVICE_STOP_FAILED', `Service did not stop cleanly: ${result.error}`, { status: 500,
        details: { id, pid: null, exitCode: result.exitCode, signal: result.signal, forcedTerminationRequested: result.forcedTerminationRequested } });
    }
    return { id, ...result, pid: null };
  }

  async #waitForClose(closed, timeoutMs) {
    if (!closed) return false;
    let timer;
    const completed = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
    clearTimeout(timer);
    return completed;
  }

  status(id) {
    const child = this.processes.get(id);
    const status = this.statuses.get(id) ?? { status: child ? 'running' : 'stopped', error: null };
    return { id, ...status, pid: child?.pid ?? null };
  }

  hasActiveLifecycle() {
    return this.processes.size > 0 || this.starting.size > 0 || this.stopping.size > 0 || this.removing.size > 0 || this.editing.size > 0;
  }

  async autoStart() {
    for (const service of this.stateStore.get(['localServices']) ?? []) {
      if (this.shuttingDown) break;
      if (service.enabled && service.autoStart && service.executable) {
        try {
          const starting = this.start(service.id);
          this.autoStartRequests.add(starting);
          await starting;
        } catch (error) { this.logger?.warn('service.autostart_failed', { id: service.id, message: error.message }); }
      }
    }
  }

  async stopAll() {
    const ids = new Set([...this.processes.keys(), ...this.starting.keys(), ...this.stopping.keys()]);
    const results = await Promise.allSettled([...ids].map((id) => this.stop(id)));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'One or more local services failed to stop');
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.#shutdown();
    return this.shutdownPromise;
  }

  async #shutdown() {
    // Join stops before waiting for removal: removal may itself reject because
    // its child stopped uncleanly and release that stop reservation meanwhile.
    const removals = [...this.removing.values()];
    const results = await Promise.allSettled([
      this.stopAll(), ...removals, ...this.starting.values(), ...this.editing.values()
    ]);
    const failures = results[0].status === 'rejected'
      ? results[0].reason instanceof AggregateError ? [...results[0].reason.errors] : [results[0].reason]
      : [];
    // A still-owned removal may outlive its released stop reservation. Retain
    // that stop failure, but do not sweep historical statuses or unrelated
    // rejected configuration writes into a later shutdown result.
    for (const result of results.slice(1, 1 + removals.length)) {
      if (result.status === 'rejected' && result.reason?.code === 'SERVICE_STOP_FAILED' && !failures.includes(result.reason)) {
        failures.push(result.reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'One or more local services failed to stop');
  }
}
