import {Image,Upload,Trash2,Copy,Info,FileBox,Check} from 'lucide-react';
import {useState,useRef,useEffect} from 'react';
import type {ProjectSnapshot,SourceAsset} from '../shared/types';

type Props={project:ProjectSnapshot;saving:boolean;onImport:()=>void;onMutate:(command:string,args:Record<string,unknown>)=>Promise<unknown>;onAlt:(value:string)=>void;onSource:(path:string)=>Promise<void>};
const size=(bytes:number)=>bytes<1000?`${bytes} B`:bytes<1_000_000?`${(bytes/1000).toFixed(1)} KB`:`${(bytes/1_000_000).toFixed(1)} MB`;
export default function AssetsPanel({project,saving,onImport,onMutate,onAlt,onSource}:Props){
  const [copied,setCopied]=useState(''),[copyError,setCopyError]=useState('');
  async function copyPath(path:string){const result=await window.builder.invoke('file.copy-path',{projectId:project.id,path});if(result.ok){setCopied(path);setCopyError('');}else setCopyError(result.error.message);}
  const hasMedia=/data-btcsite-media\s*=/.test(project.files['index.html']);
  const assets:(Pick<SourceAsset,'path'|'mime'|'bytes'>&{sha256?:string;text?:boolean})[]=[...Object.values(project.assets),...Object.entries(project.files).filter(([path])=>/\.(svg|gltf|json)$/i.test(path)).map(([path,source])=>({path,mime:/\.svg$/i.test(path)?'image/svg+xml':/\.gltf$/i.test(path)?'model/gltf+json':'application/json',bytes:new TextEncoder().encode(source).length,text:true}))];
  return <>
    <div className="panel-heading"><span className="tiny-label">THE PIECES OF YOUR WEBSITE</span><h2>Make it personal.</h2><p>Images, models, fonts, and sound.</p></div>
    <div className="panel-actions"><button className="button" disabled={saving} onClick={onImport}><Upload size={14}/>Import assets</button><p className="helper">Up to 8 MB per file. Originals stay in your project.</p></div>
    {copyError&&<p className="form-error" role="alert">{copyError}</p>}
    {assets.length?<div className="asset-list">{assets.map(asset=>{
      const raster=/^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mime),image=asset.mime.startsWith('image/'),selected=asset.path===project.settings.heroImage;
      return <article className="asset-card" key={asset.path}>
        <div className="asset-thumbnail">{raster?<img loading="lazy" src={`app://app/creator-assets/${project.id}/${asset.sha256}`} alt=""/>:image?<Image size={30}/>:<FileBox size={30}/>}</div>
        <div className="asset-copy"><strong title={asset.path}>{asset.path}</strong><span>{size(asset.bytes)} · {asset.mime.split('/')[1]}</span>{asset.text&&<button className="text-button" onClick={()=>void onSource(asset.path).catch(()=>{})}>Edit source</button>}</div>
        <div className="asset-actions">{image&&hasMedia&&<button className="button tiny" disabled={saving||selected} onClick={()=>void onMutate('project.settings',{changes:{heroImage:asset.path,imageAlt:''}}).catch(()=>{})}>{selected?<><Check size={12}/>Main image</>:'Use as main image'}</button>}<button className="icon-button" aria-label={`Copy path ${asset.path}`} title={copied===asset.path?'Copied':'Copy path'} onClick={()=>void copyPath(asset.path)}>{copied===asset.path?<Check size={14}/>:<Copy size={14}/>}</button><button className="icon-button" disabled={saving} aria-label={`Remove ${asset.path}`} title="Remove unused asset" onClick={()=>void onMutate('asset.remove',{path:asset.path}).catch(()=>{})}><Trash2 size={14}/></button></div>
        {selected&&<div className="asset-description"><AltText key={project.id+':'+asset.path} value={project.settings.imageAlt??''} onSave={onAlt}/><button className="text-button" disabled={saving} onClick={()=>void onMutate('project.settings',{changes:{heroImage:'',imageAlt:''}}).catch(()=>{})}>Restore template visual</button></div>}
      </article>;
    })}</div>:<div className="panel-empty"><Image size={30}/><h3>A place for your own assets.</h3><p>Import an image to add it to your page, or link any asset from Code.</p></div>}
    <div className="panel-note"><Info size={16}/><p>Linked assets are published before the page that uses them. Identical files are reused within a build.</p></div>
  </>;
}
function AltText({value,onSave}:{value:string;onSave:(value:string)=>void}){const [draft,setDraft]=useState(value),dirty=useRef(false);useEffect(()=>{if(!dirty.current)setDraft(value);},[value]);return <label className="field"><span>Image description</span><input value={draft} maxLength={300} placeholder="Describe what the image shows" onChange={e=>{dirty.current=true;setDraft(e.target.value);}} onBlur={()=>{dirty.current=false;if(draft!==value)onSave(draft);}}/><small className="helper">Used by screen readers. Leave empty for decoration.</small></label>;}
