import { useEffect, useRef } from 'react';
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap } from '@codemirror/view';
import { Annotation,EditorState,Transaction } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import {javascript} from '@codemirror/lang-javascript';
import {css} from '@codemirror/lang-css';
import {json} from '@codemirror/lang-json';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
const externalSource=Annotation.define<boolean>();

export default function CodeEditor({value,path,onChange,readOnly=false,label}:{value:string;path:string;onChange:(value:string)=>void;readOnly?:boolean;label?:string}){
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),callback=useRef(onChange);
  callback.current=onChange;
  useEffect(()=>{
    if(!host.current)return;
    const language=/\.css$/i.test(path)?css():/\.m?js$/i.test(path)?javascript():/\.(json|gltf)$/i.test(path)?json():/\.(html?|svg)$/i.test(path)?html():[];
    view.current=new EditorView({parent:host.current,state:EditorState.create({doc:value,extensions:[lineNumbers(),highlightActiveLineGutter(),drawSelection(),history(),language,keymap.of([indentWithTab,...defaultKeymap,...historyKeymap]),EditorState.readOnly.of(readOnly),EditorView.editable.of(!readOnly),EditorView.lineWrapping,EditorView.contentAttributes.of({'aria-label':label??(path==='index.html'?'Website HTML source':`Source: ${path}`),'aria-readonly':String(readOnly),tabindex:'0'}),EditorView.updateListener.of(update=>{if(update.docChanged&&update.transactions.some(transaction=>transaction.docChanged&&!transaction.annotation(externalSource)))callback.current(update.state.doc.toString());}),EditorView.theme({'&':{height:'100%',backgroundColor:'var(--bg)',color:'var(--text)'},'.cm-scroller':{overflow:'auto',fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:'12px',lineHeight:'1.8'},'.cm-content':{padding:'18px 0',caretColor:'var(--accent)'},'.cm-gutters':{backgroundColor:'var(--chrome)',color:'var(--muted)',borderRight:'1px solid var(--border)'},'.cm-activeLineGutter':{backgroundColor:'var(--surface-2)'},'&.cm-focused':{outline:'none'},'.cm-selectionBackground':{backgroundColor:'#f7931a33!important'}},{dark:true})]})});
    return()=>{view.current?.destroy();view.current=null;};
  },[path,readOnly,label]);
  useEffect(()=>{const editor=view.current;if(editor && editor.state.doc.toString()!==value)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:value},annotations:[externalSource.of(true),Transaction.addToHistory.of(false)]});},[value]);
  return <div className="code-editor" ref={host}/>;
}
