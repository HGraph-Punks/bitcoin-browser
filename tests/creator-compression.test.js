import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { OrdServerProvider } from '../src/main/providers/ord-server.js';
import { createCreatorResolver } from '../src/main/creator-resources.js';

test('native Ord requests admit Brotli inscriptions; creator pins use bounded decoded content', async () => {
  const plain = Buffer.from('const library = "verified native content";'.repeat(100));
  const encoded = brotliCompressSync(plain);
  const server = createServer((request, response) => {
    if (!request.headers['accept-encoding']?.split(/[, ]+/).includes('br')) { response.writeHead(406); response.end('Brotli inscription requires br'); return; }
    response.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'br', 'content-length': String(encoded.length) }); response.end(encoded);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OrdServerProvider({ id:'owned', type:'ord-server', name:'Owned', network:'mainnet', baseUrl:`http://127.0.0.1:${server.address().port}`, enabled:true, local:true, capabilities:['ord-recursion'] });
    const response = await provider.fetchPath('/content/'+'a'.repeat(64)+'i0', { maxBytes:8192 });
    assert.deepEqual(response.data, encoded); assert.equal(response.headers['content-encoding'], 'br');
    const native = { resolve:async()=>({ ...response, status:200 }) };
    const creator = createCreatorResolver(native);
    const decoded = await creator.resolve('/content/'+'a'.repeat(64)+'i0', { maxBytes:8192 });
    assert.deepEqual(decoded.data, plain); assert.equal(decoded.headers['content-encoding'], undefined);
    await assert.rejects(creator.resolve('/content/'+'a'.repeat(64)+'i0', { maxBytes:512 }), { code:'RESOURCE_TOO_LARGE' });
    const cancellation = new AbortController(); cancellation.abort(new Error('Draft changed'));
    await assert.rejects(creator.resolve('/content/'+'a'.repeat(64)+'i0', { maxBytes:8192, signal:cancellation.signal }), /Draft changed/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
