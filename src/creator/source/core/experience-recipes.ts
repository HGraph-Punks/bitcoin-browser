import {libraryByKey} from '../catalog/libraries';
import type {TemplateId} from '../shared/types';
import {libraryExperience} from './library-experiences';

// These are ordinary, editable website scripts. No editor bridge or instrumentation is published.
const include=(key:string)=>`<script src="/content/${libraryByKey(key)!.id}"></script>`;
const script=(source:string)=>`<script>\n${source.trim()}\n</script>`;
const motionButton='<button id="motion" type="button" aria-pressed="false">Pause motion</button>';
export const experienceStyle=`.experience{min-width:0}.experience-stage{aspect-ratio:1;position:relative;overflow:hidden;border-radius:18px;background:#191e18}.experience-stage canvas{width:100%;height:100%;display:block}.experience-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px}.experience-controls:first-child{margin:0 0 16px}.experience button{font:inherit;font-size:12px;color:#f3f2e9;border:1px solid #66745b;background:#222a1e;border-radius:20px;padding:11px 15px;cursor:pointer;min-height:44px}.experience button:disabled{opacity:.5;cursor:default}.experience button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}.experience-status{font-size:12px;line-height:1.6;color:#b2b9ae;margin:12px 0}.experience-fallback{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:30px;background:radial-gradient(circle at 35% 30%,#537748,#182216 65%);font-size:14px;line-height:1.6}.experience-fallback[hidden]{display:none}.experience-score{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--accent);font-size:13px}.direction-controls{display:flex;gap:6px}.direction-controls button{padding:8px;min-width:44px}.sound-pad-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:24px;aspect-ratio:1}.sound-pad-grid button{border-radius:14px;font-size:24px;min-width:0;background:linear-gradient(140deg,#34492b,#1d2819);transition:background .12s}.sound-pad-grid button[aria-pressed=true]{background:#624220}.sound-pad-grid button small{display:block;font-size:10px;margin-top:8px;letter-spacing:.1em}.sound-meter{display:flex;gap:4px;height:28px;align-items:center;padding:0 24px 8px}.sound-meter i{background:var(--accent);height:3px;flex:1;border-radius:2px}.sound-volume{display:flex;gap:12px;align-items:center;font-size:12px;color:#b2b9ae}.sound-volume input{width:100px;accent-color:var(--accent)}@media(prefers-reduced-motion:reduce){.sound-pad-grid button{transition:none}}`;

