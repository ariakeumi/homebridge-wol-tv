import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createConnection, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import type { DeviceConfig } from './config.js';
import { normalizeMac } from './config.js';

export function createMagicPacket(mac: string): Buffer {
  const address = Buffer.from(normalizeMac(mac).replaceAll(':', ''), 'hex');
  const packet = Buffer.alloc(102, 0xff);
  for (let offset = 6; offset < packet.length; offset += address.length) {
    address.copy(packet, offset);
  }
  return packet;
}

export async function sendWake(config: DeviceConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const packet = createMagicPacket(config.mac);
  const socket = createSocket('udp4');
  // One deadline covers binding and all repeated packets, below HomeKit's request timeout.
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  let failure: Error | undefined;
  const onError = (error: Error): void => { failure = error; };
  socket.on('error', onError);
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); reject(new Error('WOL send was cancelled or timed out.')); };
      const onBindError = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => {
        bounded.removeEventListener('abort', onAbort);
        socket.removeListener('error', onBindError);
      };
      bounded.addEventListener('abort', onAbort, { once: true });
      socket.once('error', onBindError);
      socket.bind(0, config.interfaceAddress ?? '0.0.0.0', () => { cleanup(); resolve(); });
    });
    socket.setBroadcast(true);
    for (let index = 0; index < config.wolPackets; index++) {
      bounded.throwIfAborted();
      if (failure) {
        throw failure;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('WOL send was cancelled or timed out.'));
        bounded.addEventListener('abort', onAbort, { once: true });
        socket.send(packet, config.wolPort, config.broadcastAddress, (error) => {
          bounded.removeEventListener('abort', onAbort);
          if (error) { reject(error); } else { resolve(); }
        });
      });
      if (index + 1 < config.wolPackets && config.wolInterval > 0) {
        await delay(config.wolInterval, undefined, { signal: bounded });
      }
    }
  } finally {
    // Keep the error listener attached while the socket is closing.
    try { socket.close(); } catch { /* Binding may have failed before the socket opened. */ }
  }
}

export function probeTcp(config: DeviceConfig, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: config.host, port: config.statusPort });
    const timer = setTimeout(() => finish(false), config.probeTimeout);
    const onAbort = (): void => finish(false, new Error('TCP probe cancelled.'));
    const finish = (online: boolean, error?: Error): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) { reject(error); } else { resolve(online); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
        finish(false, new Error('Status hostname could not be resolved.'));
      } else {
        finish(false);
      }
    });
  });
}

export function probePing(config: DeviceConfig, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(config.probeTimeout), config.host]
    : ['-n', '-c', '1', config.host];
  const executable = process.platform === 'darwin' && isIP(config.host) === 6 ? 'ping6' : 'ping';
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: config.probeTimeout, signal, windowsHide: true, maxBuffer: 65536 }, (error) => {
      if (signal.aborted) {
        reject(new Error('Ping probe cancelled.'));
      } else if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('ping executable not found; install ping or select a TCP probe.'));
      } else if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
        reject(new Error('ping could not be executed; check its permissions.'));
      } else {
        resolve(!error);
      }
    });
  });
}

export function probeHost(config: DeviceConfig, signal: AbortSignal): Promise<boolean> {
  return config.probe === 'tcp' ? probeTcp(config, signal) : probePing(config, signal);
}

export async function shutdownHost(config: DeviceConfig, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const shutdown = config.shutdown;
  if (!shutdown) {
    throw new Error('Power off is not configured. Set shutdown to a command or HTTP endpoint.');
  }
  if (shutdown.type === 'command') {
    await new Promise<void>((resolve, reject) => {
      execFile(shutdown.command, shutdown.args, {
        timeout: config.shutdownTimeout,
        signal,
        windowsHide: true,
        maxBuffer: 65536,
        shell: false,
      }, (error) => {
        if (!error) {
          resolve();
        } else {
          // Child-process errors include the full command and output; do not expose credentials.
          const code = (error as NodeJS.ErrnoException).code;
          reject(new Error(`Shutdown command failed (${signal.aborted ? 'cancelled' : error.killed ? 'timeout/output limit' : code ?? 'unknown error'}).`));
        }
      });
    });
    return;
  }
  try {
    const response = await fetch(shutdown.url, {
      method: shutdown.method,
      headers: shutdown.headers,
      body: shutdown.body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.shutdownTimeout)]),
      redirect: 'error',
    });
    // Shutdown endpoints need only acknowledge acceptance, not stream a response body.
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`Shutdown HTTP endpoint returned status ${response.status}.`);
    }
  } catch (error) {
    if (error instanceof Error && /^Shutdown HTTP endpoint returned status \d+\.$/.test(error.message)) {
      throw error;
    }
    throw new Error('Shutdown HTTP request failed, was cancelled, or timed out.');
  }
}
