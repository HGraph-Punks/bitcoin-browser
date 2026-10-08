import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {ProjectStore} from '../source/core/project-store';
import {buildProject,prepareResource,type PublishedBinding} from '../source/compiler/build';
import {encodeProject,decodeProject,readWebsiteFolder} from '../source/core/portable';
import {scanSource} from '../source/compiler/references';
import {decodeBase64,validateAssets} from '../source/core/assets';
import {readInputFile} from '../source/core/input-files';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh2kAAAAASUVORK5CYII=','base64');
const mutation=(p:{id:string;revision:number})=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');

test('parsed multi-file graph rewrites CSS, modules, srcset and glTF; final stages reject draft or mismatched IDs',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-graph-')),store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'Recursive files',template:'blank'});
  const sources={
    'index.html':'<!doctype html><html><head><link rel="stylesheet" href="styles/main.css"></head><body><img src="media/pixel.png" srcset="media/pixel.png 1x, media/copy.png 2x" style="background-image:url(&quot;media/pixel.png&quot;)"><script type="module" src="scripts/main.js"></script></body></html>',
    'styles/main.css':'@import "./theme.css"; body { background: url(\'../media/pixel.png#texture\'); }',
    'styles/theme.css':':root { color: #f7931a; }',
    'scripts/main.js':`import {label} from './label.js'; const image=new URL('../media/pixel.png?size=1',import.meta.url); fetch('/data/state.json'); fetch('/model/scene.gltf'); import('./extra.js'); document.body.dataset.label=label;`,
    'scripts/label.js':`export const label='recursive';`,
    'scripts/extra.js':`document.body.dataset.extra='loaded';`,
    'data/state.json':'{"height":123}',
    'model/scene.gltf':'{"asset":{"version":"2.0"},"buffers":[{"uri":"../data/mesh.bin","byteLength":4}],"images":[{"uri":"../media/pixel.png"}]}',
    'private-notes.txt':'This source is intentionally not referenced by the website.'
  };
  p=await store.importFiles(mutation(p),[...Object.entries(sources).map(([path,text])=>({path,bytes:Buffer.from(text)})),{path:'media/pixel.png',bytes:png},{path:'media/copy.png',bytes:png},{path:'data/mesh.bin',bytes:Buffer.from([1,2,3,4])}]);
  const build=buildProject(p);assert.deepEqual(build.findings.filter(f=>f.severity==='error'),[]);
  assert.equal(buildProject(p).id,build.id);assert.deepEqual(build.unpublishedFiles,['private-notes.txt']);
  assert.equal(build.resources.find(r=>r.path==='media/pixel.png')!.previewId,build.resources.find(r=>r.path==='media/copy.png')!.previewId);
  assert.equal(build.stages.at(-1)!.paths.at(-1),'index.html');
  const css=build.resources.find(r=>r.path==='styles/main.css')!;assert.match(css.text!,/@import "\/content\/[a-f0-9]{64}i0"/);assert.match(css.text!,/#texture/);
  assert.match(build.html,/srcset="\/content\/[a-f0-9]{64}i0 1x, \/content\/[a-f0-9]{64}i0 2x"/);
  assert.match(build.html,/background-image:url\(&quot;\/content\//);
  assert.throws(()=>prepareResource(build,'index.html',{}),{code:'DEPENDENCY_UNPUBLISHED'});
  const bindings:Record<string,PublishedBinding>={};
  for(const stage of build.stages)for(const name of stage.paths){
    const prepared=prepareResource(build,name,bindings);const actual=prepared.text===undefined?await store.readAsset(p.id,prepared.asset!.sha256):Buffer.from(prepared.text);
    assert.equal(digest(actual),prepared.sha256);
    bindings[name]={network:'mainnet',id:digest('actual-test-inscription:'+name)+'i0',sha256:prepared.sha256,mime:prepared.mime};
  }
  const final=prepareResource(build,'index.html',bindings);assert.match(final.text!,new RegExp(bindings['scripts/main.js'].id));assert.equal(final.text,prepareResource(build,'index.html',bindings).text);
  for(const r of build.resources)assert.ok(!final.text!.includes(r.previewId));
  const wrong={...bindings,'scripts/main.js':{...bindings['scripts/main.js'],sha256:'0'.repeat(64)}};assert.throws(()=>prepareResource(build,'index.html',wrong),{code:'DEPENDENCY_MISMATCH'});
  const draft={...bindings,'scripts/main.js':{...bindings['scripts/main.js'],id:build.resources.find(r=>r.path==='scripts/main.js')!.previewId}};assert.throws(()=>prepareResource(build,'index.html',draft),{code:'PROVISIONAL_ID'});
});

test('cycles, missing files, syntax failures and ambiguous document-relative requests cannot pass publication checks',async t=>{
  const store=new ProjectStore(await mkdtemp(path.join(os.tmpdir(),'btcsite-cycles-')));await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'Cycle checks',template:'blank'});
  p=await store.importFiles(mutation(p),[{path:'index.html',bytes:Buffer.from('<script type="module" src="a.js"></script><img src="missing.png">')},{path:'a.js',bytes:Buffer.from(`import './b.js'`)},{path:'b.js',bytes:Buffer.from(`import './a.js'`)}]);
  const cyclic=buildProject(p);assert.ok(cyclic.findings.some(f=>f.code==='DEPENDENCY_CYCLE'));assert.ok(cyclic.findings.some(f=>f.code==='MISSING_RESOURCE'));assert.throws(()=>prepareResource(cyclic,'index.html',{}),{code:'BUILD_BLOCKED'});
  const invalid=scanSource('broken.js','export {');assert.equal(invalid.findings[0].code,'JAVASCRIPT_SYNTAX');
  p=await store.importFiles(mutation(p),[{path:'index.html',bytes:Buffer.from('<script src="shared.js"></script><a href="nested/page.html">Page</a>')},{path:'nested/page.html',bytes:Buffer.from('<script src="../shared.js"></script>')},{path:'shared.js',bytes:Buffer.from('fetch("state.json")')},{path:'state.json',bytes:Buffer.from('{}')},{path:'nested/state.json',bytes:Buffer.from('{}')}]);
  assert.ok(buildProject(p).findings.some(f=>f.code==='AMBIGUOUS_DOCUMENT_BASE'));
});

