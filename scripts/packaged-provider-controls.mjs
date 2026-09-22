import { randomUUID } from 'node:crypto';
import { providerCapabilitiesFor } from '../src/shared/constants.js';

function requireOptions(options) {
  for (const name of ['poll', 'assert']) if (typeof options?.[name] !== 'function') throw new TypeError(`packaged provider controls require ${name}`);
  if (!options?.cdp || typeof options.cdp.evaluate !== 'function') throw new TypeError('packaged provider controls require cdp.evaluate');
  const provider = options.fixtureProvider;
  let endpoint;
  try { endpoint = new URL(provider?.baseUrl); } catch {}
  if (!provider || typeof provider.id !== 'string' || !/^beta-[a-z0-9-]{1,48}$/.test(provider.id)
    || typeof provider.name !== 'string' || !provider.name || provider.name.length > 73
    || endpoint?.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || (provider.priority !== undefined && (!Number.isInteger(provider.priority) || provider.priority < 0 || provider.priority > 999))) {
    throw new TypeError('fixtureProvider must have a unique beta-* id, name, and loopback HTTP baseUrl');
  }
  if (provider.capabilities !== undefined) throw new TypeError('custom fixtureProvider capabilities are not covered');
  const legacy = options.legacyProvider;
  let legacyEndpoint;
  try { legacyEndpoint = new URL(legacy?.baseUrl); } catch {}
  if (legacy !== undefined && (!legacy || typeof legacy.id !== 'string' || !/^beta-[a-z0-9-]{1,48}$/.test(legacy.id)
    || legacy.id === provider.id || typeof legacy.name !== 'string' || !legacy.name || legacy.name.length > 73
    || legacy.type !== 'mempool' || legacy.network !== 'mainnet' || legacy.enabled !== true || legacy.local !== true || legacy.cookieFile !== ''
    || !Number.isInteger(legacy.priority) || legacy.priority < 0 || legacy.priority > 1000
    || JSON.stringify(legacy.capabilities) !== JSON.stringify(['block', 'satpoint'])
    || legacyEndpoint?.protocol !== 'http:' || legacyEndpoint.hostname !== '127.0.0.1' || !legacyEndpoint.port
    || legacyEndpoint.username || legacyEndpoint.password || legacyEndpoint.pathname !== '/' || legacyEndpoint.search || legacyEndpoint.hash)) {
    throw new TypeError('legacyProvider must be a distinct owned enabled beta-* mainnet Mempool fixture with block,satpoint capabilities');
  }
  if (options.retainLegacyForRestart !== undefined && (options.retainLegacyForRestart !== true || !legacy)) {
    throw new TypeError('retainLegacyForRestart requires an owned legacyProvider');
  }
  return { ...options, legacyProvider: legacy ?? null, fixtureProvider: { ...provider, type: 'ord-server', network: 'mainnet', enabled: true,
    priority: Number.isInteger(provider.priority) ? provider.priority : 37 } };
}

async function snapshot(cdp) {
  return cdp.evaluate(`Promise.all([window.satBrowser.providers.list(), window.satBrowser.app.bootstrap()]).then(([providers, bootstrap]) => ({
    providers, preferredProviderId: bootstrap.state.settings.preferredProviderId,
    network: bootstrap.state.settings.network, localOnly: bootstrap.state.settings.localOnly, offlineMode: bootstrap.state.settings.offlineMode
  }))`);
}

function providerConfigurations(providers) {
  return providers.map(({ health, ...configuration }) => configuration).sort((left, right) => left.id.localeCompare(right.id));
}

