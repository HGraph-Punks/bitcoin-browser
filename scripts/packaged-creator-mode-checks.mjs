/** Native Create smoke shared by all six CI OS/architecture builds.
 * Uses actual mode controls and renderer IPC boundaries; no wallet or spend. */
export async function runPackagedCreatorModeChecks({cdp,poll,assert}) {
  const clicked=await cdp.evaluate(`(() => { /*creator-mode:enter*/
    const button=document.getElementById('enter-create-mode');
    if(!button || button.disabled || button.querySelector('.mode-alpha')?.textContent!=='Alpha') return false;
    button.click();return true;
  })()`);
  assert(clicked,'Create Alpha mode control was not reachable');
  const creation=await poll(()=>cdp.evaluate(`(() => ({ /*creator-mode:snapshot*/
    url:location.href,heading:document.querySelector('h1')?.textContent,
    starters:document.querySelectorAll('.template-card').length,
    alpha:document.querySelector('.creator-mode-switch [aria-pressed="true"] .mode-alpha')?.textContent,
    browser:typeof window.satBrowser,creator:typeof window.builder,
    node:typeof window.process,require:typeof window.require,
    types:[...document.querySelectorAll('.creation-nav button')].map(button=>button.getAttribute('aria-label'))
  }))()`),value=>value.url==='app://app/creator/generated/renderer/index.html'&&value.starters===24,undefined,'Create Alpha native workspace');
  assert(creation.heading==='Make your mark on Bitcoin.' && creation.alpha==='Alpha','Create home omitted the Alpha state');
  assert(creation.browser==='undefined' && creation.creator==='object' && creation.node==='undefined' && creation.require==='undefined','Create renderer authority separation failed');
  for(const name of ['Collections','Runes','Bitmap','BRC-20','Sats Names'])assert(creation.types.includes(name),'Missing native creation type '+name);
  const returned=await cdp.evaluate(`(() => { /*creator-mode:browse*/
    const button=[...document.querySelectorAll('.creator-mode-switch button')].find(node=>node.textContent==='Browse');
    if(!button)return false;button.click();return true;
  })()`);
  assert(returned,'Native Browse return control was not reachable');
  const browsing=await poll(()=>cdp.evaluate(`(() => ({ /*creator-mode:returned*/
    url:location.href,busy:document.getElementById('app')?.getAttribute('aria-busy'),
    browser:typeof window.satBrowser,creator:typeof window.builder,
    alpha:document.querySelector('#enter-create-mode .mode-alpha')?.textContent
  }))()`),value=>value.url==='app://app/renderer/index.html'&&value.busy==='false',undefined,'native Browse return');
  assert(browsing.browser==='object'&&browsing.creator==='undefined'&&browsing.alpha==='Alpha','Browse retained Creator authority or lost its Alpha label');
  return {creation,browsing,scope:'Actual packaged native mode controls and authoring home. No wallet, node or financial transaction.'};
}
