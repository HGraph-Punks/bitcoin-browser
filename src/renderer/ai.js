import { h, clear, button, badge, shorten, targetIcon, absoluteTime } from './dom.js';
import { AI_DEFAULT_CONFIG, AI_SERVERS, AI_LIMITS, AI_CONNECT_DIAGNOSTIC_CODES, aiResultTarget, validateAiConfig } from '../shared/local-ai.js';
import { AiRequest } from './ai-request.js';
import { aiMessage } from './ai-message.js';
import { aiAnswerEvidence, aiCardFacts, aiResultFollowUps } from './ai-result-presentation.js';
import { applicationLogo } from './assets/bitcoin-browser.js';

const sessions = new Map();
const phases = { connecting: 'Checking your local server…', prepared: 'Getting ready…', thinking: 'Your model is thinking…',
  'looking-up': 'Looking up Bitcoin data…', summarizing: 'Your model is explaining the results…', done: '' };
const cancelled = error => error?.code === 'NAVIGATION_CANCELLED';
function reportConnection(code) {
  console.info(`SATOSHI_AI_CONNECT:${AI_CONNECT_DIAGNOSTIC_CODES.includes(code) ? code : 'FAILED'}`);
}
export function forgetAiTab(id) { sessions.get(String(id))?.dispose?.(); sessions.delete(String(id)); }

// The sidebar resumes a live workspace, not a fresh chat in the current result
// tab. Keep only tab IDs at this boundary; no chat/credential data is exposed.
export function findAiSessionTab(tabs, preferredId) {
  const live = new Set(tabs.map(tab => String(tab.id)));
  const preferred = String(preferredId);
  if (live.has(preferred) && sessions.has(preferred)) return preferred;
  return [...sessions.keys()].reverse().find(id => live.has(id)) ?? null;
}

export function aiChatHistory(turns) {
  const result = [];
  let length = 0;
  for (const turn of [...turns].reverse()) {
    if (!turn.answer || turn.error || turn.stopped) continue;
    const references = (turn.cards ?? []).filter(card => aiResultTarget(card.target)).slice(0, 8)
      .map(card => `${String(card.title).slice(0, 120)}: ${card.target}`).join('\n');
    const answer = turn.answer + (references ? `\n\nPreviously displayed Bitcoin references (refresh for current facts):\n${references}` : '');
    const content = answer.length <= AI_LIMITS.answer ? answer : turn.answer;
    if (result.length + 2 > AI_LIMITS.history || length + turn.question.length + content.length > AI_LIMITS.historyChars) break;
    result.unshift({ role: 'user', content: turn.question }, { role: 'assistant', content });
    length += turn.question.length + content.length;
  }
  return result;
}

