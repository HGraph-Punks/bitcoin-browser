import candidates from '../../docs/research/library-candidates.json';
import evidence from '../../docs/research/library-verification.json';
import notices from './license-notices.json';
import qualification from './runtime-qualification.json';
import expansion from '../../docs/research/library-expansion-verification.json';
import expansionQualification from './expansion-qualification.json';
import {AppError} from '../core/errors';
import {acknowledgedLibrary,researchLibrary,libraryAcceptancesSchema} from './library-acceptance';
import type { LibraryAcceptance, Library } from '../shared/types';

const descriptions: Record<string, [string, string, string?]> = {
  'three-r178': ['3D scenes', 'Interactive objects, materials, lighting, and WebGL scenes.'],
  'three-core-r178': ['Three.js dependency', 'The core module required by the inscribed Three.js renderer.'],
  'p5-1.11.2': ['Creative drawing', 'Make generative art and interactive sketches with simple drawing commands.', 'p5'],
  'p5-2.0.1': ['Creative drawing', 'The newer p5 runtime, with its own API and templates.', 'p5'],
  'phaser-3.80.1': ['Games', 'Scenes, sprites, input, and physics for browser games.', 'Phaser'],
  'tone-15.0.4': ['Interactive audio', 'Synthesizers, effects, and musical timing. Sound starts with a user gesture.', 'Tone']
};

const originalLibraries: Library[] = candidates.libraries.flatMap(candidate => {
  const copy = descriptions[candidate.key];
  if (!copy) return [];
  const record = evidence.libraries.find(l => l.key === candidate.key)!;
  const license=notices.entries[candidate.key as keyof typeof notices.entries];
  const runtime=qualification.records.filter(r=>r.key===candidate.key&&r.id===candidate.id&&r.sha256===record.responses[0].decodedSha256);
  return [{ key: candidate.key, name: candidate.name, version: candidate.version!, purpose: copy[0], description: copy[1],
    network:'mainnet' as const, id: candidate.id, sha256: record.responses[0].decodedSha256!, mime: 'text/javascript',
    bytes: record.responses[0].decodedBytes!, storedBytes: record.inscription!.content_length,
    dependencies: candidate.key === 'three-r178' ? ['three-core-r178'] : [], format: candidate.format as 'esm' | 'classic', global: copy[2],
    upstream: candidate.upstream!, upstreamComparison: record.upstreamComparison, runtimeTested: runtime.length===2, licenseReviewed: license.reviewStatus==='reviewed',
    catalogVersion:'1.1.0',packageName:candidate.key.startsWith('three')?'three':candidate.key.startsWith('p5')?'p5':candidate.key.startsWith('phaser')?'phaser':'tone',
    contentCheckedAt:record.fetchedAt,chainIndependentlyVerified:false,license:license as Library['license'],
    templates: candidate.key.startsWith('three')?['three']:candidate.key==='p5-1.11.2'?['sketch']:candidate.key==='p5-2.0.1'?['sketch2']:candidate.key.startsWith('phaser')?['game']:['audio'],
    compatibility:candidate.key.startsWith('p5')?['Use one p5 version per page.','Motion sensors are denied by the preview sandbox. The drawing recipes do not use sensors.']:candidate.key.startsWith('tone')?['Sound requires an explicit user gesture.','This recipe synthesizes sound without external samples.']:candidate.key.startsWith('three')?['The r178 renderer needs its separately inscribed core.','A functioning WebGL2 context is required.']:['The starter uses Canvas2D and disables game audio.'],runtime }];
});
const extraDescriptions:Record<string,{purpose:string;description:string;templates:Library['templates'];compatibility:string[]}>= {
  'matter-0.19.0':{purpose:'Physics playgrounds',description:'Give shapes weight, gravity and collisions. Build playful worlds with a lightweight 2D physics engine.',templates:['physics'],compatibility:['Canvas2D rendering; no external textures or services.','Pause animation when the page is hidden and respect reduced motion.']},
  'anime-3.2.1':{purpose:'Motion & animation',description:'Animate shapes, SVG, typography and page elements with timelines and gentle transitions.',templates:['motion'],compatibility:['This is the anime.js 3.x API. Examples for 4.x are not interchangeable.','Respect reduced motion and provide a pause control for continuous animation.']},
  'd3-7.8.5':{purpose:'Data stories',description:'Turn local data into expressive charts and interactive SVG diagrams.',templates:['chart'],compatibility:['Examples use local data. External HTTP data sources are blocked by the Ord sandbox.','The browser bundle exposes the d3 global; it is not a bare npm import.']},
  'jszip-3.10.1':{purpose:'Archive tools',description:'Create ZIP collections in the browser from your own text and assets.',templates:[],compatibility:['Use bounded, trusted archive inputs.','Generated archives stay in memory; downloads may be restricted by the viewer.','Bundled dependency license review remains pending.']}
};
const extraLibraries:Library[]=expansion.entries.flatMap(record=>{
  const copy=extraDescriptions[record.key];
  if(!copy||record.upstreamComparison!=='exact-decoded-byte-match'||!record.gatewayAgreement||!record.license||!record.sha256||!record.bytes||!record.storedBytes)return [];
  const records=expansionQualification.records as (Library['runtime'][number]&{key:string;id:string;sha256:string})[];
  const runtime=records.filter(run=>run.key===record.key&&run.id===record.id&&run.sha256===record.sha256);
  const reviewed=record.key==='matter-0.19.0'||record.key==='anime-3.2.1';
  const license={...record.license,reviewStatus:reviewed?'reviewed' as const:'pending' as const,scope:reviewed?'Pinned standalone browser build. Full upstream MIT notice is retained in generated websites. Optional plugins and external assets are outside this review.':'Upstream notice retained; bundled dependency notices still need review before production publication.'};
  return [{key:record.key,name:record.name,version:record.version,packageName:record.packageName,purpose:copy.purpose,description:copy.description,network:'mainnet' as const,id:record.id,sha256:record.sha256,mime:record.mime!,bytes:record.bytes,storedBytes:record.storedBytes,format:record.format as 'classic'|'esm',global:record.global??undefined,dependencies:[],upstream:record.upstream,upstreamComparison:record.upstreamComparison,contentCheckedAt:record.checkedAt,catalogVersion:'1.2.0',chainIndependentlyVerified:false as const,runtimeTested:runtime.some(r=>r.profile==='builder-opaque-ord-emulation'),licenseReviewed:reviewed,license,templates:copy.templates,compatibility:copy.compatibility,runtime}];
});
export const libraries:Library[]=[...originalLibraries,...extraLibraries];
export function libraryByKey(key: string) { return libraries.find(l => l.key === key); }
export function resolveLibraries(keys: string[],acceptances:LibraryAcceptance[]=[]): Library[] {
  libraryAcceptancesSchema.parse(acceptances);
  const result = new Map<string, Library>();
  const visit = (key: string) => {
    const pin=acceptances.find(a=>a.key===key),catalog=libraryByKey(key);
    const entry=catalog?acknowledgedLibrary(catalog,pin):pin?researchLibrary(pin):undefined;
    if (!entry) throw new AppError('UNKNOWN_LIBRARY','Choose an available catalog library and accept its warning if needed.');
    if (result.has(key)) return;
    result.set(key, entry);
    entry.dependencies.forEach(visit);
  };
  keys.forEach(visit);
  return [...result.values()];
}
