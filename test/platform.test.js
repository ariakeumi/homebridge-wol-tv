import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';

import register from '../dist/index.js';
import { WolTvPlatform } from '../dist/platform.js';
import { baseDevice, fakeApi, logger } from './helpers.js';

test('ESM entry registers the expected Homebridge dynamic platform', () => {
  const api = fakeApi();
  register(api);
  assert.deepEqual(api.registration, ['homebridge-wol-tv', 'WolTv', WolTvPlatform]);
});

test('publishes a real HAP television and links its computer input', { timeout: 5000 }, async t => {
  const server = createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = fakeApi();
  t.after(() => api.emit('shutdown'));
  new WolTvPlatform(logger(), { platform: 'WolTv', devices: [{
    ...baseDevice, probe: 'tcp', statusPort: server.address().port,
  }] }, api);
  assert.equal(api.published.length, 0);
  api.emit('didFinishLaunching');
  const accessory = api.published[0].accessories[0];
  const { Service, Characteristic, Categories, HAPStatus } = api.hap;
  assert.equal(accessory.category, Categories.TELEVISION);
  assert.equal(api.published[0].plugin, 'homebridge-wol-tv');
  const television = accessory.getService(Service.Television);
  assert.ok(television.isPrimaryService);
  assert.equal(television.getCharacteristic(Characteristic.ConfiguredName).value, baseDevice.name);
  assert.equal(television.linkedServices.length, 1);
  assert.equal(television.linkedServices[0].UUID, Service.InputSource.UUID);
  assert.equal(await television.getCharacteristic(Characteristic.ActiveIdentifier).handleGetRequest(), 1);
  await assert.rejects(television.getCharacteristic(Characteristic.ActiveIdentifier).handleSetRequest(2), error => error === HAPStatus.INVALID_VALUE_IN_REQUEST);
  // Wait for the actual first local TCP probe to update the characteristic.
  const active = television.getCharacteristic(Characteristic.Active);
  if (active.value !== 1) { await once(active, 'change'); }
  assert.equal(await active.handleGetRequest(), 1);
  await assert.rejects(active.handleSetRequest(0), error => error === HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(await active.handleGetRequest(), 1);
  assert.equal(accessory.getService(Service.AccessoryInformation).getCharacteristic(Characteristic.SerialNumber).value, 'AABBCCDDEEFF');
});

test('keeps identity stable on rename and isolates malformed/duplicate hosts', t => {
  const api = fakeApi();
  const log = logger();
  t.after(() => api.emit('shutdown'));
  new WolTvPlatform(log, { platform: 'WolTv', devices: [
    { ...baseDevice, probe: 'tcp', statusPort: 1 },
    { ...baseDevice, mac: 'aa-bb-cc-dd-ee-ff' },
    { ...baseDevice, mac: 'invalid' },
    { ...baseDevice, name: 'Second PC', mac: 'AA:BB:CC:DD:EE:00', probe: 'tcp', statusPort: 1 },
  ] }, api);
  api.emit('didFinishLaunching');
  assert.equal(api.published.length, 2);
  assert.equal(log.entries.filter(entry => entry.level === 'error').length, 2);
  const renamed = fakeApi();
  t.after(() => renamed.emit('shutdown'));
  new WolTvPlatform(logger(), { platform: 'WolTv', devices: [{ ...baseDevice, name: 'Renamed PC', probe: 'tcp', statusPort: 1 }] }, renamed);
  renamed.emit('didFinishLaunching');
  assert.equal(api.published[0].accessories[0].UUID, renamed.published[0].accessories[0].UUID);
});

test('supports empty configuration and skips publication when HAP is disabled', () => {
  for (const config of [{ platform: 'WolTv' }, { platform: 'WolTv', devices: [] }, { platform: 'WolTv', devices: 'invalid' }]) {
    const api = fakeApi();
    new WolTvPlatform(logger(), config, api);
    api.emit('didFinishLaunching');
    assert.equal(api.published.length, 0);
    api.emit('shutdown');
  }
  const api = fakeApi();
  api.isHapEnabled = () => false;
  new WolTvPlatform(logger(), { platform: 'WolTv', devices: [baseDevice] }, api);
  api.emit('didFinishLaunching');
  assert.equal(api.published.length, 0);
  api.emit('shutdown');
});
