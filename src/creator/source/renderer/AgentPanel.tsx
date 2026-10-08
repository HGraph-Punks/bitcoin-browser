import React,{useEffect,useRef,useState} from 'react';
import {Bot,Check,Copy,Loader2,Unplug,X} from 'lucide-react';
import type {ProjectSnapshot} from '../shared/types';
import './AgentPanel.css';
type State={connections:{id:string;label:string;projects:string[];allowCreate:boolean;allowDeploy?:boolean;lastSeen?:string}[];activity:{at:string;label:string;command:string;ok:boolean;code?:string}[]};
async function call<T>(name:string,payload?:unknown){const response=await window.builder.invoke<T>(name,payload);if(!response.ok)throw new Error(response.error.message);return response.data;}
export default function AgentPanel({project,onClose}:{project:ProjectSnapshot|null;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [state,setState]=useState<State>({connections:[],activity:[]}),[label,setLabel]=useState('My AI assistant'),[allowCreate,setAllowCreate]=useState(!project),[allowDeploy,setAllowDeploy]=useState(false),[busy,setBusy]=useState(false),[settings,setSettings]=useState(''),[error,setError]=useState('');
  const refresh=()=>call<State>('agent.list').then(setState).catch(e=>setError(e.message));
  useEffect(()=>{dialog.current?.showModal();void refresh();const remove=window.builder.onChange(e=>{if(e.type==='agents')void refresh();});return remove;},[]);
  async function connect(){try{setBusy(true);setError('');const result=await call<{settings:string}>('agent.create',{label,projectIds:project?[project.id]:[],allowCreate,allowDeploy});setSettings(result.settings);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <dialog ref={dialog} className="agent-dialog" onCancel={onClose} onClick={e=>{if(e.target===dialog.current)onClose();}} aria-labelledby="agent-title"><div className="agent-inner"><button className="modal-close icon-button" aria-label="Close AI connections" onClick={onClose}><X size={18}/></button><span className="round-icon"><Bot/></span><p className="eyebrow">BUILD TOGETHER</p><h2 id="agent-title">Connect your AI assistant.</h2><p className="agent-intro">Let a compatible MCP client create, edit, and test websites in this app. You can see its changes and revoke access here.</p>
    <div className="agent-scope"><strong>{project?project.title:'New projects in this workspace'}</strong><span>Read & edit source · Add libraries · Run previews · Build HTML</span><small>The assistant cannot approve publication or obtain wallet credentials.</small></div>
    <label className="field"><span>Connection name</span><input value={label} maxLength={60} onChange={e=>setLabel(e.target.value)}/></label>{project&&<label className="agent-checkbox"><input type="checkbox" checked={allowCreate} onChange={e=>setAllowCreate(e.target.checked)}/>Also allow this assistant to create new projects</label>}
    <label className="agent-checkbox"><input type="checkbox" checked={allowDeploy} onChange={e=>setAllowDeploy(e.target.checked)}/>Allow publication planning, status, and resuming exact plans I approve</label>
    <button className="button primary full" disabled={busy||!label.trim()} onClick={()=>void connect()}>{busy?<Loader2 size={16} className="spin"/>:<Copy size={16}/>}Create connection & copy settings</button>
    {settings&&<div className="agent-settings"><p><Check size={15}/>Settings copied. Add them to your MCP client, then keep this app open.</p><details><summary>View connection settings</summary><textarea aria-label="MCP connection settings" value={settings} readOnly rows={7}/></details></div>}
    {error&&<p className="agent-error" role="alert">{error}</p>}
    {state.connections.length>0&&<section className="agent-connections"><h3>Granted connections</h3>{state.connections.map(c=><div className="agent-connection" key={c.id}><Bot size={18}/><div><strong>{c.label}</strong><small>{c.projects.length} {c.projects.length===1?'project':'projects'}{c.allowCreate?' · Can create projects':''}{c.allowDeploy?' · Publication planning':''}{c.lastSeen?` · Last used ${new Date(c.lastSeen).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`:''}</small></div><button className="button small" onClick={()=>void call('agent.revoke',{id:c.id}).then(refresh).catch(e=>setError(e.message))}><Unplug size={13}/>Revoke</button></div>)}</section>}
    {state.activity.length>0&&<details className="agent-activity"><summary>Recent AI activity</summary>{state.activity.slice(-8).reverse().map((a,i)=><div key={i}><span>{a.label}</span><code>{a.command}</code><small>{a.ok?'Completed':a.code??'Failed'}</small></div>)}</details>}
    </div></dialog>;
}
