import {parse} from 'parse5';
import {resolveLibraries} from './libraries';
import {AppError} from '../core/errors';

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function sources(keys:string[],acceptances:import('../shared/types').LibraryAcceptance[]=[]){return [...new Map(resolveLibraries(keys,acceptances).flatMap(l=>l.license.sources).map(source=>[source.sha256,source])).values()];}
function regions(html:string){const found:any[]=[];const document=parse(html,{sourceCodeLocationInfo:true});function walk(node:any){if(node.attrs?.some((a:any)=>a.name==='data-btcsite-notices'))found.push(node);for(const child of node.childNodes??[])walk(child);}walk(document);return found;}
const text=(node:any):string=>node.nodeName==='#text'?node.value:(node.childNodes??[]).map(text).join('');
/** Required text is checked, not just a forgeable attribute or hash marker. */
export function hasLibraryNotices(html:string,keys:string[],acceptances:import('../shared/types').LibraryAcceptance[]=[]){const content=regions(html).map(text).join('\n').replace(/\r\n?/g,'\n');return sources(keys,acceptances).every(source=>content.includes(source.text.replace(/\r\n?/g,'\n')));}
export function withLibraryNotices(html:string,keys:string[],acceptances:import('../shared/types').LibraryAcceptance[]=[]){
  const libraries=resolveLibraries(keys,acceptances),notices=sources(keys,acceptances);if(!libraries.length)return html;
  const links=[...new Map(libraries.filter(l=>l.license.sourceCode).map(l=>[l.license.sourceCode,`<li>${escape(l.name)} ${escape(l.version)} · ${escape(l.license.identifier)} · <a href="${escape(l.license.sourceCode)}">Corresponding upstream source</a></li>`])).values()].join('\n');
  const markup=`<section data-btcsite-notices="1" style="padding:24px 7%;font:12px/1.6 system-ui,sans-serif;color:inherit"><details><summary style="cursor:pointer">Open-source credits</summary><p>This website uses the following independently maintained libraries. Their notices and source references are retained below.</p><ul>${links}${libraries.filter(l=>l.key.startsWith('research-')).map(l=>`<li>${escape(l.name)} · unqualified library · license permissions and notices not reviewed · inscription ${escape(l.id)}</li>`).join('')}</ul>${notices.map(source=>`<details><summary>${escape(source.name)}</summary><p><a href="${escape(source.url)}">Upstream license notice</a></p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace">${escape(source.text)}</pre></details>`).join('\n')}</details></section>`;
  const existing=regions(html);
  if(existing.length){let result=html;for(const [index,node] of existing.map((node,index)=>[index,node] as const).reverse()){const location=node.sourceCodeLocation;if(!location)throw new AppError('NOTICE_LOCATION','The existing credits region could not be updated.');result=result.slice(0,location.startOffset)+(index===0?markup:'')+result.slice(location.endOffset);}return result;}
  const document=parse(html,{sourceCodeLocationInfo:true});let close:number|undefined;
  function findBody(node:any){if(node.tagName==='body')close=node.sourceCodeLocation?.endTag?.startOffset;for(const child of node.childNodes??[])findBody(child);}
  findBody(document);if(close===undefined)throw new AppError('HTML_BODY_REQUIRED','Add a closing </body> element before inserting library credits.');return html.slice(0,close)+markup+'\n'+html.slice(close);
}
