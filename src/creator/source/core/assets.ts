import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {AppError} from './errors';
import {safeRelativePath,validate} from './validation';
import type {SourceAsset} from '../shared/types';

export const MAX_ASSET_BYTES=8_000_000;
export const MAX_PROJECT_ASSET_BYTES=64_000_000;
export const assetSchema=z.object({path:z.string().min(1).max(240),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().min(1).max(MAX_ASSET_BYTES),mime:z.string().min(1).max(100),originalName:z.string().max(200),importedAt:z.string(),origin:z.discriminatedUnion('type',[z.object({type:z.literal('local')}).strict(),z.object({type:z.literal('inscription'),id:z.string().regex(/^[a-f0-9]{64}i\d+$/),network:z.enum(['mainnet','signet','regtest']),gateway:z.string().max(200)}).strict()])}).strict();
const types:Record<string,string>={'.html':'text/html;charset=utf-8','.htm':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.gltf':'model/gltf+json','.svg':'image/svg+xml','.txt':'text/plain;charset=utf-8','.md':'text/markdown;charset=utf-8','.glsl':'text/plain;charset=utf-8','.wgsl':'text/plain;charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm','.glb':'model/gltf-binary','.bin':'application/octet-stream','.wasm':'application/wasm'};
export const textExtensions=new Set(['.html','.htm','.css','.js','.mjs','.json','.gltf','.svg','.txt','.md','.glsl','.wgsl']);
export function mimeFor(filename:string){return types[path.posix.extname(filename).toLowerCase()]??'application/octet-stream';}
export function isTextFile(filename:string){return textExtensions.has(path.posix.extname(filename).toLowerCase());}
export function decodeText(bytes:Uint8Array){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('INVALID_TEXT','Source files must contain valid UTF-8 text.');}}
export function decodeBase64(text:string,limit:number){
  if(text.length>Math.ceil(limit/3)*4)throw new AppError('ASSET_TOO_LARGE','The encoded asset exceeds the import limit.');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length>limit||bytes.toString('base64')!==text)throw new AppError('INVALID_ASSET','Provide canonical base64 without whitespace or missing padding.');
  return bytes;
}
export function describeAsset(relative:string,bytes:Buffer,origin:SourceAsset['origin']={type:'local'}):SourceAsset{
  safeRelativePath(relative);
  if(bytes.length<1||bytes.length>MAX_ASSET_BYTES)throw new AppError('ASSET_TOO_LARGE','Choose a nonempty asset smaller than 8 MB.');
  const ext=path.posix.extname(relative).toLowerCase(),mime=mimeFor(relative);
  if(!types[ext])throw new AppError('UNSUPPORTED_ASSET',`The ${ext||'unnamed'} file type is not supported. Import a standard web image, font, media, model, or source file.`);
  const starts=(signature:number[])=>signature.every((byte,i)=>bytes[i]===byte);
  const checks:Record<string,()=>boolean>={
    '.png':()=>starts([137,80,78,71,13,10,26,10])&&bytes.length>=24,
    '.jpg':()=>starts([255,216,255]),'.jpeg':()=>starts([255,216,255]),
    '.gif':()=>/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()),
    '.webp':()=>bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP',
    '.avif':()=>bytes.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(bytes.subarray(8,32).toString()),
    '.woff':()=>bytes.subarray(0,4).toString()==='wOFF','.woff2':()=>bytes.subarray(0,4).toString()==='wOF2',
    '.glb':()=>bytes.subarray(0,4).toString()==='glTF',
    '.wasm':()=>starts([0,97,115,109]),'.wav':()=>bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE',
    '.ogg':()=>bytes.subarray(0,4).toString()==='OggS',
  };
  if(checks[ext]&&!checks[ext]())throw new AppError('ASSET_TYPE_MISMATCH',`The bytes in ${relative} do not match its ${ext} extension.`);
  if(ext==='.png'){
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(width<1||height<1||width>16384||height>16384||width*height>32_000_000)throw new AppError('IMAGE_DIMENSIONS','Reduce this PNG to at most 32 million pixels and 16,384 pixels per side.');
  }
  return {path:relative,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime,originalName:path.posix.basename(relative),importedAt:new Date().toISOString(),origin};
}
export function validateAssets(assets:Record<string,SourceAsset>,files:Record<string,string>){
  if(Object.keys(assets).length+Object.keys(files).length>256)throw new AppError('PROJECT_TOO_LARGE','Keep this project within 256 source files and assets.');
  let total=0;const seen=new Set<string>();
  for(const relative of [...Object.keys(files),...Object.keys(assets)]){safeRelativePath(relative);const key=relative.normalize('NFC').toLowerCase();if(seen.has(key))throw new AppError('PATH_COLLISION','File paths must be distinct, including capitalization, on every supported platform.');seen.add(key);}
  for(const relative of seen){const parts=relative.split('/');for(let i=1;i<parts.length;i++)if(seen.has(parts.slice(0,i).join('/')))throw new AppError('PATH_COLLISION','A file and a folder cannot use the same project path.');}
  for(const [relative,asset] of Object.entries(assets)){validate(assetSchema,asset);if(relative!==asset.path)throw new AppError('ASSET_PATH_MISMATCH','The asset path does not match its manifest entry.');total+=asset.bytes;}
  if(total>MAX_PROJECT_ASSET_BYTES)throw new AppError('PROJECT_TOO_LARGE','Keep imported assets within 64 MB per project.');
}
