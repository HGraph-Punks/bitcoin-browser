import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettingsPatch } from '../src/shared/validation.js';

test('privacy profiles produce concrete routing and content policies', () => {
  assert.deepEqual(validateSettingsPatch({ privacyMode: 'strict' }), {
    privacyMode: 'strict', localOnly: true, contentNetworkPolicy: 'blocked'
  });
  assert.deepEqual(validateSettingsPatch({ privacyMode: 'balanced' }), {
    privacyMode: 'balanced', localOnly: false, contentNetworkPolicy: 'blocked'
  });
  assert.deepEqual(validateSettingsPatch({ privacyMode: 'compatible' }), {
    privacyMode: 'compatible', localOnly: false, contentNetworkPolicy: 'https-only'
  });
});

test('explicit privacy-related fields override profile defaults atomically', () => {
  assert.deepEqual(validateSettingsPatch({ privacyMode: 'strict', localOnly: false, contentNetworkPolicy: 'https-only' }), {
    privacyMode: 'strict', localOnly: false, contentNetworkPolicy: 'https-only'
  });
});
