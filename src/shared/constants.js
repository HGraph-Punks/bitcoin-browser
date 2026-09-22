import { AI_DEFAULT_CONFIG } from './local-ai.js';

export const APP_NAME = 'Bitcoin Browser';
export const APP_SCHEME = 'app';
export const CONTENT_SCHEME = 'ord';
export const DEEP_LINK_SCHEME = 'satnav';
export const APP_PARTITION = 'persist:satoshi-browser-app';
export const WALLET_PARTITION = 'persist:satoshi-browser-wallet';
export const WALLET_ORIGIN = 'https://wallet.satoshi.invalid';
export const STATE_SCHEMA_VERSION = 3;
export const MAX_HISTORY = 2_000;
export const MAX_TABS = 64;

export const NETWORKS = Object.freeze(['mainnet', 'testnet', 'signet', 'regtest']);

export const IPC = Object.freeze({
  APP_BOOTSTRAP: 'app:bootstrap',
  APP_COMMAND: 'app:command',
  APP_DEEP_LINK: 'app:deep-link',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_REVEAL_PATH: 'app:reveal-path',
  NAV_PARSE: 'navigation:parse',
  ENTITY_RESOLVE: 'entity:resolve',
  ENTITY_RESOLVE_PREPARE: 'entity:resolve-prepare',
  ENTITY_RESOLVE_CANCEL: 'entity:resolve-cancel',
  AI_PREPARE: 'ai:prepare',
  AI_RUN: 'ai:run',
  AI_PROGRESS: 'ai:progress',
  AI_CANCEL: 'ai:cancel',
  CONTENT_SAVE: 'content:save',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_SNAPSHOT: 'providers:snapshot',
  PROVIDERS_HEALTH: 'providers:health',
  PROVIDERS_UPSERT: 'providers:upsert',
  PROVIDERS_RECOVER: 'providers:recover',
  PROVIDERS_CLEANUP_REVIEW: 'providers:cleanup-review',
  PROVIDERS_CLEANUP: 'providers:cleanup',
  PROVIDERS_REMOVE: 'providers:remove',
  PROVIDERS_PREFERRED: 'providers:preferred',
  SETTINGS_UPDATE: 'settings:update',
  TABS_SAVE: 'tabs:save',
  HISTORY_LIST: 'history:list',
  HISTORY_RECORD: 'history:record',
  HISTORY_CLEAR: 'history:clear',
  BOOKMARKS_LIST: 'bookmarks:list',
  BOOKMARKS_TOGGLE: 'bookmarks:toggle',
  CACHE_STATS: 'cache:stats',
  CACHE_CLEAR: 'cache:clear',
  RESOLVER_GRAPH: 'resolver:graph',
  PSBT_INSPECT: 'psbt:inspect',
  EXTENSIONS_LIST: 'extensions:list',
  EXTENSIONS_INSTALL: 'extensions:install',
  EXTENSIONS_REMOVE: 'extensions:remove',
  WALLET_OPEN: 'wallet:open',
  WALLET_DISCOVER: 'wallet:discover',
  WALLET_CONNECT: 'wallet:connect',
  WALLET_DISCONNECT: 'wallet:disconnect',
  WALLET_SIGN_PSBT: 'wallet:sign-psbt',
  WALLET_SIGN_MESSAGE: 'wallet:sign-message',
  WALLET_STATE: 'wallet:state',
  WALLET_BRIDGE_READY: 'wallet-bridge:ready',
  WALLET_BRIDGE_EVENT: 'wallet-bridge:event',
  WALLET_BRIDGE_COMMAND: 'wallet-bridge:command',
  LOCAL_SERVICES_LIST: 'local-services:list',
  LOCAL_SERVICES_UPSERT: 'local-services:upsert',
  LOCAL_SERVICES_REMOVE: 'local-services:remove',
  LOCAL_SERVICES_START: 'local-services:start',
  LOCAL_SERVICES_STOP: 'local-services:stop',
  NODE_SETUP: 'node-setup:action',
  DIAGNOSTICS_EXPORT: 'diagnostics:export'
});

export const PROVIDER_CAPABILITIES = Object.freeze([
  'ord-recursion',
  'inscription',
  'inscription-number',
  'sat',
  'block',
  'transaction',
  'transaction-raw',
  'output',
  'satpoint',
  'address',
  'rune'
]);

