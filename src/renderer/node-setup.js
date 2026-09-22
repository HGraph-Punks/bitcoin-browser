import { button, formatBytes, h } from './dom.js';
import { nodeSetupGuidance, nodeSetupDisplayWarnings } from '../shared/node-setup-guidance.js';
import { CORE_SNAPSHOT_BASES, isQuickStart, SNAPSHOT_GUIDE_URL } from '../shared/node-snapshot.js';
import { renderEasyNodeSetup } from './easy-node-setup.js';

const STEPS = ['Choose', 'Software', 'Storage & connections', 'Review', 'Progress'];
const OFFICIAL = Object.freeze({ core: 'https://bitcoincore.org/en/download/', ord: 'https://github.com/ordinals/ord/releases' });
const CORE_DEFAULTS = Object.freeze({ mainnet: 8332, testnet: 18332, signet: 38332, regtest: 18443 });
let fieldSequence = 0;

function initialDraft() {
  return {
    choice: 'both', network: 'mainnet', rootDirectory: '', autoStart: false,
    core: { mode: 'managed', executable: '', rpcPort: 8332, rpcUrl: 'http://127.0.0.1:8332', cookieFile: '', storage: 'archive' },
    ord: { mode: 'managed', executable: '', httpPort: 8080, serverUrl: 'http://127.0.0.1:8080', indexSats: false, indexRunes: false }
  };
}

function field(label, control, help = '', owner = 'field') {
  const id = `node-setup-${owner}-${++fieldSequence}`;
  control.id = id;
  return h('div', { className: 'node-setup-field' }, h('label', { htmlFor: id }, label), control,
    help ? h('p', { className: 'node-setup-help' }, help) : null);
}

