export class Store {
  constructor(initial = {}) {
    this.value = initial;
    this.listeners = new Set();
  }

  get() { return this.value; }

  set(next) {
    this.value = typeof next === 'function' ? next(this.value) : next;
    for (const listener of this.listeners) listener(this.value);
    return this.value;
  }

  patch(patch) {
    return this.set((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
