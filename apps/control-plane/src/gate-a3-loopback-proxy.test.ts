import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATE_A3_LOOPBACK_PROXY_HOST,
  GATE_A3_LOOPBACK_PROXY_PORT,
  GATE_A3_RUNTIME_TARGET_PORT,
  startGateA3LoopbackProxy,
  startGateA3LoopbackProxyForTest,
  type GateA3LoopbackProxy,
} from './gate-a3-loopback-proxy.js';

type TestServer = Readonly<{
  port: number;
  sockets: Set<Socket>;
  close: () => Promise<void>;
}>;

const proxies: GateA3LoopbackProxy[] = [];
const testServers: TestServer[] = [];
const clients = new Set<Socket>();

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.all(proxies.splice(0).map(async (proxy) => await proxy.close()));
  await Promise.all(testServers.splice(0).map(async (server) => await server.close()));
});

async function listen(server: Server): Promise<TestServer> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, GATE_A3_LOOPBACK_PROXY_HOST, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port');
  }
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  };
  const result = { port: address.port, sockets, close };
  testServers.push(result);
  return result;
}

async function startTestProxy(
  targetPort: number,
  options: Readonly<{ listenPort?: number; connectTimeoutMs?: number; idleTimeoutMs?: number }> = {},
): Promise<GateA3LoopbackProxy> {
  const proxy = await startGateA3LoopbackProxyForTest({
    targetIpv4: GATE_A3_LOOPBACK_PROXY_HOST,
    targetPort,
    ...options,
  });
  proxies.push(proxy);
  return proxy;
}

async function connectClient(port: number, allowHalfOpen = false): Promise<Socket> {
  const client = createConnection({
    host: GATE_A3_LOOPBACK_PROXY_HOST,
    port,
    family: 4,
    allowHalfOpen,
  });
  clients.add(client);
  client.once('close', () => clients.delete(client));
  await once(client, 'connect');
  return client;
}

async function readToEnd(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

describe('Gate A.3 loopback TCP proxy', () => {
  it('keeps the production listener and runtime target port immutable', async () => {
    expect(GATE_A3_LOOPBACK_PROXY_HOST).toBe('127.0.0.1');
    expect(GATE_A3_LOOPBACK_PROXY_PORT).toBe(8100);
    expect(GATE_A3_RUNTIME_TARGET_PORT).toBe(8100);
    await expect(startGateA3LoopbackProxy('localhost')).rejects.toThrow(/literal private IPv4/u);
    await expect(startGateA3LoopbackProxy('127.0.0.1')).rejects.toThrow(/literal private IPv4/u);
    await expect(startGateA3LoopbackProxy('203.0.113.10')).rejects.toThrow(/literal private IPv4/u);
    await expect(startGateA3LoopbackProxyForTest({
      targetIpv4: '127.0.0.2' as '127.0.0.1',
      targetPort: 8100,
    })).rejects.toThrow(/only numeric loopback/u);
  });

  it('forwards a half-closed request and returns the response after target EOF', async () => {
    let request = '';
    const target = await listen(createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => {
        request = Buffer.concat(chunks).toString('utf8');
        socket.end(`reply:${request}`);
      });
    }));
    const proxy = await startTestProxy(target.port);
    const client = await connectClient(proxy.listenPort);

    client.end('work-order-request');
    await expect(readToEnd(client)).resolves.toEqual(Buffer.from('reply:work-order-request'));
    expect(request).toBe('work-order-request');
  });

  it('preserves the reverse half-close while the caller finishes sending', async () => {
    let receivedAfterTargetEnd = '';
    let resolveTargetRead!: () => void;
    const targetRead = new Promise<void>((resolve) => {
      resolveTargetRead = resolve;
    });
    const target = await listen(createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => {
        receivedAfterTargetEnd = Buffer.concat(chunks).toString('utf8');
        resolveTargetRead();
      });
      socket.end('target-finished-writing');
    }));
    const proxy = await startTestProxy(target.port);
    const client = await connectClient(proxy.listenPort, true);
    const responseChunks: Buffer[] = [];
    client.on('data', (chunk: Buffer) => responseChunks.push(chunk));

    await once(client, 'end');
    client.end('caller-finished-after-eof');
    await targetRead;

    expect(Buffer.concat(responseChunks).toString('utf8')).toBe('target-finished-writing');
    expect(receivedAfterTargetEnd).toBe('caller-finished-after-eof');
  });

  it('applies stream backpressure without truncating a delayed multi-megabyte request', async () => {
    let receivedBytes = 0;
    const target = await listen(createServer({ allowHalfOpen: true }, (socket) => {
      socket.pause();
      const resumeTimer = setTimeout(() => socket.resume(), 30);
      resumeTimer.unref();
      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
      });
      socket.once('end', () => socket.end(String(receivedBytes)));
    }));
    const proxy = await startTestProxy(target.port, { idleTimeoutMs: 2_000 });
    const client = await connectClient(proxy.listenPort);
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x61);

    client.end(payload);
    await expect(readToEnd(client)).resolves.toEqual(Buffer.from(String(payload.byteLength)));
    expect(receivedBytes).toBe(payload.byteLength);
  });

  it('closes both sides after a finite idle timeout', async () => {
    let targetSocket: Socket | undefined;
    const target = await listen(createServer((socket) => {
      targetSocket = socket;
    }));
    const proxy = await startTestProxy(target.port, { idleTimeoutMs: 40 });
    const client = await connectClient(proxy.listenPort);

    await waitForClose(client);
    expect(targetSocket).toBeDefined();
    await waitForClose(targetSocket!);
  });

  it('fails closed when the target connection cannot be established', async () => {
    const unused = await listen(createServer());
    const targetPort = unused.port;
    await unused.close();
    const proxy = await startTestProxy(targetPort, { connectTimeoutMs: 40 });
    const client = await connectClient(proxy.listenPort);

    await waitForClose(client);
  });

  it('rejects a listener collision without opening a target connection', async () => {
    let acceptedConnections = 0;
    const occupied = await listen(createServer(() => {
      acceptedConnections += 1;
    }));

    await expect(startGateA3LoopbackProxyForTest({
      targetIpv4: GATE_A3_LOOPBACK_PROXY_HOST,
      targetPort: occupied.port,
      listenPort: occupied.port,
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(acceptedConnections).toBe(0);
  });

  it('stops accepting and destroys active connections on close', async () => {
    let targetSocket: Socket | undefined;
    const target = await listen(createServer((socket) => {
      targetSocket = socket;
    }));
    const proxy = await startTestProxy(target.port);
    const client = await connectClient(proxy.listenPort);

    await proxy.close();
    await waitForClose(client);
    expect(targetSocket).toBeDefined();
    await waitForClose(targetSocket!);

    const refused = createConnection({
      host: GATE_A3_LOOPBACK_PROXY_HOST,
      port: proxy.listenPort,
      family: 4,
    });
    refused.on('error', () => undefined);
    await waitForClose(refused);
    expect(refused.destroyed).toBe(true);
  });
});
