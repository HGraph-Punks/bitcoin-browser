import http from 'node:http';
import net from 'node:net';

// Counter-only loopback endpoints. No credentials, public hosts, certificate
// exceptions, filesystem access, or unbounded response bodies are involved.
export async function startHostileNetworkFixture() {
  const requests = [];
  const connections = [];
  const sockets = new Set();
  let baseUrl;
  let tlsUrl;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, baseUrl);
    requests.push({ path: url.pathname, method: request.method, query: url.search });
    response.setHeader('access-control-allow-origin', '*');
    if (url.pathname === '/control') return response.end('fixture-ready');
    if (url.pathname === '/r/blockheight') return response.end('840000');
    const inscription = url.pathname.match(/^\/r\/inscription\/([a-f0-9]{64}i\d+)$/)?.[1];
    if (inscription) {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ id: inscription, number: 100, content_type: 'text/html', sat: 0 }));
    }
    const content = url.pathname.match(/^\/content\/([a-f0-9]{64}i\d+)$/)?.[1];
    if (content) {
      response.setHeader('content-type', 'text/html');
      return response.end(hostileNetworkHtml(baseUrl, tlsUrl, content));
    }
    if (url.pathname.startsWith('/attack/')) {
      response.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/plain');
      return response.end('/* bounded fixture response */');
    }
    response.statusCode = 404;
    response.end('fixture route not found');
  });
  server.on('upgrade', (request, socket) => {
    requests.push({ path: new URL(request.url, baseUrl).pathname, method: 'UPGRADE' });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  // A raw TLS sink observes ClientHello bytes then closes. It never issues a
  // certificate, completes TLS, or weakens normal certificate verification.
  const tlsProbe = net.createServer((socket) => {
    sockets.add(socket);
    const observation = { bytes: 0, tlsHandshake: false };
    connections.push(observation);
    socket.setTimeout(1000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('data', (data) => {
      observation.bytes = data.length;
      observation.tlsHandshake = data[0] === 22;
      socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
  });
  const listen = (listener) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  await listen(server);
  try { await listen(tlsProbe); }
  catch (error) { server.close(); throw error; }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tlsUrl = `https://127.0.0.1:${tlsProbe.address().port}`;
  return {
    baseUrl, tlsUrl, requests, connections,
    provider: { id: 'beta-hostile-http', name: 'Hostile fixture source', type: 'ord-server',
      network: 'mainnet', baseUrl, enabled: true, local: true, priority: 0,
      capabilities: ['inscription', 'ord-recursion'] },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([server, tlsProbe].map((listener) => new Promise((resolve) => {
        listener.close(resolve);
        listener.closeAllConnections?.();
      })));
    }
  };
}

function hostileNetworkHtml(baseUrl, tlsUrl, token) {
  const config = JSON.stringify({ baseUrl, tlsUrl, token }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Bounded network fixture</title>
<pre id="network-result">running</pre><script>
(async () => {
  const { baseUrl, tlsUrl, token } = ${config};
  const result = { attempted: [], violations: [], permissions: {}, done: false,
    authority: Boolean(window.satBrowser || window.walletHost || window.require || window.process),
    popup: false, topNavigationAccepted: false };
  window.networkFixtureResult = result;
  document.addEventListener('securitypolicyviolation', (event) => result.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  const url = (name) => baseUrl + '/attack/' + name + '?fixture=' + token;
  const bounded = (name, action) => {
    result.attempted.push(name);
    return new Promise((resolve) => {
      let cleanup = () => {};
      const timer = setTimeout(() => { cleanup(); resolve(); }, 900);
      const done = () => { clearTimeout(timer); cleanup(); resolve(); };
      try { cleanup = action(done) || cleanup; } catch { done(); }
    });
  };
  const element = (name, tag, attribute) => bounded(name, (done) => {
    const node = document.createElement(tag);
    if (tag === 'link') node.rel = 'stylesheet';
    node.onload = done; node.onerror = done;
    node[attribute] = url(name);
    document.body.append(node);
    if (tag === 'audio' || tag === 'video') { node.preload = 'auto'; node.load(); }
    return () => node.remove();
  });
  const jobs = [
    bounded('fetch', (done) => { const abort = new AbortController(); fetch(url('fetch'), { signal: abort.signal }).then(done, done); return () => abort.abort(); }),
    bounded('post', (done) => { const abort = new AbortController(); fetch(url('post'), { method: 'POST', body: 'fixture-only', signal: abort.signal }).then(done, done); return () => abort.abort(); }),
    bounded('xhr', (done) => { const xhr = new XMLHttpRequest(); xhr.open('GET', url('xhr')); xhr.onloadend = done; xhr.send(); return () => xhr.abort(); }),
    bounded('event-stream', (done) => { const stream = new EventSource(url('event-stream')); stream.onerror = done; stream.onopen = done; return () => stream.close(); }),
    bounded('socket', (done) => { const socket = new WebSocket(url('socket').replace('http:', 'ws:')); socket.onerror = done; socket.onopen = done; return () => socket.close(); }),
    bounded('https', (done) => { const abort = new AbortController(); fetch(tlsUrl + '/attack/https', { signal: abort.signal }).then(done, done); return () => abort.abort(); }),
    bounded('wss', (done) => { const socket = new WebSocket(tlsUrl.replace('https:', 'wss:') + '/attack/wss'); socket.onerror = done; socket.onopen = done; return () => socket.close(); }),
    element('image.png', 'img', 'src'), element('script.js', 'script', 'src'),
    element('style.css', 'link', 'href'), element('frame.html', 'iframe', 'src'),
    element('audio', 'audio', 'src'), element('video', 'video', 'src'),
    bounded('worker.js', (done) => { const worker = new Worker(url('worker.js')); worker.onerror = done; return () => worker.terminate(); })
  ];
  result.attempted.push('form');
  try {
    const frame = document.createElement('iframe'); frame.name = 'form-result'; document.body.append(frame);
    const form = document.createElement('form'); form.target = frame.name; form.method = 'POST'; form.action = url('form'); document.body.append(form); form.submit();
    setTimeout(() => { frame.remove(); form.remove(); }, 900);
  } catch {}
  try { top.location = url('escape'); result.topNavigationAccepted = true; } catch {}
  try { result.popup = Boolean(window.open(url('popup'))); } catch {}
  for (const name of ['geolocation', 'camera', 'microphone']) {
    jobs.push(navigator.permissions.query({ name }).then((permission) => { result.permissions[name] = permission.state; }, () => { result.permissions[name] = 'unavailable'; }));
  }
  await Promise.all(jobs);
  await new Promise((resolve) => setTimeout(resolve, 100));
  result.done = true;
  document.querySelector('#network-result').textContent = JSON.stringify(result);
})();
</script>`;
}
