import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { resolveLibraries } from '../catalog/libraries';
import {hasLibraryNotices} from '../catalog/notices';
import path from 'node:path';
import {AppError} from '../core/errors';
import {mimeFor,validateAssets} from '../core/assets';
import {safeRelativePath} from '../core/validation';
import {scanSource,rewriteReferences,type ParsedReference,type SourceScan} from './references';
import type { BuildArtifact,BuildResource,Finding,ProjectSnapshot,ResourceReference,Network } from '../shared/types';

export const COMPILER_VERSION='2.1.0';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const compressed=(value:string)=>brotliCompressSync(Buffer.from(value),{params:{[constants.BROTLI_PARAM_QUALITY]:9}}).length;
const inscriptionId=/^[a-f0-9]{64}i(?:0|[1-9][0-9]{0,9})$/;

export function buildProject(project: ProjectSnapshot): BuildArtifact {
  if(typeof project.files['index.html']!=='string')throw new AppError('ENTRY_REQUIRED','The project needs an index.html entry point.');
  validateAssets(project.assets,project.files);
  const findings:Finding[]=[];
  const libs=resolveLibraries(project.libraries,project.libraryAcceptances);
  const knownIds=new Set(libs.map(l=>l.id));
  const scans=new Map<string,SourceScan>(),nodes=new Map<string,BuildResource>(),seenContexts=new Set<string>();
  const paths=[...Object.keys(project.files),...Object.keys(project.assets)].sort();
  const sourceIdentity=sha(JSON.stringify({compiler:COMPILER_VERSION,files:paths.map(p=>[p,mimeFor(p),project.assets[p]?.sha256??sha(project.files[p])]),libraries:libs.map(l=>[l.id,l.sha256,l.format,l.userAcknowledgement??null])}));
  const scan=(name:string)=>{if(!scans.has(name))scans.set(name,scanSource(name,project.files[name]));return scans.get(name)!;};
  const addFinding=(code:string,title:string,detail:string,file:string,severity:Finding['severity']='error')=>findings.push({code,title,detail,file,severity});
  function resolve(reference:ParsedReference,file:string,document:string):ResourceReference|undefined{
    let url=reference.url.trim();
    let baseFile=reference.base==='document'?document:file;
    if(!url||url.startsWith('#')||/^(data|blob):/i.test(url))return;
    if(reference.context==='navigation'&&/^(https?:|mailto:|tel:|\/\/)/i.test(url))return;
    if(reference.context==='module'&&!/^[./]|^[a-z][a-z0-9+.-]*:/i.test(url)){
      const imports=scan(document).imports;
      const mapped=imports[url]??(url==='three'?libs.find(l=>l.key==='three-r178')?.id:undefined);
      if(!mapped){addFinding('BARE_IMPORT','A module alias is unresolved',`Add an import map or catalog include for “${url}”.`,file);return;}
      url=inscriptionId.test(mapped)?'/content/'+mapped:mapped;
      baseFile=document;
    }
    if(/^(https?:|wss?:|\/\/)/i.test(url)){addFinding('EXTERNAL_RESOURCE','An asset is loaded from the web',`${url.slice(0,160)} must be imported or replaced with an inscription reference.`,file);return;}
    if(/^[a-z][a-z0-9+.-]*:/i.test(url)){addFinding('UNSUPPORTED_SCHEME','This URL cannot run as a recursive resource',url.slice(0,160),file);return;}
    if(/^\/(?:r\/|blockheight(?:$|[?#])|blockhash(?:$|[/?#])|blocktime(?:$|[?#]))/.test(url))return;
    const existing=url.match(/^\/content\/([a-f0-9]{64}i[0-9]+)([?#].*)?$/);
    if(existing){if(!knownIds.has(existing[1]))addFinding('UNLOCKED_DEPENDENCY','A recursive resource needs verification',`${existing[1]} is not in this project's dependency lock.`,file);return {...reference,target:'inscription:'+existing[1],suffix:existing[2]??''};}
    let resolved:URL,relative:string;
    try{resolved=new URL(url,'https://project.invalid/'+baseFile);relative=decodeURIComponent(resolved.pathname).replace(/^\//,'');if(!relative||relative.endsWith('/'))relative+='index.html';safeRelativePath(relative);}catch{addFinding('INVALID_RESOURCE_PATH','A resource path is invalid',url.slice(0,160),file);return;}
    const suffix=resolved.search+resolved.hash;
    if(relative===file&&reference.context==='navigation')return {...reference,target:'self:',suffix:suffix||'#'};
    if(!Object.hasOwn(project.files,relative)&&!Object.hasOwn(project.assets,relative)){addFinding('MISSING_RESOURCE','A local resource is missing',`Import “${relative}” or fix its reference in ${file}.`,file);return;}
    return {...reference,target:relative,suffix};
  }
  const pending=[{file:'index.html',document:'index.html'}];
  while(pending.length){
    const {file,document}=pending.shift()!,context=file+'\0'+document;
    if(seenContexts.has(context))continue;seenContexts.add(context);
    if(seenContexts.size>1024)throw new AppError('GRAPH_LIMIT','This site exceeds the document-context limit. Bundle shared scripts or simplify page dependencies.');
    const asset=project.assets[file],source=project.files[file];
    const parsed=asset?undefined:scan(file);
    const references=(parsed?.references??[]).map(r=>resolve(r,file,document)).filter((r):r is ResourceReference=>!!r);
    const dependencies=[...new Set(references.filter(r=>!r.target.includes(':')).map(r=>r.target))].sort();
    const previous=nodes.get(file);
    if(previous){
      if(JSON.stringify(previous.references.map(r=>r.target))!==JSON.stringify(references.map(r=>r.target)))addFinding('AMBIGUOUS_DOCUMENT_BASE','A shared script resolves differently between pages',`Use root-relative resource URLs in ${file}; its document-relative requests have more than one meaning.`,file);
    }else{
      if(parsed)findings.push(...parsed.findings);
      nodes.set(file,{path:file,mime:asset?.mime??mimeFor(file),kind:asset?'binary':'text',sourceSha256:asset?.sha256??sha(source),sha256:'',bytes:asset?.bytes??0,compressedBytes:asset?.bytes??0,previewId:sha('draft:'+sourceIdentity+':'+file)+'i0',stage:-1,dependencies,references,containers:parsed?.containers??{},source,asset});
    }
    for(const target of dependencies)pending.push({file:target,document:/\.(html?|svg)$/i.test(target)?target:document});
  }
  const leafIdentities=new Map<string,string>();
  for(const node of [...nodes.values()].sort((a,b)=>a.path.localeCompare(b.path))){
    if(node.path==='index.html'||node.dependencies.length)continue;
    const identity=node.mime+':'+node.sourceSha256,prior=leafIdentities.get(identity);
    if(prior){node.duplicateOf=prior;node.previewId=nodes.get(prior)!.previewId;}else leafIdentities.set(identity,node.path);
  }
  const active:string[]=[],visited=new Set<string>();
  function stage(file:string):number{
    const node=nodes.get(file)!;
    const cycle=active.indexOf(file);
    if(cycle!==-1){addFinding('DEPENDENCY_CYCLE','New inscriptions form a reference cycle',`${[...active.slice(cycle),file].join(' → ')}. Combine these files, bundle the modules, or use hash navigation.`,file);return -1;}
    if(visited.has(file))return node.stage;
    active.push(file);const values=node.dependencies.map(stage);active.pop();visited.add(file);
    node.stage=values.some(v=>v<0)?-1:values.length?Math.max(...values)+1:0;return node.stage;
  }
  stage('index.html');
  for(const node of nodes.values()){
    if(node.kind==='binary'){node.sha256=node.sourceSha256;continue;}
    node.text=rewriteReferences(node.source!,node.references,node.containers,ref=>ref.target==='self:'?ref.suffix:ref.target.startsWith('inscription:')?'/content/'+ref.target.slice(12)+ref.suffix:'/content/'+nodes.get(ref.target)!.previewId+ref.suffix);
    node.sha256=sha(node.text);node.bytes=Buffer.byteLength(node.text);node.compressedBytes=compressed(node.text);
  }
  const resources=[...nodes.values()].sort((a,b)=>a.stage-b.stage||a.path.localeCompare(b.path));
  const stages=[...new Set(resources.filter(r=>r.stage>=0&&!r.duplicateOf).map(r=>r.stage))].sort((a,b)=>a-b).map(index=>({index,paths:resources.filter(r=>r.stage===index&&!r.duplicateOf).map(r=>r.path).sort()}));
  const root=nodes.get('index.html')!,html=root.text!;
  if(!hasLibraryNotices(project.files['index.html'],project.libraries,project.libraryAcceptances))findings.push({code:'LIBRARY_NOTICES_REQUIRED',severity:'error',title:'Restore the library credits',detail:'Required upstream notices are missing or changed. Open Libraries and restore the credits before publication.',file:'index.html'});
  for(const lib of libs.filter(l=>!l.key.includes('core')&&(!l.runtimeTested||!l.licenseReviewed)))findings.push({code:'LIBRARY_QUALIFICATION',severity:'warning',title:`${lib.name} ${lib.version}: ${!lib.runtimeTested?'runtime qualification pending':'license review pending'}`,detail:lib.licenseReviewed?'Exact license notices are retained. The target runtime recipe still needs qualification.':lib.license.scope});
  for(const lib of libs.filter(l=>l.userAcknowledgement))findings.push({code:'LIBRARY_WARNING_ACCEPTED',severity:'warning',title:`${lib.name}: unqualified use accepted`,detail:'You accepted the warning for these pinned bytes. This does not establish security, compatibility or permission to redistribute. Verify required dependencies and notices before inscription.'});
  findings.push({code:'STATIC_SCAN_LIMIT',severity:'info',title:'Run the website to complete the check',detail:'HTML, CSS, JavaScript imports and common literal requests are parsed. Calculated URLs, custom loaders and unused execution paths still need runtime inspection.'});
  return {id:sha(JSON.stringify({compiler:COMPILER_VERSION,resources:resources.map(r=>[r.path,r.sha256,r.dependencies]),libraries:libs.map(l=>[l.id,l.sha256,l.format,l.userAcknowledgement??null])})),projectId:project.id,revision:project.revision,html,sha256:root.sha256,bytes:root.bytes,compressedBytes:root.compressedBytes,libraries:libs,findings,previewId:root.previewId,createdAt:new Date().toISOString(),compilerVersion:COMPILER_VERSION,resources,stages,unpublishedFiles:paths.filter(p=>!nodes.has(p)),totalNewBytes:resources.filter(r=>!r.duplicateOf).reduce((n,r)=>n+r.bytes,0),hasUnresolvedDependencies:root.dependencies.length>0};
}

export type PublishedBinding={network:Network;id:string;sha256:string;mime:string};
export type PreparedResource={path:string;mime:string;sha256:string;bytes:number;text?:string;asset?:BuildResource['asset'];dependencies:{path:string;id:string;sha256:string}[]};

/** Finalization accepts verified backend bindings, never preview identities. It does not broadcast. */
export function prepareResource(build:BuildArtifact,filename:string,bindings:Record<string,PublishedBinding>,network:Network='mainnet'):PreparedResource{
  if(build.findings.some(f=>f.severity==='error'))throw new AppError('BUILD_BLOCKED','Resolve the build errors before preparing publication bytes.');
  if(build.libraries.some(l=>l.network!==network))throw new AppError('WRONG_NETWORK','This build pins libraries from a different Bitcoin network. Use same-network equivalents before publication.');
  const nodes=new Map(build.resources.map(r=>[r.path,r])),memo=new Map<string,PreparedResource>();
  const drafts=new Set(build.resources.map(r=>r.previewId));
  function prepare(name:string):PreparedResource{
    if(memo.has(name))return memo.get(name)!;const node=nodes.get(name);if(!node)throw new AppError('RESOURCE_NOT_FOUND','This resource is not in the frozen build.');
    const dependencies:{path:string;id:string;sha256:string}[]=[];
    function binding(target:string){const resource=nodes.get(target)!,key=resource.duplicateOf??target,record=bindings[key]??bindings[target];if(!record)throw new AppError('DEPENDENCY_UNPUBLISHED',`Publish and verify ${key} before preparing ${name}.`);if(record.network!==network)throw new AppError('WRONG_NETWORK',`The published dependency ${target} belongs to a different Bitcoin network.`);if(!inscriptionId.test(record.id)||drafts.has(record.id))throw new AppError('PROVISIONAL_ID','A real inscription ID is required; draft identities cannot be published.');const expected=prepare(target);if(record.sha256!==expected.sha256||record.mime!==expected.mime)throw new AppError('DEPENDENCY_MISMATCH',`The published bytes or MIME for ${target} differ from this build.`);dependencies.push({path:target,id:record.id,sha256:record.sha256});return record.id;}
    const ids=new Map<string,string>();for(const dep of node.dependencies)ids.set(dep,binding(dep));
    const text=node.kind==='text'?rewriteReferences(node.source!,node.references,node.containers,ref=>ref.target==='self:'?ref.suffix:ref.target.startsWith('inscription:')?'/content/'+ref.target.slice(12)+ref.suffix:'/content/'+ids.get(ref.target)!+ref.suffix):undefined;
    if(text&&[...drafts].some(id=>text.includes('/content/'+id)))throw new AppError('PROVISIONAL_ID','Draft references remain in the publication artifact.');
    const prepared={path:name,mime:node.mime,sha256:text===undefined?node.sourceSha256:sha(text),bytes:text===undefined?node.bytes:Buffer.byteLength(text),text,asset:node.asset,dependencies};memo.set(name,prepared);return prepared;
  }
  return prepare(filename);
}