function exactJson(value) {
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${exactJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function exactLegacyDescriptor(provider, overrides = {}) {
  return { ...provider, ...overrides, credentialsStored: false, health: null };
}

function providerRoutingSnapshot(value) {
  return JSON.stringify({ providers: providerConfigurations(value.providers), preferredProviderId: value.preferredProviderId });
}

function exactRoutingSnapshot(value, excludedId = null) {
  return exactJson({ providers: providerConfigurations(value.providers.filter((item) => item.id !== excludedId)),
    preferredProviderId: value.preferredProviderId, network: value.network, localOnly: value.localOnly, offlineMode: value.offlineMode });
}

async function route(options) {
  options.assert(await options.cdp.evaluate(`(() => { /*provider-controls:route*/
    const control = document.querySelector('[data-route="providers"]');
    if (!control) return false; control.click(); return true;
  })()`), 'Data sources route was not reachable');
  await options.poll(() => options.cdp.evaluate("document.querySelector('#page h1')?.textContent"),
    (value) => value === 'Data sources', undefined, 'Data sources page');
}

async function openAdd(cdp, marker, ownerToken) {
  return cdp.evaluate(`(() => { /*provider-controls:${marker}*/
    const button = [...document.querySelectorAll('#page button')].find((node) => node.textContent?.trim().endsWith('Add source'));
    if (!button) return false; button.click();
    const modal = document.querySelector('#modal'); if (!modal) return false;
    modal.dataset.providerControlsOwner = ${JSON.stringify(ownerToken)}; return true;
  })()`);
}

async function modalState(cdp, ownerToken, headings) {
  return cdp.evaluate(`(() => { /*provider-controls:modal-state*/
    const modal = document.querySelector('#modal');
    return { visible: !document.querySelector('#modal-backdrop')?.classList.contains('hidden'),
      owned: modal?.dataset.providerControlsOwner === ${JSON.stringify(ownerToken)},
      heading: modal?.querySelector('h2')?.textContent?.trim() ?? '',
      expected: ${JSON.stringify(headings)}.includes(modal?.querySelector('h2')?.textContent?.trim() ?? '') };
  })()`);
}

async function waitModal(options, ownerToken, headings, visible, label) {
  return options.poll(() => modalState(options.cdp, ownerToken, headings),
    (value) => value.visible === visible && (!visible || (value.owned && value.expected)), undefined, label);
}

async function modalAction(cdp, action, values = {}) {
  return cdp.evaluate(`(() => { /*provider-controls:${action}*/
    const modal = document.querySelector('#modal');
    if (!modal) return false;
    const field = (label) => [...modal.querySelectorAll('.form-field')].find((node) => node.querySelector(':scope > .form-field-label')?.textContent.trim() === label)?.querySelector('input,select');
    const values = ${JSON.stringify(values)};
    for (const [label, value] of Object.entries(values)) {
      const control = field(label); if (!control) return false;
      control.value = String(value); control.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const label = ${JSON.stringify(action)};
    if (label === null) return true;
    const button = [...modal.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!button) return false;
    if (label === 'Save source') modal.__providerControlsPreviousToast = document.querySelector('#toasts .toast:last-child');
    button.click(); return true;
  })()`);
}

async function setProviderStatus(cdp, enabled) {
  return cdp.evaluate(`(() => { /*provider-controls:disabled-draft-status*/
    const field = [...document.querySelectorAll('#modal .form-field')].find((node) => node.querySelector(':scope > .form-field-label')?.textContent.trim() === 'Status');
    const input = field?.querySelector('input[type="checkbox"]'); if (!input) return false;
    input.checked = ${Boolean(enabled)}; input.dispatchEvent(new Event('change', { bubbles: true })); return input.checked === ${Boolean(enabled)};
  })()`);
}

async function selectCapabilities(cdp, selected) {
  return cdp.evaluate(`(() => { /*provider-controls:capabilities*/
    const modal = document.querySelector('#modal');
    const selected = ${JSON.stringify(selected)};
    const controls = [...(modal?.querySelectorAll('[data-capability]') ?? [])];
    for (const wrapper of controls) {
      const input = wrapper.querySelector('input'); if (!input) return null;
      input.checked = selected.includes(wrapper.dataset.capability);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { available: controls.map((node) => node.dataset.capability),
      selected: controls.filter((node) => node.querySelector('input')?.checked).map((node) => node.dataset.capability) };
  })()`);
}

async function switchNetworkViaUi(options, network, providerName) {
  options.assert(await options.cdp.evaluate(`(() => { /*provider-controls:settings-route*/
    const control = document.querySelector('[data-route="settings"]'); if (!control) return false; control.click(); return true;
  })()`), 'Settings route was not reachable for provider network selection');
  await options.poll(() => options.cdp.evaluate("document.querySelector('#page h1')?.textContent"),
    (value) => value === 'Settings', undefined, 'Settings page for provider network selection');
  options.assert(await options.cdp.evaluate(`(() => { /*provider-controls:network-choice*/
    const select = document.querySelector('#page select[aria-label="Bitcoin network"]');
    if (!select || ![...select.options].some((option) => option.value === ${JSON.stringify(network)})) return false;
    select.value = ${JSON.stringify(network)}; select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`), `Bitcoin network choice ${network} was not reachable`);
  await options.poll(() => snapshot(options.cdp), (value) => value.network === network, undefined, `network changed to ${network}`);
  await route(options);
  await options.poll(() => options.cdp.evaluate(`(() => { /*provider-controls:network-card*/
    const name = ${JSON.stringify(providerName)};
    return [...document.querySelectorAll('#page .provider-card')].filter((node) => {
      const strong = node.querySelector('.provider-copy strong');
      return [...(strong?.childNodes ?? [])].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('').trim() === name;
    }).length;
  })()`), (count) => count === 1, undefined, `provider visible on ${network}`);
}

async function cardActionByName(cdp, name, label, ownerToken) {
  return cdp.evaluate(`(() => { /*provider-controls:card-name-action*/
    const cards = [...document.querySelectorAll('#page .provider-card')].filter((node) => {
      const strong = node.querySelector('.provider-copy strong');
      const directText = [...(strong?.childNodes ?? [])].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('').trim();
      return directText === ${JSON.stringify(name)};
    });
    if (cards.length !== 1) return false;
    const button = [...cards[0].querySelectorAll('button')].find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) return false; button.click();
    if (${JSON.stringify(label)} === 'Edit') {
      const modal = document.querySelector('#modal'); if (!modal) return false;
      modal.dataset.providerControlsOwner = ${JSON.stringify(ownerToken)};
    }
    return true;
  })()`);
}

async function toggleByName(cdp, name) {
  return cdp.evaluate(`(() => { /*provider-controls:toggle-name*/
    const cards = [...document.querySelectorAll('#page .provider-card')].filter((node) => {
      const strong = node.querySelector('.provider-copy strong');
      return [...(strong?.childNodes ?? [])].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('').trim() === ${JSON.stringify(name)};
    });
    if (cards.length !== 1) return false;
    const button = cards[0].querySelector('button[role="switch"]'); if (!button) return false;
    window.__providerControlsPreviousToggleToast = document.querySelector('#toasts .toast:last-child');
    button.click(); return true;
  })()`);
}

function matchesProvider(item, expected) {
  return item?.id === expected.id && item.name === expected.name && item.type === expected.type
    && item.network === expected.network && item.baseUrl === expected.baseUrl && item.priority === expected.priority
    && item.enabled === true && item.local === true
    && JSON.stringify(item.capabilities) === JSON.stringify(expected.capabilities);
}

async function waitProvider(options, predicate, label) {
  return options.poll(() => snapshot(options.cdp), predicate, undefined, label);
}

function requireDraftOptions(options) {
  for (const name of ['poll', 'assert']) if (typeof options?.[name] !== 'function') throw new TypeError(`packaged disabled provider draft requires ${name}`);
  if (!options?.cdp || typeof options.cdp.evaluate !== 'function') throw new TypeError('packaged disabled provider draft requires cdp.evaluate');
  if (options.setOwnedProvider !== undefined && typeof options.setOwnedProvider !== 'function') throw new TypeError('setOwnedProvider must be a function');
  const provider = options.provider;
  let endpoint;
  try { endpoint = new URL(provider?.baseUrl); } catch {}
  if (!provider || typeof provider.id !== 'string' || !/^beta-[a-z0-9-]{1,48}$/.test(provider.id)
    || typeof provider.name !== 'string' || !provider.name || provider.name.length > 73
    || provider.type !== 'mempool' || provider.network !== 'mainnet' || provider.enabled !== false || provider.local !== true
    || provider.cookieFile !== '' || !Number.isInteger(provider.priority) || provider.priority < 0 || provider.priority > 999
    || !Array.isArray(provider.capabilities) || provider.capabilities.length !== 0
    || endpoint?.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new TypeError('provider must be an owned disabled-empty beta-* mainnet Mempool loopback fixture');
  }
  return { ...options, provider };
}

export async function createDisabledEmptyProviderDraft(rawOptions) {
  const options = requireDraftOptions(rawOptions);
  const { provider } = options;
  const ownerToken = randomUUID();
  const initial = await snapshot(options.cdp);
  options.assert(initial.providers.every((item) => item.id !== provider.id && item.name !== provider.name), 'Owned disabled draft id or name already exists');
  await options.setOwnedProvider?.(provider);
  try {
    await route(options);
    options.assert(await openAdd(options.cdp, 'disabled-draft-open', ownerToken), 'Disabled draft Add control was not reachable');
    await waitModal(options, ownerToken, ['Add a data source'], true, 'owned disabled draft modal');
    options.assert(await modalAction(options.cdp, null, { Identifier: provider.id, Name: provider.name, 'Adapter type': provider.type,
      'Bitcoin network': provider.network, 'Base URL': provider.baseUrl, Priority: provider.priority }), 'Disabled draft fields could not be prepared');
    const selection = await selectCapabilities(options.cdp, []);
    options.assert(JSON.stringify(selection?.available) === JSON.stringify(providerCapabilitiesFor('mempool')) && selection.selected.length === 0,
      'Disabled draft capability selection was not exact');
    options.assert(await setProviderStatus(options.cdp, false), 'Disabled draft status checkbox was not reachable');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Disabled draft could not be saved');
    await waitProvider(options, (value) => exactJson(value.providers.find((item) => item.id === provider.id))
      === exactJson(exactLegacyDescriptor(provider)), 'disabled-empty provider draft saved exactly');
    await waitModal(options, ownerToken, [], false, 'Disabled draft modal closed after save');
    options.assert(exactRoutingSnapshot(await snapshot(options.cdp), provider.id) === exactRoutingSnapshot(initial),
      'Disabled draft creation changed pre-existing providers, preference, or routing settings');
    return { schemaVersion: 1, deferredCleanup: { providerId: provider.id, reason: 'ordinary-restart-readback' }, provider,
      preexistingStatePreserved: true };
  } catch (error) {
    const cleanupErrors = [];
    try {
      await options.cdp.evaluate(`(() => { /*provider-controls:disabled-draft-cleanup-modal*/
        const modal = document.querySelector('#modal');
        if (modal?.dataset.providerControlsOwner !== ${JSON.stringify(ownerToken)}) return false;
        modal.querySelector('.modal-close')?.click(); return true;
      })()`);
    } catch (cleanupError) { cleanupErrors.push({ phase: 'modal', message: String(cleanupError.message).slice(0, 1024) }); }
    try {
      await options.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(provider.id)})`);
      const remaining = await options.cdp.evaluate('window.satBrowser.providers.list()');
      if (remaining.some((item) => item.id === provider.id)) throw new Error('Owned disabled draft remained after failure cleanup');
      await options.setOwnedProvider?.(null);
    } catch (cleanupError) { cleanupErrors.push({ phase: 'provider', message: String(cleanupError.message).slice(0, 1024) }); }
    if (cleanupErrors.length) error.evidence = { ...(error.evidence ?? {}), cleanupErrors };
    throw error;
  }
}

export async function verifyDisabledEmptyProviderDraftAfterRestart(rawOptions) {
  const options = requireDraftOptions(rawOptions);
  const { provider } = options;
  const initial = await snapshot(options.cdp);
  const observed = initial.providers.filter((item) => item.id === provider.id);
  options.assert(observed.length === 1 && exactJson(observed[0]) === exactJson(exactLegacyDescriptor(provider)),
    'Disabled-empty provider draft did not survive ordinary restart exactly');
  await route(options);
  const unchanged = providerRoutingSnapshot(await snapshot(options.cdp));
  options.assert(await toggleByName(options.cdp, provider.name), 'Disabled-empty provider Enable control was not reachable');
  const rejection = await options.poll(() => options.cdp.evaluate(`(() => ({ /*provider-controls:invalid-enable-snapshot*/
    status: document.querySelector('#toasts .toast:last-child')?.textContent ?? '',
    fresh: Boolean(document.querySelector('#toasts .toast:last-child')) && document.querySelector('#toasts .toast:last-child') !== window.__providerControlsPreviousToggleToast
  }))()`), (value) => value.fresh && /Could not update source|capabilit/i.test(value.status), undefined, 'fresh disabled-empty Enable feedback');
  options.assert(providerRoutingSnapshot(await snapshot(options.cdp)) === unchanged, 'Rejected disabled-empty Enable changed providers or preference');
  await options.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(provider.id)})`);
  const remaining = await options.cdp.evaluate('window.satBrowser.providers.list()');
  options.assert(remaining.every((item) => item.id !== provider.id), 'Disabled-empty provider cleanup did not remove the exact owned id');
  const final = await snapshot(options.cdp);
  options.assert(exactRoutingSnapshot(final) === exactRoutingSnapshot(initial, provider.id),
    'Disabled draft restart cleanup changed pre-existing providers, preference, or routing settings');
  return { schemaVersion: 1, persisted: true, enabled: false, capabilities: [], invalidEnableRejected: rejection.fresh,
    preexistingStatePreserved: true, cleaned: true };
}

export async function runPackagedProviderControlChecks(rawOptions) {
  const options = requireOptions(rawOptions);
  const provider = options.fixtureProvider;
  const initial = await snapshot(options.cdp);
  options.assert(initial.network === 'mainnet', 'Provider controls fixture requires the mainnet page initially');
  options.assert(initial.providers.every((item) => item.id !== provider.id), 'Owned provider fixture id already exists');
  options.assert(initial.providers.every((item) => item.name !== provider.name && item.name !== `${provider.name} edited`), 'Owned provider fixture name is not unique');
  if (options.legacyProvider) {
    const seededLegacy = initial.providers.filter((item) => item.id === options.legacyProvider.id);
    options.assert(seededLegacy.length === 1, 'Owned legacy provider fixture is not present exactly once');
    options.assert(exactJson(seededLegacy[0]) === exactJson(exactLegacyDescriptor(options.legacyProvider)),
      'Owned legacy provider fixture does not exactly match its expected canonical configuration');
    options.assert(initial.providers.every((item) => item.id === options.legacyProvider.id || item.name !== options.legacyProvider.name),
      'Owned legacy provider fixture name is not unique');
    options.assert(initial.preferredProviderId !== options.legacyProvider.id, 'Owned legacy provider fixture must not be preferred');
  }
  const ownedIds = new Set([provider.id, options.legacyProvider?.id].filter(Boolean));
  const initialProviderJson = JSON.stringify(providerConfigurations(initial.providers.filter((item) => !ownedIds.has(item.id))));
  const ordCapabilities = ['ord-recursion', 'inscription', 'inscription-number', 'sat', 'block', 'transaction-raw', 'output', 'satpoint', 'address', 'rune'];
  const editedName = `${provider.name} edited`;
  const ownerToken = randomUUID();
  const evidence = [];
  let primaryFailure;
  let retainLegacy = false;
  try {
    await route(options);

    if (options.legacyProvider) {
      const legacy = options.legacyProvider;
      options.assert(await toggleByName(options.cdp, legacy.name), 'Legacy provider Disable control was not reachable');
      await waitProvider(options, (value) => {
        const item = value.providers.find((candidate) => candidate.id === legacy.id);
        return exactJson(item) === exactJson(exactLegacyDescriptor(legacy, { enabled: false }));
      }, 'legacy provider disabled without losing declarations');
      const disabledSnapshot = providerRoutingSnapshot(await snapshot(options.cdp));
      options.assert(await toggleByName(options.cdp, legacy.name), 'Invalid legacy provider Enable control was not reachable');
      const invalidEnable = await options.poll(() => options.cdp.evaluate(`(() => ({ /*provider-controls:invalid-enable-snapshot*/
        status: document.querySelector('#toasts .toast:last-child')?.textContent ?? '',
        fresh: Boolean(document.querySelector('#toasts .toast:last-child')) && document.querySelector('#toasts .toast:last-child') !== window.__providerControlsPreviousToggleToast
      }))()`), (value) => value.fresh && /Could not update source|not supported|capabilit/i.test(value.status), undefined, 'fresh incompatible legacy Enable feedback');
      options.assert(providerRoutingSnapshot(await snapshot(options.cdp)) === disabledSnapshot, 'Rejected legacy Enable changed authoritative provider configuration or preference');
      options.assert(await cardActionByName(options.cdp, legacy.name, 'Edit', ownerToken), 'Legacy provider Edit control was not reachable');
      await waitModal(options, ownerToken, [`Edit ${legacy.name}`], true, 'owned legacy Edit modal');
      const repaired = await selectCapabilities(options.cdp, ['block']);
      options.assert(JSON.stringify(repaired?.available) === JSON.stringify(providerCapabilitiesFor('mempool')), 'Legacy Mempool repair checkbox inventory diverged from the shared contract');
      options.assert(await modalAction(options.cdp, 'Save source'), 'Legacy provider repair could not be submitted');
      await waitProvider(options, (value) => {
        const item = value.providers.find((candidate) => candidate.id === legacy.id);
        return exactJson(item) === exactJson(exactLegacyDescriptor(legacy, { enabled: false, capabilities: ['block'] }));
      }, 'legacy provider repaired while disabled');
      await waitModal(options, ownerToken, [], false, 'Legacy Edit modal closed after repair');
      options.assert(await toggleByName(options.cdp, legacy.name), 'Repaired legacy provider Enable control was not reachable');
      await waitProvider(options, (value) => {
        const item = value.providers.find((candidate) => candidate.id === legacy.id);
        return exactJson(item) === exactJson(exactLegacyDescriptor(legacy, { capabilities: ['block'] }));
      }, 'repaired legacy provider enabled');
      evidence.push({ branch: 'legacy-disable-repair-enable', id: legacy.id, invalidEnableRejected: invalidEnable.fresh,
        retainedBeforeRepair: legacy.capabilities, repaired: ['block'] });
    }
    const workflowBaseline = await snapshot(options.cdp);

    options.assert(await openAdd(options.cdp, 'invalid-open', ownerToken), 'Add source control was not reachable for validation');
    await waitModal(options, ownerToken, ['Add a data source'], true, 'owned invalid Add modal');
    const beforeInvalid = JSON.stringify(providerConfigurations((await snapshot(options.cdp)).providers));
    options.assert(await modalAction(options.cdp, 'Save source', { Identifier: 'INVALID ID', Name: provider.name,
      'Base URL': provider.baseUrl }), 'Invalid provider form could not be submitted');
    const invalid = await options.poll(() => options.cdp.evaluate(`(() => ({ /*provider-controls:invalid-snapshot*/
      modalVisible: !document.querySelector('#modal-backdrop')?.classList.contains('hidden'),
      status: document.querySelector('#toasts .toast:last-child')?.textContent ?? '',
      fresh: Boolean(document.querySelector('#toasts .toast:last-child')) && document.querySelector('#toasts .toast:last-child') !== document.querySelector('#modal')?.__providerControlsPreviousToast
    }))()`), (value) => value.modalVisible && value.fresh && /Could not save source|invalid/i.test(value.status), undefined, 'fresh invalid provider feedback');
    options.assert(JSON.stringify(providerConfigurations((await snapshot(options.cdp)).providers)) === beforeInvalid, 'Invalid provider submission changed provider configuration');
    evidence.push({ branch: 'validation', modalRetained: invalid.modalVisible });
    options.assert(await modalAction(options.cdp, 'Cancel'), 'Invalid provider modal could not be cancelled');
    await waitModal(options, ownerToken, [], false, 'invalid Add modal closed');

    options.assert(await openAdd(options.cdp, 'cancel-open', ownerToken), 'Add source control was not reachable for cancellation');
    await waitModal(options, ownerToken, ['Add a data source'], true, 'owned Add cancellation modal');
    options.assert(await modalAction(options.cdp, 'Cancel'), 'Add source cancellation control was not reachable');
    await waitModal(options, ownerToken, [], false, 'Add cancellation modal closed');
    options.assert(providerRoutingSnapshot(await snapshot(options.cdp)) === providerRoutingSnapshot(workflowBaseline), 'Cancelled add changed providers or preference');
    evidence.push({ branch: 'add-cancel', unchanged: true });

    options.assert(await openAdd(options.cdp, 'add-open', ownerToken), 'Add source control was not reachable');
    await waitModal(options, ownerToken, ['Add a data source'], true, 'owned Add modal');
    options.assert(await modalAction(options.cdp, 'Save source', { Identifier: provider.id, Name: provider.name,
      'Adapter type': provider.type, 'Bitcoin network': provider.network, 'Base URL': provider.baseUrl, Priority: provider.priority }), 'Provider form could not be submitted');
    await waitProvider(options, (value) => value.providers.some((item) => matchesProvider(item, { ...provider, name: provider.name,
      type: 'ord-server', network: 'mainnet', baseUrl: provider.baseUrl, priority: provider.priority, capabilities: ordCapabilities })), 'provider added with exact Ord defaults');
    await waitModal(options, ownerToken, [], false, 'Add modal closed after save');
    evidence.push({ branch: 'add', id: provider.id });

    options.assert(await cardActionByName(options.cdp, provider.name, 'Edit', ownerToken), 'Edit control was not reachable');
    await waitModal(options, ownerToken, [`Edit ${provider.name}`], true, 'owned Edit modal');
    const beforeEmptyCapabilities = providerRoutingSnapshot(await snapshot(options.cdp));
    const emptySelection = await selectCapabilities(options.cdp, []);
    options.assert(Array.isArray(emptySelection?.selected) && emptySelection.selected.length === 0, 'Capability checkboxes could not be cleared');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Empty capability form could not be submitted');
    const emptyRejected = await options.poll(() => options.cdp.evaluate(`(() => ({ /*provider-controls:empty-capability-snapshot*/
      modalVisible: !document.querySelector('#modal-backdrop')?.classList.contains('hidden'),
      status: document.querySelector('#toasts .toast:last-child')?.textContent ?? '',
      fresh: Boolean(document.querySelector('#toasts .toast:last-child')) && document.querySelector('#toasts .toast:last-child') !== document.querySelector('#modal')?.__providerControlsPreviousToast
    }))()`), (value) => value.modalVisible && value.fresh && /Choose at least one supported capability/i.test(value.status), undefined, 'fresh empty capability feedback');
    options.assert(emptyRejected.modalVisible, 'Empty capability rejection closed the repairable provider modal');
    options.assert(providerRoutingSnapshot(await snapshot(options.cdp)) === beforeEmptyCapabilities, 'Empty capability rejection changed providers or preference');
    evidence.push({ branch: 'empty-capability-rejected', modalRetained: true });

    options.assert(await modalAction(options.cdp, null, { Name: editedName, 'Adapter type': 'mempool',
      'Bitcoin network': 'testnet', Priority: provider.priority + 1 }), 'Mempool provider fields could not be prepared');
    const mempoolCapabilities = ['block', 'address'];
    const mempoolSelection = await selectCapabilities(options.cdp, mempoolCapabilities);
    options.assert(JSON.stringify(mempoolSelection?.available) === JSON.stringify(providerCapabilitiesFor('mempool')), 'Mempool checkbox inventory diverged from the shared contract');
    options.assert(JSON.stringify(mempoolSelection?.selected) === JSON.stringify(mempoolCapabilities), 'Mempool capability checkboxes did not retain the exact selection');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Mempool provider form could not be submitted');
    await waitProvider(options, (value) => value.providers.some((item) => matchesProvider(item, { ...provider, name: editedName,
      type: 'mempool', network: 'testnet', baseUrl: provider.baseUrl, priority: provider.priority + 1,
      capabilities: mempoolCapabilities })), 'provider edited with exact Mempool configuration');
    await waitModal(options, ownerToken, [], false, 'Mempool Edit modal closed after save');

    await switchNetworkViaUi(options, 'testnet', editedName);
    options.assert(await cardActionByName(options.cdp, editedName, 'Edit', ownerToken), 'Mempool Edit control was not reachable');
    await waitModal(options, ownerToken, [`Edit ${editedName}`], true, 'owned Mempool Edit modal');
    options.assert(await modalAction(options.cdp, null, { 'Adapter type': 'bitcoin-core' }), 'Bitcoin Core provider fields could not be prepared');
    const coreCapabilities = ['transaction-raw', 'output'];
    const coreSelection = await selectCapabilities(options.cdp, coreCapabilities);
    options.assert(JSON.stringify(coreSelection?.available) === JSON.stringify(providerCapabilitiesFor('bitcoin-core')), 'Bitcoin Core checkbox inventory diverged from the shared contract');
    options.assert(JSON.stringify(coreSelection?.selected) === JSON.stringify(coreCapabilities), 'Bitcoin Core capability checkboxes did not retain the exact selection');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Bitcoin Core provider form could not be submitted');
    await waitProvider(options, (value) => value.providers.some((item) => matchesProvider(item, { ...provider, name: editedName,
      type: 'bitcoin-core', network: 'testnet', baseUrl: provider.baseUrl, priority: provider.priority + 1,
      capabilities: coreCapabilities })), 'provider edited with exact Bitcoin Core configuration');
    await waitModal(options, ownerToken, [], false, 'Bitcoin Core Edit modal closed after save');

    options.assert(await cardActionByName(options.cdp, editedName, 'Edit', ownerToken), 'Bitcoin Core Edit control was not reachable');
    await waitModal(options, ownerToken, [`Edit ${editedName}`], true, 'owned Bitcoin Core Edit modal');
    options.assert(await modalAction(options.cdp, null, { 'Adapter type': 'mock', 'Bitcoin network': 'regtest' }), 'Mock provider fields could not be prepared');
    const mockCapabilities = ['satpoint'];
    const mockSelection = await selectCapabilities(options.cdp, mockCapabilities);
    options.assert(JSON.stringify(mockSelection?.available) === JSON.stringify(providerCapabilitiesFor('mock')), 'Mock checkbox inventory diverged from the shared contract');
    options.assert(JSON.stringify(mockSelection?.selected) === JSON.stringify(mockCapabilities), 'Mock capability checkboxes did not retain the exact selection');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Mock provider form could not be submitted');
    await waitProvider(options, (value) => value.providers.some((item) => matchesProvider(item, { ...provider, name: editedName,
      type: 'mock', network: 'regtest', baseUrl: '', priority: provider.priority + 1, capabilities: mockCapabilities })), 'provider edited with exact Mock configuration');
    await waitModal(options, ownerToken, [], false, 'Mock Edit modal closed after save');

    await switchNetworkViaUi(options, 'regtest', editedName);
    options.assert(await cardActionByName(options.cdp, editedName, 'Edit', ownerToken), 'Mock Edit control was not reachable');
    await waitModal(options, ownerToken, [`Edit ${editedName}`], true, 'owned Mock Edit modal');
    options.assert(await modalAction(options.cdp, null, { 'Adapter type': 'ord-server', 'Bitcoin network': 'mainnet',
      'Base URL': provider.baseUrl }), 'Ord restore fields could not be prepared');
    const ordSelection = await selectCapabilities(options.cdp, ordCapabilities);
    options.assert(JSON.stringify(ordSelection?.available) === JSON.stringify(providerCapabilitiesFor('ord-server')), 'Ord checkbox inventory diverged from the shared contract');
    options.assert(JSON.stringify(ordSelection?.selected) === JSON.stringify(ordCapabilities), 'Ord default capability checkboxes were not available');
    options.assert(await modalAction(options.cdp, 'Save source'), 'Ord restore form could not be submitted');
    await waitProvider(options, (value) => value.providers.some((item) => matchesProvider(item, { ...provider, name: editedName,
      type: 'ord-server', network: 'mainnet', baseUrl: provider.baseUrl, priority: provider.priority + 1,
      capabilities: ordCapabilities })), 'provider restored to exact Ord configuration');
    await waitModal(options, ownerToken, [], false, 'Ord restore modal closed after save');
    await switchNetworkViaUi(options, 'mainnet', editedName);
    evidence.push({ branch: 'edit-adapters-networks-capabilities', name: editedName, priority: provider.priority + 1,
      types: ['ord-server', 'mempool', 'bitcoin-core', 'mock'], networks: ['mainnet', 'testnet', 'regtest'] });

    options.assert(await cardActionByName(options.cdp, editedName, 'Prefer', ownerToken), 'Prefer control was not reachable');
    await waitProvider(options, (value) => value.preferredProviderId === provider.id, 'provider preferred');
    options.assert(await cardActionByName(options.cdp, editedName, 'Auto', ownerToken), 'Auto routing control was not reachable');
    await waitProvider(options, (value) => value.preferredProviderId === null, 'automatic routing restored');
    evidence.push({ branch: 'prefer-auto', preferredThenAutomatic: true });

    const toggle = async (enabled) => {
      const result = await options.cdp.evaluate(`(() => { /*provider-controls:toggle*/
        const cards = [...document.querySelectorAll('#page .provider-card')].filter((node) => {
          const strong = node.querySelector('.provider-copy strong');
          const directText = [...(strong?.childNodes ?? [])].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('').trim();
          return directText === ${JSON.stringify(editedName)};
        });
        if (cards.length !== 1) return false;
        const button = cards[0].querySelector('button[role="switch"]'); if (!button) return false; button.click(); return true;
      })()`);
      options.assert(result, 'Provider enable/disable control was not reachable');
      await waitProvider(options, (value) => value.providers.find((item) => item.id === provider.id)?.enabled === enabled, `provider ${enabled ? 'enabled' : 'disabled'}`);
    };
    await toggle(false); await toggle(true);
    evidence.push({ branch: 'disable-enable', finalEnabled: true });

    const beforeRemoveCancel = providerRoutingSnapshot(await snapshot(options.cdp));
    options.assert(await cardActionByName(options.cdp, editedName, 'Edit', ownerToken), 'Edit control was not reachable for remove cancellation');
    await waitModal(options, ownerToken, [`Edit ${editedName}`], true, 'owned Edit modal for remove cancellation');
    options.assert(await modalAction(options.cdp, 'Remove'), 'Remove confirmation was not reachable');
    await waitModal(options, ownerToken, [editedName], true, 'owned Remove confirmation');
    options.assert(await modalAction(options.cdp, 'Cancel'), 'Remove cancellation was not reachable');
    await waitModal(options, ownerToken, [], false, 'Remove cancellation modal closed');
    options.assert(providerRoutingSnapshot(await snapshot(options.cdp)) === beforeRemoveCancel, 'Cancelled remove changed providers or preference');
    options.assert(await cardActionByName(options.cdp, editedName, 'Edit', ownerToken), 'Edit control was not reachable for removal');
    await waitModal(options, ownerToken, [`Edit ${editedName}`], true, 'owned Edit modal for removal');
    options.assert(await modalAction(options.cdp, 'Remove'), 'Remove confirmation was not reachable for removal');
    await waitModal(options, ownerToken, [editedName], true, 'owned permanent Remove confirmation');
    options.assert(await modalAction(options.cdp, 'Remove permanently'), 'Permanent remove control was not reachable');
    await waitProvider(options, (value) => value.providers.every((item) => item.id !== provider.id), 'provider removed');
    await waitModal(options, ownerToken, [], false, 'Remove confirmation closed after removal');
    evidence.push({ branch: 'remove-cancel-confirm', removed: true });

    const final = await snapshot(options.cdp);
    options.assert(JSON.stringify(providerConfigurations(final.providers.filter((item) => !ownedIds.has(item.id)))) === initialProviderJson, 'Provider controls changed a pre-existing provider configuration');
    options.assert(final.network === initial.network && final.localOnly === initial.localOnly && final.offlineMode === initial.offlineMode, 'Provider controls changed routing mode settings');
    retainLegacy = options.retainLegacyForRestart === true;
    return { schemaVersion: 1, fixtureId: provider.id, evidence, authoritativeCleanupVerified: true,
      deferredCleanup: retainLegacy ? { providerId: options.legacyProvider.id, reason: 'restart-readback' } : null,
      scope: 'Real packaged DOM controls with preload API readback; native dialogs, credentials, and provider transport are not exercised.' };
  } catch (error) {
    primaryFailure = error;
    error.evidence = { ...(error.evidence ?? {}), fixtureId: provider.id, steps: evidence };
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (phase, action) => { try { await action(); } catch (error) { cleanupErrors.push({ phase, message: String(error?.message ?? error).slice(0, 1024) }); } };
    await cleanup('dismiss-owned-modal', async () => {
      const clicked = await options.cdp.evaluate(`(() => { /*provider-controls:cleanup-modal*/
        const modal = document.querySelector('#modal');
        const visible = !document.querySelector('#modal-backdrop')?.classList.contains('hidden');
        const expected = new Set(${JSON.stringify(['Add a data source', `Edit ${provider.name}`, `Edit ${editedName}`, provider.name, editedName,
          ...(options.legacyProvider ? [`Edit ${options.legacyProvider.name}`, options.legacyProvider.name] : [])])});
        if (!visible || modal?.dataset.providerControlsOwner !== ${JSON.stringify(ownerToken)}) return false;
        if (!expected.has(modal.querySelector('h2')?.textContent?.trim())) throw new Error('Owned provider modal has an unexpected heading');
        const close = modal.querySelector('.modal-close'); if (!close) throw new Error('Owned provider modal has no close control');
        close.click(); return true;
      })()`);
      if (clicked) await waitModal(options, ownerToken, [], false, 'owned provider modal cleanup');
    });
    await cleanup('remove-owned-provider', () => options.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(provider.id)})`));
    if (options.legacyProvider && !retainLegacy) await cleanup('remove-owned-legacy-provider', () => options.cdp.evaluate(`window.satBrowser.providers.remove(${JSON.stringify(options.legacyProvider.id)})`));
    await cleanup('restore-settings', () => options.cdp.evaluate(`window.satBrowser.settings.update(${JSON.stringify({ network: initial.network, localOnly: initial.localOnly, offlineMode: initial.offlineMode })})`));
    await cleanup('restore-preference', () => options.cdp.evaluate(`window.satBrowser.providers.preferred(${JSON.stringify(initial.preferredProviderId)})`));
    await cleanup('verify-cleanup', async () => {
      const restored = await snapshot(options.cdp);
      options.assert(JSON.stringify(providerConfigurations(restored.providers.filter((item) => !ownedIds.has(item.id)))) === initialProviderJson
        && restored.providers.every((item) => item.id !== provider.id)
        && (!options.legacyProvider || retainLegacy || restored.providers.every((item) => item.id !== options.legacyProvider.id))
        && restored.preferredProviderId === initial.preferredProviderId
        && restored.network === initial.network && restored.localOnly === initial.localOnly && restored.offlineMode === initial.offlineMode,
      'Provider control cleanup did not restore authoritative state');
    });
    if (cleanupErrors.length) {
      if (primaryFailure) primaryFailure.evidence.cleanupErrors = cleanupErrors;
      else { const error = new Error(`Provider control cleanup failed: ${cleanupErrors[0].message}`); error.evidence = { steps: evidence, cleanupErrors }; throw error; }
    }
  }
}
