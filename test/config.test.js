import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';

import { normalizeMac, parseDeviceConfig } from '../dist/config.js';

const base = { name: 'PC', mac: 'AA:BB:CC:DD:EE:FF', host: '192.168.1.10' };

test('normalizes hardware identity and supplies network defaults', () => {
  for (const mac of ['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'aabbccddeeff']) {
    assert.equal(normalizeMac(mac), base.mac);
  }
  const device = parseDeviceConfig(base);
  assert.equal(device.pollInterval, 5);
  assert.equal(device.broadcastAddress, '255.255.255.255');
  assert.equal(device.wolPackets, 3);
  assert.equal(device.probe, 'ping');
  assert.equal(device.shutdown, undefined);
});

test('rejects malformed devices and values that could become ping options', () => {
  for (const invalid of [
    null, [], {}, { ...base, name: '' }, { ...base, name: 'x'.repeat(65) },
    { ...base, mac: 'AA:BB-CC:DD:EE:FF' }, { ...base, mac: 'FF:FF:FF:FF:FF:FF' },
    { ...base, mac: '00:00:00:00:00:00' }, { ...base, host: '-c1' },
    { ...base, host: 'localhost; touch /tmp/example' }, { ...base, host: '127.0.0.1:22' },
    { ...base, broadcastAddress: 'hostname' }, { ...base, interfaceAddress: '::1' },
    { ...base, probe: 'tcp' }, { ...base, probe: 'other' },
    { ...base, pollInterval: 0 }, { ...base, wolPort: 65536 }, { ...base, wolPackets: '3' },
    { ...base, shutdownTimeout: 10000 }, { ...base, offlineThreshold: 1.5 },
  ]) {
    assert.throws(() => parseDeviceConfig(invalid));
  }
  assert.equal(parseDeviceConfig({ ...base, host: '::1' }).host, '::1');
});

test('validates command and HTTP shutdown contracts', () => {
  assert.deepEqual(parseDeviceConfig({ ...base, shutdown: { type: 'command', command: '/bin/true' } }).shutdown,
    { type: 'command', command: '/bin/true', args: [] });
  assert.equal(parseDeviceConfig({ ...base, shutdown: { type: 'http', url: 'https://localhost/shutdown' } }).shutdown.method, 'POST');
  for (const shutdown of [
    { type: 'invalid' }, { type: 'command', command: 'ssh', args: 'host' },
    { type: 'http', url: 'file:///tmp/test' }, { type: 'http', url: 'invalid' },
    { type: 'http', url: 'http://user:secret@localhost' },
    { type: 'http', url: 'http://localhost', method: 'DELETE' },
    { type: 'http', url: 'http://localhost', method: 'GET', body: '{}' },
    { type: 'http', url: 'http://localhost', headers: { token: 123 } },
    { type: 'http', url: 'http://localhost', headers: { token: '\nsecret' } },
  ]) {
    assert.throws(() => parseDeviceConfig({ ...base, shutdown }));
  }
});

test('unfinished optional shutdown forms keep the host available without power off', () => {
  for (const shutdown of [{}, { method: 'POST' }, { type: 'command' },
    { type: 'command', command: ' ', args: [] }, { type: 'http', method: 'POST' },
    { type: 'http', url: '', method: 'POST', headers: {}, body: '' }]) {
    assert.equal(parseDeviceConfig({ ...base, shutdown }).shutdown, undefined);
  }
  assert.throws(() => parseDeviceConfig({ ...base, shutdown: { type: 'command', args: ['host'] } }));
  assert.throws(() => parseDeviceConfig({ ...base, shutdown: { type: 'http', headers: { Authorization: 'token' } } }));
});

test('Homebridge UI schema validates examples and enforces conditional fields', () => {
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema.schema);
  assert.equal(validate(example.platforms[0]), true, JSON.stringify(validate.errors));
  assert.equal(validate({ devices: [{ ...base, probe: 'tcp' }] }), false);
  assert.equal(validate({ devices: [{ ...base, shutdown: { type: 'command' } }] }), true);
  assert.equal(validate({ devices: [{ ...base, shutdown: { type: 'http' } }] }), true);
  assert.equal(validate({ devices: [{ ...base, shutdown: {} }] }), true);
  assert.equal(validate({ devices: [{ ...base, probe: 'tcp', statusPort: 22 }] }), true);
});
