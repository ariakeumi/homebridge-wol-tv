import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only access to the installed Homebridge implementation, without an extra HAP copy.
const require = createRequire(import.meta.url);
const homebridgeRoot = dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = await import(pathToFileURL(join(homebridgeRoot, 'api.js')));
const realApi = new HomebridgeAPI();

export function logger() {
  const entries = [];
  const log = Object.assign(() => {}, Object.fromEntries(
    ['info', 'warn', 'error', 'debug', 'success'].map(level => [level, (...args) => entries.push({ level, args })]),
  ));
  log.entries = entries;
  return log;
}

export function fakeApi() {
  const api = new EventEmitter();
  api.hap = realApi.hap;
  api.platformAccessory = realApi.platformAccessory;
  api.published = [];
  api.unregistered = [];
  api.isHapEnabled = () => true;
  api.publishExternalAccessories = (plugin, accessories) => api.published.push({ plugin, accessories });
  api.unregisterPlatformAccessories = (...args) => api.unregistered.push(args);
  api.registerPlatform = (...args) => { api.registration = args; };
  return api;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const baseDevice = { name: 'Test PC', mac: 'AA:BB:CC:DD:EE:FF', host: '127.0.0.1' };
