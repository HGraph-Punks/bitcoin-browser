import http from 'node:http';
import net from 'node:net';

export const SHUTDOWN_CASES = Object.freeze(['idle', 'shell-cold-link', 'shell-recreate', 'settings-roundtrip', 'provider-only', 'content-none', 'content-https-blocked', 'content-https', 'content-https-include', 'content-wss-blocked', 'content-wss',
  'frame-https-include', 'frame-https-include-credentialless', 'frame-wss', 'frame-wss-credentialless']);

export function shutdownCaseProbe(name) {
  if (!SHUTDOWN_CASES.includes(name)) throw new Error('Unknown shutdown case');
  if (name.includes('wss')) return 'wss';
  if (name.includes('https-include')) return 'https-include';
  return name.includes('https') ? 'https' : 'none';
}

// Diagnostic-only composition. Both controls use the same opaque sandbox and
// real ord protocol; credentialless is set before src and before attachment.
// This does not mutate the packaged renderer or qualify its actual UI path.
export function shutdownFrameExpression(id, credentialless) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}i[1-3]$/.test(id) || typeof credentialless !== 'boolean') throw new Error('Invalid diagnostic frame configuration');
  return `(() => {
    if (document.querySelector('#shutdown-isolation-frame') || document.querySelector('.viewer-canvas iframe')) throw new Error('Unexpected existing diagnostic/content frame');
    const frame = document.createElement('iframe');
    if (!('credentialless' in frame)) throw new Error('Credentialless iframe is unsupported');
    frame.id = 'shutdown-isolation-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-pointer-lock');
    frame.referrerPolicy = 'no-referrer';
    frame.credentialless = ${credentialless};
    frame.src = ${JSON.stringify(`ord://content/${id}`)};
    document.querySelector('#page').append(frame);
    return { credentialless: frame.credentialless, sandbox: frame.getAttribute('sandbox'), referrerPolicy: frame.referrerPolicy, src: frame.src };
  })()`;
}

export function shutdownProbeHtml(probe, endpoint) {
  if (!['none', 'https', 'https-include', 'wss'].includes(probe)) throw new Error('Unknown shutdown probe');
  const url = new URL(endpoint);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'https:' || !url.port || url.username || url.password) throw new Error('Expected a loopback TLS fixture');
  const config = JSON.stringify({ probe, endpoint }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Shutdown isolation fixture</title>
<pre>Single bounded network operation</pre><script>
(() => {
  const { probe, endpoint } = ${config};
  const result = window.shutdownProbe = { probe, attempted: false, done: false, outcome: null,
    credentialless: typeof window.credentialless === 'boolean' ? window.credentialless : null };
  let cleanup = () => {};
  let timer;
  const finish = (outcome) => {
    if (result.done) return;
    result.done = true; result.outcome = outcome; clearTimeout(timer); cleanup();
  };
  if (probe === 'none') { finish('no-network'); return; }
  timer = setTimeout(() => finish('bounded-timeout'), 1200);
  result.attempted = true;
  try {
    if (probe === 'https' || probe === 'https-include') {
      const controller = new AbortController();
      cleanup = () => controller.abort();
      fetch(endpoint + '/probe', { signal: controller.signal, credentials: probe === 'https-include' ? 'include' : 'same-origin' }).then(() => finish('response'), () => finish('rejected'));
    } else {
      const socket = new WebSocket(endpoint.replace('https:', 'wss:') + '/probe');
      cleanup = () => socket.close();
      socket.onopen = () => finish('opened'); socket.onerror = () => finish('rejected');
    }
  } catch { finish('thrown'); }
})();
</script>`;
}

// One HTTP provider and one raw TLS sink, both bound to loopback. No certificate
// is supplied, no trust exception is installed, and no credentials are involved.
export async function startShutdownFixture(probe) {
  if (!['none', 'https', 'https-include', 'wss'].includes(probe)) throw new Error('Unknown shutdown probe');
  const requests = [];
  const connections = [];
  const sockets = new Set();
  let observationsTruncated = false;
  let endpoint;
  const track = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); };
  const add = (list, value) => { if (list.length < 256) list.push(value); else observationsTruncated = true; };
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    add(requests, { path: route.slice(0, 256), method: request.method });
    response.setHeader('content-type', 'application/json');
    if (route === '/r/blockheight') return response.end('840000');
    if (route === '/r/sat/0') return response.end(JSON.stringify({ number: '0', name: 'fixture-sat', rarity: 'common', ids: [] }));
    const id = route.match(/^\/r\/inscription\/([a-f0-9]{64}i\d+)$/)?.[1];
    if (id) return response.end(JSON.stringify({ id, number: 1, content_type: 'text/html', sat: 0 }));
    if (/^\/content\/[a-f0-9]{64}i\d+$/.test(route)) {
      response.setHeader('content-type', 'text/html');
      return response.end(shutdownProbeHtml(probe, endpoint));
    }
    response.statusCode = 404;
    response.end('{}');
  });
  server.on('connection', track);
  const tls = net.createServer((socket) => {
    track(socket);
    const observation = { clientHello: false, bytes: 0, closed: false };
    add(connections, observation);
    socket.setTimeout(1500, () => socket.destroy());
    socket.once('data', (data) => { observation.bytes = data.length; observation.clientHello = data[0] === 22; socket.destroy(); });
    socket.once('close', () => { observation.closed = true; });
  });
  const listen = (listener) => new Promise((resolve, reject) => {
    listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, tls].map((listener) => new Promise((resolve) => {
      if (!listener.listening) return resolve();
      listener.close(resolve); listener.closeAllConnections?.();
    })));
  };
  try { await listen(server); await listen(tls); }
  catch (error) { await close(); throw error; }
  endpoint = `https://127.0.0.1:${tls.address().port}`;
  return {
    requests, connections, close, endpoint,
    get observationsTruncated() { return observationsTruncated; },
    provider: { id: 'shutdown-loopback', name: 'Shutdown loopback', type: 'ord-server', network: 'mainnet',
      baseUrl: `http://127.0.0.1:${server.address().port}`, enabled: true, local: true, priority: 0,
      capabilities: ['sat', 'inscription', 'ord-recursion'] }
  };
}

export function classifyShutdown(result) {
  return result.operationCompleted === true && result.code === 0 && result.signal === null
    && result.forced === false && result.closed === true && result.spawnError === null
    && result.diagnostics === 0 && result.exceptionCount === 0 && result.truncated === false;
}
