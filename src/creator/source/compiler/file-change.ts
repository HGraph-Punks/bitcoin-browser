import path from 'node:path';
import {AppError} from '../core/errors';
import {mimeFor} from '../core/assets';
import {safeRelativePath} from '../core/validation';
import {scanSource,rewriteReferences} from './references';
import {buildProject} from './build';
import type {ProjectSnapshot,ResourceReference,BuildArtifact} from '../shared/types';

export function changeFile(project:ProjectSnapshot,from:string,to?:string,graph?:BuildArtifact){
  safeRelativePath(from);if(to)safeRelativePath(to);
  if(from==='index.html')throw new AppError('ENTRY_REQUIRED','The index.html entry point cannot be renamed or removed.');
  if(!Object.hasOwn(project.files,from)&&!Object.hasOwn(project.assets,from))throw new AppError('FILE_NOT_FOUND','That file is not in this project.');
  if(to&&(Object.hasOwn(project.files,to)||Object.hasOwn(project.assets,to)))throw new AppError('PATH_COLLISION','Another file already uses that path.');
  if(to&&mimeFor(from)!==mimeFor(to))throw new AppError('FILE_TYPE_CHANGE','Keep the same web file type when renaming a file.');
  graph??=buildProject(project);
  if(graph.projectId!==project.id||graph.revision!==project.revision)throw new AppError('REVISION_CONFLICT','The project changed while resolving its file references.');
  if(graph.findings.some(f=>f.code==='AMBIGUOUS_DOCUMENT_BASE'))throw new AppError('AMBIGUOUS_DOCUMENT_BASE','Use root-relative URLs in shared scripts before renaming or removing their dependencies.');
  const files={...project.files},assets={...project.assets},usedBy=new Set<string>();
  for(const [filename,source] of Object.entries(project.files)){
    const parsed=scanSource(filename,source),references:ResourceReference[]=[];
    const resolved=graph.resources.find(r=>r.path===filename)?.references??[];
    if(parsed.findings.some(f=>f.severity==='error'&&/_SYNTAX$/.test(f.code)))throw new AppError('SOURCE_PARSE_REQUIRED',`Fix the syntax in ${filename} before changing file paths.`);
    for(const ref of parsed.references){
      if(!ref.url||/^(#|\/content\/|\/r\/|[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref.url))continue;
      if(ref.context==='module'&&!/^[./]/.test(ref.url))continue;
      const base=ref.base==='document'&&!/\.(html?|svg)$/.test(filename)?'index.html':filename;
      let target:string,suffix:string;try{const url=new URL(ref.url,'https://project.invalid/'+base);target=decodeURIComponent(url.pathname).slice(1);if(!target||target.endsWith('/'))target+='index.html';suffix=url.search+url.hash;}catch{continue;}
      const known=resolved.find(r=>r.start===ref.start&&r.end===ref.end&&r.container===ref.container);
      if(known&&!known.target.includes(':')){target=known.target;suffix=known.suffix;}
      if(target===from){usedBy.add(filename);if(!to)continue;}
      const nextFilename=filename===from&&to?to:filename;
      if(to&&(target===from||nextFilename!==filename)){
        const documentRelative=ref.base==='document'&&!/\.(html?|svg)$/.test(nextFilename);
        if(documentRelative&&target!==from)continue;
        const nextBase=ref.base==='document'&&!/\.(html?|svg)$/.test(nextFilename)?'index.html':nextFilename;
        const nextTarget=target===from?to:target;
        let relative=documentRelative?'/'+nextTarget.split('/').map(encodeURIComponent).join('/'):path.posix.relative(path.posix.dirname(nextBase),nextTarget).split('/').map(encodeURIComponent).join('/');if(!relative.startsWith('.')&&!relative.startsWith('/'))relative='./'+relative;
        references.push({...ref,target:relative,suffix});
      }
    }
    if(references.length)files[filename]=rewriteReferences(source,references,parsed.containers,ref=>ref.target+ref.suffix);
  }
  if(!to&&usedBy.size)throw new AppError('FILE_IN_USE',`Remove or replace references in ${[...usedBy].slice(0,6).join(', ')} before deleting this file.`);
  if(to){if(Object.hasOwn(files,from)){files[to]=files[from];delete files[from];}else{assets[to]={...assets[from],path:to};delete assets[from];}}
  else{delete files[from];delete assets[from];}
  const settings=project.settings.heroImage===from?{...project.settings,heroImage:to??''}:project.settings;
  return {files,assets,settings};
}