test('asset history, safe renames and portable project archives retain original bytes without exporting private paths',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-portable-')),store=new ProjectStore(root);await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'Portable gallery',template:'blank'});
  p=await store.importFiles(mutation(p),[{path:'index.html',bytes:Buffer.from('<!doctype html><img src="images/original.png">')},{path:'images/original.png',bytes:png}]);
  await assert.rejects(store.changeFile(mutation(p),'images/original.png'),{code:'FILE_IN_USE'});
  const rename=mutation(p);p=await store.changeFile(rename,'images/original.png','images/renamed.png');assert.match(p.files['index.html'],/images\/renamed.png/);assert.equal((await store.changeFile(rename,'images/original.png','images/renamed.png')).revision,p.revision);
  const archive=await encodeProject(p,(id,sha)=>store.readAsset(id,sha));assert.ok(!archive.toString().includes(root));
  const imported=decodeProject(archive),copy=await store.create({title:imported.title,template:imported.template},undefined,imported);
  assert.notEqual(copy.id,p.id);assert.deepEqual(copy.files,p.files);assert.deepEqual(await store.readAsset(copy.id,copy.assets['images/renamed.png'].sha256),png);
  p=await store.history(mutation(p),'undo');assert.ok(p.assets['images/original.png']);assert.deepEqual(await store.readAsset(p.id,p.assets['images/original.png'].sha256),png);
  const corrupted=JSON.parse(archive.toString());corrupted.files[0].content+='!';assert.throws(()=>decodeProject(Buffer.from(JSON.stringify(corrupted))),{code:'ARCHIVE_INTEGRITY'});
  const escaped=JSON.parse(archive.toString());escaped.files[0].path='../outside.html';assert.throws(()=>decodeProject(Buffer.from(JSON.stringify(escaped))),{code:'UNSAFE_PATH'});
  await writeFile(path.join(root,p.id,'assets',p.assets['images/original.png'].sha256),'changed');await assert.rejects(store.readAsset(p.id,p.assets['images/original.png'].sha256),{code:'ASSET_INTEGRITY'});
});

