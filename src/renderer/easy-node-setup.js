import { button, h } from './dom.js';

const space = bytes => Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB` : 'Not available';
const PHASES = Object.freeze({
  preparing: 'Checking your setup…', confirming: 'Review the confirmation to continue', review: 'Review the confirmation to continue',
  downloading: 'Downloading and verifying Bitcoin Core…', saving: 'Saving your dedicated node setup…',
  starting: 'Starting Bitcoin Core…', saved: 'Your setup is saved', failed: 'Setup needs attention', cancelling: 'Cancelling setup…'
});

// A small front door to the existing walkthrough, not a replacement for it.
// Polling changes only stage text, never a made-up download/sync percentage.
export function renderEasyNodeSetup(ctx, initial, { customize, completed }) {
  const root = h('div', { className: 'easy-node-setup' });
  let recommendation = initial, autoStart = false, busy = false, error = '', phase = '', token = null;
  let disposed = false, timer = null, canCancel = false, cancelRequested = false, actionRevision = 0;
  let progressNodes = null;
  const stopPoll = () => { clearTimeout(timer); timer = null; };
  const cancel = async () => {
    cancelRequested = true; canCancel = false; phase = 'cancelling'; updateProgress();
    if (token) {
      try {
        const value = await ctx.nodeSetup('easy-cancel', { token });
        if (!disposed && value.cancelled === false) { canCancel = false; phase = value.phase; updateProgress(); }
      } catch (cause) { if (!disposed) { canCancel = true; cancelRequested = false; error = `Cancellation could not be confirmed. Try Cancel setup again. ${String(cause?.message ?? cause)}`; render(); } }
    }
  };
  const poll = async () => {
    if (disposed || !busy || !token) return;
    const pollToken = token, revision = actionRevision;
    try {
      const value = await ctx.nodeSetup('easy-status', { token: pollToken });
      if (!disposed && busy && revision === actionRevision && token === pollToken && (!cancelRequested || !value.canCancel) && (phase !== value.phase || canCancel !== value.canCancel)) {
        phase = value.phase; canCancel = value.canCancel; updateProgress();
      }
    } catch { /* The lifecycle request owns actionable errors. */ }
    if (!disposed && busy && revision === actionRevision && token === pollToken) timer = setTimeout(poll, 1000);
  };
  const check = async (chooseFolder = false) => {
    if (busy || disposed) return;
    busy = true; error = ''; phase = 'preparing'; render();
    try {
      const selection = chooseFolder ? await ctx.nodeSetup('pick', { kind: 'directory' }) : null;
      if (disposed || (chooseFolder && !selection?.path)) return;
      const next = await ctx.nodeSetup('capacity', { rootDirectory: selection?.path ?? recommendation.rootDirectory });
      if (!disposed) recommendation = next;
    } catch (cause) { if (!disposed) error = String(cause?.message ?? cause); }
    finally { if (!disposed) { busy = false; phase = ''; render(); } }
  };
  const start = async () => {
    if (busy || disposed || !recommendation.eligible) return;
    const revision = ++actionRevision;
    busy = true; error = ''; phase = 'preparing'; token = null; canCancel = true; cancelRequested = false; render();
    try {
      const preview = await ctx.nodeSetup('easy-preview', { rootDirectory: recommendation.rootDirectory, autoStart });
      token = preview.token;
      if (disposed || cancelRequested) { await cancel(); if (!disposed) error = 'Setup cancelled. Nothing was installed or started.'; return; }
      phase = 'confirming'; updateProgress(); timer = setTimeout(poll, 500);
      const value = await ctx.nodeSetup('easy-start', { token });
      if (!disposed && value?.committed) { canCancel = false; completed(value); }
    } catch (cause) {
      if (!disposed && cause?.details?.setupCommitted && cause.details.setupId) {
        canCancel = false;
        completed({ committed: true, setupId: cause.details.setupId,
          startWarning: 'Setup was saved, but status could not be refreshed. Resume it; do not install again.' });
      } else if (!disposed) error = String(cause?.message ?? cause);
    } finally {
      stopPoll();
      if (!disposed && revision === actionRevision) { busy = false; canCancel = false; token = null; phase = ''; render(); }
    }
  };
  function updateProgress() {
    if (disposed || !progressNodes) return;
    progressNodes.title.textContent = PHASES[phase] ?? 'Working…';
    progressNodes.description.textContent = phase === 'downloading' ? 'Checking the pinned download before anything starts. This may take a few minutes.'
      : phase === 'cancelling' ? 'Waiting for setup to stop and finish cleanup. A program already verified on disk can be reused later.'
      : ['saving', 'starting', 'saved'].includes(phase) ? 'Finishing your approved setup. You can manage or stop the node from Local node.' : 'Nothing starts until you approve the native confirmation.';
    progressNodes.cancel.hidden = !canCancel; progressNodes.cancel.disabled = !canCancel;
    progressNodes.stay.hidden = !canCancel;
  }
  function workingView() {
    if (!busy) { progressNodes = null; return null; }
    progressNodes = { title: h('strong'), description: h('p'), cancel: button('Cancel setup', { onClick: cancel }),
      stay: h('p', { className: 'node-setup-help' }, 'Stay on this page until setup is saved. Leaving now cancels setup before saving; you can browse while Core syncs afterward.') };
    updateProgress();
    return h('div', { className: 'easy-node-working', role: 'status', 'aria-live': 'polite' }, progressNodes.title, progressNodes.description, progressNodes.stay, progressNodes.cancel);
  }
  function render() {
    if (disposed) return;
    const r = recommendation;
    const ready = r.eligible;
    root.replaceChildren(
      h('header', { className: 'easy-node-heading' }, h('p', { className: 'eyebrow' }, 'Your computer. Your verification.'),
        h('h1', {}, 'Run your own Bitcoin node'),
        h('p', {}, 'Check Bitcoin for yourself. We’ll handle the download, configuration and startup — you stay in control.')),
      h('section', { className: 'easy-node-recommendation', ariaLabel: 'Recommended Bitcoin Core setup' },
        h('div', { className: 'easy-node-title' }, h('h2', {}, 'Compact Bitcoin Core'), h('span', { className: `easy-node-badge${ready ? '' : ' needs-review'}` }, ready ? 'Recommended for this computer' : 'Review your computer’s capacity')),
        h('p', { className: 'easy-node-lead' }, 'Full validation. Less stored history. No wallet required.'),
        h('dl', { className: 'easy-node-capacity' },
          h('div', {}, h('dt', {}, 'Free on selected drive'), h('dd', {}, space(r.availableBytes))),
          h('div', {}, h('dt', {}, 'Installed memory'), h('dd', {}, space(r.memoryBytes))),
          h('div', {}, h('dt', {}, 'Logical processors'), h('dd', {}, r.logicalCpus ?? 'Not available'))),
        h('p', { className: 'easy-node-private' }, 'Checked on this computer only. No hardware profile is uploaded.'),
        r.slower ? h('p', { className: 'node-setup-warning' }, 'This computer has limited memory or processing capacity. Setup uses conservative resource targets; initial sync may be slow and everyday apps may feel less responsive.') : null,
        !ready ? h('div', { className: 'node-setup-warning', role: 'status' }, h('strong', {}, 'Before you start'), h('ul', {}, ...(r.reasons ?? []).map(reason => h('li', {}, reason)))) : null,
        h('div', { className: 'node-setup-actions' },
          button('Set up Bitcoin Core', { primary: true, disabled: busy || !ready, onClick: start }),
          button('Recheck computer', { disabled: busy, onClick: () => check(false) })),
        h('p', { className: 'node-setup-help' }, `Bitcoin Core ${r.version ?? 'download unavailable'} · Bitcoin mainnet · One confirmation before download and startup.`),
        workingView(),
        error ? h('p', { className: 'node-setup-error', role: 'alert' }, error) : null,
        h('ul', { className: 'easy-node-expectations' },
          h('li', {}, h('strong', {}, 'Start with 30 GiB free. '), 'Old block files are pruned after processing. Total storage can grow.'),
          h('li', {}, h('strong', {}, 'Plan for the first sync. '), 'Core still downloads and processes Bitcoin’s history: hundreds of gigabytes, often hours or days. Use an unmetered connection.'),
          h('li', {}, h('strong', {}, 'Keep browsing while it works. '), 'Leave the browser and computer running to sync. You can stop and resume without starting over.')),
        h('div', { className: 'easy-node-storage' }, h('div', {}, h('strong', {}, 'Node data folder'), h('p', { className: 'node-setup-path' }, r.rootDirectory)),
          button('Change folder', { disabled: busy, onClick: () => check(true) })),
        h('label', { className: 'check-label easy-node-autostart' }, h('input', { type: 'checkbox', checked: autoStart, disabled: busy,
          onChange: event => { if (!busy && !disposed) autoStart = event.currentTarget.checked; } }), 'Start my node when I open Bitcoin Browser'),
        h('p', { className: 'node-setup-help' }, 'Optional. Quitting the browser stops its managed node; this does not install an operating-system startup service.')),
      h('details', { className: 'easy-node-details' }, h('summary', {}, 'What this setup does — and doesn’t do'),
        h('p', {}, 'Your node independently checks Bitcoin’s rules and relays transactions and recent blocks through its peer connections while online. This is not mining, and there are no rewards for running it. A compact node does not keep or serve the entire historical blockchain.'),
        h('p', {}, `We use a ${r.dbCacheMiB} MiB database-cache target and ${r.validationThreads} validation thread(s) to leave room for other apps. These are not total memory or CPU limits. No validation rules are disabled.`),
        h('p', {}, 'A separate pinned Core download is checksum-checked; publisher signatures are not verified. OS launch protections stay enabled. Fresh data folders are created without changing personal Bitcoin configurations. No administrator installer, router changes or inbound listening ports are requested; RPC stays on this computer.'),
        h('p', {}, 'Core makes its own peer-to-peer connections. Browser offline and local-only controls are not a node firewall; use Stop managed services to stop the app-owned node. After setup, leaving this page does not stop it.'),
        h('p', {}, 'Complete local inscriptions and Runes need an Ord index backed by archival Core, or another data source. Your existing browsing sources stay available.'),
        h('p', {}, 'The local check covers storage, installed memory, processor count and a supported OS baseline. Drive speed, sustained performance, network quality and runtime-library compatibility cannot be guaranteed.'),
        button('Official Bitcoin Core downloads', { onClick: () => ctx.openExternal?.('https://bitcoincore.org/en/download/') })),
      h('section', { className: 'easy-node-alternatives' }, h('h2', {}, 'Already have a node, or want more control?'),
        h('p', {}, `${r.archiveFits ? 'Your selected drive also has room for our 1 TiB archive starting allowance; actual needs grow. ' : ''}Choose Core + Ord, archive storage, snapshot-assisted sync, an existing service, another network, or no node at all.`),
        h('div', { className: 'node-setup-actions' }, button('Customize setup', { disabled: busy, onClick: () => { if (!busy) customize(r); } }),
          button('Not now', { disabled: busy, onClick: () => ctx.navigate('satnav://home') }))),
      h('nav', { className: 'node-setup-links', ariaLabel: 'Advanced node controls' },
        button('Advanced local services', { disabled: busy, onClick: () => ctx.navigate('satnav://services') }),
        button('Advanced data sources', { disabled: busy, onClick: () => ctx.navigate('satnav://providers') })));
  }
  root.dispose = () => { if (disposed) return; disposed = true; stopPoll(); if (canCancel) void cancel(); };
  render(); return root;
}
