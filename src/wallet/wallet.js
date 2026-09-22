import { normalizeAccounts, requestRpc, requestStyle } from './adapters.js';

const host = window.walletHost;
const walletsElement = document.querySelector('#wallets');
const statusElement = document.querySelector('#bridge-status');
const requestPanel = document.querySelector('#request-panel');
const requestTitle = document.querySelector('#request-title');
const requestDetail = document.querySelector('#request-detail');
const extensionCountElement = document.querySelector('#extension-count');
const registry = new Map();
const standardRegistry = new Map();
const standardWalletIds = new WeakMap();
let standardWalletSequence = 0;
let connected = null;
let connectedWallet = null;
let connectionGeneration = 0;
const providerDisconnects = new WeakMap();
let extensionCount = 0;
let discoveryReady = false;
let previousRegistry = null;

function safeWallet(id, name, kind, provider, icon = null, rpcStyle = null) {
  if (!id || !provider) return;
  const previous = previousRegistry?.get(id);
  if (previous && previous.kind === kind && previous.provider === provider && previous.rpcStyle === rpcStyle) {
    previous.name = name || id;
    previous.icon = icon;
    registry.set(id, previous);
  } else {
    registry.set(id, { id, name: name || id, kind, provider, icon, rpcStyle });
  }
}

function rpc(wallet, method, params) {
  return requestRpc(wallet.provider, method, params, wallet.rpcStyle);
}

function discoverWalletStandard() {
  const register = (...wallets) => {
    const registrations = [];
    for (const wallet of wallets.flat()) {
      const feature = wallet?.features?.['sats-connect:'];
      const provider = feature?.provider;
      if (provider && wallet && typeof wallet === 'object') {
        let id = standardWalletIds.get(wallet);
        if (!id) {
          id = `standard:${++standardWalletSequence}:${String(wallet.name || 'wallet').slice(0, 90)}`;
          standardWalletIds.set(wallet, id);
        }
        // Wallet Standard ignores duplicate registration of the same object;
        // its returned unregister callback must not own the earlier entry.
        if (standardRegistry.has(id)) continue;
        const entry = { id, name: wallet.name, kind: 'wallet-standard', provider, icon: wallet.icon, rpcStyle: requestStyle(provider) };
        standardRegistry.set(entry.id, entry);
        registrations.push({ id, wallet, entry });
      }
    }
    if (discoveryReady) discover();
    return () => {
      let changed = false;
      for (const { id, wallet, entry } of registrations) {
        if (standardWalletIds.get(wallet) === id && standardRegistry.get(id) === entry && standardRegistry.delete(id)) changed = true;
      }
      if (changed && discoveryReady) discover();
    };
  };
  const api = Object.freeze({ register });
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    if (typeof event.detail === 'function') {
      try { event.detail(api); } catch {}
    }
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}

function discover() {
  previousRegistry = new Map(registry);
  registry.clear();
  for (const wallet of standardRegistry.values()) safeWallet(wallet.id, wallet.name, wallet.kind, wallet.provider, wallet.icon, wallet.rpcStyle);
  if (window.unisat) safeWallet('unisat', 'UniSat', 'unisat', window.unisat);
  if (window.okxwallet?.bitcoin) safeWallet('okx', 'OKX Bitcoin', 'unisat', window.okxwallet.bitcoin);
  if (window.magicEden?.bitcoin) safeWallet('magic-eden', 'Magic Eden', 'unisat', window.magicEden.bitcoin);
  if (window.BitcoinProvider) safeWallet('bitcoin-provider', 'Sats Connect wallet', 'json-rpc', window.BitcoinProvider, null, requestStyle(window.BitcoinProvider));
  if (window.LeatherProvider) safeWallet('leather', 'Leather', 'json-rpc', window.LeatherProvider, null, requestStyle(window.LeatherProvider));
  for (const key of Object.keys(window)) {
    if (!/bitcoin|wallet/i.test(key)) continue;
    const value = window[key];
    if (value && typeof value === 'object' && (typeof value.requestAccounts === 'function' || typeof value.request === 'function')) {
      safeWallet(`detected:${key}`, key, typeof value.requestAccounts === 'function' ? 'unisat' : 'json-rpc', value, null, requestStyle(value));
    }
  }
  if (connected && registry.get(connected.walletId) !== connectedWallet) {
    connectionGeneration += 1;
    connected = null;
    connectedWallet = null;
    host.emit({ type: 'state', state: { connected: false, accounts: [] } });
  }
  render();
  host.emit({ type: 'discovered', wallets: [...registry.values()].map(({ id, name, kind, icon }) => ({ id, name, kind, icon })) });
  previousRegistry = null;
}

function render() {
  walletsElement.replaceChildren();
  const wallets = [...registry.values()];
  statusElement.textContent = wallets.length ? 'Ready' : 'No wallet';
  extensionCountElement.textContent = `${extensionCount} extension${extensionCount === 1 ? '' : 's'} loaded`;
  if (!wallets.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No compatible wallet provider was detected. Add an unpacked wallet extension from the main app, then refresh.';
    walletsElement.append(empty);
    return;
  }
  for (const wallet of wallets) {
    const row = document.createElement('div');
    row.className = 'wallet';
    const icon = document.createElement(wallet.icon ? 'img' : 'div');
    icon.className = 'icon';
    if (wallet.icon) icon.src = wallet.icon;
    else icon.textContent = '₿';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('strong');
    name.textContent = wallet.name;
    const kind = document.createElement('span');
    kind.textContent = wallet.kind;
    meta.append(name, kind);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = connected?.walletId === wallet.id ? 'Connected' : 'Connect';
    button.addEventListener('click', () => execute({ requestId: crypto.randomUUID(), action: 'connect', payload: { walletId: wallet.id } }, false));
    row.append(icon, meta, button);
    walletsElement.append(row);
  }
}