test('native folder import follows internal links but rejects escaping links and ignores hidden credentials',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-import-'));await writeFile(path.join(root,'index.html'),'<h1>Imported</h1>');await writeFile(path.join(root,'.env'),'private');await mkdir(path.join(root,'media'));await writeFile(path.join(root,'media/pixel.png'),png);
  await symlink(path.join(root,'media/pixel.png'),path.join(root,'copy.png'));
  const imported=await readWebsiteFolder(root);assert.deepEqual(imported.skipped,['.env']);assert.equal(imported.entries.length,3);
  const outside=await mkdtemp(path.join(os.tmpdir(),'btcsite-outside-'));await writeFile(path.join(outside,'private.txt'),'private');await symlink(path.join(outside,'private.txt'),path.join(root,'escape.txt'));
  await assert.rejects(readWebsiteFolder(root),{code:'IMPORT_PATH_ESCAPE'});
});

test('CSS escapes, network scopes, and document-relative requests retain their meaning through file changes',async t=>{
  const parsed=scanSource('escaped.css',String.raw`body { background: url("images/pi\78 el.png?mode=1#detail"); }`);
  assert.equal(parsed.references[0].url,'images/pixel.png?mode=1#detail');
  const store=new ProjectStore(await mkdtemp(path.join(os.tmpdir(),'btcsite-context-')));await store.initialize();t.after(()=>store.close());
  let p=await store.create({title:'Page contexts',template:'blank'});
  p=await store.importFiles(mutation(p),[{path:'index.html',bytes:Buffer.from('<a href="nested/page.html">Details</a>')},{path:'nested/page.html',bytes:Buffer.from('<script type="module" src="../scripts/main.js"></script>')},{path:'scripts/main.js',bytes:Buffer.from('fetch("state.json");')},{path:'nested/state.json',bytes:Buffer.from('{"answer":42}')}]);
  p=await store.changeFile(mutation(p),'nested/state.json','data/state.json');assert.match(p.files['scripts/main.js'],/fetch\("\/data\/state.json"\)/);
  assert.equal(buildProject(p).findings.filter(f=>f.severity==='error').length,0);
  p=await store.changeFile(mutation(p),'scripts/main.js','moved/main.js');assert.match(p.files['nested/page.html'],/\.\.\/moved\/main.js/);assert.match(p.files['moved/main.js'],/fetch\("\/data\/state.json"\)/);
  const graph=buildProject(p),state=prepareResource(graph,'data/state.json',{});
  const wrong:Record<string,PublishedBinding>={'data/state.json':{network:'regtest',id:'a'.repeat(64)+'i0',sha256:state.sha256,mime:state.mime}};
  assert.throws(()=>prepareResource(graph,'moved/main.js',wrong),{code:'WRONG_NETWORK'});
  const three=buildProject(await store.create({title:'Mainnet library',template:'three'}));assert.throws(()=>prepareResource(three,'index.html',{},'regtest'),{code:'WRONG_NETWORK'});
});


test('large asset bodies stay bounded and path prefixes cannot collide with files',async()=>{
  const body=Buffer.alloc(8_000_000,42),encoded=body.toString('base64');assert.deepEqual(decodeBase64(encoded,8_000_000),body);
  assert.throws(()=>decodeBase64(encoded,7_999_999),{code:'INVALID_ASSET'});
  assert.throws(()=>decodeBase64('AB==',8),{code:'INVALID_ASSET'});
  assert.throws(()=>validateAssets({}, {'index.html':'','folder.json':'{}','folder.json/nested.js':''}),{code:'PATH_COLLISION'});
  const root=await mkdtemp(path.join(os.tmpdir(),'btcsite-bounded-')),filename=path.join(root,'asset.bin');await writeFile(filename,body);
  assert.deepEqual(await readInputFile(filename,8_000_000),body);await assert.rejects(readInputFile(filename,7_999_999),{code:'IMPORT_LIMIT'});
});
