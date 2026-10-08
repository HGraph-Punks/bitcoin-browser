import {libraryByKey} from '../catalog/libraries';
import type {TemplateId} from '../shared/types';
const include=(key:string)=>`<script src="/content/${libraryByKey(key)!.id}"></script>`;
const script=(text:string)=>`<script>\n${text.trim()}\n</script>`;
const pause='<button id="motion" type="button" aria-pressed="false">Pause motion</button>';
export const libraryExperienceStyle=`.motion-field{position:relative;width:100%;height:100%;display:grid;grid-template-columns:repeat(4,1fr);place-items:center;padding:12%;gap:14px}.motion-mark{width:70%;aspect-ratio:1;border-radius:24%;background:var(--accent);opacity:.85;will-change:transform}.motion-mark:nth-child(3n){border-radius:50%;background:#dce8c9}.motion-mark:nth-child(3n+1){background:#667f52}.chart-stage{padding:22px;aspect-ratio:1}.chart-stage svg{width:100%;height:100%}.chart-values{font-size:12px;color:#b2b9ae;display:flex;flex-wrap:wrap;gap:8px 16px;list-style:none;padding:0}.chart-values strong{color:var(--accent)}@media(prefers-reduced-motion:reduce){.motion-mark{will-change:auto}}`;
export function libraryExperience(template:TemplateId):{visual:string;scripts:string}|undefined{
  if(template==='physics')return {visual:`<div class="experience"><div id="physics" class="experience-stage" role="img" aria-label="Falling shapes physics playground"></div><div class="experience-controls">${pause}<button id="drop-shape" type="button">Drop a shape</button><button id="reset-shapes" type="button">Reset</button></div><p id="experience-status" class="experience-status" role="status">6 shapes · Drop another and watch it settle.</p></div>`,scripts:include('matter-0.19.0')+script(`
const host=document.getElementById('physics'),motion=document.getElementById('motion'),status=document.getElementById('experience-status'),drop=document.getElementById('drop-shape');
const preference=matchMedia('(prefers-reduced-motion: reduce)'),engine=Matter.Engine.create();
const render=Matter.Render.create({element:host,engine,options:{width:480,height:480,wireframes:false,background:'#191e18',pixelRatio:Math.min(devicePixelRatio,2)}});
let paused=preference.matches,count=0,last=0,frame=0;
const colors=['#f7931a','#dce8c9','#667f52'];
function add(){if(count>=60)return;const x=80+(count*67)%320;const body=count%2?Matter.Bodies.rectangle(x,32,32,32,{render:{fillStyle:colors[count%3]}}):Matter.Bodies.circle(x,32,18,{render:{fillStyle:colors[count%3]}});Matter.Composite.add(engine.world,body);count++;drop.disabled=count>=60;status.textContent=count+' shapes · '+(paused?'Motion paused.':'Drop another and watch it settle.');Matter.Render.world(render)}
function sync(){motion.textContent=paused?'Play motion':'Pause motion';motion.setAttribute('aria-pressed',String(paused));status.textContent=count+' shapes · '+(paused?'Motion paused.':'Drop another and watch it settle.')}
function reset(){Matter.Composite.clear(engine.world,false);Matter.Engine.clear(engine);count=0;drop.disabled=false;Matter.Composite.add(engine.world,[Matter.Bodies.rectangle(240,470,480,24,{isStatic:true,render:{fillStyle:'#42583a'}}),Matter.Bodies.rectangle(-12,240,24,480,{isStatic:true}),Matter.Bodies.rectangle(492,240,24,480,{isStatic:true})]);for(let i=0;i<6;i++)add();sync()}
function tick(time){if(!paused&&!document.hidden){Matter.Engine.update(engine,Math.min(1000/30,Math.max(1,time-last||1000/60)));Matter.Render.world(render)}last=time;frame=requestAnimationFrame(tick)}
motion.onclick=()=>{paused=!paused;sync()};drop.onclick=add;document.getElementById('reset-shapes').onclick=reset;
preference.addEventListener('change',e=>{if(e.matches){paused=true;sync()}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){paused=true;sync()}});
reset();frame=requestAnimationFrame(tick);
addEventListener('pagehide',()=>{cancelAnimationFrame(frame);Matter.Render.stop(render);Matter.Composite.clear(engine.world,false);Matter.Engine.clear(engine)},{once:true});
`) };
  if(template==='motion')return {visual:`<div class="experience"><div class="experience-stage"><div class="motion-field" id="motion-field" role="img" aria-label="A choreographed field of twelve shapes">${'<span class="motion-mark"></span>'.repeat(12)}</div></div><div class="experience-controls">${pause}<button id="rearrange" type="button">Rearrange</button></div><p id="experience-status" class="experience-status" role="status">Composition 1 · Gentle motion, at your pace.</p></div>`,scripts:include('anime-3.2.1')+script(`
const motion=document.getElementById('motion'),status=document.getElementById('experience-status'),marks=[...document.querySelectorAll('.motion-mark')],preference=matchMedia('(prefers-reduced-motion: reduce)');
let paused=preference.matches,composition=1,animation;
function sync(){motion.textContent=paused?'Play motion':'Pause motion';motion.setAttribute('aria-pressed',String(paused));status.textContent='Composition '+composition+' · '+(paused?'Motion paused.':'Gentle motion, at your pace.')}
function compose(){animation?.pause();anime.remove(marks);marks.forEach((mark,i)=>{mark.style.transform='rotate('+((i*13+composition*17)%90)+'deg)'});animation=anime({targets:marks,translateY:(_,i)=>[0,(i%2?1:-1)*(8+composition%4*4)],rotate:(_,i)=>[(i*13+composition*17)%90,(i*13+composition*17)%90+45],scale:[.78,1],delay:anime.stagger(65),duration:2200,direction:'alternate',loop:true,easing:'easeInOutSine',autoplay:!paused});sync()}
motion.onclick=()=>{paused=!paused;paused?animation.pause():animation.play();sync()};
document.getElementById('rearrange').onclick=()=>{composition++;compose()};
preference.addEventListener('change',e=>{if(e.matches){paused=true;animation.pause();sync()}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){paused=true;animation.pause();sync()}});
compose();addEventListener('pagehide',()=>{animation.pause();anime.remove(marks)},{once:true});
`) };
  if(template==='chart')return {visual:`<div class="experience"><div id="chart" class="experience-stage chart-stage"></div><div class="experience-controls"><button id="new-data" type="button">New data</button><button id="reset-data" type="button">Reset data</button></div><p id="experience-status" class="experience-status" role="status">Dataset 1 · Five ideas, made visible.</p><ul class="chart-values" id="chart-values" aria-label="Chart values"></ul></div>`,scripts:include('d3-7.8.5')+script(`
const names=['Create','Collect','Explore','Play','Share'];let dataset=1;
const svg=d3.select('#chart').append('svg').attr('viewBox','0 0 420 420').attr('role','img').attr('aria-label','Bar chart of five creative activities');
svg.append('title').text('Five ideas, made visible');
const x=d3.scaleBand().domain(names).range([20,400]).padding(.28),y=d3.scaleLinear().domain([0,100]).range([360,40]);
function draw(){const values=names.map((name,i)=>({name,value:20+(i*19+dataset*13)%76}));
  svg.selectAll('rect').data(values,d=>d.name).join('rect').attr('x',d=>x(d.name)).attr('y',d=>y(d.value)).attr('width',x.bandwidth()).attr('height',d=>360-y(d.value)).attr('rx',8).attr('fill',getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  svg.selectAll('text.value').data(values).join('text').attr('class','value').attr('x',d=>x(d.name)+x.bandwidth()/2).attr('y',d=>y(d.value)-12).attr('text-anchor','middle').attr('fill','#dce8c9').attr('font-size',15).text(d=>d.value);
  svg.selectAll('text.label').data(values).join('text').attr('class','label').attr('x',d=>x(d.name)+x.bandwidth()/2).attr('y',386).attr('text-anchor','middle').attr('fill','#b2b9ae').attr('font-size',12).text(d=>d.name);
  d3.select('#chart-values').selectAll('li').data(values).join('li').text(d=>d.name+': '+d.value);
  document.getElementById('experience-status').textContent='Dataset '+dataset+' · Five ideas, made visible.';
}
document.getElementById('new-data').onclick=()=>{dataset++;draw()};document.getElementById('reset-data').onclick=()=>{dataset=1;draw()};draw();
`) };
}
