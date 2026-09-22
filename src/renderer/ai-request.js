// A request owns its preparation, progress polling, and cancellation. Stop
// before preparation finishes cannot resurrect work; late replies cannot paint.
export class AiRequest {
  // Window timers are Web IDL methods: calling an unbound timer as
  // this.setTimer() supplies an AiRequest receiver and Chromium throws
  // "Illegal invocation". Keep the Window receiver inside these wrappers.
  constructor(api, { onProgress = () => {}, onProgressError = () => {}, pollMs = 650,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = timer => globalThis.clearTimeout(timer) } = {}) {
    Object.assign(this, { api, onProgress, onProgressError, pollMs, setTimer, clearTimer });
    this.handle = null; this.cancelled = false; this.finished = false; this.timer = null; this.cancellation = null;
  }
  cancelMain() {
    return this.cancellation ??= Promise.resolve().then(() => this.api.cancel(this.handle));
  }
  async cancel() {
    this.cancelled = true; this.clearTimer(this.timer);
    await this.preparation;
    if (this.handle !== null && !this.finished) await this.cancelMain();
  }
  async poll() {
    if (this.cancelled || this.finished) return;
    try {
      const value = await this.api.progress(this.handle);
      if (!this.cancelled && !this.finished && value) this.onProgress(value);
    } catch {
      if (!this.cancelled && !this.finished) this.onProgressError();
    }
    if (!this.cancelled && !this.finished) this.timer = this.setTimer(() => { void this.poll(); }, this.pollMs);
  }
  async run(request) {
    if (this.preparation) throw new Error('An AI request cannot be replayed.');
    if (!['prepare', 'run', 'progress', 'cancel'].every(method => typeof this.api?.[method] === 'function')) {
      this.finished = true;
      throw { code: 'AI_BRIDGE_UNAVAILABLE', message: 'The AI connection service is unavailable in this window. Restart Bitcoin Browser to load the latest version, then reconnect.' };
    }
    this.preparation = Promise.resolve().then(() => this.api.prepare(request)).then(value => {
      if (!Number.isSafeInteger(value?.handle) || value.handle < 1) throw new Error('The AI request could not be prepared.');
      this.handle = value.handle;
    });
    try {
      await this.preparation;
      if (this.cancelled) { await this.cancelMain(); throw { code: 'NAVIGATION_CANCELLED', message: 'Stopped.' }; }
      const response = this.api.run(this.handle);
      this.timer = this.setTimer(() => { void this.poll(); }, this.pollMs);
      const result = await response;
      if (this.cancelled) throw { code: 'NAVIGATION_CANCELLED', message: 'Stopped.' };
      return result;
    } catch (error) {
      if (this.handle !== null) {
        try { await this.cancelMain(); } catch { /* The caller retains the primary error; the main request is deadline-bounded. */ }
      }
      throw error;
    } finally { this.finished = true; this.clearTimer(this.timer); }
  }
}