async function connect(wallet, options = {}) {
  const authority = ++connectionGeneration;
  const pendingDisconnect = providerDisconnects.get(wallet.provider);
  if (pendingDisconnect) await pendingDisconnect;
  if (authority !== connectionGeneration || registry.get(wallet.id) !== wallet) {
    throw Object.assign(new Error('Wallet provider changed before the connection started'), { code: 'WALLET_PROVIDER_CHANGED' });
  }
  let response;
  if (wallet.kind === 'unisat') {
    response = await wallet.provider.requestAccounts();
  } else {
    response = await rpc(wallet, 'getAccounts', { purposes: ['payment', 'ordinals'], message: 'Connect to Bitcoin Browser' });
  }
  let accounts = normalizeAccounts(response);
  if (!accounts.length && wallet.kind === 'unisat' && typeof wallet.provider.getAccounts === 'function') accounts = normalizeAccounts(await wallet.provider.getAccounts());
  if (!accounts.length) throw new Error('Wallet returned no Bitcoin accounts');
  if (authority !== connectionGeneration || registry.get(wallet.id) !== wallet) {
    throw Object.assign(new Error('Wallet provider changed before the connection completed'), { code: 'WALLET_PROVIDER_CHANGED' });
  }
  connected = { connected: true, walletId: wallet.id, walletName: wallet.name, accounts, connectedAt: new Date().toISOString() };
  connectedWallet = wallet;
  if (options.emitState !== false) host.emit({ type: 'state', state: connected });
  render();
  return connected;
}

async function disconnect(options = {}) {
  const previous = connected;
  const wallet = previous ? registry.get(previous.walletId) : null;
  connectionGeneration += 1;
  connected = null;
  connectedWallet = null;
  if (options.emitState !== false) host.emit({ type: 'state', state: { connected: false, accounts: [] } });
  render();
  if (previous) {
    const providerDisconnect = (async () => {
      if (wallet && wallet.kind !== 'unisat') await rpc(wallet, 'wallet_disconnect', {});
      else if (typeof wallet?.provider?.disconnect === 'function') await wallet.provider.disconnect();
    })();
    if (wallet?.provider && typeof wallet.provider === 'object') providerDisconnects.set(wallet.provider, providerDisconnect);
    try { await providerDisconnect; } catch {}
    finally {
      if (wallet?.provider && providerDisconnects.get(wallet.provider) === providerDisconnect) providerDisconnects.delete(wallet.provider);
    }
  }
  return { connected: false };
}

async function signPsbt(payload) {
  const wallet = registry.get(payload.walletId ?? connected?.walletId);
  if (!wallet) throw new Error('Connected wallet provider is unavailable');
  if (wallet.kind === 'unisat' && typeof wallet.provider.signPsbt === 'function') {
    return wallet.provider.signPsbt(payload.psbt, { autoFinalized: false, ...(payload.options ?? {}) });
  }
  return rpc(wallet, 'signPsbt', { psbt: payload.psbt, ...payload.options });
}

async function signMessage(payload) {
  const wallet = registry.get(payload.walletId ?? connected?.walletId);
  if (!wallet) throw new Error('Connected wallet provider is unavailable');
  if (wallet.kind === 'unisat' && typeof wallet.provider.signMessage === 'function') {
    return wallet.provider.signMessage(payload.message, payload.type ?? 'bip322-simple');
  }
  return rpc(wallet, 'signMessage', { address: payload.address, message: payload.message, protocol: payload.protocol ?? undefined });
}

async function execute(command, respond = true) {
  if (!command || typeof command !== 'object') return;
  if (command.action === 'refresh') {
    extensionCount = Number.isSafeInteger(command.payload?.extensionCount) ? command.payload.extensionCount : extensionCount;
    discover();
    return;
  }
  requestPanel.classList.remove('hidden');
  requestTitle.textContent = ({ connect: 'Connecting wallet', disconnect: 'Disconnecting wallet', signPsbt: 'Signing transaction', signMessage: 'Signing message' })[command.action] ?? 'Wallet request';
  requestDetail.textContent = command.action.startsWith('sign') ? 'Review and approve the request in your wallet extension.' : 'Complete the connection flow in your wallet extension.';
  try {
    let result;
    if (command.action === 'connect') {
      const wallet = registry.get(command.payload?.walletId);
      if (!wallet) throw new Error('Selected wallet is not available');
      result = await connect(wallet, { emitState: !respond });
    } else if (command.action === 'disconnect') result = await disconnect({ emitState: !respond });
    else if (command.action === 'signPsbt') result = await signPsbt(command.payload ?? {});
    else if (command.action === 'signMessage') result = await signMessage(command.payload ?? {});
    else throw new Error(`Unsupported wallet action: ${command.action}`);
    if (respond) host.emit({ type: 'result', requestId: command.requestId, ok: true, result });
  } catch (error) {
    if (respond) host.emit({ type: 'result', requestId: command.requestId, ok: false, error: { code: error?.code ?? 'WALLET_ERROR', message: error?.message ?? String(error) } });
  } finally {
    requestPanel.classList.add('hidden');
  }
}

document.querySelector('#refresh').addEventListener('click', discover);
host.onCommand((command) => execute(command, true));
discoverWalletStandard();
discoveryReady = true;
discover();
host.ready();
