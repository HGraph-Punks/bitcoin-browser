import test from 'node:test';
import assert from 'node:assert/strict';
import {withLibraryNotices,hasLibraryNotices} from '../source/catalog/notices';
import {createTemplate,initialSettings} from '../source/core/templates';
import {libraries} from '../source/catalog/libraries';

test('credits preserve custom source, retain complete license texts, and repair tampered notices without duplication',()=>{
  const source='<!doctype html><html><head><title>Custom</title></head><body><main><!--keep me--><h1>My own layout</h1></main><script>window.custom=21</script></body></html>';
  const keys=['three-r178','tone-15.0.4'],result=withLibraryNotices(source,keys);
  assert.ok(result.includes(source.slice(0,source.indexOf('</body>'))));assert.equal(hasLibraryNotices(result,keys),true);
  assert.equal(withLibraryNotices(result,keys),result);assert.equal((result.match(/data-btcsite-notices=/g)??[]).length,1);
  const tampered=result.replace('Permission is hereby granted','Permission was removed');assert.equal(hasLibraryNotices(tampered,keys),false);
  assert.equal(withLibraryNotices(tampered,keys),result);
  const tricky=source.replace('window.custom=21','window.custom="</body>"');const kept=withLibraryNotices(tricky,keys);assert.ok(kept.includes('<script>window.custom="</body>"</script>'));assert.equal(hasLibraryNotices(kept,keys),true);
  // p5's complete LGPL text must survive HTML escaping and parsing as well.
  const sketch=createTemplate('sketch2',initialSettings('sketch2','A sketch'));assert.equal(hasLibraryNotices(sketch,['p5-2.0.1']),true);
  assert.ok(sketch.includes('GNU LESSER GENERAL PUBLIC LICENSE'));
});

test('source/license evidence is explicit and p5 variants cannot silently share a starter',()=>{
  for(const library of libraries){assert.ok(library.license.sources.length);assert.equal(library.chainIndependentlyVerified,false);for(const source of library.license.sources){assert.match(source.sha256,/^[a-f0-9]{64}$/);assert.match(source.url,/^https:\/\//);}}
  const first=createTemplate('sketch',initialSettings('sketch','First')),second=createTemplate('sketch2',initialSettings('sketch2','Second'));
  for(const key of ['p5-1.11.2','p5-2.0.1']){const library=libraries.find(l=>l.key===key)!;assert.equal((key==='p5-1.11.2'?first:second).includes('/content/'+library.id),true);assert.equal((key==='p5-1.11.2'?second:first).includes('/content/'+library.id),false);}
});
