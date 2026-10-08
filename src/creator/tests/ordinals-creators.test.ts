import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ProjectStore} from '../source/core/project-store';
import {buildProject} from '../source/compiler/build';
import {templates} from '../source/core/templates';
import {encodeProject,decodeProject} from '../source/core/portable';
import {defaultRune,runePlan,runeSchema,readCollection,traitFrequency} from '../source/shared/ordinals';
import {parseExactJson,validateRunestone,decodeMetadata,verifyMetadata} from '../source/deploy/ordinal-validation';
const mutation=(p:any)=>({projectId:p.id,expectedRevision:p.revision,idempotencyKey:randomUUID()});
test('Rune quantities remain exact above JavaScript limits, with divisibility, windows, names and symbol validation',()=>{
 const plan=runePlan({...defaultRune,premine:'9007199254740993.00000001',divisibility:8,amount:'0.00000001',cap:'9007199254740993'});assert.equal(plan.supply,'9007199344812985.54740994');
 assert.equal(parseExactJson('{"amount":340282366920938463463374607431768211455}').amount,'340282366920938463463374607431768211455');
 for(const change of [{premine:'1.001',divisibility:2},{premine:'340282366920938463463374607431768211455',amount:'1',cap:'1'},{offsetStart:'10',offsetEnd:'9'},{amount:'0'},{name:'A'.repeat(27)},{symbol:' '},{symbol:'\ud800'}])assert.throws(()=>runePlan({...defaultRune,...change}));assert.equal(runeSchema.parse({...defaultRune,symbol:'💎'}).symbol,'💎');
});
test('Runestone validation rejects cenotaphs, transfers, altered supply, mint terms and wallet pointers',()=>{
 const spec={...defaultRune,name:'TEST•RUNE',divisibility:2,premine:'1.25',amount:'0.5',cap:'10'},artifact={Runestone:{edicts:[],mint:null,pointer:1,etching:{rune:'TESTRUNE',spacers:8,divisibility:2,premine:125,symbol:spec.symbol,turbo:false,terms:{cap:10,amount:50,height:[null,null],offset:[null,null]}}}};
 assert.doesNotThrow(()=>validateRunestone(artifact,spec,1));for(const transform of [(a:any)=>a.Runestone.edicts.push({amount:1}),(a:any)=>a.Runestone.pointer=0,(a:any)=>a.Runestone.etching.premine=124,(a:any)=>a.Runestone.etching.terms.cap=11,(a:any)=>a.Runestone.etching.terms.offset=[1,null]]){const copy=structuredClone(artifact);transform(copy);assert.throws(()=>validateRunestone(copy,spec,1),{code:'INVALID_TRANSACTION'})}assert.throws(()=>validateRunestone({Cenotaph:{}},spec,1));
});
test('Collection metadata decoding is bounded, exact, and rejects duplicates or byte substitution',()=>{
 const hex='a1646e616d656141';assert.deepEqual({...decodeMetadata(hex) as any},{name:'A'});assert.doesNotThrow(()=>verifyMetadata(hex,{name:'A'}));assert.throws(()=>verifyMetadata(hex,{name:'B'}));for(const invalid of ['a2646e616d656141646e616d656142','a1646e616d65','a1646e616d65614100','9fff','1b0020000000000000'])assert.throws(()=>decodeMetadata(invalid));
});
test('Collection editions, traits, source, history, rename and portable archive survive without deduplication',async()=>{
 const root=await mkdtemp('/private/tmp/creator-collection-unit-'),store=new ProjectStore(root);try{await store.initialize();let p=await store.create({title:'Edition test',template:'collection'});const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');p=await store.importCollection(mutation(p),[{path:'assets/art.svg',bytes:svg}]);p=await store.duplicateCollectionItem(mutation(p),'assets/art.svg');let spec=readCollection(p.files)!;spec.items[0].attributes=[{trait_type:'Color',value:'Gold'}];spec.items[1].attributes=[{trait_type:'Color',value:'Gold'}];p=await store.writeFile(mutation(p),'index.html',p.files['index.html'].replace('</body>','<script>window.custom=true</script></body>'));p=await store.configureCollection(mutation(p),{...spec,name:'<Artifact & Co>'});assert.match(p.files['index.html'],/window.custom=true/);assert.match(p.files['index.html'],/&lt;Artifact &amp; Co&gt;/);assert.equal(traitFrequency(readCollection(p.files)!).get('["Color","Gold"]'),2);
 const graph=buildProject(p);assert.equal(graph.findings.some(f=>f.severity==='error'),false);assert.equal(graph.resources.filter(r=>r.mime==='image/svg+xml').length,2);assert.equal(graph.resources.some(r=>r.duplicateOf),false);
 await assert.rejects(store.changeFile(mutation(p),'assets/art.svg',undefined,graph));p=await store.changeFile(mutation(p),'assets/art.svg','assets/renamed.svg',graph);assert.equal(readCollection(p.files)!.items[0].path,'assets/renamed.svg');
 const archive=decodeProject(await encodeProject(p,(id,sha)=>store.readAsset(id,sha))),copy=await store.create({title:archive.title,template:archive.template},undefined,archive);assert.deepEqual(readCollection(copy.files),readCollection(p.files));
 p=await store.history(mutation(p),'undo');assert.equal(readCollection(p.files)!.items[0].path,'assets/art.svg');const before=p.revision;await assert.rejects(store.configureCollection(mutation(p),{...spec,items:[{...spec.items[0],path:'missing.png'}]}));assert.equal((await store.read(p.id)).revision,before);
 }finally{await store.close();await rm(root,{recursive:true,force:true})}
});
test('Specialized creation specs cannot disappear or silently publish a design as a Rune',async()=>{
 const root=await mkdtemp('/private/tmp/creator-rune-unit-'),store=new ProjectStore(root);try{await store.initialize();let p=await store.create({title:'Rune design',template:'runes'});assert.ok(buildProject(p).rune);await assert.rejects(store.changeFile(mutation(p),'rune.json','other.json'));const files={...p.files};delete files['rune.json'];assert.ok(buildProject({...p,files}).findings.some(f=>f.severity==='error'));assert.throws(()=>store.configureRune(mutation(p),{...defaultRune,amount:'0'}),{code:'INVALID_RUNE'});p=await store.configureRune(mutation(p),{...defaultRune,name:'MY•TEST•RUNE',openMint:false,premine:'50'});assert.equal(buildProject(p).rune?.name,'MY•TEST•RUNE');p=await store.writeFile(mutation(p),'rune.json',JSON.stringify({...JSON.parse(p.files['rune.json']),premine:'777'}));assert.match(p.files['index.html'],/<strong>777<\/strong>/);
 const archive=decodeProject(await encodeProject(p,(id,sha)=>store.readAsset(id,sha)));const copy=await store.create({title:archive.title,template:archive.template},undefined,archive);assert.deepEqual(buildProject(copy).rune,buildProject(p).rune);
 }finally{await store.close();await rm(root,{recursive:true,force:true})}
});
test('All targeted experience starters compile without external dependencies; empty collections need artwork',async()=>{
 const root=await mkdtemp('/private/tmp/creator-template-unit-'),store=new ProjectStore(root);try{await store.initialize();assert.equal(templates.length,21);for(const template of ['pixel','generative','story','artifact'] as const){const p=await store.create({title:'Original '+template,template}),build=buildProject(p);assert.equal(build.findings.some(f=>f.severity==='error'),false,template);assert.equal(build.libraries.length,0);}const p=await store.create({title:'Empty',template:'collection'});assert.ok(buildProject(p).findings.some(f=>f.code==='COLLECTION_EMPTY'));}finally{await store.close();await rm(root,{recursive:true,force:true})}
});
