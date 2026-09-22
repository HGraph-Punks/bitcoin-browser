import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStatusMonitor } from '../src/renderer/provider-status-monitor.js';

function fixture() {
  const timers = new Map(); let sequence = 0, calls = 0, enabled = true;
  let refresh = async () => {};
  const monitor = createProviderStatusMonitor({ enabled: () => enabled, refresh: async () => { calls++; await refresh(); },
    schedule: (callback, delay) => { assert.equal(delay, 5000); timers.set(++sequence, callback); return sequence; }, cancel: id => timers.delete(id) });
  return { monitor, timers, get calls() { return calls; }, enable: value => { enabled = value; }, refresh: value => { refresh = value; },
    tick() { const [id, callback] = timers.entries().next().value; timers.delete(id); return callback(); } };
}

test('background status polling starts once, stays bounded, and stops on disposal', async () => {
  const f = fixture(); f.monitor.start(); f.monitor.start(); assert.equal(f.timers.size, 1);
  await f.tick(); assert.equal(f.calls, 1); assert.equal(f.timers.size, 1);
  await f.tick(); assert.equal(f.calls, 2);
  f.monitor.stop(); assert.equal(f.timers.size, 0);
});

test('disabled polling does no work and resumes when the window/routing state permits', async () => {
  const f = fixture(); f.enable(false); f.monitor.start(); await f.tick(); assert.equal(f.calls, 0);
  f.enable(true); await f.tick(); assert.equal(f.calls, 1); f.monitor.stop();
});

test('an in-flight read never overlaps and does not rearm after shutdown', async () => {
  const f = fixture(); let finish; f.refresh(() => new Promise(resolve => { finish = resolve; }));
  f.monitor.start(); const pending = f.tick(); assert.equal(f.calls, 1); assert.equal(f.timers.size, 0);
  f.monitor.stop(); finish(); await pending; assert.equal(f.timers.size, 0);
});

test('a failed read keeps polling without unhandled rejection or automatic mutations', async () => {
  const f = fixture(); f.refresh(async () => { throw new Error('synthetic IPC failure'); });
  f.monitor.start(); await f.tick(); assert.equal(f.calls, 1); assert.equal(f.timers.size, 1);
  f.refresh(async () => {}); await f.tick(); assert.equal(f.calls, 2); f.monitor.stop();
});
