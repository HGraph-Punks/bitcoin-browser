import {parse as parseHtml} from 'parse5';
import {parse as parseJs} from 'acorn';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import path from 'node:path';
import {escapeHtml} from '../core/templates';
import {AppError} from '../core/errors';
import type {Finding,ReferenceContainer,ResourceReference} from '../shared/types';

export type ParsedReference=Omit<ResourceReference,'target'|'suffix'>&{base:'file'|'document'};
export type SourceScan={references:ParsedReference[];containers:Record<string,ReferenceContainer>;findings:Finding[];imports:Record<string,string>};
type Frame={offset:number;container?:string};
const literal=(node:any):string|undefined=>node?.type==='Literal'&&typeof node.value==='string'?node.value:node?.type==='TemplateLiteral'&&node.expressions.length===0?node.quasis[0].value.cooked:undefined;
const property=(node:any)=>node?.type==='Identifier'?node.name:node?.type==='Literal'?node.value:undefined;
const cssUrl=(value:string)=>value.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|([\s\S]))/g,(_match,hex:string|undefined,char:string|undefined)=>{if(hex){const point=parseInt(hex,16);return !point||point>0x10ffff||point>=0xd800&&point<=0xdfff?'\ufffd':String.fromCodePoint(point);}return char&& !/[\n\r\f]/.test(char)?char:'';});

