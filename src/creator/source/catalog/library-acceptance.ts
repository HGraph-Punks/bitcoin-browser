import {z} from 'zod';
import research from './research-catalog.json';
import type {Library,LibraryAcceptance} from '../shared/types';
import {AppError} from '../core/errors';

export const libraryAcceptanceSchema=z.object({key:z.string().min(1).max(80),id:z.string().regex(/^[a-f0-9]{64}i(?:0|[1-9][0-9]{0,9})$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),mime:z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[^\r\n]{1,60})?$/).max(100),bytes:z.number().int().min(1).max(8_000_000),format:z.enum(['classic','esm','stylesheet','asset']),acceptedAt:z.string().datetime(),warningVersion:z.literal(1)}).strict();
export const libraryAcceptancesSchema=z.array(libraryAcceptanceSchema).max(32).refine(items=>new Set(items.map(i=>i.key)).size===items.length,'Duplicate library acceptances');
import {researchKey} from '../shared/library-warning';
export {researchKey,needsLibraryWarning} from '../shared/library-warning';
export function researchLibrary(acceptance:LibraryAcceptance):Library{
  const pin=libraryAcceptanceSchema.parse(acceptance),record=research.entries.find(r=>r.id===pin.id);
  if(!record||pin.key!==researchKey(record.id))throw new AppError('UNKNOWN_LIBRARY','Choose an inscription from the research catalog.');
  return {key:pin.key,id:pin.id,sha256:pin.sha256,mime:pin.mime,bytes:pin.bytes,storedBytes:0,format:pin.format,name:record.name,version:'unqualified',purpose:'Research library',description:record.notes,network:'mainnet',dependencies:[],upstream:'',upstreamComparison:'not-reviewed',runtimeTested:false,licenseReviewed:false,catalogVersion:'research-user-selected-v1',packageName:pin.key,contentCheckedAt:pin.acceptedAt,chainIndependentlyVerified:false,license:{identifier:'Not reviewed',reviewStatus:'pending',scope:'User accepted the warning for authoring and preview. License permissions and notices are still unreviewed; inscription remains blocked by the existing license-review gate. Dependencies and runtime compatibility also need review.',sourceCode:'',sources:[]},templates:[],compatibility:[record.verification,record.notes,'Stored inscription size and transitive dependencies have not been independently verified.'],runtime:[],userAcknowledgement:pin};
}
export function acknowledgedLibrary(library:Library,pin?:LibraryAcceptance):Library{
  if(!pin)return library;
  libraryAcceptanceSchema.parse(pin);
  if(pin.key!==library.key||pin.id!==library.id||pin.sha256!==library.sha256||pin.bytes!==library.bytes||pin.mime!==library.mime||pin.format!==library.format)throw new AppError('LIBRARY_ACCEPTANCE_MISMATCH','The accepted warning does not match these exact library bytes.');
  return {...library,userAcknowledgement:pin};
}
