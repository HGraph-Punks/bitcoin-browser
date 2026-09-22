import { AppError } from '../../shared/errors.js';

export class DataProvider {
  constructor(config, dependencies = {}) {
    this.config = structuredClone(config);
    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.network = config.network;
    this.capabilities = new Set(config.capabilities ?? []);
    this.secureStore = dependencies.secureStore;
    this.logger = dependencies.logger;
  }

  supports(capability) {
    return this.capabilities.has(capability);
  }

  async health() {
    throw new AppError('NOT_IMPLEMENTED', `${this.type} provider does not implement health()`, { status: 501 });
  }

  async resolve() {
    throw new AppError('NOT_IMPLEMENTED', `${this.type} provider does not implement resolve()`, { status: 501 });
  }

  descriptor(health = null) {
    const hasSecret = (key) => typeof this.secureStore?.has === 'function'
      ? this.secureStore.has(key)
      : Boolean(this.secureStore?.get?.(key));
    return {
      ...structuredClone(this.config),
      credentialsStored: hasSecret(`provider:${this.id}:username`) || hasSecret(`provider:${this.id}:password`),
      health
    };
  }
}
