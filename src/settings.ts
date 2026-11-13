import { readFileSync } from 'node:fs';

export const PLUGIN_NAME = 'homebridge-wol-tv';
export const PLATFORM_NAME = 'WolTv';
export const PLUGIN_VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;