function choiceButton(label, value, selected, onClick, description) {
  return h('button', { type: 'button', className: `node-setup-choice${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), onClick },
    h('strong', {}, label), h('span', {}, description));
}

export function renderNodeSetup(ctx) {
  const state = {
    step: 0, draft: initialDraft(), inspection: null, preview: null, applied: null, status: null,
    busy: false, busyLabel: '', error: '', statusError: '', statusRevision: 0,
    disposed: false, timer: null, polling: false, draftRevision: 0, regtestPeerConnections: null, snapshotSelection: null,
    easyView: null, customized: false, easyCompleted: false
  };
  const touchDraft = () => { state.draftRevision += 1; state.preview = null; };
  const edit = (change, repaint = false) => {
    if (state.disposed || state.busy) return false;
    touchDraft(); change(); if (repaint) render(); return true;
  };
  const model = () => typeof ctx.model === 'function' ? ctx.model() : (ctx.model ?? {});
  const root = h('section', { className: 'node-setup', dataset: { owner: String(model().activeTabId ?? '') } });

  const act = async (action, payload = {}, busyLabel = 'Working…') => {
    if (state.disposed || state.busy) return null;
    if (action === 'start' || action === 'stop' || action === 'snapshot-load') {
      // A read admitted before this action cannot describe its outcome. Keep
      // its eventual result/error from replacing the lifecycle response.
      state.statusRevision += 1; state.status = null; state.statusError = '';
    }
    state.busy = true; state.busyLabel = busyLabel; state.error = ''; render();
    try { return await ctx.nodeSetup(action, payload); }
    catch (error) { if (!state.disposed) state.error = String(error?.message ?? error); return null; }
    finally { if (!state.disposed) { state.busy = false; state.busyLabel = ''; render(); } }
  };
  const pick = async (kind, assign) => {
    const result = await act('pick', { kind });
    if (result?.path && !state.disposed) { touchDraft(); assign(result.path); render(); }
  };
  const install = async (kind) => {
    const result = await act('install', { kind }, 'Downloading and verifying…');
    if (result?.executable && !state.disposed) {
      touchDraft();
      state.draft[kind].executable = result.executable;
      state.inspection = { ...(state.inspection ?? {}), installed: { ...(state.inspection?.installed ?? {}), [kind]: result } };
      render();
    }
  };
  const validate = () => {
    const d = state.draft;
    if (nodeSetupGuidance(d).managed && !d.rootDirectory.trim()) return 'Choose a parent folder for fresh node data folders.';
    if (['both', 'core'].includes(d.choice) && d.core.mode === 'managed' && !d.core.executable) return 'Choose or download Bitcoin Core.';
    if (['both', 'ord'].includes(d.choice) && d.ord.mode === 'managed' && !d.ord.executable) return 'Choose or download Ord.';
    if (d.choice === 'both' && d.core.mode === 'managed' && d.ord.mode === 'managed' && d.core.storage !== 'archive') return 'Core must use archive storage when managed Ord is included.';
    if (['both', 'core'].includes(d.choice) && d.core.mode === 'existing' && (!d.core.rpcUrl || !d.core.cookieFile)) return 'The running Core service needs an RPC URL and cookie file.';
    if (d.choice === 'ord' && d.ord.mode === 'managed' && (!d.core.rpcUrl || !d.core.cookieFile)) return 'Managed Ord needs an existing Core RPC URL and cookie file.';
    if (d.core.sync === 'snapshot' && (!isQuickStart(d) || d.network !== 'mainnet' || d.core.storage !== 'pruned')) return 'Quick start needs managed compact mainnet Core.';
    return '';
  };
  const preview = async () => {
    const error = validate();
    if (error) { state.error = error; render(); return; }
    const revision = state.draftRevision;
    const value = await act('preview', { draft: structuredClone(state.draft) });
    if (value && !state.disposed && revision === state.draftRevision) { state.preview = value; render(); }
  };
  const apply = async () => {
    if (!state.preview?.token) return;
    if (state.disposed || state.busy) return;
    state.busy = true; state.busyLabel = 'Working…'; state.error = ''; render();
    try {
      const value = await ctx.nodeSetup('apply', { token: state.preview.token });
      if (value?.committed && !state.disposed) { state.applied = value; state.step = 4; render(); schedulePoll(); }
    } catch (error) {
      if (!state.disposed && error?.details?.setupCommitted === true && error.details.setupId) {
        state.applied = { setupId: error.details.setupId, committed: true };
        state.step = 4;
        state.error = 'Setup was saved, but its latest status could not be read. Refresh status; do not submit the setup again.';
        schedulePoll();
      } else if (!state.disposed) state.error = String(error?.message ?? error);
    } finally { if (!state.disposed) { state.busy = false; state.busyLabel = ''; render(); } }
  };
  const refreshStatus = async () => {
    if (!state.applied?.setupId || state.polling || state.disposed || state.busy) return;
    const revision = state.statusRevision;
    state.polling = true; render();
    try {
      const value = await ctx.nodeSetup('status', { setupId: state.applied.setupId });
      if (value && !state.disposed && revision === state.statusRevision) { state.status = value; state.statusError = ''; render(); }
    } catch (error) {
      if (!state.disposed && revision === state.statusRevision) { state.statusError = String(error?.message ?? error); render(); }
    }
    finally { state.polling = false; if (!state.disposed) render(); }
  };
  const schedulePoll = () => {
    clearTimeout(state.timer);
    if (!state.disposed && state.step === 4 && state.applied?.setupId) state.timer = setTimeout(async () => {
      await refreshStatus(); schedulePoll();
    }, 10_000);
  };

  function softwarePanel(kind, selected) {
    if (!selected) return null;
    const config = state.draft[kind];
    const catalog = state.inspection?.catalog?.[kind] ?? null;
    const detected = state.inspection?.detected?.[kind] ?? [];
    const changeMode = value => {
      config.mode = value;
      if (kind === 'core' && value === 'existing') delete state.draft.core.sync;
      if (kind === 'ord' && value === 'managed' && state.draft.choice === 'both') { delete state.draft.core.sync; state.draft.core.storage = 'archive'; }
    };
    const mode = h('select', { value: config.mode, onChange: (event) => edit(() => changeMode(event.currentTarget.value), true) },
      h('option', { value: 'managed', selected: config.mode === 'managed' }, 'Let Bitcoin Browser manage it'), h('option', { value: 'existing', selected: config.mode === 'existing' }, 'Use a running service'));
    const actions = config.mode === 'managed' ? h('div', { className: 'node-setup-actions' },
      button(catalog ? 'Download for me' : 'Open official downloads', { onClick: () => catalog ? install(kind) : ctx.openExternal?.(OFFICIAL[kind]), disabled: state.busy }),
      button('Choose installed program', { onClick: () => pick(`${kind}-executable`, value => { config.executable = value; }), disabled: state.busy }),
      button('Use running service', { onClick: () => edit(() => changeMode('existing'), true), disabled: state.busy })) : null;
    return h('section', { className: 'node-setup-panel' }, h('h2', {}, kind === 'core' ? 'Bitcoin Core' : 'Ord'),
      field(`${kind === 'core' ? 'Core' : 'Ord'} setup mode`, mode, '', `${kind}-mode`), actions,
      config.mode === 'existing' ? field(kind === 'core' ? 'Running Core RPC URL' : 'Running Ord server URL',
        h('input', { className: 'field', value: kind === 'core' ? config.rpcUrl : config.serverUrl, onInput: event => {
          edit(() => { if (kind === 'core') config.rpcUrl = event.currentTarget.value; else config.serverUrl = event.currentTarget.value; });
        } }), '', `${kind}-url`) : null,
      config.executable ? h('p', { className: 'node-setup-path' }, config.executable) : null,
      config.mode === 'managed' ? detected.map((value, index) => button(`Use detected ${kind}: ${value}`, { onClick: () => edit(() => { config.executable = value; }, true), disabled: state.busy, key: `${kind}-${index}` })) : null,
      state.inspection?.installed?.[kind] ? h('p', { className: 'node-setup-help' }, `Installed ${state.inspection.installed[kind].version ?? 'version not reported'}; SHA-256 ${state.inspection.installed[kind].sha256 ?? 'not reported'}; publisher signature not verified.`) : null,
      config.mode === 'managed' && catalog ? h('p', { className: 'node-setup-help' }, `Download ${catalog.version ?? 'reviewed version'} with pinned SHA-256 integrity. Publisher signature verification is not claimed.`)
        : config.mode === 'managed' ? h('p', { className: 'node-setup-warning' }, 'Automatic download is unavailable on this platform. Open the official download page and choose the installed program.') : null);
  }

  function chooseStep() {
    const bothGuidance = nodeSetupGuidance({ ...state.draft, choice: 'both', core: { ...state.draft.core, storage: 'archive', sync: 'standard' } });
    return h('div', {}, h('h1', {}, 'Set up a local Bitcoin node'), h('p', {}, 'Choose only what you need. Nothing is installed or started until you explicitly ask.'),
      state.inspection?.saved ? h('div', { className: 'node-setup-panel' }, h('strong', {}, 'Existing guided setup found'),
        h('p', {}, 'Resume its progress without changing or deleting its saved services, providers, or data.'),
        button('Resume existing setup', { onClick: () => {
          state.applied = { setupId: state.inspection.saved.id, committed: true, setup: state.inspection.saved };
          state.status = state.inspection.saved.status ?? null; state.step = 4; render(); schedulePoll();
        } })) : null,
      state.inspection?.recovery ? h('div', { className: 'node-setup-warning' }, h('strong', {}, 'Saved setup needs attention'), h('p', {}, String(state.inspection.recovery.message ?? state.inspection.recovery)), h('p', {}, 'Use Advanced local services or Advanced data sources to review the saved definitions. Nothing was deleted.')) : null,
      h('div', { className: 'node-setup-choices' },
        choiceButton('Bitcoin Core + Ord', 'both', state.draft.choice === 'both', () => edit(() => { state.draft.choice = 'both'; state.draft.core.storage = 'archive'; delete state.draft.core.sync; }, true), `Browse inscriptions with your own node. ${bothGuidance.choiceText}`),
        choiceButton('Bitcoin Core only', 'core', state.draft.choice === 'core', () => edit(() => { state.draft.choice = 'core'; }, true), 'Run Bitcoin Core without an inscription index.'),
        choiceButton('Ord only', 'ord', state.draft.choice === 'ord', () => edit(() => { state.draft.choice = 'ord'; delete state.draft.core.sync; }, true), 'Connect Ord to an existing Core service.'),
        choiceButton('Not now', 'none', state.draft.choice === 'none', () => edit(() => { state.draft.choice = 'none'; delete state.draft.core.sync; }, true), 'Continue browsing without changing configuration.')));
  }

  function syncChoices(d) {
    if (!['both', 'core'].includes(d.choice) || d.core.mode !== 'managed') return null;
    const needsArchive = d.choice === 'both' && d.ord.mode === 'managed';
    const choose = value => edit(() => { d.core.storage = value === 'archive' ? 'archive' : 'pruned'; if (value === 'snapshot') d.core.sync = 'snapshot'; else delete d.core.sync; }, true);
    return h('section', { className: 'node-sync-options', ariaLabel: 'Bitcoin Core sync and storage' },
      h('h2', {}, 'How would you like to run Bitcoin?'),
      h('p', { className: 'node-setup-help' }, 'All modes keep Bitcoin Core’s validation rules. Choose storage and startup speed to suit this device.'),
      h('div', { className: 'node-sync-choices' },
        !needsArchive ? choiceButton('Compact node', 'pruned', d.core.storage === 'pruned' && !isQuickStart(d), () => choose('pruned'), 'Less disk space. Downloads and processes history, then removes older blocks. No snapshot needed.') : null,
        !needsArchive && d.network === 'mainnet' ? choiceButton('Quick-start compact node', 'snapshot', isQuickStart(d), () => choose('snapshot'), 'Get current sooner with a supported snapshot file. Core still downloads and validates earlier history in the background.') : null,
        choiceButton('Complete archive', 'archive', d.core.storage === 'archive', () => choose('archive'), 'Keep all blocks and a transaction index. Required for this browser’s managed Ord setup.')),
      needsArchive ? h('p', { className: 'node-setup-help' }, 'Managed Ord needs complete history. Choose Bitcoin Core only if you prefer a compact node and a separate inscription/Runes source.')
        : d.network !== 'mainnet' ? h('p', { className: 'node-setup-help' }, 'Quick start is currently available for mainnet with Core 31.x.') : null,
      isQuickStart(d) ? h('div', { className: 'node-snapshot-help' }, h('strong', {}, 'Have a snapshot file ready'),
        h('p', {}, 'After saving and starting Core, choose an uncompressed UTXO snapshot. The browser recognizes its header; Core verifies the full commitment. Nothing imports automatically.'),
        h('p', {}, `Supported mainnet snapshot heights: ${CORE_SNAPSHOT_BASES.map(row => row.height.toLocaleString()).join(', ')}. Newer supported snapshots reduce catch-up work.`),
        button('How to obtain a snapshot', { small: true, onClick: () => ctx.openExternal?.(SNAPSHOT_GUIDE_URL) }),
        h('p', {}, 'There is no automatic snapshot download in this version. No arbitrary mirror is selected for you. You can continue ordinary compact sync without a snapshot.')) : null);
  }

  function storageStep() {
    const d = state.draft;
    const guidance = nodeSetupGuidance(d);
    const hasCore = ['both', 'core'].includes(d.choice);
    const ordCoreDependency = d.choice === 'ord' && d.ord.mode === 'managed';
    const needsExistingCore = (hasCore && d.core.mode === 'existing') || ordCoreDependency;
    const managedSelected = guidance.managed;
    return h('div', {}, h('h1', {}, 'Storage and connections'),
      field('Network', h('select', { value: d.network, onChange: e => edit(() => {
        const oldPort = CORE_DEFAULTS[d.network]; const nextPort = CORE_DEFAULTS[e.currentTarget.value];
        if (d.core.rpcPort === oldPort) d.core.rpcPort = nextPort;
        if (d.core.rpcUrl === `http://127.0.0.1:${oldPort}`) d.core.rpcUrl = `http://127.0.0.1:${nextPort}`;
        if (d.network !== e.currentTarget.value) {
          if (d.network === 'regtest') state.regtestPeerConnections = d.core.peerConnections ?? 'automatic';
          if (e.currentTarget.value === 'regtest') d.core.peerConnections = state.regtestPeerConnections ?? 'disabled';
          else delete d.core.peerConnections;
        }
        d.network = e.currentTarget.value;
        if (d.network !== 'mainnet') delete d.core.sync;
      }, true) },
        ...['mainnet', 'testnet', 'signet', 'regtest'].map(value => h('option', { value, selected: value === d.network }, value)))),
      managedSelected ? field('Parent folder', h('input', { className: 'field', value: d.rootDirectory, readOnly: true }), 'Fresh named subfolders will be created for managed services. Existing personal configuration is not edited.') : null,
      managedSelected ? button('Choose parent folder', { onClick: () => pick('directory', value => { d.rootDirectory = value; }), disabled: state.busy }) : null,
      syncChoices(d),
      needsExistingCore ? field('Core RPC URL', h('input', { className: 'field', value: d.core.rpcUrl, onInput: e => edit(() => { d.core.rpcUrl = e.currentTarget.value; }) }), '', 'core-rpc-url') : null,
      needsExistingCore ? h('div', { className: 'node-setup-dependency' },
        h('strong', {}, ordCoreDependency ? 'Existing Bitcoin Core required' : 'Core authentication'), h('p', {}, ordCoreDependency ? 'Ord needs a running Core RPC service and its cookie file; this choice does not install Core.' : 'Choose the cookie file for the running Core service.'),
        field('Core cookie file', h('input', { className: 'field', value: d.core.cookieFile, readOnly: true })),
        button('Choose cookie file', { onClick: () => pick('cookie', value => { d.core.cookieFile = value; }), disabled: state.busy })) : null,
      managedSelected ? h('details', {}, h('summary', {}, 'Advanced settings'),
        hasCore && d.core.mode === 'managed' ? field('Core RPC port', h('input', { type: 'number', value: d.core.rpcPort, onInput: e => edit(() => { d.core.rpcPort = Number(e.currentTarget.value); }) })) : null,
        hasCore && d.core.mode === 'managed' ? ['dbCacheMiB', 'validationThreads'].map(key => field(key === 'dbCacheMiB' ? 'Database cache target (MiB)' : 'Validation threads',
          h('input', { type: 'number', value: d.core[key] ?? '', placeholder: 'Core default', min: key === 'dbCacheMiB' ? 64 : 1, max: key === 'dbCacheMiB' ? 16384 : 64,
            onInput: e => edit(() => { if (e.currentTarget.value === '') delete d.core[key]; else d.core[key] = Number(e.currentTarget.value); }) }),
          'Optional. These are not total memory or CPU limits; leave empty to use Core’s default.')) : null,
        hasCore && d.core.mode === 'managed' && d.network === 'regtest' ? field('Core peer connections', h('select', { value: d.core.peerConnections ?? 'automatic', onChange: e => edit(() => {
          d.core.peerConnections = e.currentTarget.value; state.regtestPeerConnections = e.currentTarget.value;
        }) },
          h('option', { value: 'disabled', selected: d.core.peerConnections === 'disabled' }, 'Off — local test chain only'),
          h('option', { value: 'automatic', selected: (d.core.peerConnections ?? 'automatic') === 'automatic' }, 'Automatic — allow peer traffic')),
        'Off disables peer connections and DNS seeding at startup. Blocks must be supplied locally; this is not an OS firewall. Core RPC can change network activity.', 'core-peers') : null,
        ['both', 'ord'].includes(d.choice) && d.ord.mode === 'managed' ? field('Ord HTTP port', h('input', { type: 'number', value: d.ord.httpPort, onInput: e => edit(() => { d.ord.httpPort = Number(e.currentTarget.value); }) })) : null,
        managedSelected ? h('label', { className: 'check-label' }, h('input', { type: 'checkbox', checked: d.autoStart, onChange: e => edit(() => { d.autoStart = e.currentTarget.checked; }) }), 'Start managed services when Bitcoin Browser starts') : null,
        ['both', 'ord'].includes(d.choice) && d.ord.mode === 'managed' ? h('div', {},
          h('label', { className: 'check-label' }, h('input', { type: 'checkbox', checked: d.ord.indexSats, onChange: e => edit(() => { d.ord.indexSats = e.currentTarget.checked; }, true) }), 'Index individual sats'),
          h('label', { className: 'check-label' }, h('input', { type: 'checkbox', checked: d.ord.indexRunes, onChange: e => edit(() => { d.ord.indexRunes = e.currentTarget.checked; }) }), 'Index runes')) : null) : null,
      h('p', { className: managedSelected ? 'node-setup-warning' : 'node-setup-help' }, guidance.storageText));
  }

  function reviewStep() {
    const summary = state.preview?.summary;
    const draft = state.preview?.draft ?? state.draft;
    const guidance = nodeSetupGuidance(draft);
    return h('div', {}, h('h1', {}, 'Review setup'),
      summary ? h('dl', { className: 'node-setup-summary' }, ...Object.entries(summary).map(([key, value]) => [h('dt', {}, ({ choice: 'Software', network: 'Network', coreDataDirectory: 'Core data folder', ordDataDirectory: 'Ord data folder', coreUrl: 'Core RPC URL', ordUrl: 'Ord server URL', corePeerConnections: 'Core peer connections' })[key] ?? key), h('dd', {}, key === 'corePeerConnections' ? (value === 'disabled' ? 'Off — local test chain only' : 'Automatic — allow peer traffic') : String(value ?? '—'))]))
        : h('p', {}, 'Review will calculate directories, services, providers, disk needs, and warnings without changing your computer.'),
      h('p', { className: 'node-setup-help' }, guidance.storageText),
      guidance.coreManaged ? h('p', {}, `Core mode: ${isQuickStart(draft) ? 'Quick-start compact node — snapshot import is a separate, confirmed action' : draft.core.storage === 'pruned' ? 'Compact node — standard historical sync' : 'Complete archive'}.`) : null,
      state.preview?.disk && guidance.managed ? h('p', {}, `Storage recommendation: ${guidance.recommendedBytes === null ? 'Unknown for this test chain' : formatBytes(guidance.recommendedBytes)}. Available in selected parent folder: ${state.preview.disk.availableBytes === null ? 'Unknown' : formatBytes(state.preview.disk.availableBytes)}.`) : null,
      ...nodeSetupDisplayWarnings(draft, state.preview?.warnings).map(value => h('p', { className: 'node-setup-warning' }, String(value))),
      button('Refresh review', { onClick: preview, disabled: state.busy }),
      state.preview?.token ? button('Save setup', { primary: true, onClick: apply, disabled: state.busy }) : null);
  }

  function progressStep() {
    const status = state.status;
    const draft = { ...state.draft, ...state.applied?.setup?.plan?.draft };
    const managed = nodeSetupGuidance(draft).managed;
    const line = (name, value, extra = '') => h('div', { className: 'node-setup-progress-line' }, h('strong', {}, name),
      h('span', {}, value?.message ?? value?.phase ?? 'Not checked yet'),
      Number.isFinite(value?.progress) ? h('progress', { max: 1, value: Math.max(0, Math.min(1, value.progress)), ariaLabel: `${name} progress` }) : null,
      extra ? h('small', {}, extra) : null);
    const coreCounts = status?.core && (Number.isFinite(status.core.blocks) || Number.isFinite(status.core.headers))
      ? `Blocks ${Number.isFinite(status.core.blocks) ? status.core.blocks.toLocaleString() : 'unknown'} of ${Number.isFinite(status.core.headers) ? status.core.headers.toLocaleString() : 'unknown'} headers` : '';
    const ordCounts = Number.isFinite(status?.ord?.height) ? `Indexed through height ${status.ord.height.toLocaleString()}` : '';
    const ready = status?.ord?.phase === 'ready' || (draft.choice === 'core' && status?.core?.phase === 'ready');
    const quick = isQuickStart(draft), snapshot = status?.snapshot;
    const importing = snapshot?.phase === 'loading';
    const snapshotActive = ['accepted', 'validating', 'validated'].includes(snapshot?.phase);
    return h('div', {}, h('h1', {}, 'Setup saved'), h('p', {}, state.easyCompleted
      ? 'Bitcoin Core has been configured. Check its live status below: the first sync can take hours or days. You can keep browsing, stop and resume, or return here from Local node. Quitting the browser stops its managed node.'
      : managed ? 'Saved does not mean synchronized or ready. Starting services is a separate action.' : 'Connections are saved. Check their current status below; the browser does not start or stop these existing services.'),
      h('div', { role: 'status', 'aria-live': 'polite', className: 'node-setup-progress' }, line('Bitcoin Core', status?.core, coreCounts), !state.easyCompleted || draft.choice !== 'core' ? line('Ord', status?.ord, ordCounts) : null, status?.message ? h('p', {}, status.message) : null),
      quick ? h('section', { className: 'node-snapshot-help', ariaLabel: 'Quick start progress' },
        h('h2', {}, 'Quick start'),
        h('p', {}, snapshot?.message ?? 'Start Core first, then choose your snapshot. Ordinary synchronization can continue without one.'),
        h('dl', { className: 'node-setup-summary' }, h('dt', {}, 'Current with network'), h('dd', {}, status?.core?.current === true ? 'Yes' : status?.core?.current === false ? 'Not yet' : 'Not confirmed'),
          h('dt', {}, 'Historical validation'), h('dd', {}, status?.core?.historicalValidated === true ? 'Complete' : status?.core?.historicalValidated === false ? 'Not complete' : 'Not confirmed')),
        Number.isSafeInteger(status?.core?.backgroundBlocks) ? h('p', {}, `Background validation has reached block ${status.core.backgroundBlocks.toLocaleString()}.`) : null,
        h('p', {}, 'Being current does not mean earlier history has been validated. Import progress has no reliable percentage. Leaving this page does not stop Core.'),
        !snapshotActive ? button('Choose snapshot file', { disabled: state.busy || importing, onClick: async () => {
          state.snapshotSelection = null;
          const value = await act('snapshot-select', { setupId: state.applied.setupId }, 'Checking snapshot header…');
          if (!state.disposed && value) { state.snapshotSelection = value.selection; render(); }
        } }) : null,
        state.snapshotSelection && !importing && !snapshotActive ? h('div', {},
          h('p', { className: 'node-setup-path' }, `${state.snapshotSelection.name} · ${formatBytes(state.snapshotSelection.bytes)} · Block ${state.snapshotSelection.baseHeight.toLocaleString()}`),
          h('p', {}, state.snapshotSelection.message),
          button('Import snapshot', { primary: true, disabled: state.busy, onClick: async () => {
            const token = state.snapshotSelection?.token; if (!token) return;
            state.snapshotSelection = null;
            const value = await act('snapshot-load', { setupId: state.applied.setupId, token }, 'Reviewing snapshot import…');
            if (value && !state.disposed) { state.status = { setupId: state.applied.setupId, core: { phase: 'snapshot-loading', message: value.snapshot.message }, snapshot: value.snapshot }; render(); schedulePoll(); }
          } })) : null,
        button('Snapshot guide', { small: true, onClick: () => ctx.openExternal?.(SNAPSHOT_GUIDE_URL) }),
        h('p', { className: 'node-setup-help' }, 'Older blocks are pruned after processing. Complete local inscriptions and Runes still need a separate source or archival Core + Ord. The snapshot file is never automatically deleted.')) : null,
      h('div', { className: 'node-setup-actions' },
        button(managed ? 'Start services' : 'Check connections', { primary: true, disabled: state.busy || importing || (state.easyCompleted && ['ready', 'syncing', 'starting'].includes(status?.core?.phase)), onClick: async () => { const value = await act('start', { setupId: state.applied.setupId }); if (value) { state.status = value; render(); schedulePoll(); } } }),
        button('Refresh status', { disabled: state.busy || state.polling, onClick: refreshStatus }),
        managed ? button('Stop managed services', { danger: true, disabled: state.busy, onClick: async () => { const value = await act('stop', { setupId: state.applied.setupId }); if (value) { state.status = value; render(); } } }) : null,
        ready ? button('Explore inscriptions', { primary: true, onClick: () => ctx.navigate('satnav://inscriptions') }) : null,
        button('Continue browsing', { onClick: () => ctx.navigate('satnav://home') })));
  }

  function render() {
    if (state.disposed) return;
    if (state.step === 0 && state.inspection?.easy && !state.inspection.saved && !state.inspection.recovery && !state.customized && state.draftRevision === 0) {
      if (!state.easyView) state.easyView = renderEasyNodeSetup(ctx, state.inspection.easy, {
        customize: recommendation => {
          state.customized = true; state.draft.rootDirectory = recommendation.rootDirectory;
          state.easyView?.dispose(); state.easyView = null; render();
        },
        completed: value => {
          state.draft.choice = 'core'; state.draft.network = 'mainnet'; state.draft.core.mode = 'managed'; state.draft.core.storage = 'pruned'; delete state.draft.core.sync;
          state.applied = value; state.status = value.status ?? null; state.error = value.startWarning ?? '';
          state.easyCompleted = true; state.step = 4; state.easyView?.dispose(); state.easyView = null;
          render(); schedulePoll();
        }
      });
      root.dataset.step = 'recommended'; root.replaceChildren(state.easyView); return;
    }
    root.dataset.step = String(state.step + 1);
    const content = state.step === 0 ? chooseStep() : state.step === 1
      ? h('div', {}, h('h1', {}, 'Choose software'), softwarePanel('core', ['both', 'core'].includes(state.draft.choice)), softwarePanel('ord', ['both', 'ord'].includes(state.draft.choice)))
      : state.step === 2 ? storageStep() : state.step === 3 ? reviewStep() : progressStep();
    const none = state.draft.choice === 'none';
    root.replaceChildren(
      h('ol', { className: 'node-setup-steps', ariaLabel: 'Setup progress' }, ...STEPS.map((label, index) => h('li', { className: index === state.step ? 'active' : '' }, `${index + 1}. ${label}`))),
      h('div', { className: 'node-setup-card', 'aria-busy': String(state.busy) }, state.busy ? h('p', { role: 'status', 'aria-live': 'polite', className: 'node-setup-busy-label' }, state.busyLabel || 'Working…') : null, h('fieldset', { className: 'node-setup-busy-scope', disabled: state.busy }, content),
        ...[state.error, state.statusError].filter(Boolean).map(message => h('p', { className: 'node-setup-error', role: 'alert' }, message)),
        state.step < 4 ? h('div', { className: 'node-setup-nav' },
          state.step ? button('Back', { onClick: () => { state.step -= 1; state.error = ''; render(); }, disabled: state.busy })
            : state.customized && state.inspection?.easy ? button('Recommended setup', { onClick: async () => {
              const value = await act('capacity', { rootDirectory: state.draft.rootDirectory });
              if (value) { state.inspection.easy = value; state.customized = false; state.draftRevision = 0; render(); }
            }, disabled: state.busy }) : null,
          state.step === 0 && none ? button('Continue browsing', { primary: true, onClick: () => ctx.navigate('satnav://home') })
            : state.step < 3 ? button('Continue', { primary: true, disabled: state.busy, onClick: async () => {
              if (state.step === 2) { state.step = 3; await preview(); }
              else { state.customized = true; state.step += 1; state.error = ''; render(); }
            } }) : null) : null),
      h('nav', { className: 'node-setup-links', ariaLabel: 'Other setup options' },
        button('Advanced local services', { onClick: () => ctx.navigate('satnav://services') }),
        button('Advanced data sources', { onClick: () => ctx.navigate('satnav://providers') })));
  }

  root.dispose = () => { if (state.disposed) return; state.disposed = true; state.easyView?.dispose(); clearTimeout(state.timer); state.timer = null; };
  render();
  const inspectionRevision = state.draftRevision;
  Promise.resolve().then(async () => {
    if (state.disposed) return;
    try {
      state.inspection = await ctx.nodeSetup('inspect', {});
      if (inspectionRevision === state.draftRevision && state.inspection?.defaults) state.draft = {
        ...state.draft, ...structuredClone(state.inspection.defaults),
        core: { ...state.draft.core, ...structuredClone(state.inspection.defaults.core ?? {}) },
        ord: { ...state.draft.ord, ...structuredClone(state.inspection.defaults.ord ?? {}) }
      };
    }
    catch (error) { if (!state.disposed) state.error = String(error?.message ?? error); }
    if (!state.disposed) render();
  });
  return root;
}
