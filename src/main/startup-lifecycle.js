// Readiness is deliberately outside this lifecycle: stopping before startup
// admission must not wait for Electron's whenReady() promise to settle.
export function createStartupLifecycle() {
  const stopped = Object.assign(new Error('Application startup stopped'), { code: 'APP_STARTUP_STOPPED' });
  let stopping = false;
  let startupPromise = null;
  let stopPromise = null;

  const observe = (promise) => {
    // The caller still receives the original rejecting promise. Attach an
    // observer immediately, including when stop precedes the caller's catch.
    void promise.catch(() => {});
    return promise;
  };
  const checkpoint = () => {
    if (stopping) throw stopped;
  };
  const step = async (action) => {
    checkpoint();
    const result = await action();
    checkpoint();
    return result;
  };

  return {
    get stopping() { return stopping; },
    isStopError: (error) => error === stopped,
    run(action) {
      if (startupPromise) return startupPromise;
      if (stopping) return observe(Promise.reject(stopped));
      startupPromise = observe(Promise.resolve().then(async () => {
        checkpoint();
        const result = await action({ step, checkpoint });
        checkpoint();
        return result;
      }).catch((error) => {
        stopping = true;
        throw error;
      }));
      return startupPromise;
    },
    stop() {
      stopping = true;
      if (!stopPromise) {
        stopPromise = observe((startupPromise ?? Promise.resolve()).catch((error) => {
          // A genuine initialization failure, even with the same error code,
          // must remain a failing shutdown result after cleanup is attempted.
          if (error !== stopped) throw error;
        }));
      }
      return stopPromise;
    }
  };
}
