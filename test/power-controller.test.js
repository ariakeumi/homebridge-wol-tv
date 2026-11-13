import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDeviceConfig } from '../dist/config.js';
import { PowerBusyError, PowerController } from '../dist/power-controller.js';
import { baseDevice, deferred, logger } from './helpers.js';

function fixture(t, overrides = {}, dependencies = {}) {
  let reachable = false;
  let time = 1000;
  let wakes = 0;
  let shutdowns = 0;
  const updates = [];
  const log = logger();
  const controller = new PowerController(parseDeviceConfig({
    ...baseDevice, shutdown: { type: 'command', command: 'unused' }, ...overrides,
  }), log, value => updates.push(value), {
    probe: async () => reachable,
    wake: async () => { wakes++; },
    shutdown: async () => { shutdowns++; },
    now: () => time,
    ...dependencies,
  });
  t.after(() => controller.stop());
  return {
    controller, updates, log,
    online: value => { reachable = value; },
    advance: ms => { time += ms; },
    get wakes() { return wakes; },
    get shutdowns() { return shutdowns; },
  };
}

test('reports unknown until first probe and filters transient offline failures', async t => {
  const f = fixture(t);
  assert.throws(() => f.controller.active, /first host status/);
  f.online(true);
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
  f.online(false);
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
  await f.controller.refresh();
  assert.equal(f.controller.active, false);
});

test('holds optimistic on state while booting, then confirms or rolls back', async t => {
  const f = fixture(t, { onGracePeriod: 2 });
  await f.controller.refresh();
  await f.controller.setPower(true);
  assert.equal(f.controller.active, true);
  await f.controller.setPower(true);
  assert.equal(f.wakes, 1);
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
  f.advance(2001);
  await f.controller.refresh();
  assert.equal(f.controller.active, false);
  assert.ok(f.log.entries.some(entry => String(entry.args).includes('not confirmed')));
  await f.controller.setPower(true);
  f.online(true);
  await f.controller.refresh();
  f.advance(100000);
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
});

test('shutdown stays off during grace and rolls back when host remains reachable', async t => {
  const f = fixture(t, { offGracePeriod: 2 });
  f.online(true);
  await f.controller.refresh();
  await f.controller.setPower(false);
  assert.equal(f.controller.active, false);
  await f.controller.refresh();
  assert.equal(f.controller.active, false);
  f.advance(2001);
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
  await f.controller.setPower(false);
  f.online(false);
  await f.controller.refresh();
  await f.controller.refresh();
  f.advance(3000);
  await f.controller.refresh();
  assert.equal(f.controller.active, false);
  assert.equal(f.shutdowns, 2);
});

test('unconfigured or failed shutdown never changes a known online state', async t => {
  const f = fixture(t, { shutdown: undefined });
  f.online(true);
  await f.controller.refresh();
  await assert.rejects(f.controller.setPower(false), /not configured/);
  assert.equal(f.controller.active, true);
  const failed = fixture(t, {}, { shutdown: async () => { throw new Error('failed'); } });
  failed.online(true);
  await failed.controller.refresh();
  await assert.rejects(failed.controller.setPower(false), /failed/);
  assert.equal(failed.controller.active, true);
});

test('coalesces identical commands and rejects opposite commands while sending', async t => {
  const sending = deferred();
  let calls = 0;
  const f = fixture(t, {}, { wake: () => { calls++; return sending.promise; } });
  const first = f.controller.setPower(true);
  const second = f.controller.setPower(true);
  assert.equal(first, second);
  await assert.rejects(f.controller.setPower(false), PowerBusyError);
  sending.resolve();
  await first;
  assert.equal(calls, 1);
  await f.controller.setPower(false);
  assert.equal(f.controller.active, false);
});

test('discards a probe begun before a command, including stale probe errors', async t => {
  const probing = deferred();
  const f = fixture(t, {}, { probe: () => probing.promise });
  const pending = f.controller.refresh();
  assert.equal(pending, f.controller.refresh());
  await f.controller.setPower(true);
  probing.reject(new Error('stale failure'));
  await pending;
  assert.equal(f.controller.active, true);
  assert.equal(f.updates.length, 1);
});

test('probe errors report unavailable, expire optimism, and recover on success', async t => {
  let broken = false;
  const f = fixture(t, { onGracePeriod: 1 }, { probe: async () => {
    if (broken) { throw new Error('ping unavailable'); }
    return false;
  } });
  await f.controller.refresh();
  await f.controller.setPower(true);
  broken = true;
  await f.controller.refresh();
  assert.equal(f.controller.active, true);
  f.advance(1001);
  await f.controller.refresh();
  assert.throws(() => f.controller.active, /ping unavailable/);
  assert.ok(f.updates.at(-1) instanceof Error);
  broken = false;
  await f.controller.refresh();
  assert.equal(f.controller.active, false);
});

test('stop cancels work and prevents further probes or state updates', async t => {
  const probing = deferred();
  let signal;
  let probes = 0;
  const f = fixture(t, {}, { probe: (_config, value) => {
    probes++;
    signal = value;
    return probing.promise;
  } });
  const pending = f.controller.refresh();
  f.controller.stop();
  assert.equal(signal.aborted, true);
  probing.resolve(true);
  await pending;
  await f.controller.refresh();
  assert.equal(probes, 1);
  assert.equal(f.updates.length, 0);
  await assert.rejects(f.controller.setPower(true), /shutting down/);
});