export function experienceRecipe(template:TemplateId):{visual:string;scripts:string}|undefined{
  const libraryRecipe=libraryExperience(template);if(libraryRecipe)return libraryRecipe;
  if(template==='sketch'||template==='sketch2'){
    const modern=template==='sketch2';
    return {visual:`<div class="experience"><div id="sketch" class="experience-stage" role="img" aria-label="${modern?'Seeded orbit drawing':'Flowing line drawing'}"></div><div class="experience-controls">${motionButton}<button id="variation" type="button">New variation</button></div><p id="experience-status" class="experience-status" role="status">${modern?'Orbit study':'Line study'} · Seed <span id="seed-label">21</span></p></div>`,scripts:include(modern?'p5-2.0.1':'p5-1.11.2')+script(`
const host=document.getElementById('sketch'),motion=document.getElementById('motion');
const preference=matchMedia('(prefers-reduced-motion: reduce)');
let seed=21,paused=preference.matches,phase=0;
function sync(){motion.textContent=paused?'Play motion':'Pause motion';motion.setAttribute('aria-pressed',String(paused))}
try{
  const sketch=new p5(p=>{
    let color,ready=false;
    p.setup=()=>{p.createCanvas(Math.max(1,host.clientWidth),Math.max(1,host.clientWidth));p.pixelDensity(Math.min(devicePixelRatio,2));color=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();p.noFill();p.frameRate(30);if(paused)p.noLoop();sync();ready=true};
    p.draw=()=>{p.background('#111310');p.stroke(color);p.strokeWeight(1);p.randomSeed(seed);${modern?`
      for(let ring=0;ring<12;ring++){const radius=p.width*(.12+ring*.025);const count=12+ring*3;for(let n=0;n<count;n++){const angle=n/count*Math.PI*2+phase*(ring%2?1:-1)+p.random(-.035,.035);p.circle(p.width/2+Math.cos(angle)*radius,p.height/2+Math.sin(angle)*radius,2+ring*.35)}}`:`
      for(let n=0;n<34;n++){const offset=p.random(-.08,.08);p.beginShape();for(let x=0;x<=p.width;x+=5){const y=p.height/2+Math.sin(x/p.width*4+n*.16+phase+offset)*p.height*(.1+n*.009);p.vertex(x,y)}p.endShape()}`}
      if(!paused)phase+=.008;
    };
    new ResizeObserver(()=>{if(ready){const size=Math.max(1,host.clientWidth);if(size!==p.width||size!==p.height)p.resizeCanvas(size,size)}}).observe(host);
  },host);
  motion.addEventListener('click',()=>{paused=!paused;sync();if(paused)sketch.noLoop();else sketch.loop()});
  document.getElementById('variation').addEventListener('click',()=>{seed=(seed+1)>>>0;phase=0;document.getElementById('seed-label').textContent=String(seed);sketch.redraw()});
  preference.addEventListener('change',e=>{if(e.matches){paused=true;sync();sketch.noLoop()}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)sketch.noLoop();else if(!paused)sketch.loop()});
  addEventListener('pagehide',()=>sketch.remove(),{once:true});
}catch(error){host.textContent='The drawing could not start. Reload this page to try again.';motion.disabled=true;document.getElementById('variation').disabled=true;console.error(error)}
`) };
  }
  if(template==='game')return {visual:`<div class="experience"><div class="experience-controls"><button id="play-game" type="button">Start game</button><button id="reset-game" type="button">Reset</button><span id="score" class="experience-score" role="status">0 / 5 lights</span></div><div id="game" class="experience-stage" aria-label="Collect the light game"></div><div class="experience-controls direction-controls" aria-label="Movement"><button type="button" data-dx="-32" data-dy="0" aria-label="Move left">←</button><button type="button" data-dx="0" data-dy="-32" aria-label="Move up">↑</button><button type="button" data-dx="0" data-dy="32" aria-label="Move down">↓</button><button type="button" data-dx="32" data-dy="0" aria-label="Move right">→</button></div><p id="experience-status" class="experience-status" role="status">Collect all five lights. Tap a spot to move, or focus the game and use the arrow keys.</p></div>`,scripts:include('phaser-3.80.1')+script(`
const host=document.getElementById('game'),play=document.getElementById('play-game'),status=document.getElementById('experience-status'),score=document.getElementById('score');
let scene,player,lights,running=false,collected=0,target=null;
const held=new Set(),positions=[[96,256],[208,112],[384,144],[416,384],[192,416]];
function sync(){play.textContent=running?'Pause game':collected===5?'Play again':'Start game';score.textContent=collected+' / 5 lights'}
function reset(){held.clear();target=null;collected=0;player.body.reset(48,256);lights.clear(true,true);positions.forEach(([x,y])=>lights.create(x,y,'light'));status.textContent='Collect all five lights. Tap a spot or use the arrow keys.';sync()}
try{
  const game=new Phaser.Game({type:Phaser.CANVAS,parent:host,width:512,height:512,backgroundColor:'#191e18',audio:{noAudio:true},banner:false,scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},physics:{default:'arcade',arcade:{debug:false}},fps:{target:30},scene:{
    create(){scene=this;const graphic=this.make.graphics({x:0,y:0});graphic.fillStyle(0xf7931a);graphic.fillCircle(12,12,11);graphic.generateTexture('player',24,24);graphic.clear();graphic.fillStyle(0xe4edcf);graphic.fillCircle(7,7,6);graphic.generateTexture('light',14,14);graphic.destroy();
      const grid=this.add.graphics();grid.lineStyle(1,0x34442e,.6);for(let n=32;n<512;n+=32){grid.lineBetween(n,0,n,512);grid.lineBetween(0,n,512,n)}
      player=this.physics.add.image(48,256,'player').setCircle(11,1,1).setCollideWorldBounds(true);lights=this.physics.add.staticGroup();reset();
      this.physics.add.overlap(player,lights,(_player,light)=>{if(!running)return;light.destroy();collected++;sync();if(collected===5){running=false;player.setVelocity(0);target=null;status.textContent='All five lights collected. Play again whenever you like.';sync()}});
      this.input.on('pointerdown',pointer=>{if(running)target={x:pointer.x,y:pointer.y};game.canvas.focus()});
      game.canvas.tabIndex=0;game.canvas.setAttribute('role','img');game.canvas.setAttribute('aria-label','Game board. Use arrow keys to collect five lights.');
      game.canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();held.add(e.key);target=null}});
      game.canvas.addEventListener('keyup',e=>held.delete(e.key));game.canvas.addEventListener('blur',()=>held.clear());
    },
    update(){if(!player)return;if(!running){player.setVelocity(0);return}let x=Number(held.has('ArrowRight'))-Number(held.has('ArrowLeft')),y=Number(held.has('ArrowDown'))-Number(held.has('ArrowUp'));if(target){const dx=target.x-player.x,dy=target.y-player.y,distance=Math.hypot(dx,dy);if(distance<5){player.body.reset(target.x,target.y);target=null}else{x=dx/distance;y=dy/distance}}const length=Math.hypot(x,y)||1;player.setVelocity(x/length*180,y/length*180)}
  }});
  play.addEventListener('click',()=>{if(!player)return;if(collected===5)reset();running=!running;sync()});
  document.getElementById('reset-game').addEventListener('click',()=>{if(player){running=false;reset()}});
  document.querySelectorAll('[data-dx]').forEach(button=>button.addEventListener('click',()=>{if(!running||!player)return;target=null;player.body.reset(Math.max(12,Math.min(500,player.x+Number(button.dataset.dx))),Math.max(12,Math.min(500,player.y+Number(button.dataset.dy))))}));
  document.addEventListener('visibilitychange',()=>{if(document.hidden){running=false;held.clear();sync()}});
  const observer=new ResizeObserver(()=>{if(scene&&game.canvas)game.scale.refresh()});observer.observe(host);
  addEventListener('pagehide',()=>{observer.disconnect();game.destroy(true)},{once:true});
}catch(error){host.textContent='The game could not start. Reload this page to try again.';play.disabled=true;status.textContent='Your browser could not start the game.';console.error(error)}
`) };
  if(template==='audio')return {visual:`<div class="experience"><div class="experience-controls"><button id="sound-toggle" type="button" aria-pressed="false">Enable sound</button><label class="sound-volume">Volume <input id="volume" type="range" min="-36" max="-6" value="-18" aria-label="Sound volume"></label></div><div class="experience-stage" style="aspect-ratio:auto"><div class="sound-pad-grid" aria-label="Musical notes">${[['C4','C'],['D4','D'],['E4','E'],['G4','G']].map(([note,name])=>`<button type="button" data-note="${note}" aria-label="Play ${note}" aria-pressed="false" disabled>${name}<small>${note}</small></button>`).join('')}</div><div class="sound-meter" aria-hidden="true">${'<i></i>'.repeat(16)}</div></div><p id="experience-status" class="experience-status" role="status">Sound is off. Enable it, then play a note. Every sound is synthesized here.</p></div>`,scripts:include('tone-15.0.4')+script(`
const toggle=document.getElementById('sound-toggle'),status=document.getElementById('experience-status'),pads=[...document.querySelectorAll('[data-note]')],bars=[...document.querySelectorAll('.sound-meter i')];
let synth,volume,analyser,enabled=false,starting=false,frame=0;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
function sync(){toggle.textContent=enabled?'Stop sound':'Enable sound';toggle.setAttribute('aria-pressed',String(enabled));pads.forEach(pad=>pad.disabled=!enabled)}
function meter(){if(!enabled||document.hidden)return;const values=analyser.getValue();if(!reduced.matches)bars.forEach((bar,i)=>{const value=Math.abs(values[Math.floor(i*values.length/bars.length)]);bar.style.height=(3+Math.min(1,value*8)*22)+'px'});frame=requestAnimationFrame(meter)}
async function stop(){enabled=false;cancelAnimationFrame(frame);synth?.releaseAll();pads.forEach(pad=>pad.setAttribute('aria-pressed','false'));bars.forEach(bar=>bar.style.height='3px');sync();status.textContent='Sound is off. Enable it whenever you are ready.';if(synth)await Tone.getContext().rawContext.suspend()}
toggle.addEventListener('click',async()=>{
  if(starting)return;if(enabled){await stop();return}starting=true;toggle.disabled=true;
  try{await Tone.start();if(!synth){volume=new Tone.Volume(Number(document.getElementById('volume').value)).toDestination();analyser=new Tone.Analyser('waveform',512);volume.connect(analyser);synth=new Tone.PolySynth(Tone.Synth,{oscillator:{type:'sine'},envelope:{attack:.02,decay:.2,sustain:.2,release:.6}}).connect(volume)}enabled=true;sync();status.textContent='Ready. Play a note with your pointer, Enter, or Space.';meter()}
  catch(error){enabled=false;sync();status.textContent='Sound could not start. Try Enable sound again.';console.error(error)}
  finally{starting=false;toggle.disabled=false}
});
pads.forEach(pad=>pad.addEventListener('click',()=>{if(!enabled)return;synth.triggerAttackRelease(pad.dataset.note,'4n',Tone.now());pad.setAttribute('aria-pressed','true');setTimeout(()=>pad.setAttribute('aria-pressed','false'),350)}));
document.getElementById('volume').addEventListener('input',e=>{if(volume)volume.volume.rampTo(Number(e.target.value),.05)});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&enabled)void stop()});
addEventListener('pagehide',()=>{cancelAnimationFrame(frame);synth?.dispose();volume?.dispose();analyser?.dispose()},{once:true});
`) };
  if(template==='webgl')return {visual:`<div class="experience"><div id="webgl" class="experience-stage"><canvas aria-label="A procedural field of glowing rings"></canvas><div id="graphics-fallback" class="experience-fallback" hidden>Graphics are resting.<br>A still composition is here while WebGL is unavailable.</div></div><div class="experience-controls">${motionButton}<button id="variation" type="button">New variation</button></div><p id="experience-status" class="experience-status" role="status">Light, color, and a few lines of code.</p></div>`,scripts:script(`
const host=document.getElementById('webgl'),canvas=host.querySelector('canvas'),fallback=document.getElementById('graphics-fallback'),motion=document.getElementById('motion'),variation=document.getElementById('variation'),status=document.getElementById('experience-status');
const preference=matchMedia('(prefers-reduced-motion: reduce)');
let gl,program,buffer,frame=0,time=0,seed=1,paused=preference.matches,previous=0,lost=false;
function sync(){motion.textContent=paused?'Play motion':'Pause motion';motion.setAttribute('aria-pressed',String(paused))}
function unavailable(){cancelAnimationFrame(frame);fallback.hidden=false;motion.disabled=true;variation.disabled=true;status.textContent='Showing a still composition. Live graphics will return if the context recovers.'}
function initialize(){
  try{gl=canvas.getContext('webgl2')||canvas.getContext('webgl');if(!gl)return unavailable();
    function shader(type,source){const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value));return value}
    const vertex=shader(gl.VERTEX_SHADER,'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}');
    const fragment=shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform vec2 resolution;uniform float time;uniform float seed;uniform vec3 accent;void main(){vec2 p=(gl_FragCoord.xy-.5*resolution)/min(resolution.x,resolution.y);float radius=length(p);float rings=.5+.5*cos(radius*45.-time+seed);float glow=pow(rings,5.)*(1.-smoothstep(.1,.7,radius));vec3 color=mix(vec3(.06,.08,.055),accent,glow);gl_FragColor=vec4(color,1.);}');
    program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
    buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    fallback.hidden=true;motion.disabled=false;variation.disabled=false;lost=false;previous=0;sync();status.textContent='Light, color, and a few lines of code.';draw(performance.now());
  }catch(error){unavailable();console.error(error)}
}
function draw(now){cancelAnimationFrame(frame);if(!gl||lost)return;const ratio=Math.min(devicePixelRatio,2),size=Math.max(1,Math.floor(host.clientWidth*ratio));if(canvas.width!==size||canvas.height!==size){canvas.width=size;canvas.height=size}gl.viewport(0,0,size,size);if(previous&&!paused)time+=Math.min(50,now-previous)*.001;previous=now;gl.uniform2f(gl.getUniformLocation(program,'resolution'),size,size);gl.uniform1f(gl.getUniformLocation(program,'time'),time);gl.uniform1f(gl.getUniformLocation(program,'seed'),seed);const color=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();gl.uniform3f(gl.getUniformLocation(program,'accent'),parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255);gl.drawArrays(gl.TRIANGLES,0,3);if(!paused&&!document.hidden)frame=requestAnimationFrame(draw)}
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;unavailable()});canvas.addEventListener('webglcontextrestored',initialize);
motion.addEventListener('click',()=>{paused=!paused;previous=0;sync();draw(performance.now())});variation.addEventListener('click',()=>{seed++;draw(performance.now())});
new ResizeObserver(()=>{if(gl&&!lost)draw(performance.now())}).observe(host);
preference.addEventListener('change',e=>{if(e.matches){paused=true;sync();draw(performance.now())}});
document.addEventListener('visibilitychange',()=>{previous=0;if(document.hidden)cancelAnimationFrame(frame);else if(gl&&!lost)draw(performance.now())});
addEventListener('pagehide',()=>{cancelAnimationFrame(frame);if(gl){gl.deleteBuffer(buffer);gl.deleteProgram(program)}},{once:true});initialize();
`) };
}
