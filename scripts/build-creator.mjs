import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const creator=path.join(root,'src/creator');
const require=createRequire(path.join(creator,'package.json'));
let build;
try{({build}=require('esbuild'));}catch{throw new Error('Install locked creator build dependencies with: npm ci --prefix src/creator');}
const output=path.join(creator,'generated');
// This exact generated directory is owned by this build. Remove stale split
// chunks before hashing the new payload; project/profile data is elsewhere.
await fs.rm(output,{recursive:true,force:true});
await fs.mkdir(output,{recursive:true});
const common={absWorkingDir:creator,bundle:true,metafile:true,sourcemap:false,legalComments:'external',target:'node22'};
const results=[];
for(const [source,destination] of [['main/host.ts','host.cjs'],['mcp/browser-entry.ts','stdio.cjs'],['compiler/worker.ts','compiler/worker.cjs'],['core/merge-worker.ts','core/merge-worker.cjs'],['main/preload.ts','preload.cjs']])results.push(await build({...common,entryPoints:['source/'+source],outfile:'generated/'+destination,platform:'node',format:'cjs',external:['electron']}));
results.push(await build({...common,entryPoints:['source/renderer/index.tsx'],outdir:'generated/renderer',splitting:true,platform:'browser',format:'esm',target:'chrome138',minify:true,loader:{'.woff2':'file'}}));
await fs.copyFile(path.join(creator,'source/renderer/index.html'),path.join(output,'renderer/index.html'));
const mainPreload=path.join(root,'src/main/preload.cjs');
const base=(await fs.readFile(mainPreload,'utf8')).split('// CREATOR_PRELOAD_INSERTION_POINT')[0];
await fs.writeFile(mainPreload,base+`// CREATOR_PRELOAD_INSERTION_POINT
if(typeof location!=='undefined' && location.href==='app://app/creator/generated/renderer/index.html'){
${await fs.readFile(path.join(output,'preload.cjs'),'utf8')}
}
`);
const packages=new Map();
for(const input of results.flatMap(r=>Object.keys(r.metafile.inputs))){
  if(!input.includes('node_modules/'))continue;
  let directory=path.dirname(path.resolve(creator,input));
  while(directory.includes('/node_modules/')){
    try{const metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));if(metadata.name&&metadata.version){packages.set(`${metadata.name}@${metadata.version}`,{directory,metadata});break;}}catch(error){if(error.code!=='ENOENT')throw error;}
    directory=path.dirname(directory);
  }
}
const notices=[await fs.readFile(path.join(creator,'THIRD_PARTY_NOTICES.md'),'utf8')],inventory=[];
for(const [identity,{directory,metadata}] of [...packages].sort(([a],[b])=>a.localeCompare(b))){
  const names=(await fs.readdir(directory,{withFileTypes:true})).filter(e=>e.isFile()&&/^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(e.name)).map(e=>e.name).sort();
  if(!names.length)throw new Error('Missing retained license notice for '+identity);
  const records=[];for(const name of names){const text=await fs.readFile(path.join(directory,name),'utf8');notices.push('\n'+'='.repeat(72)+'\n'+identity+' · '+name+'\n\n'+text);records.push({file:name,sha256:createHash('sha256').update(text).digest('hex')});}
  inventory.push({name:metadata.name,version:metadata.version,license:metadata.license,notices:records});
}
await fs.mkdir(path.join(output,'licenses'),{recursive:true});
await fs.writeFile(path.join(output,'licenses/THIRD_PARTY_NOTICES.txt'),notices.join('\n'));
await fs.writeFile(path.join(output,'licenses/inventory.json'),JSON.stringify({schemaVersion:1,packages:inventory},null,2)+'\n');
const inputs={};
for(const input of [...new Set(results.flatMap(r=>Object.keys(r.metafile.inputs)))].sort()){if(input.includes('node_modules/'))continue;inputs[input]=createHash('sha256').update(await fs.readFile(path.resolve(creator,input))).digest('hex');}
const payload={};
async function walk(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile()&&entry.name!=='build-manifest.json')payload[path.relative(output,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');}}
await walk(output);
await fs.writeFile(path.join(output,'build-manifest.json'),JSON.stringify({schemaVersion:1,sourceBuilderCommit:'96141f4',createdAt:new Date().toISOString(),inputs,payload},null,2)+'\n');
console.log(`Built Create mode, MCP bridge, bounded workers and ${inventory.length} retained dependency notices.`);
