import {useEffect,useRef,useState} from 'react';
import {FileCode2,Plus,Pencil,Trash2,Info,X} from 'lucide-react';
import type {ProjectSnapshot} from '../shared/types';

type Props={project:ProjectSnapshot;activeFile:string;saving:boolean;onSelect:(path:string)=>Promise<void>;onMutate:(command:string,args:Record<string,unknown>)=>Promise<unknown>};
export default function SourcePanel({project,activeFile,saving,onSelect,onMutate}:Props){
  const [editing,setEditing]=useState<{from?:string}|null>(null),[name,setName]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(editing)dialog.current?.showModal();},[editing]);
  function begin(from?:string){setName(from??'styles.css');setError('');setEditing({from});}
  async function save(){
    if(!editing)return;setWorking(true);setError('');
    try{
      if(editing.from)await onMutate('file.rename',{from:editing.from,to:name.trim()});
      else {if(Object.hasOwn(project.files,name.trim())||Object.hasOwn(project.assets,name.trim()))throw new Error('A file already uses that path. Choose another name.');await onMutate('project.file',{path:name.trim(),content:/\.(json|gltf)$/i.test(name)?'{}\n':''});}
      await onSelect(name.trim());setEditing(null);
    }catch(e){setError((e as Error).message);}finally{setWorking(false);}
  }
  return <>
    <div className="panel-heading"><span className="tiny-label">THE REAL SOURCE</span><h2>Your code, your rules.</h2><p>Plain files. Linked into a lasting website.</p></div>
    <div className="panel-actions"><button className="button small" onClick={()=>begin()} disabled={saving}><Plus size={14}/>New file</button></div>
    <div className="file-tree" aria-label="Source files">{Object.keys(project.files).sort((a,b)=>a==='index.html'?-1:b==='index.html'?1:a.localeCompare(b)).map(file=><div className={`file-row ${file===activeFile?'selected':''}`} key={file}>
      <button className="file-select" aria-current={file===activeFile?'page':undefined} title={file} onClick={()=>void onSelect(file).catch(()=>{})}><FileCode2 size={15}/><span>{file}</span></button>
      {file!=='index.html'&&<div className="file-actions"><button className="icon-button" disabled={saving} aria-label={`Rename ${file}`} title={`Rename ${file}`} onClick={()=>begin(file)}><Pencil size={13}/></button><button className="icon-button" disabled={saving} aria-label={`Remove ${file}`} title={`Remove ${file}`} onClick={()=>void onMutate('file.remove',{path:file}).catch(()=>{})}><Trash2 size={13}/></button></div>}
    </div>)}</div>
    <div className="panel-note"><Info size={16}/><p>Use relative paths in your code. The compiler turns them into recursive content references. Removing a linked file requires updating its references first.</p></div>
    <div className="panel-note"><Info size={16}/><p>Visual controls update marked template regions. Your other code stays as you wrote it.</p></div>
    {editing&&<dialog ref={dialog} className="create-dialog" aria-labelledby="file-dialog-title" onCancel={()=>{if(!working)setEditing(null);}}><section className="modal file-modal"><button className="modal-close icon-button" aria-label="Close file dialog" disabled={working} onClick={()=>setEditing(null)}><X size={18}/></button><h2 id="file-dialog-title">{editing.from?'Rename file':'Create a file'}</h2><p>{editing.from?'Known references update with the new path.':'Use a project path such as styles.css or scripts/main.js.'}</p><form onSubmit={e=>{e.preventDefault();void save();}}><label className="field"><span>File path</span><input autoFocus value={name} maxLength={240} required onChange={e=>setName(e.target.value)}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={working||!name.trim()}>{editing.from?'Rename file':'Create file'}</button></form></section></dialog>}
  </>;
}
