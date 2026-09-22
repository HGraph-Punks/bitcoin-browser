// Native consent is kept in the main process. No generic path/command authority
// is exposed to content, and selecting a cookie never reads its contents here.
import { nodeSetupGuidance } from '../shared/node-setup-guidance.js';

export function createNodeSetupDialogs(dialog, getWindow) {
  return {
    async pick(kind) {
      const directory = kind === 'directory';
      const titles = { directory: 'Choose storage for fresh node data folders', 'core-executable': 'Choose the bitcoind program (not Bitcoin-Qt)', 'ord-executable': 'Choose the ord program', cookie: 'Choose the running Bitcoin Core cookie file', snapshot: 'Choose an uncompressed mainnet UTXO snapshot for Core 31' };
      if (!Object.hasOwn(titles, kind)) throw new Error('Unknown node setup picker');
      const result = await dialog.showOpenDialog(getWindow() ?? undefined, {
        title: titles[kind], properties: directory ? ['openDirectory', 'createDirectory'] : ['openFile', 'showHiddenFiles']
      });
      return { path: result.canceled ? null : result.filePaths?.[0] ?? null };
    },
    async confirm(action, value) {
      let message, detail, button;
      const guidance = nodeSetupGuidance(value?.draft);
      const isolatedCore = value?.core?.managed && value.draft?.network === 'regtest'
        && value.draft.core?.peerConnections === 'disabled';
      if (action === 'easy-start') {
        const { plan, descriptor } = value;
        message = 'Set up and start Bitcoin Core?';
        detail = `Bitcoin Core ${descriptor.version} from ${descriptor.url}\nNetwork: mainnet (the browser will switch to mainnet)\nStorage: ${plan.draft.rootDirectory}\n\nThis downloads a separate program, checks its pinned SHA-256 checksum, saves fresh dedicated configuration, and starts a compact, fully validating node. Publisher signatures are not verified; OS launch protections remain enabled. Personal node configurations are not changed.\n\nAllow at least 30 GiB free initially; storage can grow. The 10,000 MiB pruning target is for block files, not total disk use. Core still downloads and processes Bitcoin’s history: hundreds of gigabytes, potentially days of work, plus ongoing bandwidth, power and memory use. Use an unmetered connection. Cache target: ${plan.draft.core.dbCacheMiB} MiB; validation threads: ${plan.draft.core.validationThreads}. These are not total resource limits.\n\nNo wallet or funds are involved. The browser uses Core’s authentication cookie internally without displaying it. RPC stays on this computer; no router ports are opened. Core uses its own peer connections; browser offline/local-only controls do not stop that traffic. Use Stop managed services to stop this node.\n\n${plan.draft.autoStart ? 'You opted into starting Core on future Bitcoin Browser launches.' : 'Core will not start automatically on future browser launches.'} This is not an operating-system startup service. Quitting Bitcoin Browser stops its managed node. Inscription and Runes indexing still requires a separate source or archival Core + Ord.`;
        button = 'Set up and start';
      } else if (action === 'install') {
        message = `Download ${value.kind === 'core' ? 'Bitcoin Core' : 'Ord'} ${value.version}?`;
        detail = `Download from ${value.url}\n\nThe browser will store a separate copy of this program and verify its pinned SHA-256 checksum. Publisher signature verification is not performed. Your operating system’s launch protections remain enabled. Nothing starts yet.`;
        button = 'Download program';
      } else if (action === 'apply') {
        message = 'Save this local node setup?';
        const storage = value.services.length ? `Storage: ${value.draft.rootDirectory}\n\nThis creates fresh dedicated configuration only; existing services and personal configuration are not edited.`
          : 'No new node data folders are created. Only local source connections are saved; existing services and personal configuration are not edited.';
        detail = `Network: ${value.draft.network}\nNew managed services: ${value.services.length}\nLocal data sources: ${value.providers.length}\n${storage} The browser network changes to the selected network. Saved sources may be checked automatically, using the selected Core cookie when Core RPC authentication is needed, without displaying it. No process starts now.${value.draft.autoStart && value.services.length ? '\n\nYou opted into starting these managed services automatically on future browser launches, including their network and disk activity.' : ''}`;
        if (isolatedCore) detail += '\n\nCore peer connections: Off — local test chain only. Peer connections and DNS seeding will be disabled at startup. This is application configuration, not an OS firewall.';
        button = 'Save setup';
      } else if (action === 'start') {
        message = value.services.length ? 'Start your local node setup?' : 'Check your existing local connections?';
        const activity = [];
        if (isolatedCore) activity.push('Managed regtest Core starts with peer connections and DNS seeding off. Blocks must be supplied locally; it will not synchronize from peers. This is application configuration, not an OS firewall; authenticated Core RPC can change network activity.');
        else if (guidance.coreManaged) activity.push(`Managed Bitcoin Core may connect to Bitcoin peers on ${value.draft.network}.`);
        if (guidance.ordManaged) activity.push('Ord builds a local index and waits for Core, its transaction index and REST before starting.');
        activity.push(guidance.storageText, 'This is not a wallet setup and no funds are used.');
        detail = `${activity.join(' ')}\n\nThe browser and Ord use the selected Core cookie when Core RPC authentication is needed, without displaying it. Browser offline/local-only controls do not stop node peer traffic.${value.services.length ? ' Use Stop managed services to stop app-owned processes.' : ''} Existing connected services are never started or stopped by this walkthrough.`;
        button = value.services.length ? 'Start managed services' : 'Check connections';
      } else if (action === 'snapshot') {
        message = 'Import this snapshot into managed Bitcoin Core?';
        detail = `File: ${value.path}\nNetwork: mainnet\nSnapshot base: ${value.baseHeight}\nBlock hash: ${value.baseHash}\n\nOnly the file header has been recognized. Core must verify the entire UTXO commitment against its built-in value. This changes Core chainstate and can take several minutes. Core will then catch up and validate earlier history in the background; current does not mean historically validated.\n\nAllow about 60 GiB of free workspace, plus the snapshot file. Actual needs vary and disk growth is not capped. The original file is never deleted. No funds, wallet or witness-verification settings are changed.\n\nLeaving the page or losing the RPC connection does not cancel Core's import. Use Stop managed services to request a process stop, then check status before retrying.`;
        button = 'Import snapshot';
      } else throw new Error('Unknown node setup confirmation');
      const result = await dialog.showMessageBox(getWindow() ?? undefined, { type: 'question', title: 'Local node setup', message, detail, buttons: ['Cancel', button], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1;
    }
  };
}