/** Parse browser syntax without executing project code. All edits retain source offsets. */
export function scanSource(filename:string,source:string):SourceScan{
  const result:SourceScan={references:[],containers:{},findings:[],imports:{}};
  const seen=new Set<string>();
  function finding(code:string,title:string,detail:string,offset=0,severity:Finding['severity']='error'){
    result.findings.push({code,title,detail,severity,file:filename,line:source.slice(0,Math.max(0,offset)).split('\n').length});
  }
  function add(url:string,start:number,end:number,format:ParsedReference['format'],context:ParsedReference['context'],frame:Frame,base:ParsedReference['base']='file'){
    const ref={url,start:start+frame.offset,end:end+frame.offset,format,context,base,container:frame.container};
    const key=`${ref.container??''}:${ref.start}:${ref.end}`;if(seen.has(key))return;seen.add(key);
    if(result.references.length>=4096)throw new AppError('REFERENCE_LIMIT','A source file exceeds the 4,096-reference limit. Split it into smaller resources.');
    result.references.push(ref);
  }
  function js(text:string,frame:Frame,module=true){
    let ast:any;
    try{ast=parseJs(text,{ecmaVersion:'latest',sourceType:module?'module':'script',allowReturnOutsideFunction:!module});}
    catch(error){finding('JAVASCRIPT_SYNTAX','JavaScript could not be parsed',(error as Error).message,frame.container?result.containers[frame.container].start:frame.offset+(error as any).pos);return;}
    const stack:any[]=[ast];
    while(stack.length){
      const node=stack.pop();
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source){add(node.source.value,node.source.start,node.source.end,'js','module',frame);}
      if(node.type==='ImportExpression'){
        const url=literal(node.source);if(url!==undefined)add(url,node.source.start,node.source.end,'js','module',frame);
        else finding('DYNAMIC_IMPORT','A module path is calculated at runtime','Declare a literal import or bundle these modules before publication.',frame.offset+node.start);
      }
      if(node.type==='NewExpression'&&property(node.callee)==='URL'){
        const url=literal(node.arguments[0]),base=node.arguments[1];
        const moduleBase=base?.type==='MemberExpression'&&base.object?.type==='MetaProperty'&&base.object.meta.name==='import'&&property(base.property)==='url';
        if(url!==undefined&&moduleBase)add(url,node.arguments[0].start,node.arguments[0].end,'js','resource',frame,'file');
      }
      if(node.type==='CallExpression'||node.type==='NewExpression'){
        const name=property(node.callee),member=node.callee?.type==='MemberExpression'?property(node.callee.property):undefined;
        const isFetch=name==='fetch'||name==='Request'||member==='fetch';
        const isWorker=name==='Worker'||name==='SharedWorker';
        const isImportScripts=name==='importScripts';
        const isLoader=member==='load'||member==='loadAsync';
        if(isFetch||isWorker||isImportScripts||isLoader){
          const args=isImportScripts?node.arguments:[node.arguments[0]];
          for(const arg of args){
            const url=literal(arg);
            if(url!==undefined&&(!isLoader||/[./]/.test(url)))add(url,arg.start,arg.end,'js',isWorker?'worker':'fetch',frame,'document');
            else if((isFetch||isWorker||isImportScripts)&&!(arg?.type==='NewExpression'&&property(arg.callee)==='URL'&&literal(arg.arguments[0])!==undefined&&arg.arguments[1]?.type==='MemberExpression'&&arg.arguments[1].object?.type==='MetaProperty'))finding('DYNAMIC_REQUEST','A resource path is calculated at runtime','Runtime requests need explicit testing; the compiler cannot prove these dependencies are closed.',frame.offset+node.start,'warning');
          }
          if(isWorker)finding('WORKER_SANDBOX','Test this worker in the target viewer','Opaque Ord iframes restrict worker origins. A parsed worker dependency is not proof that the browser will start it.',frame.offset+node.start,'warning');
        }
      }
      // Acorn nodes contain offsets and syntax only; never evaluate expressions.
      for(const value of Object.values(node)){if(Array.isArray(value)){for(let i=value.length-1;i>=0;i--)if(value[i]&&typeof value[i]==='object'&&typeof value[i].type==='string')stack.push(value[i]);}else if(value&&typeof value==='object'&&typeof(value as any).type==='string')stack.push(value);}
    }
  }
  function css(text:string,frame:Frame){
    let ast:postcss.Root;try{ast=postcss.parse(text,{from:undefined});}catch(error){finding('CSS_SYNTAX','CSS could not be parsed',(error as any).reason??(error as Error).message,frame.offset);return;}
    function values(value:string,offset:number,importRule=false){
      const parsed=valueParser(value);let first=true;
      parsed.walk((node:any)=>{
        if(importRule&&first&&node.type==='string'){add(cssUrl(node.value),offset+node.sourceIndex,offset+node.sourceEndIndex,'css','resource',frame);first=false;return false;}
        if(node.type!=='space'&&node.type!=='comment')first=false;
        if(node.type==='function'&&node.value.toLowerCase()==='url'){
          const meaningful=node.nodes.filter((n:any)=>n.type!=='space'&&n.type!=='comment');
          if(meaningful.length===1&&['string','word'].includes(meaningful[0].type)){
            const item=meaningful[0];add(cssUrl(item.value),offset+item.sourceIndex,offset+item.sourceEndIndex,'css','resource',frame);
          }else finding('CSS_DYNAMIC_URL','A CSS URL could not be resolved','Use a literal resource URL in this declaration.',frame.offset+offset+node.sourceIndex);
          return false;
        }
        if(node.type==='function'&&['image-set','-webkit-image-set'].includes(node.value.toLowerCase())){
          for(const item of node.nodes)if(item.type==='string')add(cssUrl(item.value),offset+item.sourceIndex,offset+item.sourceEndIndex,'css','resource',frame);
        }
      });
    }
    ast.walkDecls(declaration=>{
      const start=declaration.source?.start?.offset??0;
      const valueStart=start+declaration.prop.length+(declaration.raws.between??':').length;
      values(declaration.raws.value?.raw??declaration.value,valueStart);
    });
    ast.walkAtRules(rule=>{if(rule.name.toLowerCase()==='import'){
      const start=(rule.source?.start?.offset??0)+1+rule.name.length+(rule.raws.afterName??'').length;values(rule.params,start,true);
    }});
  }
  function srcset(value:string,frame:Frame){
    let index=0;
    while(index<value.length){
      while(/[\s,]/.test(value[index]??'')&&index<value.length)index++;
      const start=index;while(index<value.length&&!/\s/.test(value[index]))index++;
      let end=index;while(value[end-1]===',')end--;
      if(end>start)add(value.slice(start,end),start,end,'raw','resource',frame);
      if(end<index)continue;
      let depth=0;while(index<value.length){const char=value[index++];if(char==='(')depth++;else if(char===')')depth--;else if(char===','&&depth===0)break;}
    }
  }
  function jsonUris(text:string,frame:Frame,importMap=false){
    let parsed:any;try{parsed=JSON.parse(text);}catch{finding('JSON_SYNTAX','JSON could not be parsed','Correct this JSON before building.',frame.offset);return;}
    if(importMap){
      if(parsed.imports&&typeof parsed.imports==='object')for(const [name,value] of Object.entries(parsed.imports))if(typeof value==='string'){result.imports[name]=value;if(name.endsWith('/')||value.endsWith('/'))finding('IMPORT_MAP_PREFIX','Directory import mappings need bundling','Use exact module aliases, or bundle imports before publication.',frame.offset);}
      if(parsed.scopes)finding('SCOPED_IMPORT_MAP','Scoped import maps need bundling','Flatten this map to exact aliases or bundle the modules.',frame.offset);
    }
    let ast:any;try{ast=parseJs('('+text+')',{ecmaVersion:'latest'});}catch{return;}
    const stack:{node:any;parentKey?:string}[]=[{node:ast}];
    while(stack.length){const {node,parentKey}=stack.pop()!;
      if(node.type==='Property'){
        const key=property(node.key),value=literal(node.value);
        if(value!==undefined&&(importMap?parentKey==='imports':key==='uri'))add(value,node.value.start-1,node.value.end-1,'js','resource',frame);
        stack.push({node:node.value,parentKey:key});continue;
      }
      for(const value of Object.values(node)){if(Array.isArray(value)){for(const child of value)if(child&&typeof child==='object'&&child.type)stack.push({node:child,parentKey});}else if(value&&typeof value==='object'&&(value as any).type)stack.push({node:value,parentKey});}
    }
  }
  const extension=path.posix.extname(filename).toLowerCase();
  if(['.html','.htm','.svg'].includes(extension)){
    const doc=parseHtml(source,{sourceCodeLocationInfo:true});const stack:any[]=[doc];
    while(stack.length){const node=stack.pop(),attrs=node.attrs??[],location=node.sourceCodeLocation;
      const get=(name:string)=>attrs.find((a:any)=>a.name===name)?.value;
      if(node.tagName==='base'&&get('href'))finding('BASE_URL','Remove the document base URL','Inscribed resources use root-relative /content/ paths; a custom base changes their meaning.',location?.startOffset);
      if(node.tagName==='meta'&&get('http-equiv')?.toLowerCase()==='refresh')finding('META_REDIRECT','Replace automatic redirects','Use explicit hash navigation or links between published resources.',location?.startOffset);
      for(const attribute of attrs){
        const name=attribute.prefix?attribute.prefix+':'+attribute.name:attribute.name;
        const range=location?.attrs?.[name];if(!range)continue;
        if(attribute.name==='srcdoc'){finding('INLINE_FRAME','Move this frame into a source file','A separate HTML file allows recursive dependencies to be parsed and published.',range.startOffset);continue;}
        if(!['src','href','poster','srcset','style','data','xlink:href'].includes(name)&&!name.startsWith('on'))continue;
        if(name==='href'&&node.tagName==='base')continue;
        const container=`${range.startOffset}:${range.endOffset}`;
        result.containers[container]={start:range.startOffset,end:range.endOffset,source:attribute.value,attribute:name};
        const frame={offset:0,container};
        if(name==='style')css(attribute.value,frame);
        else if(name.startsWith('on'))js(attribute.value,frame,false);
        else if(name==='srcset')srcset(attribute.value,frame);
        else add(attribute.value,0,attribute.value.length,'raw',node.tagName==='a'?'navigation':'resource',frame);
      }
      if(location?.startTag&&location?.endTag){
        const frame={offset:location.startTag.endOffset},text=source.slice(frame.offset,location.endTag.startOffset);
        if(node.tagName==='style')css(text,frame);
        if(node.tagName==='script'&&!get('src')){
          const type=get('type')?.toLowerCase()??'';
          if(type==='importmap')jsonUris(text,frame,true);
          else if(['','module','text/javascript','application/javascript'].includes(type))js(text,frame,type==='module');
        }
      }
      for(let i=(node.childNodes?.length??0)-1;i>=0;i--)stack.push(node.childNodes[i]);
      if(node.content)stack.push(node.content);
    }
  }else if(extension==='.css')css(source,{offset:0});
  else if(extension==='.js'||extension==='.mjs')js(source,{offset:0});
  else if(extension==='.gltf')jsonUris(source,{offset:0});
  else if(extension==='.json'){try{JSON.parse(source);}catch{finding('JSON_SYNTAX','JSON could not be parsed','Correct this JSON before building.');}}
  return result;
}