export function renderAi(ctx) {
  const owner = String(ctx.model.activeTabId);
  let session = sessions.get(owner);
  if (!session) {
    session = { config: { ...AI_DEFAULT_CONFIG, ...ctx.model.settings.localAi }, token: '', connected: false, responded: false,
      models: [], turns: [], draft: '', allowLookups: true, selected: null, network: ctx.model.settings.network };
    sessions.set(owner, session);
  }
  // Map order tracks the most recently visited workspace, including revisits.
  sessions.delete(owner); sessions.set(owner, session);
  const networkChanged = session.network !== ctx.model.settings.network;
  if (networkChanged) {
    session.network = ctx.model.settings.network; session.turns = []; session.selected = null;
    session.scrollTop = 0; session.followLatest = true; session.connectionScrollTop = null;
  }
  const root = h('section', { className: 'ai-workspace', dataset: { owner } });
  let disposed = false, pending = null, activeTurn = null,
    errorText = networkChanged ? 'Network changed. A new chat keeps results from different networks separate.' : '', connectionErrorText = '',
    connectionOpen = !session.connected || session.connectionOpen === true;
  let followLatest = session.followLatest ?? true, restoringScroll = true, connectionScrollTop = session.connectionScrollTop ?? null;
  const turnNodes = new Map();
  const connection = h('section', { className: 'ai-connection', id: 'ai-connection', ariaLabel: 'AI connection' });
  const connectionStatus = h('p', { className: 'ai-stage ai-connection-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const connectionError = h('p', { className: 'ai-error ai-connection-error', id: 'ai-connection-error', role: 'alert' });
  const connectionStop = button('Cancel connection', { onClick: () => { void stopRequest(); } });
  const transcript = h('div', { className: 'ai-transcript', role: 'log', ariaLabel: 'Conversation', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const scrollport = h('div', { className: 'ai-scroll', id: 'ai-scroll', role: 'region', tabindex: '0', ariaLabel: 'AI conversation and setup',
    onScroll: () => {
      if (disposed || restoringScroll) return;
      followLatest = scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight < 64;
      updateJump();
    } });
  const jump = button('Jump to latest ↓', { small: true, className: 'ai-jump', onClick: () => { jumpToLatest(); input.focus({ preventScroll: true }); } });
  jump.setAttribute('aria-controls', 'ai-scroll');
  const status = h('p', { className: 'ai-stage', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const error = h('p', { className: 'ai-error', role: 'alert' });
  const privacy = h('p', { className: 'ai-source-policy' });
  const networkBadge = badge(String(session.network).toUpperCase());
  const input = h('textarea', { className: 'ai-prompt', rows: '2', maxlength: AI_LIMITS.prompt, value: session.draft,
    ariaLabel: 'Ask a question about Bitcoin', 'aria-describedby': 'ai-input-help', placeholder: 'Ask about Bitcoin, or paste a public address, transaction, inscription, or Rune…',
    onInput: () => { session.draft = input.value; session.previousDraft = null; updateControls(); },
    onKeydown: event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }
  });
  const ask = button('Ask Bitcoin', { primary: true, onClick: () => { void send(); } });
  const undoPrompt = button('Restore my draft', { small: true, className: 'ai-restore-draft', onClick: () => {
    if (session.previousDraft == null || pending) return;
    input.value = session.previousDraft; session.draft = session.previousDraft; session.previousDraft = null; updateControls(); input.focus();
  } });
  const stop = button('Stop', { onClick: () => { void stopRequest(); } });
  const lookup = h('input', { type: 'checkbox', checked: session.allowLookups, onChange: () => { session.allowLookups = lookup.checked; updateControls(); } });
  const newChat = button('New chat', { onClick: () => {
    session.turns = []; session.selected = null; errorText = ''; resetScroll(); renderTurns(); renderResults(); updateControls(); input.focus();
  } });
  const change = button('Connection', { small: true, onClick: () => {
    if (!connectionOpen) connectionScrollTop = scrollport.scrollTop;
    connectionOpen = !connectionOpen; renderConnection();
    scrollport.scrollTop = connectionOpen ? 0 : connectionScrollTop ?? 0;
    followLatest = !connectionOpen && scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight < 64;
    updateJump();
  } });
  const connectionState = h('span', { className: 'ai-connection-state', role: 'status' });
  change.setAttribute('aria-controls', 'ai-connection');
  const modelSelect = h('select', { className: 'field ai-model-select', ariaLabel: 'AI model', onChange: async () => {
    session.config.model = modelSelect.value; session.responded = false; session.turns = []; session.selected = null;
    resetScroll(); renderTurns(); renderResults(); updateControls(); await savePreferences();
  } });
  const modelBar = h('div', { className: 'ai-model-bar' }, connectionState,
    h('label', { className: 'ai-model-label' }, 'Model', modelSelect), change, newChat);
  const starters = h('div', { className: 'ai-starters', ariaLabel: 'Suggested questions' });
  for (const [label, prompt] of [
    ['Explore inscriptions', 'Show me some recent inscriptions to explore. Explain that this is a sample, not all inscriptions.'],
    ['Find recursive art', 'Find a highly recursive inscription for me to explore.'],
    ['Find a Rune', 'Find DOG in the featured Rune catalog, then look up its current on-chain details.'],
    ['Check my node', 'Which Bitcoin data sources can you use? If I have a local node, check its sync status using local sources only.'],
    ['Understand sat rarity', 'Explain uncommon and rare sats, and how sat rarity differs from inscription art rarity or a collection rank.'],
    ['Learn the basics', 'What is the difference between a Bitcoin transaction, an inscription, and a Rune?']
  ]) starters.append(button(label, { small: true, onClick: () => choosePrompt(prompt) }));
  const composer = h('form', { className: 'ai-composer', onSubmit: event => { event.preventDefault(); void send(); } },
    input, undoPrompt,
    h('div', { className: 'ai-composer-actions' }, h('label', { className: 'check-label', title: 'Let your model choose bounded, read-only lookups through your configured Bitcoin sources.' }, lookup, 'Bitcoin data'), stop, ask),
    status, error, privacy, h('p', { id: 'ai-input-help', className: 'ai-help' }, 'Enter to send · Shift + Enter for a new line. Never paste a seed phrase or private key.'));
  lookup.setAttribute('aria-label', 'Allow read-only Bitcoin lookups');
  scrollport.append(connection, h('div', { className: 'ai-chat' }, transcript, starters),
    h('details', { className: 'ai-privacy-details' }, h('summary', {}, 'Privacy & capabilities'),
      h('p', {}, 'Bitcoin Browser sends this chat’s recent messages, displayed Bitcoin references, and bounded Bitcoin records or inscription text to the local server you choose. The AI can discover your enabled source names and capabilities, use local Core/Ord or configured public sources, and chain read-only lookups. Network, offline and local-only settings always apply. It does not share your browser history, open pages, wallet connection, private keys, credentials, or local file paths. Chats are kept in memory and disappear when you close this tab or the browser. Opening a result uses normal browser history and caching.'),
      h('p', {}, 'The server controls its own logging and where its models run. Use downloaded models and disable cloud/remote routing for fully local inference. Ollama models advertised as remote are excluded, but a local server is not proof of local inference. The browser does not install or start AI services.'),
      h('p', {}, 'AI explanations can be wrong. Result cards are browser-produced source snapshots, not AI-generated facts, rankings, or financial advice. The AI cannot sign, spend, execute code, read files, open external sites, or change settings. It reads text content without executing it; images, videos, PDFs and 3D models are opened by you in the browser, not inspected by the model. Collection and keyword discovery is limited to the small curated catalog; it is not a complete Bitcoin search index.')));
  root.append(h('div', { className: 'ai-topbar' },
    h('header', { className: 'ai-heading' }, h('div', {}, h('h1', {}, 'Ask Bitcoin'), h('p', {}, 'Your local AI, connected to Bitcoin.')), networkBadge), modelBar),
    scrollport, h('div', { className: 'ai-composer-dock' }, jump, composer));

  function updateJump() { jump.hidden = !session.turns.length || followLatest || connectionOpen; }
  function jumpToLatest() {
    followLatest = true;
    scrollport.scrollTop = scrollport.scrollHeight ?? 0;
    updateJump();
  }
  function resetScroll() {
    session.scrollTop = 0; followLatest = true; scrollport.scrollTop = 0; connectionScrollTop = null;
  }
  function choosePrompt(prompt, network) {
    if (pending || disposed) return;
    if (network && ctx.model.settings.network !== network) { errorText = 'This suggested question belongs to another Bitcoin network. Start a new question for the current network.'; updateControls(); return; }
    if (input.value.trim() && input.value !== prompt && session.previousDraft == null) session.previousDraft = input.value;
    input.value = prompt; session.draft = prompt; updateControls(); input.focus({ preventScroll: true });
  }
  function finishScroll() {
    if (!restoringScroll && !connectionOpen && followLatest && session.turns.length) jumpToLatest();
    else updateJump();
  }
  const resizeObserver = typeof globalThis.ResizeObserver === 'function' ? new globalThis.ResizeObserver(() => { if (!disposed) finishScroll(); }) : null;
  resizeObserver?.observe(scrollport);

  async function savePreferences() {
    try { await ctx.saveAiPreferences?.({ ...session.config }); }
    catch { if (!disposed) { errorText = 'Connected, but connection preferences could not be saved. You can still use this session.'; updateControls(); } }
  }
  function updateControls() {
    if (disposed) return;
    const busy = Boolean(pending);
    const connecting = busy && !activeTurn;
    ask.disabled = busy || !session.connected || !input.value.trim();
    undoPrompt.hidden = session.previousDraft == null; undoPrompt.disabled = busy;
    starters.querySelectorAll('button').forEach(node => { node.disabled = busy; });
    root.querySelectorAll('.ai-followup').forEach(node => { node.disabled = busy; });
    stop.disabled = !busy || pending?.cancelled; stop.hidden = !busy || connecting;
    lookup.disabled = busy; modelSelect.disabled = busy || !session.connected; newChat.disabled = busy || !session.turns.length; change.disabled = busy;
    connectionState.textContent = connecting ? 'Connecting…' : !session.connected ? 'Not connected' : session.responded ? 'Model responded' : 'Server connected';
    connectionState.dataset.connected = String(session.connected);
    const capacity = session.models.find(model => model.id === session.config.model)?.contextLength;
    modelSelect.title = capacity ? `Loaded context: ${capacity.toLocaleString()} tokens. The browser may shorten older model context while keeping your visible chat.` : 'Model context capacity was not reported. The browser uses a conservative context budget.';
    connectionState.title = session.checkedAt ? `${session.models.length} chat models found. Server checked ${absoluteTime(session.checkedAt)}. ${session.responded ? 'The model has responded.' : 'Model not tested yet.'} Availability is checked again when you ask.` : 'No AI server has been contacted.';
    modelSelect.hidden = !session.connected;
    modelSelect.parentElement.hidden = !session.connected;
    connection.querySelectorAll('button,input').forEach(node => { if (node !== connectionStop) node.disabled = busy; });
    connectionStop.hidden = !connecting; connectionStop.disabled = !connecting || Boolean(pending?.cancelled);
    const connect = connection.querySelector('.ai-connect-button');
    if (connect) connect.textContent = connecting ? (pending.cancelled ? 'Stopping…' : 'Connecting…') : session.connected ? 'Reconnect' : 'Connect & find models';
    connectionStatus.textContent = connecting ? (pending.cancelled ? 'Stopping the connection check…' : 'Checking this server for chat models. This can take up to 15 seconds…') : '';
    connectionError.textContent = connectionErrorText;
    error.textContent = errorText;
    const settings = ctx.model.settings;
    networkBadge.textContent = String(settings.network).toUpperCase();
    privacy.textContent = !session.allowLookups ? 'Bitcoin lookups are off. Answers will be explanations without checked source data.'
      : `${String(settings.network).toUpperCase()} · ${settings.offlineMode ? 'Offline: Bitcoin lookups use cached data only.' : settings.localOnly ? 'Bitcoin lookups use your local sources only.' : 'Bitcoin lookups may send public identifiers to your configured public data sources.'}`;
    composer.setAttribute('aria-busy', String(busy));
    starters.hidden = session.turns.length > 0;
    updateJump();
  }
  function renderModels() {
    clear(modelSelect, session.models.map(model => h('option', { value: model.id, selected: model.id === session.config.model }, `${model.id}${model.loaded ? ' · loaded' : ''}`)));
    modelSelect.value = session.config.model;
  }
  function renderConnection() {
    if (disposed) return;
    connection.hidden = !connectionOpen;
    change.setAttribute('aria-expanded', String(connectionOpen));
    if (!connectionOpen) return;
    const choices = h('div', { className: 'ai-server-choices' });
    const address = h('input', { className: 'field', value: session.addressDraft ?? session.config.baseUrl, type: 'text', maxlength: '100', spellcheck: 'false', autocomplete: 'off', ariaLabel: 'Local AI server address',
      'aria-describedby': 'ai-server-address-help ai-connection-error', onInput: () => { session.addressDraft = address.value; address.setAttribute('aria-invalid', 'false'); } });
    const token = h('input', { className: 'field', value: session.token, type: 'password', maxlength: '512', autocomplete: 'off', ariaLabel: 'LM Studio server API token (session only)' });
    const options = h('details', { className: 'ai-connection-options' }, h('summary', {}, 'Connection options'),
      session.config.provider === 'lmstudio' ? h('label', { className: 'form-field' }, 'Server API token (optional · session only)', token) : null,
      h('p', { className: 'ai-help' }, 'Loopback only; no LAN or cloud endpoints. Changing connection or model starts a new chat.'));
    const connect = button(session.connected ? 'Reconnect' : 'Connect & find models', { primary: true, className: 'ai-connect-button', onClick: async () => {
      if (pending || disposed) return;
      let config;
      try {
        // A port-only convenience is renderer-side only. Main still receives
        // and validates an exact loopback URL; no discovery or port scanning.
        const raw = address.value.trim();
        config = validateAiConfig({ ...session.config, baseUrl: /^\d{4,5}$/.test(raw) ? `http://127.0.0.1:${raw}` : raw });
      }
      catch (failure) {
        connectionErrorText = failure.message; address.setAttribute('aria-invalid', 'true'); updateControls(); address.focus(); reportConnection('AI_VALIDATION'); return;
      }
      address.value = config.baseUrl; session.addressDraft = config.baseUrl; address.setAttribute('aria-invalid', 'false');
      session.config = config; session.token = session.config.provider === 'lmstudio' ? token.value : '';
      session.connected = false; session.responded = false; session.turns = []; session.selected = null;
      resetScroll();
      renderTurns(); renderResults(); errorText = ''; connectionErrorText = '';
      const request = new AiRequest(ctx.ai); pending = request; updateControls(); reportConnection('STARTED');
      try {
        const result = await request.run({ action: 'connect', config: { ...session.config }, token: session.token });
        if (disposed || pending !== request) return;
        if (!Array.isArray(result?.models) || !result.models.length) throw { code: 'AI_NO_MODELS', message: 'The server did not return any chat models. Download a chat model in your AI app, then reconnect.' };
        session.models = result.models; session.config.model = result.models.some(model => model.id === session.config.model) ? session.config.model : result.models[0].id;
        session.checkedAt = result.checkedAt; session.connected = true; connectionOpen = false;
        renderModels(); renderConnection(); reportConnection('CONNECTED');
        if (result.excludedRemote) errorText = `${result.excludedRemote} remote model(s) excluded. Only downloaded local models are offered.`;
        await savePreferences(); input.focus();
      } catch (failure) {
        if (!disposed) {
          connectionErrorText = cancelled(failure) ? 'Connection check stopped. You can change the address or try again.' : (failure?.message || 'Could not connect to the local server.');
          if (failure?.code === 'AI_AUTH') options.open = true;
          reportConnection(failure?.code);
        }
      } finally {
        if (pending === request) pending = null;
        if (!disposed) { status.textContent = ''; updateControls(); }
      }
    } });
    for (const [key, server] of Object.entries(AI_SERVERS)) {
      const choice = button(server.name, { onClick: () => {
        if (pending || session.config.provider === key) return;
        // Correcting the app selection must not silently discard a custom port.
        const raw = address.value.trim(), custom = raw !== AI_SERVERS[session.config.provider].baseUrl;
        session.addressDraft = custom ? address.value : server.baseUrl;
        session.config = { provider: key, baseUrl: server.baseUrl, model: '' }; session.token = ''; session.connected = false; session.responded = false;
        connectionErrorText = '';
        session.turns = []; session.selected = null; resetScroll(); renderTurns(); renderResults(); renderConnection(); updateControls();
      } });
      choice.setAttribute('aria-pressed', String(session.config.provider === key)); choices.append(choice);
    }
    const guide = session.config.provider === 'lmstudio'
      ? ['Open LM Studio and download a chat model with tool support (look for the tool/hammer badge).', 'Load the model, then start the server in the Developer tab. Keep it bound to your computer.', 'Connect here, choose the model, and ask a question.']
      : ['Open Ollama and download a local chat model that supports tools.', 'Keep Ollama running on this computer. Disable cloud features in Ollama for fully local inference.', 'Connect here, choose the model, and ask a question.'];
    clear(connection, h('h2', {}, 'Connect your AI'), h('p', {}, 'Choose the AI app you already use. Nothing is installed or contacted until you connect.'), choices,
      h('ol', { className: 'ai-setup-steps' }, guide.map(text => h('li', {}, text))),
      h('div', { className: 'ai-server-address' }, h('label', { className: 'form-field' }, 'Local server address or port', address),
        h('p', { id: 'ai-server-address-help', className: 'ai-help' }, 'Use the address shown in your AI app, or just its port (for example, 11434). Choose the app you are running; either app can use a custom port.')),
      options, h('div', { className: 'ai-setup-actions' }, connect, connectionStop, button('Setup guide', { onClick: () => {
        Promise.resolve().then(() => ctx.openExternal(AI_SERVERS[session.config.provider].guide)).catch(() => { connectionErrorText = 'The setup guide was not opened.'; updateControls(); });
      } }), session.connected ? button('Disconnect', { onClick: () => {
        session.connected = false; session.responded = false; session.token = ''; session.models = []; session.turns = []; session.selected = null;
        resetScroll(); renderModels(); renderTurns(); renderResults(); renderConnection(); updateControls();
      } }) : null), connectionStatus, connectionError,
      h('p', { className: 'ai-help' }, 'Only this chat and its requested Bitcoin data are shared with this server. The server has its own privacy and logging settings.'));
  }
  function disclosure(turn, key, attributes, ...children) {
    turn.disclosures ??= {};
    return h('details', { ...attributes, open: turn.disclosures[key] ?? attributes.open ?? false,
      onToggle: event => { turn.disclosures[key] = event.currentTarget.open; } }, ...children);
  }
  function renderTurns() {
    if (disposed) return;
    if (!session.turns.length) {
      turnNodes.clear();
      clear(transcript, h('div', { className: 'ai-welcome' }, applicationLogo('ai-welcome-mark', 64),
        h('h2', {}, 'What would you like to know about Bitcoin?'), h('p', {}, 'Explore inscriptions and Runes, understand a transaction, or check your node. Just ask.')));
      return;
    }
    const live = new Set(session.turns);
    for (const [turn, record] of turnNodes) if (!live.has(turn)) { record.root.remove(); turnNodes.delete(turn); }
    for (const child of [...transcript.children]) if (!child.className?.includes('ai-turn')) child.remove();
    for (const turn of session.turns) {
      let record = turnNodes.get(turn);
      if (!record) {
        const answer = h('div', { className: 'ai-answer-body' });
        const activity = disclosure(turn, 'activity', { className: 'ai-activity' });
        const results = h('section', { className: 'ai-results', ariaLabel: 'Bitcoin search results' });
        record = { root: h('article', { className: 'ai-turn' },
          h('div', { className: 'ai-question' }, h('span', { className: 'ai-speaker' }, 'You'), h('p', {}, turn.question)),
          h('div', { className: 'ai-answer' }, h('span', { className: 'ai-speaker ai-assistant-label' }, applicationLogo('ai-assistant-logo', 20), 'Ask Bitcoin'), activity, answer, results)),
        answer, activity, results, signature: '', resultSignature: '', activitySignature: '' };
        turnNodes.set(turn, record); transcript.append(record.root);
      }
      const activity = turn.activity ?? [];
      const activitySignature = JSON.stringify([activity, turn.done, turn.stopped, turn.error]);
      if (record.activitySignature !== activitySignature) {
        record.activitySignature = activitySignature;
        record.activity.hidden = activity.length === 0;
        const running = activity.find(item => item.state === 'running');
        clear(record.activity, h('summary', {}, running && !turn.done && !turn.stopped && !turn.error ? `${running.label}…`
          : `${activity.length} Bitcoin lookup${activity.length === 1 ? '' : 's'} · view activity`),
        h('ol', {}, activity.map(item => h('li', { dataset: { state: item.state } }, h('span', {}, item.label, item.sources?.length ? ` · ${item.sources.join(', ')}` : ''),
          h('span', {}, item.state === 'complete' ? 'Done' : item.state === 'unavailable' ? 'Unavailable' : turn.stopped || turn.error || turn.done ? 'Interrupted' : 'Working…')))));
      }
      const signature = JSON.stringify([turn.answer, aiAnswerEvidence(turn), (turn.cards ?? []).map(card => [card.target, card.title, card.network]), turn.error, turn.stopped, turn.done]);
      if (record.signature === signature) continue;
      record.signature = signature;
      clear(record.answer,
        turn.answer ? h('p', { className: 'ai-evidence-label' }, aiAnswerEvidence(turn)) : null,
        turn.answer ? aiMessage(turn.answer, { cards: turn.cards, network: turn.network, openResult }) : h('p', { className: `ai-help${!turn.stopped && !turn.error && !turn.done ? ' ai-thinking' : ''}` }, turn.stopped ? 'Stopped. Completed result cards are still available.' : turn.error ? 'No complete explanation was received.' : turn.done ? 'See the lookup results and notes below.' : 'Working on your question…'),
        turn.error ? h('p', { className: 'ai-error' }, turn.error.message) : null,
        turn.answer && ctx.copy ? button('Copy answer', { small: true, onClick: () => { void Promise.resolve(ctx.copy(turn.answer)).catch(() => ctx.toast?.('Could not copy answer', 'Try selecting the text instead.', 'error')); } }) : null,
        (turn.error || turn.stopped) ? button('Edit & try again', { small: true, className: 'ai-followup', onClick: () => choosePrompt(turn.question, turn.network) }) : null
      );
    }
    finishScroll();
  }
  function openResult(target, network) {
    if (!aiResultTarget(target)) return;
    if (ctx.model.settings.network !== network) { errorText = 'This result belongs to another Bitcoin network. Switch back before opening it.'; updateControls(); return; }
    // User-owned navigation only. No navigation or content execution by a model.
    ctx.openAiResult(target);
  }
  function renderResults() {
    if (disposed) return;
    for (const turn of session.turns) {
      const record = turnNodes.get(turn);
      if (!record) continue;
      const signature = JSON.stringify([turn.cards, turn.browse, turn.notes, turn.done]);
      if (signature === record.resultSignature) continue;
      record.resultSignature = signature;
      const cards = [...(turn.cards ?? [])].sort((a, b) => Number(a.editorial === true) - Number(b.editorial === true));
      record.results.hidden = !cards.length && !turn.browse?.length && !turn.notes?.length;
      const renderCard = card => {
        const facts = aiCardFacts(card);
        const factList = facts => h('dl', { className: 'ai-result-facts' }, facts.map(fact => h('div', {}, h('dt', {}, fact.label), h('dd', {}, fact.value))));
        return h('article', { className: 'ai-result-card' },
          h('div', { className: 'ai-card-heading' }, h('span', { className: 'ai-card-icon', 'aria-hidden': 'true' }, card.kind === 'network' ? '₿' : targetIcon(card.kind)),
            h('h3', { title: card.title }, shorten(card.title, 36, 10))),
          h('p', { className: 'ai-card-caption' }, card.editorial ? 'Curated example' : card.cache === 'stale' ? 'Stale cached snapshot' : card.cache && card.cache !== 'miss' ? 'Cached snapshot' : 'Source snapshot', ' · ', card.source),
          factList(facts.slice(0, 3)),
          disclosure(turn, `card:${card.target ?? card.key}:${card.editorial === true}`, { className: 'ai-card-details' }, h('summary', {}, 'Details & source'),
            card.description ? h('p', {}, card.description) : null, factList(facts.slice(3)), card.note ? h('p', {}, card.note) : null,
            h('p', { className: 'ai-provenance' }, `${card.source} · ${card.network}`,
              card.fetchedAt ? ` · ${card.editorial ? 'Reviewed' : 'Fetched'} ${card.editorial ? card.fetchedAt : absoluteTime(card.fetchedAt)}` : '')),
          aiResultTarget(card.target) ? button('Open in browser', { small: true, title: 'Opens a new tab. Select Ask Bitcoin in the sidebar to return to this chat.', onClick: () => openResult(card.target, card.network) }) : null);
      };
      clear(record.results,
        cards.length ? h('h3', { className: 'ai-results-heading' }, `Bitcoin results · ${cards.length}`) : null,
        h('div', { className: 'ai-result-list' }, cards.slice(0, 4).map(renderCard)),
        cards.length > 4 ? disclosure(turn, 'more', { className: 'ai-more-results' }, h('summary', {}, `Show ${cards.length - 4} more results`),
          h('div', { className: 'ai-result-list' }, cards.slice(4).map(renderCard))) : null,
        (turn.browse ?? []).filter(aiResultTarget).map(target => button(target.startsWith('satnav://runes') ? 'Browse the Rune listing' : 'Browse the inscription listing', { small: true, onClick: () => openResult(target, turn.network) })),
        turn.done && cards.length ? h('div', { className: 'ai-followups', role: 'group', ariaLabel: 'Suggested follow-up questions; fills the message without sending' },
          aiResultFollowUps(turn).map(([label, prompt]) => button(label, { small: true, className: 'ai-followup', title: 'Add this question to your draft; you decide when to send.', onClick: () => choosePrompt(prompt, turn.network) }))) : null,
        turn.notes?.length ? disclosure(turn, 'notes', { className: 'ai-result-notes', open: !cards.length }, h('summary', {}, 'Source notes & limitations'),
          turn.notes.map(note => h('p', { className: 'ai-result-note' }, note))) : null);
    }
    finishScroll();
  }
  async function stopRequest() {
    const request = pending;
    if (!request) return;
    status.textContent = 'Stopping…';
    if (activeTurn) activeTurn.stopped = true;
    const cancellation = request.cancel(); updateControls();
    try { await cancellation; }
    catch { if (!disposed) {
      const message = 'Stop could not be confirmed. Late results will be ignored; the request has a fixed timeout.';
      if (activeTurn) errorText = message; else connectionErrorText = message;
      updateControls();
    } }
  }
  async function send() {
    if (pending || disposed || !session.connected || !input.value.trim()) return;
    const question = input.value.trim();
    if (question.length > AI_LIMITS.prompt) { errorText = `Keep your question under ${AI_LIMITS.prompt.toLocaleString()} characters.`; updateControls(); return; }
    const history = aiChatHistory(session.turns);
    const turn = { question, answer: '', cards: [], browse: [], notes: [], network: ctx.model.settings.network };
    session.turns.push(turn); if (session.turns.length > 20) session.turns.shift(); session.selected = turn; activeTurn = turn;
    input.value = ''; session.draft = ''; session.previousDraft = null; errorText = ''; status.textContent = phases.thinking;
    const request = new AiRequest(ctx.ai, { onProgress: value => {
      if (disposed || pending !== request) return;
      Object.assign(turn, value); status.textContent = phases[value.phase] ?? phases.thinking; renderTurns(); renderResults();
    }, onProgressError: () => { if (!disposed && pending === request) status.textContent = 'Waiting for the final reply; progress is temporarily unavailable…'; } });
    pending = request; renderTurns(); renderResults(); updateControls();
    jumpToLatest();
    try {
      const result = await request.run({ action: 'chat', config: { ...session.config }, token: session.token,
        prompt: question, history, allowLookups: session.allowLookups });
      if (disposed || pending !== request) return;
      Object.assign(turn, result, { done: true });
      session.responded = session.responded || result.inferenceResponded === true || (result.answerOrigin !== 'browser' && (Boolean(result.answer) || Boolean(result.cards?.length)));
    } catch (failure) {
      if (!disposed) {
        if (cancelled(failure)) turn.stopped = true;
        else turn.error = { code: failure.code, message: failure.message || 'The AI request failed. Please try again.' };
        if (['AI_UNREACHABLE', 'AI_AUTH', 'AI_MODEL_MISSING', 'AI_REMOTE_MODEL'].includes(failure.code)) {
          session.connected = false; connectionScrollTop = scrollport.scrollTop; connectionOpen = true;
          renderConnection(); scrollport.scrollTop = 0; followLatest = false;
        }
      }
    } finally {
      if (pending === request) { pending = null; activeTurn = null; }
      if (!disposed) { status.textContent = ''; renderTurns(); renderResults(); updateControls(); }
    }
  }
  root.retainAi = (result, model) => {
    if (result.error || result.target?.kind !== 'internal' || result.target.value !== 'ai' || String(model.activeTabId) !== owner) return false;
    if (session.network !== model.settings.network) {
      if (pending) void stopRequest();
      session.network = model.settings.network; session.turns = []; session.selected = null;
      resetScroll();
      errorText = 'Network changed. A new chat keeps results from different networks separate.'; renderTurns(); renderResults();
    }
    updateControls(); return true;
  };
  root.dispose = () => {
    if (disposed) return;
    session.scrollTop = scrollport.scrollTop; session.followLatest = followLatest;
    session.connectionOpen = connectionOpen; session.connectionScrollTop = connectionScrollTop;
    resizeObserver?.disconnect();
    if (activeTurn) activeTurn.stopped = true;
    if (pending) void pending.cancel().catch(() => ctx.toast?.('AI stop unconfirmed', 'The request is deadline-bounded; late replies will not update the page.', 'error'));
    disposed = true; session.dispose = null;
  };
  session.dispose = root.dispose;
  renderModels(); renderConnection(); renderTurns(); renderResults(); updateControls();
  queueMicrotask(() => {
    if (disposed) return;
    if (session.scrollTop != null) scrollport.scrollTop = session.scrollTop;
    restoringScroll = false; updateJump();
    if (!disposed && root.isConnected) console.info('SATOSHI_AI_WORKSPACE_READY');
  });
  return root;
}
