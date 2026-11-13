import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import test from 'node:test';

import { parseDeviceConfig } from '../dist/config.js';
import { createMagicPacket, probePing, probeTcp, sendWake, shutdownHost } from '../dist/network.js';
import { baseDevice } from './helpers.js';

const signal = () => new AbortController().signal;
const device = overrides => parseDeviceConfig({ ...baseDevice, ...overrides });

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
}

test('Magic Packet contains the sync header and sixteen exact copies of the MAC', () => {
  const packet = createMagicPacket(baseDevice.mac);
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));
  for (let index = 0; index < 16; index++) {
    assert.equal(packet.subarray(6 + index * 6, 12 + index * 6).toString('hex'), 'aabbccddeeff');
  }
});

test('WOL sends repeated packets through a bound local UDP socket', { timeout: 5000 }, async t => {
  const receiver = createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  t.after(() => receiver.close());
  const packets = [];
  const received = new Promise(resolve => receiver.on('message', packet => {
    packets.push(packet);
    if (packets.length === 3) { resolve(); }
  }));
  await sendWake(device({
    broadcastAddress: '127.0.0.1', interfaceAddress: '127.0.0.1',
    wolPort: receiver.address().port, wolPackets: 3, wolInterval: 10,
  }), signal());
  await received;
  assert.equal(packets.length, 3);
  assert.ok(packets.every(packet => packet.equals(createMagicPacket(baseDevice.mac))));
});

test('WOL rejects an unavailable interface and pre-cancelled requests', async () => {
  await assert.rejects(sendWake(device({ interfaceAddress: '192.0.2.123' }), signal()));
  await assert.rejects(sendWake(device(), AbortSignal.abort()));
});

test('TCP probes distinguish listening and closed ports and honor aborts', async t => {
  const server = createTcpServer(socket => socket.end());
  const port = await listen(t, server);
  assert.equal(await probeTcp(device({ probe: 'tcp', statusPort: port }), signal()), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeTcp(device({ probe: 'tcp', statusPort: port }), signal()), false);
  assert.throws(() => probeTcp(device({ probe: 'tcp', statusPort: port }), AbortSignal.abort()));
});

test('Ping recognizes loopback using the host ping executable', async () => {
  assert.equal(await probePing(device(), signal()), true);
});

test('HTTP shutdown sends configured authentication and body once', async t => {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) { body += chunk; }
    requests.push({ method: req.method, auth: req.headers.authorization, body });
    res.writeHead(202).end();
  });
  const port = await listen(t, server);
  await shutdownHost(device({ shutdown: {
    type: 'http', url: `http://127.0.0.1:${port}/shutdown`,
    method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: '{"action":"shutdown"}',
  } }), signal());
  assert.deepEqual(requests, [{ method: 'POST', auth: 'Bearer test-token', body: '{"action":"shutdown"}' }]);
});

test('HTTP shutdown rejects errors, redirects, timeouts and hides URL credentials', async t => {
  let redirected = 0;
  const server = createHttpServer((req, res) => {
    if (req.url === '/error?token=secret') { res.writeHead(403).end('private details'); }
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }).end(); }
    else if (req.url === '/target') { redirected++; res.end(); }
    // /timeout intentionally never returns a response.
  });
  const port = await listen(t, server);
  const config = path => device({ shutdownTimeout: 100, shutdown: { type: 'http', url: `http://127.0.0.1:${port}${path}` } });
  await assert.rejects(shutdownHost(config('/error?token=secret'), signal()), error => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /secret|private/);
    return true;
  });
  await assert.rejects(shutdownHost(config('/redirect'), signal()));
  assert.equal(redirected, 0);
  await assert.rejects(shutdownHost(config('/timeout'), signal()), /timed out/);
  await assert.rejects(shutdownHost(config('/timeout'), AbortSignal.abort()));
});

test('command shutdown passes literal arguments without shell expansion', async () => {
  await shutdownHost(device({ shutdown: {
    type: 'command', command: process.execPath,
    args: ['-e', 'if (process.argv[1] !== "$(echo not-expanded)") process.exit(1)', '$(echo not-expanded)'],
  } }), signal());
});

test('command shutdown rejects nonzero exits, missing programs and timeouts without leaking output', async () => {
  await assert.rejects(shutdownHost(device({ shutdown: {
    type: 'command', command: process.execPath,
    args: ['-e', 'console.error("secret-value"); process.exit(2)'],
  } }), signal()), error => {
    assert.match(error.message, /failed \(2\)/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  await assert.rejects(shutdownHost(device({ shutdown: {
    type: 'command', command: 'homebridge-wol-tv-nonexistent-test-command',
  } }), signal()), /ENOENT/);
  await assert.rejects(shutdownHost(device({ shutdownTimeout: 100, shutdown: {
    type: 'command', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  } }), signal()), /timeout/);
  await assert.rejects(shutdownHost(device(), signal()), /not configured/);
});

test('stopping cancels in-flight HTTP shutdown and child processes', async t => {
  const server = createHttpServer(() => {});
  const port = await listen(t, server);
  const httpAbort = new AbortController();
  const httpPending = shutdownHost(device({ shutdown: {
    type: 'http', url: `http://127.0.0.1:${port}/shutdown`,
  } }), httpAbort.signal);
  httpAbort.abort();
  await assert.rejects(httpPending, /cancelled/);
  const commandAbort = new AbortController();
  const commandPending = shutdownHost(device({ shutdown: {
    type: 'command', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
  } }), commandAbort.signal);
  commandAbort.abort();
  await assert.rejects(commandPending, /cancelled/);
});