const freezeCapabilityMap = (value) => Object.freeze(Object.fromEntries(
  Object.entries(value).map(([type, capabilities]) => [type, Object.freeze([...capabilities])])
));

export const PROVIDER_CAPABILITIES_BY_TYPE = freezeCapabilityMap({
  'ord-server': ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'],
  mempool: ['block', 'transaction', 'output', 'address'],
  'bitcoin-core': ['block', 'transaction', 'transaction-raw', 'output'],
  // The deterministic provider intentionally covers the complete navigation
  // surface for packaged and hostile-content fixtures.
  mock: PROVIDER_CAPABILITIES
});

export const DEFAULT_PROVIDER_CAPABILITIES_BY_TYPE = freezeCapabilityMap({
  'ord-server': PROVIDER_CAPABILITIES_BY_TYPE['ord-server'],
  mempool: PROVIDER_CAPABILITIES_BY_TYPE.mempool,
  'bitcoin-core': PROVIDER_CAPABILITIES_BY_TYPE['bitcoin-core'],
  mock: ['ord-recursion', 'inscription', 'sat', 'block', 'transaction', 'output', 'satpoint', 'address']
});

export function providerCapabilitiesFor(type) {
  return PROVIDER_CAPABILITIES_BY_TYPE[type] ?? Object.freeze([]);
}

export function defaultProviderCapabilitiesFor(type) {
  return DEFAULT_PROVIDER_CAPABILITIES_BY_TYPE[type] ?? Object.freeze([]);
}

export function providerTypeSupportsCapability(type, capability) {
  return providerCapabilitiesFor(type).includes(capability);
}

export const DEFAULT_SETTINGS = Object.freeze({
  network: 'mainnet',
  theme: 'system',
  privacyMode: 'balanced',
  localOnly: false,
  offlineMode: false,
  contentNetworkPolicy: 'blocked',
  cacheMaxBytes: 1_073_741_824,
  maxResourceBytes: 67_108_864,
  maxGraphBytes: 4_194_304,
  maxRecursionDepth: 32,
  maxRecursionNodes: 512,
  maxConcurrentContentRequests: 12,
  requestTimeoutMs: 15_000,
  developerMode: false,
  restoreSession: true,
  telemetryEnabled: false,
  preferredProviderId: null,
  localAi: AI_DEFAULT_CONFIG
});

export const DEFAULT_PROVIDERS = Object.freeze([
  {
    id: 'local-ord-mainnet',
    type: 'ord-server',
    name: 'Local ord server',
    network: 'mainnet',
    baseUrl: 'http://127.0.0.1:80',
    enabled: true,
    priority: 10,
    local: true,
    capabilities: ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune']
  },
  {
    id: 'official-ord-mainnet',
    type: 'ord-server',
    name: 'Ordinals.com',
    network: 'mainnet',
    baseUrl: 'https://ordinals.com',
    enabled: true,
    priority: 50,
    local: false,
    capabilities: ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune']
  },
  {
    id: 'mempool-space-mainnet',
    type: 'mempool',
    name: 'mempool.space',
    network: 'mainnet',
    baseUrl: 'https://mempool.space',
    enabled: true,
    priority: 80,
    local: false,
    capabilities: ['block', 'transaction', 'output', 'address']
  },
  {
    id: 'local-bitcoin-core-mainnet',
    type: 'bitcoin-core',
    name: 'Local Bitcoin Core',
    network: 'mainnet',
    baseUrl: 'http://127.0.0.1:8332',
    enabled: false,
    priority: 20,
    local: true,
    cookieFile: '',
    capabilities: ['block', 'transaction', 'transaction-raw', 'output']
  }
]);

export const DEFAULT_LOCAL_SERVICES = Object.freeze([
  {
    id: 'managed-bitcoind',
    name: 'Bitcoin Core',
    executable: '',
    args: ['-server=1', '-txindex=1'],
    cwd: '',
    autoStart: false,
    enabled: false
  },
  {
    id: 'managed-ord',
    name: 'ord server',
    executable: '',
    args: ['server'],
    cwd: '',
    autoStart: false,
    enabled: false
  }
]);
