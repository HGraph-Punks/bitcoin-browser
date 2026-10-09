import test from 'node:test';
import assert from 'node:assert/strict';
import {runPackagedCreatorModeChecks} from '../scripts/packaged-creator-mode-checks.mjs';
function fixture(overrides={}) {
  const creation={url:'app://app/creator/generated/renderer/index.html',heading:'Make your mark on Bitcoin.',starters:24,alpha:'Alpha',browser:'undefined',creator:'object',node:'undefined',require:'undefined',types:['Collections','Runes','Bitmap','BRC-20','Sats Names'],...overrides.creation};
  const browsing={url:'app://app/renderer/index.html',busy:'false',browser:'object',creator:'undefined',alpha:'Alpha',...overrides.browsing};
  const cdp={evaluate:async expression=>expression.includes('creator-mode:enter')?overrides.enter!==false:expression.includes('creator-mode:browse')?true:expression.includes('creator-mode:snapshot')?creation:browsing};
  const poll=async(read,accept)=>{const value=await read();if(!accept(value))throw new Error('Fixture timeout');return value;};
  return {cdp,poll,assert};
}
test('native Create qualification uses explicit controls and verifies all protocol types before returning to Browse',async()=>{const result=await runPackagedCreatorModeChecks(fixture());assert.equal(result.creation.starters,24);assert.equal(result.browsing.creator,'undefined');});
test('a missing Alpha entry control cannot pass native Create qualification',async()=>{await assert.rejects(runPackagedCreatorModeChecks(fixture({enter:false})),/not reachable/);});
test('a partial Creator bundle cannot pass native qualification',async()=>{await assert.rejects(runPackagedCreatorModeChecks(fixture({creation:{starters:23}})),/timeout/);});
test('native mode qualification rejects privileged or shared renderer authority',async()=>{for(const creation of [{node:'object'},{require:'function'},{browser:'object'}])await assert.rejects(runPackagedCreatorModeChecks(fixture({creation})),/authority separation/);await assert.rejects(runPackagedCreatorModeChecks(fixture({browsing:{creator:'object'}})),/retained Creator authority/);});
test('protocol type omission or loss of the Alpha label cannot pass native qualification',async()=>{await assert.rejects(runPackagedCreatorModeChecks(fixture({creation:{types:['Collections','Runes']}})),/Missing native creation type/);await assert.rejects(runPackagedCreatorModeChecks(fixture({creation:{alpha:''}})),/Alpha state/);});
