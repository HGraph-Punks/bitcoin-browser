import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {StateStore} from '../src/main/state-store.js';
import {launchPackagedRenderer} from './creator-qualification/packaged-driver';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(path.join(root,'src/creator/package.json'));
const {_electron}=require('playwright'),{expect}=require('@playwright/test');
const rootRequire=createRequire(path.join(root,'package.json'));
const packaged=process.argv.includes('--packaged');
const receiptName=process.argv.find(v=>v.startsWith('--receipt-name='))?.slice('--receipt-name='.length);
if(receiptName&&!/^[a-z0-9][a-z0-9.-]{0,95}\.json$/.test(receiptName))throw new Error('Invalid receipt basename');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const executable=packaged?path.join(root,'release',version,'mac-arm64/Bitcoin Browser.app/Contents/MacOS/Bitcoin Browser'):rootRequire('electron');
const run=await fs.mkdtemp('/private/tmp/btc-home-native-');
const checks:string[]=[],screenshots:string[]=[],errors:string[]=[];
let app:any,page:any;
const state=()=>page.locator('.home-intro-scene').evaluate((node:any)=>node.animationState());
async function screenshot(name:string){while(await page.locator('#toasts .toast').count())await page.locator('#toasts .toast').first().click();const file=path.join(run,name+'.png');await page.screenshot({path:file});screenshots.push(file);}
async function home(){await page.locator('[data-command="home"]').click();await expect(page.locator('.home-page')).toBeVisible();await expect(page.locator('#app')).toHaveAttribute('aria-busy','false');}
async function launch(returning=false){
  const profile=path.join(run,returning?'returning-profile':'fresh-profile');
  const logger={info:async()=>{},warn:async()=>{},error:async()=>{}};
  const store=new StateStore(path.join(profile,'state'),logger);await store.init();
  await store.mutate((draft:any)=>{draft.settings.theme='dark';draft.providers=[];if(returning){const timestamp=new Date().toISOString();draft.history=[{id:'home-history-fixture',canonical:'sat:0',title:'The first satoshi',kind:'sat',visitedAt:timestamp}];draft.bookmarks=[{id:'home-bookmark-fixture',canonical:'block:840000',title:'The halving block',kind:'block',createdAt:timestamp}];}});await store.flush();
  app=packaged?await launchPackagedRenderer(executable,profile,root):await _electron.launch({executablePath:executable,args:[root,'--user-data-dir='+profile],cwd:root,timeout:30000});
  page=await app.firstWindow();page.on('pageerror',(error:any)=>errors.push(error.message));await page.emulateMedia({reducedMotion:'no-preference'});await expect(page.locator('#app')).toHaveAttribute('aria-busy','false',{timeout:20000});await expect(page.locator('.home-page')).toBeVisible();await page.setViewportSize({width:1440,height:1000});
}
try{
  await launch();console.log('Native homepage: fresh profile ready.');
  await expect(page.locator('.home-intro-scene')).toHaveAttribute('data-motion-state','ambient',{timeout:15000});
  const initial=await state();assert.equal(initial.renderer,'webgl');assert.ok(initial.particles>500&&initial.particles<=2920);assert.ok(initial.elapsed>=3.32);
  assert.equal(await page.locator('canvas.home-particle-canvas').evaluate((canvas:any)=>canvas.getContext('webgl').getError()),0);
  await screenshot('home-desktop');await page.locator('.home-explore-area').scrollIntoViewIfNeeded();await screenshot('home-discovery');await page.evaluate(()=>{document.getElementById('main-stage')!.scrollTop=0;});await expect.poll(async()=> (await state()).state).toBe('ambient');checks.push('Real native WebGL shaders assemble the bundled logo and enter ambient animation without GL errors');
  await page.getByRole('button',{name:'Pause animation',exact:true}).click();const paused=await state();await page.waitForTimeout(180);assert.deepEqual(await state(),paused);
  await page.getByRole('button',{name:'Resume animation',exact:true}).click();await expect.poll(async()=> (await state()).frames).toBeGreaterThan(paused.frames);
  await page.getByRole('button',{name:'Replay intro',exact:true}).click();assert.ok((await state()).elapsed<.5);await page.waitForTimeout(650);await screenshot('home-assembling');
  checks.push('Pause freezes frames and time; Resume advances; Replay restarts assembly');
  await page.getByRole('button',{name:'The halving block',exact:true}).click();await expect(page.locator('.home-page .lookup-query input')).toHaveValue('block:840000');await expect(page.locator('.home-page .lookup-query input')).toBeFocused();await expect(page.locator('.home-page')).toBeVisible();
  assert.equal(await page.locator('.home-page .home-explore button').count(),4);checks.push('Examples focus and prefill search without navigation; four explicit discovery actions');
  await page.evaluate(()=>{(window as any).__home=document.querySelector('.home-intro-scene');document.getElementById('main-stage')!.scrollTop=100000;});
  await expect.poll(async()=> (await state()).state).toBe('suspended');const suspended=await state();await page.waitForTimeout(160);assert.equal((await state()).frames,suspended.frames);
  await page.evaluate(()=>{document.getElementById('main-stage')!.scrollTop=0;});await expect.poll(async()=> (await state()).frames).toBeGreaterThan(suspended.frames);checks.push('Animation suspends offscreen and resumes when visible');
  await page.emulateMedia({reducedMotion:'reduce'});await expect.poll(async()=> (await state()).renderer).toBe('static');await expect(page.locator('.home-intro-logo')).toBeVisible();await expect(page.getByRole('button',{name:'Pause animation',exact:true})).toBeHidden();const reduced=await state();await page.waitForTimeout(160);assert.equal((await state()).frames,reduced.frames);await screenshot('home-reduced-motion');
  await page.emulateMedia({reducedMotion:'no-preference'});await expect.poll(async()=> (await state()).renderer).toBe('webgl');checks.push('Reduced motion releases WebGL, presents the real logo, and responds to live preference changes');
  await page.getByRole('button',{name:'All bookmarks',exact:true}).click();assert.equal(await page.evaluate(()=> (window as any).__home.animationState().disposed),true);await home();checks.push('Navigating away disposes the previous scene and native Home creates a fresh one');
  await page.locator('.home-make').click({position:{x:20,y:170}});await expect(page).toHaveURL('app://app/creator/generated/renderer/index.html');await expect(page.getByRole('heading',{name:'Make your mark on Bitcoin.'})).toBeVisible();await expect(page.locator('.template-card')).toHaveCount(24);
  await page.locator('.creator-mode-switch').getByRole('button',{name:'Browse',exact:true}).click();await expect(page).toHaveURL('app://app/renderer/index.html');await expect(page.locator('#app')).toHaveAttribute('aria-busy','false');await expect(page.locator('.home-page')).toBeVisible();checks.push('Homepage Create opens the dedicated native 24-starter creator and Browse returns to the browser');
  await page.locator('[data-command="settings"]').first().click();await page.getByLabel('Theme',{exact:true}).selectOption('light');await home();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('.home-intro-scene')).toHaveAttribute('data-motion-state','ambient',{timeout:15000});await screenshot('home-light');
  await page.setViewportSize({width:780,height:900});await screenshot('home-narrow');assert.ok(await page.locator('.home-page').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  await page.setViewportSize({width:640,height:900});await screenshot('home-small');assert.ok(await page.locator('.home-page').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  assert.ok(await page.locator('.home-hero').evaluate(node=>{const scene=node.querySelector('.home-intro-scene')!.getBoundingClientRect(),search=node.querySelector('.home-launchpad')!.getBoundingClientRect();return search.bottom<=scene.top+1;}));checks.push('Native light theme and narrow layouts retain search before decoration without horizontal overflow');
  await page.setViewportSize({width:1440,height:1000});await expect.poll(async()=> (await state()).renderer).toBe('webgl');
  const contextLoss=await page.locator('canvas.home-particle-canvas').evaluate((canvas:any)=>{const ext=canvas.getContext('webgl').getExtension('WEBGL_lose_context');if(!ext)return false;ext.loseContext();return true;});assert.equal(contextLoss,true);await expect.poll(async()=> (await state()).renderer).toBe('static');await expect(page.locator('.home-intro-logo')).toBeVisible();await screenshot('home-context-fallback');checks.push('Actual WebGL context loss switches to the static logo while keeping search usable');
  await page.evaluate(()=>{(window as any).__originalContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type:any,...args:any[]){if(type==='webgl')return null;return (window as any).__originalContext.call(this,type,...args);} as any;});
  await page.getByRole('button',{name:'All bookmarks',exact:true}).click();await home();await expect(page.locator('.home-intro-scene')).toHaveAttribute('data-motion-state','static');await expect(page.locator('.home-intro-logo')).toBeVisible();await page.getByRole('button',{name:'The very first sat',exact:true}).click();await expect(page.locator('.home-page .lookup-query input')).toHaveValue('sat:0');await page.evaluate(()=>{HTMLCanvasElement.prototype.getContext=(window as any).__originalContext;delete (window as any).__originalContext;});checks.push('Unavailable WebGL has a static bundled fallback with usable search');
  await app.close();app=null;console.log('Native homepage: animation, controls, modes, responsiveness and fallbacks passed.');
  await launch(true);await expect(page.locator('.home-hero .home-kicker')).toHaveText('WELCOME BACK TO BITCOIN BROWSER');await expect(page.locator('.home-library-area')).toContainText('The first satoshi');await expect(page.locator('.home-library-area')).toContainText('The halving block');assert.ok(await page.locator('.home-page').evaluate(node=>Boolean(node.querySelector('.home-library-area')!.compareDocumentPosition(node.querySelector('.home-explore-area')!)&Node.DOCUMENT_POSITION_FOLLOWING)));
  await expect(page.locator('.home-intro-scene')).toHaveAttribute('data-motion-state','ambient',{timeout:15000});await screenshot('home-returning');checks.push('Returning users receive a welcome back and recent places/bookmarks before discovery cards');
  assert.deepEqual(errors,[]);await expect(page.locator('#app')).toHaveAttribute('aria-busy','false');await app.close();app=null;
  const receipt={schemaVersion:1,version,packaged,driver:packaged?'renderer-cdp-with-main-inspection-disabled':'playwright-electron-development',archiveSha256:packaged?JSON.parse(await fs.readFile(path.join(root,'release',version,'release-manifest.json'),'utf8')).sha256:undefined,at:new Date().toISOString(),localEvidence:run,checks,initial,screenshots,rendererErrors:errors,scope:'Owned fresh and returning profiles; native homepage and Create navigation only. No wallet or financial transaction test.'};
  await fs.writeFile(path.join(run,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');await fs.writeFile(path.join(root,'docs/evidence',receiptName??'home-'+(packaged?'packaged':'native')+'.json'),JSON.stringify(receipt,null,2)+'\n');console.log('Native homepage qualification passed: '+path.join(run,'receipt.json'));
}catch(error){if(page)await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});console.error('Homepage evidence: '+run,error);throw error;}
finally{if(app)await app.close();}
