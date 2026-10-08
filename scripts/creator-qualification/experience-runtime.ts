import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {ElectronApplication} from '@playwright/test';
import type {TemplateId} from '../../src/creator/source/shared/types';

export type RuntimeTarget={contentsId:number;framePath:string};
export async function evaluateSite(application:ElectronApplication,target:RuntimeTarget,source:string):Promise<any>{
  return application.evaluate(async({webContents},{target,source})=>{
    const contents=webContents.fromId(target.contentsId),frame=contents?.mainFrame.framesInSubtree.find(f=>new URL(f.url||'about:blank').pathname===target.framePath);
    if(!frame)throw new Error('The requested website frame is unavailable.');return frame.executeJavaScript(source);
  },{target,source});
}
export async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,message:string,ms=20_000):Promise<T>{
  const deadline=Date.now()+ms;let result:T;
  do{result=await read();if(accept(result))return result;await new Promise(resolve=>setTimeout(resolve,80))}while(Date.now()<deadline);
  throw new Error(message+': '+JSON.stringify(result));
}
/** Uses native trusted input; executeJavaScript's userGesture escape hatch is not used. */
export async function clickSite(application:ElectronApplication,target:RuntimeTarget,selector:string,point?:{x:number;y:number}){
  const rect=await evaluateSite(application,target,`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw new Error('Missing interaction target');element.scrollIntoView({block:'center',behavior:'instant'});const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const offset=await application.evaluate(async({webContents},target)=>{
    const contents=webContents.fromId(target.contentsId)!;
    if(new URL(contents.mainFrame.url).pathname===target.framePath)return {x:0,y:0};
    return contents.executeJavaScript(`(()=>{const iframe=document.querySelector('iframe');iframe.scrollIntoView({block:'center',behavior:'instant'});const r=iframe.getBoundingClientRect();return {x:r.x+iframe.clientLeft,y:r.y+iframe.clientTop}})()`);
  },target);
  // Allow the scroll and resized native surface to reach the compositor before input.
  await new Promise(resolve=>setTimeout(resolve,70));
  if(process.env.DEBUG_RECIPE_INPUT)console.log('Input target',selector,rect,offset,await evaluateSite(application,target,"({width:innerWidth,height:innerHeight,scrollY,ratio:devicePixelRatio})"));
  if(process.env.DEBUG_RECIPE_INPUT)await evaluateSite(application,target,"window.recipeInput=[];addEventListener('pointerdown',e=>recipeInput.push({x:e.clientX,y:e.clientY,target:e.target.id,text:e.target.textContent?.slice(0,40),trusted:e.isTrusted}),{once:true})");
  await application.evaluate(async({webContents,BrowserWindow,app},{id,x,y})=>{
    const contents=webContents.fromId(id)!;app.focus({steal:true});BrowserWindow.getAllWindows()[0]?.focus();contents.focus();
    if(!contents.debugger.isAttached())contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y});
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y});
  },{id:target.contentsId,x:Math.round(offset.x+rect.x+rect.width*(point?.x??.5)),y:Math.round(offset.y+rect.y+rect.height*(point?.y??.5))});
  if(process.env.DEBUG_RECIPE_INPUT){await new Promise(resolve=>setTimeout(resolve,100));console.log('Actual input',await evaluateSite(application,target,'window.recipeInput'));}
}
async function canvasHash(application:ElectronApplication,target:RuntimeTarget){
  const url=await evaluateSite(application,target,`(()=>{const c=document.querySelector('canvas');return c&&c.toDataURL()})()`);return url?createHash('sha256').update(url).digest('hex'):null;
}
export async function qualifyExperience(application:ElectronApplication,target:RuntimeTarget,template:TemplateId){
  await until(()=>evaluateSite(application,target,"document.readyState"),value=>value==='complete','Website did not finish loading');
  const isolation=await evaluateSite(application,target,"({node:typeof process,bridge:typeof window.builder,path:location.pathname,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches})");
  assert.equal(isolation.node,'undefined');assert.equal(isolation.bridge,'undefined');
  const evidence:any={template,isolation};
  if(['sketch','sketch2','webgl','physics','motion'].includes(template)){
    await application.evaluate(async({webContents},target)=>{
      const contents=webContents.fromId(target.contentsId)!;if(!contents.debugger.isAttached())contents.debugger.attach('1.3');
      const targets=await contents.debugger.sendCommand('Target.getTargets');
      const frame=targets.targetInfos.find((info:any)=>info.type==='iframe'&&new URL(info.url||'about:blank').pathname===target.framePath);
      const sessionId=frame?(await contents.debugger.sendCommand('Target.attachToTarget',{targetId:frame.targetId,flatten:true})).sessionId:undefined;
      await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
    },target);
    await until(()=>evaluateSite(application,target,"({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,label:document.getElementById('motion')?.textContent})"),v=>v.reduced&&v.label==='Play motion','The recipe did not respect reduced motion');
    evidence.reducedMotion=true;isolation.reducedMotion=true;
  }
  if(template==='three'){
    evidence.graphics=await until(()=>evaluateSite(application,target,"new Promise(resolve=>requestAnimationFrame(()=>{const c=document.querySelector('#scene canvas'),g=c&&c.getContext('webgl2');if(!g||g.isContextLost())return resolve(null);const width=g.drawingBufferWidth,height=g.drawingBufferHeight;if(width*height>4000000)throw new Error('Pixel limit');const data=new Uint8Array(width*height*4);g.readPixels(0,0,width,height,g.RGBA,g.UNSIGNED_BYTE,data);let colored=0;for(let i=0;i<data.length;i+=4)if(data[i+3]&&data[i]>60&&data[i]>data[i+2]*1.4)colored++;resolve({width,height,colored,version:g.getParameter(g.VERSION)})}))"),v=>v?.colored>100,'The Three.js sculpture did not render colored WebGL2 pixels');
  }else if(template==='sketch'||template==='sketch2'){
    await until(()=>evaluateSite(application,target,"({version:p5.VERSION,canvas:!!document.querySelector('#sketch canvas'),seed:document.getElementById('seed-label').textContent})"),value=>value.canvas&&value.seed==='21','The p5 drawing did not initialize');
    evidence.version=await evaluateSite(application,target,'p5.VERSION');assert.equal(evidence.version,template==='sketch'?'1.11.2':'2.0.1');
    evidence.initialPause=await evaluateSite(application,target,"document.getElementById('motion').textContent");if(isolation.reducedMotion)assert.equal(evidence.initialPause,'Play motion');else await clickSite(application,target,'#motion');
    // A meaningful pixel check distinguishes a rendered drawing from an empty canvas.
    evidence.pixels=await evaluateSite(application,target,"(()=>{const c=document.querySelector('canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let colored=0;for(let i=0;i<p.length;i+=4)if(p[i]>80&&p[i]>p[i+2]*1.4)colored++;return {width:c.width,height:c.height,colored}})()");assert.ok(evidence.pixels.colored>100);
    const first=await canvasHash(application,target);await clickSite(application,target,'#variation');await until(()=>evaluateSite(application,target,"document.getElementById('seed-label').textContent"),v=>v==='22','The variation control did not work');
    const second=await until(()=>canvasHash(application,target),value=>!!value&&value!==first,'The p5 variation did not change the drawing');evidence.variationHashes=[first,second];
    await clickSite(application,target,'#motion');await until(()=>canvasHash(application,target),value=>!!value&&value!==second,'The p5 play control did not animate');evidence.playControl=true;await clickSite(application,target,'#motion');
  }else if(template==='game'){
    await until(()=>evaluateSite(application,target,"({canvas:!!document.querySelector('#game canvas'),version:Phaser.VERSION})"),value=>value.canvas,'The game did not start');
    evidence.version=await evaluateSite(application,target,'Phaser.VERSION');assert.equal(evidence.version,'3.80.1');
    assert.equal(await evaluateSite(application,target,"document.getElementById('score').textContent"),'0 / 5 lights');await clickSite(application,target,'#play-game');
    await clickSite(application,target,'[aria-label="Move right"]');await clickSite(application,target,'[aria-label="Move right"]');
    await until(()=>evaluateSite(application,target,"document.getElementById('score').textContent"),v=>v==='1 / 5 lights','The movement buttons did not collect a light');
    evidence.movementButtons=true;
    for(let expected=2;expected<=5;expected++){
      const next=await evaluateSite(application,target,'(()=>{const light=lights.getChildren()[0];return {x:light.x/512,y:light.y/512}})()');
      await clickSite(application,target,'#game canvas',next);
      await until(()=>evaluateSite(application,target,"document.getElementById('score').textContent"),v=>v===expected+' / 5 lights','Pointer control failed to collect light '+expected);
    }
    assert.match(await evaluateSite(application,target,"document.getElementById('experience-status').textContent"),/All five/);evidence.completed=true;
    await clickSite(application,target,'#reset-game');assert.equal(await evaluateSite(application,target,"document.getElementById('score').textContent"),'0 / 5 lights');evidence.reset=true;
    await clickSite(application,target,'#play-game');await clickSite(application,target,'#game canvas',{x:48/512,y:256/512});
    await application.evaluate(async({webContents},id)=>webContents.fromId(id)!.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}),target.contentsId);
    await until(()=>evaluateSite(application,target,'player.x'),v=>v>70,'Arrow key did not move the player');
    await application.evaluate(async({webContents},id)=>webContents.fromId(id)!.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}),target.contentsId);evidence.keyboard=true;await clickSite(application,target,'#play-game');
  }else if(template==='audio'){
    const initial=await evaluateSite(application,target,"({disabled:[...document.querySelectorAll('[data-note]')].every(b=>b.disabled),version:Tone.version,context:Tone.getContext().state})");assert.equal(initial.disabled,true);assert.notEqual(initial.context,'running');evidence.initial=initial;assert.equal(initial.version,'15.0.4');
    await clickSite(application,target,'#sound-toggle');
    await until(()=>evaluateSite(application,target,"({label:document.getElementById('sound-toggle').textContent,state:Tone.getContext().state,activated:navigator.userActivation.hasBeenActive})"),v=>v.label==='Stop sound'&&v.state==='running'&&v.activated,'A real click did not activate audio');
    await clickSite(application,target,'[data-note="C4"]');
    evidence.waveform=await until(()=>evaluateSite(application,target,"(()=>{const samples=Array.from(analyser.getValue());return {peak:Math.max(...samples.map(Math.abs)),rms:Math.sqrt(samples.reduce((s,x)=>s+x*x,0)/samples.length),state:Tone.getContext().state}})()"),v=>v.peak>.001,'The synthesizer did not produce audio samples');
    evidence.trustedGesture=true;await clickSite(application,target,'#sound-toggle');evidence.stopped=await until(()=>evaluateSite(application,target,"({context:Tone.getContext().state,label:document.getElementById('sound-toggle').textContent,padsDisabled:[...document.querySelectorAll('[data-note]')].every(pad=>pad.disabled)})"),v=>v.context==='suspended'&&v.label==='Enable sound'&&v.padsDisabled,'Stop sound did not suspend audio and disable its controls');
  }else if(template==='webgl'){
    evidence.graphics=await until(()=>evaluateSite(application,target,"(()=>{const c=document.querySelector('#webgl canvas'),g=c&&(c.getContext('webgl2')||c.getContext('webgl'));return g&&!g.isContextLost()?{version:g.getParameter(g.VERSION),width:g.drawingBufferWidth,height:g.drawingBufferHeight,fallback:!document.getElementById('graphics-fallback').hidden}:null})()"),v=>v?.width>0&&!v.fallback,'Native WebGL did not render');
    if(!isolation.reducedMotion)await clickSite(application,target,'#motion');
    const first=await canvasHash(application,target);await clickSite(application,target,'#variation');const second=await until(()=>canvasHash(application,target),v=>!!v&&v!==first,'Native WebGL variation did not render');evidence.variationHashes=[first,second];
    await evaluateSite(application,target,"window.recipeLostContext=gl.getExtension('WEBGL_lose_context');recipeLostContext.loseContext()");await until(()=>evaluateSite(application,target,"document.getElementById('graphics-fallback').hidden"),v=>v===false,'No fallback after graphics context loss');
    await new Promise(resolve=>setTimeout(resolve,250));await evaluateSite(application,target,"recipeLostContext.restoreContext()");await until(()=>evaluateSite(application,target,"document.getElementById('graphics-fallback').hidden"),v=>v===true,'Graphics did not recover');evidence.contextLossAndRestore=true;
  }else if(template==='physics'){
    evidence.version=await evaluateSite(application,target,'Matter.version');assert.equal(evidence.version,'0.19.0');
    await until(()=>evaluateSite(application,target,"({canvas:!!document.querySelector('#physics canvas'),bodies:engine.world.bodies.length,count})"),v=>v.canvas&&v.count===6&&v.bodies===9,'Physics world did not initialize');
    await clickSite(application,target,'#drop-shape');await until(()=>evaluateSite(application,target,'count'),v=>v===7,'Drop shape did not add a body');
    const initial=await evaluateSite(application,target,'engine.world.bodies.find(b=>!b.isStatic).position.y');
    await clickSite(application,target,'#motion');await until(()=>evaluateSite(application,target,'engine.world.bodies.find(b=>!b.isStatic).position.y'),v=>v>initial+20,'Gravity did not move the body');
    await clickSite(application,target,'#motion');const before=await canvasHash(application,target);await new Promise(resolve=>setTimeout(resolve,200));assert.equal(await canvasHash(application,target),before);
    await clickSite(application,target,'#reset-shapes');assert.equal(await evaluateSite(application,target,'count'),6);evidence.drop=true;evidence.gravity=true;evidence.pause=true;evidence.reset=true;
  }else if(template==='motion'){
    evidence.version=await evaluateSite(application,target,'anime.version');assert.equal(evidence.version,'3.2.1');
    assert.equal(await evaluateSite(application,target,"document.querySelectorAll('.motion-mark').length"),12);
    const initial=await evaluateSite(application,target,"getComputedStyle(document.querySelector('.motion-mark')).transform");
    await clickSite(application,target,'#rearrange');await until(()=>evaluateSite(application,target,'composition'),v=>v===2,'Rearrange did not change composition');
    const second=await evaluateSite(application,target,"getComputedStyle(document.querySelector('.motion-mark')).transform");assert.notEqual(second,initial);
    await clickSite(application,target,'#motion');await until(()=>evaluateSite(application,target,"getComputedStyle(document.querySelector('.motion-mark')).transform"),v=>v!==second,'The animation did not play');await clickSite(application,target,'#motion');
    const stopped=await evaluateSite(application,target,'animation.currentTime');await new Promise(resolve=>setTimeout(resolve,200));assert.equal(await evaluateSite(application,target,'animation.currentTime'),stopped);evidence.rearrange=true;evidence.play=true;evidence.pause=true;
  }else if(template==='chart'){
    evidence.version=await evaluateSite(application,target,'d3.version');assert.equal(evidence.version,'7.8.5');
    assert.equal(await evaluateSite(application,target,"document.querySelectorAll('#chart rect').length"),5);
    const first=await evaluateSite(application,target,"document.getElementById('chart-values').textContent");
    await clickSite(application,target,'#new-data');const second=await evaluateSite(application,target,"document.getElementById('chart-values').textContent");assert.notEqual(second,first);
    assert.equal(await evaluateSite(application,target,"document.querySelectorAll('#chart rect').length"),5);
    await clickSite(application,target,'#reset-data');assert.equal(await evaluateSite(application,target,"document.getElementById('chart-values').textContent"),first);evidence.values=[first,second];evidence.reset=true;evidence.accessibleValues=true;
  }else throw new Error('No runtime recipe for '+template);
  await evaluateSite(application,target,"new Promise(resolve=>{scrollTo({top:0,behavior:'instant'});requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null)))})");
  return evidence;
}
