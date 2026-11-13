import { isIP } from 'node:net';

export interface CommandShutdown {
  type: 'command';
  command: string;
  args: string[];
}

export interface HttpShutdown {
  type: 'http';
  url: string;
  method: 'POST' | 'PUT' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export interface DeviceConfig {
  name: string;
  mac: string;
  host: string;
  broadcastAddress: string;
  interfaceAddress?: string;
  wolPort: number;
  wolPackets: number;
  wolInterval: number;
  probe: 'ping' | 'tcp';
  statusPort: number;
  pollInterval: number;
  probeTimeout: number;
  offlineThreshold: number;
  onGracePeriod: number;
  offGracePeriod: number;
  shutdownTimeout: number;
  shutdown?: CommandShutdown | HttpShutdown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function normalizeMac(value: unknown): string {
  const mac = string(value, 'mac');
  if (!/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})$/i.test(mac)) {
    throw new Error('mac must contain six hexadecimal octets, e.g. AA:BB:CC:DD:EE:FF.');
  }
  const compact = mac.replace(/[:-]/g, '').toUpperCase();
  if (compact === '000000000000' || (Number.parseInt(compact.slice(0, 2), 16) & 1) !== 0) {
    throw new Error('mac must be a unicast hardware address.');
  }
  return compact.match(/../g)!.join(':');
}

function parseShutdown(value: unknown): DeviceConfig['shutdown'] {
  if (value === undefined) {
    return undefined;
  }
  const input = object(value, 'shutdown');
  if (input.type === 'command') {
    const command = string(input.command, 'shutdown.command');
    if (input.args !== undefined && (!Array.isArray(input.args) || !input.args.every(arg => typeof arg === 'string'))) {
      throw new Error('shutdown.args must be an array of strings.');
    }
    return { type: 'command', command, args: (input.args as string[] | undefined) ?? [] };
  }
  if (input.type === 'http') {
    const url = string(input.url, 'shutdown.url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('shutdown.url must be an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('shutdown.url must use HTTP(S) without embedded credentials; use headers for authentication.');
    }
    const method = input.method ?? 'POST';
    if (method !== 'POST' && method !== 'PUT' && method !== 'GET') {
      throw new Error('shutdown.method must be POST, PUT, or GET.');
    }
    const headers = input.headers === undefined ? {} : object(input.headers, 'shutdown.headers');
    if (!Object.values(headers).every(header => typeof header === 'string')) {
      throw new Error('shutdown.headers values must be strings.');
    }
    if (Object.values(headers).some(header => /[\r\n]/.test(header as string))) {
      throw new Error('shutdown.headers values cannot contain line breaks.');
    }
    try {
      new Headers(headers as Record<string, string>);
    } catch {
      throw new Error('shutdown.headers contains an invalid HTTP header.');
    }
    if (input.body !== undefined && typeof input.body !== 'string') {
      throw new Error('shutdown.body must be a string.');
    }
    if (method === 'GET' && input.body !== undefined) {
      throw new Error('shutdown.body cannot be used with GET.');
    }
    return { type: 'http', url, method, headers: headers as Record<string, string>, body: input.body as string | undefined };
  }
  throw new Error('shutdown.type must be command or http.');
}

export function parseDeviceConfig(value: unknown): DeviceConfig {
  const input = object(value, 'device');
  const name = string(input.name, 'name');
  if (name.length > 64) {
    throw new Error('name must be at most 64 characters.');
  }
  const host = string(input.host, 'host');
  if (!isIP(host) && (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error('host must be an IP address or hostname, without a port or command options.');
  }
  const broadcastAddress = input.broadcastAddress === undefined ? '255.255.255.255' : string(input.broadcastAddress, 'broadcastAddress');
  if (isIP(broadcastAddress) !== 4) {
    throw new Error('broadcastAddress must be an IPv4 address.');
  }
  const interfaceAddress = input.interfaceAddress === undefined ? undefined : string(input.interfaceAddress, 'interfaceAddress');
  if (interfaceAddress !== undefined && isIP(interfaceAddress) !== 4) {
    throw new Error('interfaceAddress must be a local IPv4 address.');
  }
  const probe = input.probe ?? 'ping';
  if (probe !== 'ping' && probe !== 'tcp') {
    throw new Error('probe must be ping or tcp.');
  }
  if (probe === 'tcp' && input.statusPort === undefined) {
    throw new Error('statusPort is required for a TCP probe.');
  }
  return {
    name,
    mac: normalizeMac(input.mac),
    host,
    broadcastAddress,
    interfaceAddress,
    wolPort: integer(input.wolPort, 9, 1, 65535, 'wolPort'),
    wolPackets: integer(input.wolPackets, 3, 1, 10, 'wolPackets'),
    wolInterval: integer(input.wolInterval, 100, 0, 250, 'wolInterval'),
    probe,
    statusPort: integer(input.statusPort, 22, 1, 65535, 'statusPort'),
    pollInterval: integer(input.pollInterval, 5, 1, 3600, 'pollInterval'),
    probeTimeout: integer(input.probeTimeout, 2000, 100, 5000, 'probeTimeout'),
    offlineThreshold: integer(input.offlineThreshold, 2, 1, 10, 'offlineThreshold'),
    onGracePeriod: integer(input.onGracePeriod, 90, 0, 600, 'onGracePeriod'),
    offGracePeriod: integer(input.offGracePeriod, 30, 0, 600, 'offGracePeriod'),
    shutdownTimeout: integer(input.shutdownTimeout, 5000, 100, 8000, 'shutdownTimeout'),
    shutdown: parseShutdown(input.shutdown),
  };
}
