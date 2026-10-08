import {ordinalTemplate,ordinalTemplates} from './ordinal-templates';
import {defaultRune,runePlan} from '../shared/ordinals';
import {runeHTML} from './ordinal-templates';
import { parse } from 'parse5';
import type { SiteSettings, TemplateId } from '../shared/types';
import { AppError } from './errors';
import {settingsSchema} from './validation';
import {experienceRecipe,experienceStyle} from './experience-recipes';
import {withLibraryNotices} from '../catalog/notices';
import {libraryExperienceStyle} from './library-experiences';

export const templates: { id: TemplateId; name: string; description: string; tag: string; libraries: string[] }[] = [
  ...Object.entries(ordinalTemplates).map(([id,value])=>({id:id as TemplateId,...value,libraries:[]})),
  { id: 'website', name: 'Personal website', description: 'A thoughtful home for your work, ideas, and links.', tag: 'Start here', libraries: [] },
  { id: 'gallery', name: 'Digital gallery', description: 'A quiet space for a collection of unique works.', tag: 'Art & collections', libraries: [] },
  { id: 'three', name: 'Living sculpture', description: 'An interactive 3D scene using on-chain Three.js.', tag: '3D & WebGL', libraries: ['three-r178'] },
  { id: 'sketch', name: 'Generative sketch', description: 'A responsive canvas that changes with your ideas.', tag: 'Creative coding', libraries: ['p5-1.11.2'] },
  { id: 'sketch2', name: 'Orbit study', description: 'Seeded patterns and quiet motion, made with p5 2.x.', tag: 'Creative coding · p5 2', libraries: ['p5-2.0.1'] },
  { id: 'game', name: 'Collect the light', description: 'A small playable game with touch and keyboard controls.', tag: 'Games · Phaser', libraries: ['phaser-3.80.1'] },
  { id: 'audio', name: 'Sound garden', description: 'Four musical notes, synthesized with on-chain Tone.js.', tag: 'Sound · Tone.js', libraries: ['tone-15.0.4'] },
  { id: 'webgl', name: 'Light field', description: 'Procedural color and motion using built-in WebGL.', tag: 'Native WebGL', libraries: [] },
  { id: 'blocks', name: 'Bitcoin clock', description: 'A page that responds to Bitcoin’s latest block.', tag: 'Dynamic data', libraries: [] },
  { id: 'physics', name: 'Falling shapes', description: 'A playful world of gravity and collisions. Drop a shape and watch it settle.', tag: 'Physics · Matter.js', libraries: ['matter-0.19.0'] },
  { id: 'motion', name: 'Motion study', description: 'Choreograph a field of shapes with gentle, controllable animation.', tag: 'Animation · anime.js', libraries: ['anime-3.2.1'] },
  { id: 'chart', name: 'Data garden', description: 'An interactive, accessible SVG chart. Change the values and explore.', tag: 'Data · D3', libraries: ['d3-7.8.5'] },
  { id: 'blank', name: 'Blank canvas', description: 'A minimal HTML page, ready for your own direction.', tag: 'From scratch', libraries: [] }
];
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
export function initialSettings(template: TemplateId, name: string): SiteSettings {
  const copy: Record<TemplateId, [string, string, string]> = {
    collection:['AN ORDINALS COLLECTION','A collection worth\nkeeping.','Independent image inscriptions, brought together in a recursive gallery.'],runes:['A NEW RUNE','Give your Rune\na clear beginning.','Design exact supply and mint terms before reviewing a Bitcoin etching.'],image:['ONE IMAGE. ONE ARTIFACT.','A singular work.\nA permanent home.','An original digital work, made to be held and explored.'],pixel:['A CHARACTER FROM A SEED','Small pixels.\nDistinct personalities.','A deterministic character generator built with compact native SVG.'],generative:['CODE. SEED. ARTIFACT.','A rule becomes\na work of art.','Explore a deterministic edition of self-contained generative geometry.'],recursive:['A GALLERY OF INSCRIPTIONS','Individual artifacts.\nA shared world.','A recursive display that links to the actual image inscriptions after publication.'],story:['A STORY ON BITCOIN','Every artifact\nhas a story.','Move through a small narrative with touch or keyboard. Shape it into your own comic or interactive story.'],artifact:['AN INDEPENDENT ARTIFACT','An object for\nthe long view.','Compact vector geometry, an edition identity, and a story that stays with the code.'],
    website: ['AN INDEPENDENT SPACE', 'Good things deserve\na place that lasts.', 'A small corner of Bitcoin for the things I make, the ideas I follow, and the work still to come.'],
    gallery: ['A COLLECTION OF POSSIBILITIES', 'Art, without\nan expiration date.', 'An open collection of experiments in shape, light, and motion. Made to be explored.'],
    three: ['FORM · LIGHT · BITCOIN', 'A little impossible.\nEntirely on-chain.', 'A living sculpture built from shared code on Bitcoin. Move your pointer and explore the form.'],
    sketch: ['ONE SEED. ENDLESS POSSIBILITIES.', 'Patterns in\nthe everyday.', 'A study of motion, repetition, and the spaces between. Every frame begins with a simple idea.'],
    sketch2: ['A STUDY IN ORBITS', 'A simple rule.\nA new perspective.', 'Small marks find their place in a larger pattern. Change the variation, pause the motion, and look a little closer.'],
    game: ['A MOMENT TO PLAY', 'Follow the light.\nFind your rhythm.', 'Five little lights are waiting to be found. A simple game, built from shared code on Bitcoin.'],
    audio: ['A SMALL SOUND GARDEN', 'A few notes.\nYour own melody.', 'Enable sound and play. Four notes, endless combinations, and no samples to download.'],
    webgl: ['CODE BECOMES COLOR', 'Light, in\nevery direction.', 'An experiment in color and repetition. A live shader draws every pixel, using only the capabilities of your browser.'],
    blocks: ['A DIFFERENT KIND OF TIME', 'The world moves.\nBitcoin keeps time.', 'A living page following the latest block. The code stays the same; the chain keeps changing.'],
    physics: ['A LITTLE GRAVITY', 'Let curiosity\ntake shape.', 'Drop a shape, watch it fall, and build a small world of your own. A physics playground made from shared code on Bitcoin.'],
    motion: ['A STUDY IN MOVEMENT', 'Small gestures.\nNew possibilities.', 'Simple forms find a rhythm together. Pause the motion, rearrange the field, and discover a different composition.'],
    chart: ['EVERY NUMBER HAS A STORY', 'Make the invisible\na little clearer.', 'A garden of values, drawn with shared code on Bitcoin. Change the data and see a new story take shape.'],
    blank: ['A NEW BEGINNING', 'Make something\nthat matters.', 'This is your space. Start with a sentence, an idea, or a little code.']
  };
  const [eyebrow, headline, description] = copy[template];
  return { name, eyebrow, headline, description, accent: '#f7931a' };
}
const baseStyle = `*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#111310;color:#f3f2e9;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:5px}nav{display:flex;align-items:center;justify-content:space-between;padding:28px 7%;border-bottom:1px solid #ffffff16}nav .brand{font-size:15px;font-weight:700;letter-spacing:-.03em}nav .links{display:flex;gap:26px;font-size:12px;color:#c0c5b9}main{padding:72px 7% 0;max-width:1500px;margin:auto}.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:8%;align-items:center;min-height:430px}.eyebrow{font-size:10px;letter-spacing:.18em;font-weight:650;color:var(--accent);margin:0 0 24px}h1{white-space:pre-line;font-size:clamp(32px,5.5vw,72px);line-height:1.04;font-weight:550;letter-spacing:-.06em;margin:0 0 26px}.intro{font-size:14px;line-height:1.8;color:#b2b9ae;max-width:405px}.cta{display:inline-flex;align-items:center;gap:26px;border:1px solid #66745b;padding:13px 18px;border-radius:30px;font-size:12px;margin-top:20px}.hero-image{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:18px}.art{aspect-ratio:1;position:relative;overflow:hidden;border-radius:50%;background:radial-gradient(circle at 38% 30%,#bac29c 0,#617548 22%,#263c20 49%,#111910 73%);box-shadow:inset -16px -24px 50px #0009,0 0 90px #6d854413}.art:before{content:'';position:absolute;inset:7%;border:1px solid #dbe9b72b;border-radius:50%;box-shadow:0 0 0 24px #dbe9b710,0 0 0 48px #dbe9b708}.art:after{content:'';position:absolute;inset:-12%;background:repeating-radial-gradient(ellipse at 20% 20%,transparent 0 7px,#0e190b44 8px 9px);transform:rotate(-26deg)}.caption{display:flex;justify-content:space-between;margin-top:23px;font-size:9px;letter-spacing:.13em;color:#a6ae9d}.section{border-top:1px solid #ffffff1b;margin-top:80px;padding:32px 0 60px}.section h2{font-size:24px;letter-spacing:-.04em;font-weight:500;margin:12px 0 24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.work{background:#1b2019;padding:22px;border-radius:4px;min-height:160px}.work h3{font-size:15px;font-weight:500}.work p{font-size:12px;color:#a8b19f;line-height:1.7}.number{font-size:10px;letter-spacing:.12em;color:var(--accent)}footer{display:flex;justify-content:space-between;border-top:1px solid #ffffff18;padding:24px 7%;font-size:10px;color:#a0a99a}#scene,#sketch{aspect-ratio:1;overflow:hidden;border-radius:18px}canvas{display:block;max-width:100%}.block-card{padding:40px;border:1px solid #496b3a;border-radius:18px;background:#1e2b18}.block-height{display:block;font-size:clamp(36px,6vw,74px);letter-spacing:-.06em;color:var(--accent)}.block-caption{font-size:11px;color:#c0cab8}.gallery-tile{aspect-ratio:1;border-radius:6px;background:radial-gradient(circle at 25% 35%,var(--accent),#172d34 65%);margin-bottom:18px}.gallery-tile.b{background:conic-gradient(from 60deg at 50% 60%,#483925,#b6c29e,#34544c,#483925)}.gallery-tile.c{background:repeating-radial-gradient(ellipse at 70% 50%,#152b27 0 15px,#859967 16px 20px)}@media(max-width:650px){nav{padding:22px 6%}.hero{grid-template-columns:1fr;gap:40px}main{padding:44px 6% 0}h1{font-size:42px}.hero-visual{max-width:400px;width:100%;margin:auto}.cards{grid-template-columns:1fr}.section{margin-top:50px}footer{gap:20px}nav .links{gap:16px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;

export function createTemplate(template: TemplateId, settings: SiteSettings): string {
  const ordinal=ordinalTemplate(template,settings);if(ordinal)return ordinal;
  if(template==='runes')return runeHTML(settings,defaultRune,runePlan(defaultRune).supply);
  const mediaKind=template==='blank'?'empty':['website','gallery'].includes(template)?'art':undefined;
  let visual = mediaMarkup(settings,'art');
  let scripts = '';
  if (template === 'three') {
    visual = '<div id="scene" aria-label="Interactive three-dimensional knot"></div>';
    scripts = `<script type="module">\nimport * as THREE from '/content/a4a6f99205628bdc3ca2143a4e380f7ebc576b4414c16dffdb34be28337ffe83i0';\nconst host=document.getElementById('scene');\nconst scene=new THREE.Scene();\nconst camera=new THREE.PerspectiveCamera(40,1,.1,100);camera.position.z=5;\nconst renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.appendChild(renderer.domElement);\nconst shape=new THREE.Mesh(new THREE.TorusKnotGeometry(1,.28,160,24),new THREE.MeshStandardMaterial({color:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),metalness:.55,roughness:.24}));scene.add(shape);\nscene.add(new THREE.HemisphereLight(0xdfeacf,0x263020,3));const light=new THREE.DirectionalLight(0xffffff,4);light.position.set(3,4,3);scene.add(light);\nnew ResizeObserver(()=>{const {width,height}=host.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix()}).observe(host);\nlet targetX=.2,targetY=.4;host.addEventListener('pointermove',e=>{const r=host.getBoundingClientRect();targetY=(e.clientX-r.left)/r.width;targetX=(e.clientY-r.top)/r.height});\nconst reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;renderer.setAnimationLoop(t=>{shape.rotation.y+=(targetY-shape.rotation.y)*.025;shape.rotation.x+=(targetX-shape.rotation.x)*.025;if(!reduced)shape.rotation.z=Math.sin(t*.0003)*.2;renderer.render(scene,camera)});\n</script>`;
  }
  const experience=experienceRecipe(template);
  if(experience){visual=experience.visual;scripts=experience.scripts;}
  if (template === 'blocks') {
    visual = '<div class="block-card"><p class="eyebrow">LATEST BITCOIN BLOCK</p><strong class="block-height" id="height">Loading…</strong><p class="block-caption" id="block-status">Reading the connected Ord source</p></div>';
    scripts = `<script>async function updateBlock(){try{const response=await fetch('/r/blockheight');if(!response.ok)throw new Error('Source unavailable');const height=await response.json();document.getElementById('height').textContent=Number(height).toLocaleString();document.getElementById('block-status').textContent='Updates every 30 seconds'}catch(e){document.getElementById('height').textContent='—';document.getElementById('block-status').textContent='Block data is unavailable. Trying again soon.'}}updateBlock();setInterval(updateBlock,30000);</script>`;
  }
  if (template === 'blank') visual = mediaMarkup(settings,'empty');
  const field = (key: keyof SiteSettings) => `data-btcsite-field="${key}"`;
  const cards = template === 'gallery' ? ['A study in light', 'Between forms', 'Infinite directions'].map((t,i)=>`<article class="work"><div class="gallery-tile ${['','b','c'][i]}" role="img" aria-label="Abstract artwork ${i+1}"></div><span class="number">00${i+1}</span><h3>${t}</h3><p>Shape, texture, and a different way of seeing.</p></article>`).join('\n') : '<article class="work"><span class="number">01 / CREATE</span><h3>A work in progress</h3><p>Ideas take shape through small experiments. This is where the next one begins.</p></article><article class="work"><span class="number">02 / COLLECT</span><h3>Things worth keeping</h3><p>A collection of details, discoveries, and things that make me look twice.</p></article><article class="work"><span class="number">03 / EXPLORE</span><h3>Follow your curiosity</h3><p>There is always another possibility, waiting just around the corner.</p></article>';
  return withLibraryNotices(`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title ${field('name')}>${escapeHtml(settings.name)}</title>\n<style data-btcsite-theme>:root{--accent:${settings.accent}}</style>\n<style>${baseStyle}${experience?experienceStyle+libraryExperienceStyle:''}</style>\n</head>\n<body>\n<nav aria-label="Main"><a class="brand" href="#home" ${field('name')}>${escapeHtml(settings.name)}</a><div class="links"><a href="#work">Work</a><a href="#about">About</a></div></nav>\n<main id="home"><section class="hero"><div><p class="eyebrow" ${field('eyebrow')}>${escapeHtml(settings.eyebrow)}</p><h1 ${field('headline')}>${escapeHtml(settings.headline)}</h1><p class="intro" ${field('description')}>${escapeHtml(settings.description)}</p><a class="cta" href="#work">Explore the work <span aria-hidden="true">↗</span></a></div><div class="hero-visual"${mediaKind?` data-btcsite-media="${mediaKind}"`:""}>${visual}</div></section>\n<section class="section" id="work"><p class="eyebrow">SELECTED POSSIBILITIES</p><h2>A few things I’m exploring.</h2><div class="cards">${cards}</div></section>\n<section class="section" id="about"><p class="eyebrow">A LITTLE ABOUT THIS SPACE</p><h2>Made with intention. Built to last.</h2><p class="intro">An independent website, composed of simple ideas and shared building blocks. Welcome to my corner of Bitcoin.</p></section></main>\n<footer><span ${field('name')}>${escapeHtml(settings.name)}</span><span>Built for Bitcoin · Open by design</span></footer>\n${scripts}\n</body>\n</html>\n`,templates.find(t=>t.id===template)!.libraries);
}

function mediaMarkup(settings:Pick<SiteSettings,'heroImage'|'imageAlt'>,kind:string){
  if(settings.heroImage)return `<img class="hero-image" src="${escapeHtml(settings.heroImage)}" alt="${escapeHtml(settings.imageAlt??'')}" width="640" height="640">`;
  return kind==='empty'?'':'<div class="art" role="img" aria-label="An abstract green sphere with concentric textures"></div><div class="caption"><span>EXPERIMENT NO. 001</span><span>ALWAYS EVOLVING ↗</span></div>';
}
/** Recover only explicitly managed values when importing an ordinary source folder. */
export function readTemplateSettings(html:string,fallback:SiteSettings):SiteSettings{
  const values:Record<string,string>={},document=parse(html);
  const text=(node:any):string=>node.nodeName==='#text'?node.value:(node.childNodes??[]).map(text).join('');
  function walk(node:any){
    const attrs: {name:string;value:string}[]=node.attrs??[],key=attrs.find(a=>a.name==='data-btcsite-field')?.value;
    if(key&&['name','eyebrow','headline','description'].includes(key)&&!Object.hasOwn(values,key))values[key]=text(node);
    if(attrs.some(a=>a.name==='data-btcsite-theme')){const accent=text(node).match(/--accent\s*:\s*(#[a-fA-F0-9]{6})\b/);if(accent)values.accent=accent[1];}
    if(attrs.some(a=>a.name==='data-btcsite-media')){
      const img=node.childNodes?.find((child:any)=>child.tagName==='img'),imageAttrs=img?.attrs??[];
      if(img){values.heroImage=imageAttrs.find((a:any)=>a.name==='src')?.value??'';values.imageAlt=imageAttrs.find((a:any)=>a.name==='alt')?.value??'';}
    }
    for(const child of node.childNodes??[])walk(child);
  }
  walk(document);const settings={...fallback};
  for(const [key,value] of Object.entries(values)){const next={...settings,[key]:value};if(settingsSchema.safeParse(next).success)Object.assign(settings,next);}
  return settings;
}
export function updateTemplateFields(html: string, changes: Partial<SiteSettings>,current:Partial<SiteSettings>={}): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const replacements: { start: number; end: number; value: string }[] = [];
  const found = new Set<string>();
  function walk(node: any) {
    const attrs: {name:string;value:string}[] = node.attrs ?? [];
    const key = attrs.find(a => a.name === 'data-btcsite-field')?.value as keyof SiteSettings | undefined;
    const location = node.sourceCodeLocation;
    if (key && Object.hasOwn(changes, key) && location?.startTag && location?.endTag) {
      replacements.push({ start: location.startTag.endOffset, end: location.endTag.startOffset, value: escapeHtml(changes[key]!) }); found.add(key);
    }
    if (attrs.some(a=>a.name==='data-btcsite-theme') && changes.accent && location?.startTag && location?.endTag) {
      replacements.push({ start: location.startTag.endOffset, end: location.endTag.startOffset, value: `:root{--accent:${changes.accent}}` }); found.add('accent');
    }
    const media=attrs.find(a=>a.name==='data-btcsite-media')?.value;
    if(media&&['art','empty'].includes(media)&&(Object.hasOwn(changes,'heroImage')||Object.hasOwn(changes,'imageAlt'))&&location?.startTag&&location?.endTag){
      replacements.push({start:location.startTag.endOffset,end:location.endTag.startOffset,value:mediaMarkup({...current,...changes},media)});
      for(const key of ['heroImage','imageAlt'])if(Object.hasOwn(changes,key))found.add(key);
      return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(document);
  for (const key of Object.keys(changes)) if (!found.has(key)) throw new AppError('VISUAL_FIELD_MISSING', `The ${key} control was removed from the source. Edit this field in Code or restore its data-btcsite-field marker.`);
  for (const r of replacements.sort((a,b)=>b.start-a.start)) html=html.slice(0,r.start)+r.value+html.slice(r.end);
  return html;
}