export function rewriteReferences(source:string,references:ResourceReference[],containers:Record<string,ReferenceContainer>,resolve:(reference:ResourceReference)=>string):string{
  const edits:{start:number;end:number;text:string}[]=[],groups=new Map<string,ResourceReference[]>();
  const render=(reference:ResourceReference)=>{const url=resolve(reference);return reference.format==='raw'?url:JSON.stringify(url).replace(/</g,'\\u003c');};
  for(const reference of references){if(reference.container){const group=groups.get(reference.container)??[];group.push(reference);groups.set(reference.container,group);}else edits.push({start:reference.start,end:reference.end,text:render(reference)});}
  for(const [id,group] of groups){const container=containers[id];if(!container)throw new AppError('INVALID_BUILD','A reference container is missing.');const value=applyEdits(container.source,group.map(r=>({start:r.start,end:r.end,text:render(r)})));edits.push({start:container.start,end:container.end,text:`${container.attribute}="${escapeHtml(value)}"`});}
  return applyEdits(source,edits);
}
function applyEdits(source:string,edits:{start:number;end:number;text:string}[]){
  let last=source.length;for(const edit of edits.sort((a,b)=>b.start-a.start)){if(edit.start<0||edit.end>last||edit.end<edit.start)throw new AppError('OVERLAPPING_REFERENCES','Source references overlap. Simplify this expression before building.');source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);last=edit.start;}return source;
}
