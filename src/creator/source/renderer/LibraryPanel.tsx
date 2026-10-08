import React from 'react';
import {Box,Braces,Palette,Music,Gamepad2,Search,Plus,Check,ExternalLink} from 'lucide-react';
import type {Library,ProjectSnapshot} from '../shared/types';
import {matchesLibrary} from '../catalog/library-guides';

export default function LibraryPanel({libraries,project,saving,query,onQuery,onAdd,onSource,onBrowse}:{libraries:Library[];project:ProjectSnapshot;saving:boolean;query:string;onQuery:(value:string)=>void;onAdd:(key:string)=>void;onSource:(key:string)=>void;onBrowse:()=>void}){
  const matches=libraries.filter(l=>matchesLibrary(l,query));
  return <><div className="panel-heading"><span className="tiny-label">ALREADY ON BITCOIN</span><h2>Build on what exists.</h2><p>Shared code. Ready for your next idea.</p></div><button className="button primary library-browse-button" onClick={onBrowse}>Browse possibilities<ExternalLink size={14}/></button><label className="library-search"><Search size={14}/><input value={query} onChange={e=>onQuery(e.target.value)} placeholder="Find a capability…" aria-label="Find a library"/></label><div className="library-list">{matches.map(l=>{
    const added=project.libraries.includes(l.key);
    return <article className="library-card" key={l.key}>
      <div className="library-top"><span className="library-icon">{l.packageName==='three'?<Box/>:l.packageName==='p5'?<Palette/>:l.packageName==='tone'?<Music/>:l.packageName==='phaser'?<Gamepad2/>:<Braces/>}</span><div><h3>{l.name}<small>{l.version}</small></h3><span>{l.purpose}</span></div></div>
      <p>{l.description}</p>
      <div className="library-bottom"><span>{(l.storedBytes/1000).toFixed(0)} KB reused</span><button className={`button small ${added?'added':''}`} disabled={added||saving} onClick={()=>onAdd(l.key)}>{added?<><Check size={12}/>Added</>:<><Plus size={12}/>Add</>}</button></div>
      <details><summary>Source & compatibility</summary>
        <p>{l.upstreamComparison==='exact-decoded-byte-match'?'Matches the exact upstream release.':'Matches upstream after the documented recursive import rewrite.'}</p>
        <p>{l.runtimeTested?'Starter interaction tested.':'Runtime qualification pending.'} {l.licenseReviewed?'License notices reviewed.':'License review remains open.'}</p>
        {l.runtime.map(run=><p key={run.profile+run.recipe}>{run.profile} · {new Date(run.checkedAt).toLocaleDateString()}<br/>{run.limitations.join(' ')}</p>)}
        <dl className="library-facts"><dt>License</dt><dd>{l.license.identifier}</dd><dt>Format</dt><dd>{l.format==='esm'?'ES modules':'Classic script'}{l.global?` · ${l.global}`:''}</dd><dt>Content type</dt><dd>{l.mime}</dd><dt>Decoded size</dt><dd>{l.bytes.toLocaleString()} bytes</dd><dt>Network</dt><dd>{l.network}</dd></dl>
        <p className="helper">{l.license.scope}</p>
        {l.compatibility.map(note=><p key={note}>{note}</p>)}
        <p>Inscription ID</p><code>{l.id}</code><p>Decoded SHA-256</p><code>{l.sha256}</code>
        <p>Gateway bytes were checked on {new Date(l.contentCheckedAt).toLocaleDateString()}. Independent chain verification is not claimed.</p>
        <div className="library-source-actions"><button className="button small" onClick={()=>onSource(l.key)}>Upstream source<ExternalLink size={12}/></button>{added&&<button className="button small" disabled={saving} onClick={()=>onAdd(l.key)}>Restore credits</button>}</div>
      </details>
    </article>;
  })}{!matches.length&&<p className="helper">No libraries match that search. Try “3D”, “drawing”, “game”, or “audio”.</p>}</div></>;
}
