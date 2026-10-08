import test from 'node:test';
import assert from 'node:assert/strict';
import {trustedModeSender,CREATOR_URL,BROWSER_URL} from '../src/shared/creator-boundary.js';
test('creation commands require the exact live native owner window and main document',()=>{
  const mainFrame={url:CREATOR_URL},webContents={mainFrame},window={webContents,isDestroyed:()=>false};
  const owner={sender:webContents,senderFrame:mainFrame};
  assert.equal(trustedModeSender(owner,window,CREATOR_URL),true);
  for(const event of [{...owner,senderFrame:{url:CREATOR_URL}},{...owner,senderFrame:{url:'ord://content/'+'a'.repeat(64)+'i0'}},{...owner,sender:{}}, {...owner,senderFrame:{url:CREATOR_URL+'?privileged=true'}}])assert.equal(trustedModeSender(event,window,CREATOR_URL),false);
  assert.equal(trustedModeSender(owner,window,BROWSER_URL),false);
  assert.equal(trustedModeSender(owner,{...window,isDestroyed:()=>true},CREATOR_URL),false);
  assert.equal(trustedModeSender(owner,null,CREATOR_URL),false);
});
