import {AppError} from '../core/errors';
import {runePlan,type RuneSpec} from '../shared/ordinals';
import {objectHash} from './storage';
export function parseExactJson(text:string):any{return (JSON.parse as any)(text,(_key:string,value:unknown,context?:{source:string})=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context?.source??(()=>{throw new AppError('INVALID_PROVIDER_NUMBER','Exact integer parsing is unavailable.')})():value);}
function check(value:unknown,message:string):asserts value{if(!value)throw new AppError('INVALID_TRANSACTION',message)}
/** Only the bounded JSON-compatible CBOR subset used for collection metadata. */
export function decodeMetadata(hex:string):unknown{
 check(/^(?:[a-f0-9]{2})*$/.test(hex)&&hex.length<=100_000,'Invalid inscription metadata encoding.');const bytes=Buffer.from(hex,'hex');let at=0,visited=0;
 const read=(count:number)=>{check(Number.isSafeInteger(count)&&count>=0&&at+count<=bytes.length,'Truncated metadata.');const value=bytes.subarray(at,at+count);at+=count;return value};
 const integer=(info:number)=>{if(info<24)return info;check([24,25,26,27].includes(info),'Indefinite metadata is unsupported.');const chunk=read(2**(info-24));let value=0n;for(const byte of chunk)value=value*256n+BigInt(byte);check(value<=BigInt(Number.MAX_SAFE_INTEGER),'Metadata integer exceeds the supported exact range.');return Number(value)};
 function item(depth:number):unknown{check(depth<=12&&++visited<=5000&&at<bytes.length,'Metadata nesting or size limit exceeded.');const header=read(1)[0],major=header>>5,info=header&31;
 if(major===7){if(info===20)return false;if(info===21)return true;if(info===22)return null;throw new AppError('INVALID_TRANSACTION','Unsupported metadata scalar.');}
 const length=integer(info);if(major===0)return length;if(major===1){check(Number.isSafeInteger(-1-length),'Metadata integer exceeds the exact range.');return -1-length;}if(major===3){const raw=read(length),text=new TextDecoder('utf-8',{fatal:true}).decode(raw);return text;}
 if(major===4){check(length<=1000,'Metadata array is too large.');return Array.from({length},()=>item(depth+1))}
 if(major===5){check(length<=1000,'Metadata map is too large.');const result:Record<string,unknown>=Object.create(null);for(let i=0;i<length;i++){const key=item(depth+1);check(typeof key==='string'&&!Object.hasOwn(result,key),'Invalid or duplicate metadata key.');result[key]=item(depth+1)}return result;}
 throw new AppError('INVALID_TRANSACTION','Unsupported metadata structure.');}
 const result=item(0);check(at===bytes.length,'Trailing metadata bytes.');return result;
}
export function verifyMetadata(hex:string|null|undefined,expected:unknown){check(typeof hex==='string'&&objectHash(decodeMetadata(hex))===objectHash(expected),'Inscription metadata differs from the reviewed title, description or traits.');}
export function validateRunestone(artifact:any,spec:RuneSpec,premineIndex:number|null){
 const plan=runePlan(spec),stone=artifact?.Runestone;check(stone&&Object.keys(artifact).length===1&&!stone.edicts?.length&&stone.mint==null,'The reveal must contain a valid etching without transfers or a cenotaph.');const etching=stone.etching;let spacers=0,index=0;for(const char of plan.spec.name){if(char==='•')spacers+=2**(index-1);else index++}
 const scalar=(value:unknown,fallback='0')=>value==null?fallback:String(value);
 check(etching&&etching.rune===plan.spec.name.replace(/•/g,'')&&Number(etching.divisibility??0)===spec.divisibility&&Number(etching.spacers??0)===spacers&&etching.symbol===spec.symbol&&scalar(etching.premine)===plan.premineUnits&&etching.turbo===spec.turbo,'The runestone name, symbol, divisibility, premine or flags differs from the reviewed Rune.');
 check(stone.pointer===premineIndex,'The Rune premine pointer differs from its reviewed wallet output.');
 if(!spec.openMint)check(etching.terms==null,'An unexpected open mint was added.');else{const terms=etching.terms;check(terms&&scalar(terms.amount)===plan.amountUnits&&scalar(terms.cap)===spec.cap,'The mint amount or cap differs from the review.');for(const [field,start,end] of [['height',spec.heightStart,spec.heightEnd],['offset',spec.offsetStart,spec.offsetEnd]]){check(Array.isArray(terms[field])&&scalar(terms[field][0],'')===start&&scalar(terms[field][1],'')===end,'The mint window differs from the review.');}}
 return plan;
}

export function runeCommitment(name:string){let value=0n;for(const [index,char] of Array.from(name.replace(/[•.]/g,'')).entries()){if(index)value++;value=value*26n+BigInt(char.charCodeAt(0)-65);}const result:number[]=[];while(value){result.push(Number(value&255n));value>>=8n;}return result;}
