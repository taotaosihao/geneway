import {
  createConnection,
  createServer,
  isIPv4,
  type Server,
  type Socket,
} from 'node:net';

export const GATE_A3_LOOPBACK_PROXY_HOST = '127.0.0.1' as const;
export const GATE_A3_LOOPBACK_PROXY_PORT = 8100 as const;
export const GATE_A3_RUNTIME_TARGET_PORT = 8100 as const;

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

type ProxyConfiguration = Readonly<{
  listenPort: number;
  targetIpv4: string;
  targetPort: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
}>;

export type GateA3LoopbackProxy = Readonly<{
  listenHost: typeof GATE_A3_LOOPBACK_PROXY_HOST;
  listenPort: number;
  targetIpv4: string;
  targetPort: number;
  close: () => Promise<void>;
}>;

export type GateA3LoopbackProxyTestOptions = Readonly<{
  targetIpv4: typeof GATE_A3_LOOPBACK_PROXY_HOST;
  targetPort: number;
  listenPort?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}>;

type SocketPair = Readonly<{
  client: Socket;
  target: Socket;
  abort: () => void;
}>;

function isPrivateIpv4(value: string): boolean {
  if (!isIPv4(value)) return false;
  const octets = value.split('.').map(Number);
  const first = octets[0];
  const second = octets[1];
  return first === 10
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function assertPort(value: number, allowEphemeral: boolean): void {
  const minimum = allowEphemeral ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new Error('Gate A.3 loopback proxy port is invalid');
  }
}

function assertTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 10 || value > 120_000) {
    throw new Error('Gate A.3 loopback proxy timeout is invalid');
  }
}

function attachSocketPair(
  client: Socket,
  configuration: ProxyConfiguration,
  activePairs: Set<SocketPair>,
): void {
  client.pause();
  client.setNoDelay(true);

  const target = createConnection({
    host: configuration.targetIpv4,
    port: configuration.targetPort,
    family: 4,
    allowHalfOpen: true,
  });
  target.setNoDelay(true);

  let aborted = false;
  let clientReadEnded = false;
  let targetReadEnded = false;
  let clientClosed = false;
  let targetClosed = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    clearTimeout(connectTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  };

  const removeWhenClosed = (): void => {
    if (!clientClosed || !targetClosed) return;
    clearTimers();
    activePairs.delete(pair);
  };

  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    clearTimers();
    client.unpipe(target);
    target.unpipe(client);
    client.destroy();
    target.destroy();
  };

  const armIdleTimer = (): void => {
    if (aborted) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, configuration.idleTimeoutMs);
    idleTimer.unref();
  };

  const pair: SocketPair = { client, target, abort };
  activePairs.add(pair);

  const connectTimer = setTimeout(abort, configuration.connectTimeoutMs);
  connectTimer.unref();

  client.once('error', abort);
  target.once('error', abort);

  client.once('end', () => {
    clientReadEnded = true;
    if (!target.destroyed) target.end();
  });
  target.once('end', () => {
    targetReadEnded = true;
    if (!client.destroyed) client.end();
  });

  client.once('close', () => {
    clientClosed = true;
    if (!aborted && !(clientReadEnded && targetReadEnded)) abort();
    removeWhenClosed();
  });
  target.once('close', () => {
    targetClosed = true;
    if (!aborted && !(clientReadEnded && targetReadEnded)) abort();
    removeWhenClosed();
  });

  target.once('connect', () => {
    if (aborted) return;
    clearTimeout(connectTimer);
    client.on('data', armIdleTimer);
    target.on('data', armIdleTimer);
    client.pipe(target, { end: false });
    target.pipe(client, { end: false });
    armIdleTimer();
    client.resume();
  });
}

async function listen(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string'
        || address.address !== GATE_A3_LOOPBACK_PROXY_HOST) {
        reject(new Error('Gate A.3 loopback proxy did not bind its exact loopback authority'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({
      host: GATE_A3_LOOPBACK_PROXY_HOST,
      port,
      exclusive: true,
    });
  });
}

async function startProxy(configuration: ProxyConfiguration): Promise<GateA3LoopbackProxy> {
  const activePairs = new Set<SocketPair>();
  let stopping = false;
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (stopping) {
      client.destroy();
      return;
    }
    attachSocketPair(client, configuration, activePairs);
  });

  let actualPort: number;
  try {
    actualPort = await listen(server, configuration.listenPort);
  } catch (error) {
    for (const pair of activePairs) pair.abort();
    if (server.listening) server.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    stopping = true;
    for (const pair of activePairs) pair.abort();
    closePromise = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    return closePromise;
  };

  server.on('error', () => {
    void close().catch(() => undefined);
  });

  return {
    listenHost: GATE_A3_LOOPBACK_PROXY_HOST,
    listenPort: actualPort,
    targetIpv4: configuration.targetIpv4,
    targetPort: configuration.targetPort,
    close,
  };
}

export async function startGateA3LoopbackProxy(targetIpv4: string): Promise<GateA3LoopbackProxy> {
  if (!isPrivateIpv4(targetIpv4)) {
    throw new Error('Gate A.3 runtime target must be a literal private IPv4 address');
  }
  return await startProxy({
    listenPort: GATE_A3_LOOPBACK_PROXY_PORT,
    targetIpv4,
    targetPort: GATE_A3_RUNTIME_TARGET_PORT,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  });
}

export async function startGateA3LoopbackProxyForTest(
  options: GateA3LoopbackProxyTestOptions,
): Promise<GateA3LoopbackProxy> {
  if (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true') {
    throw new Error('Gate A.3 loopback proxy test options are available only inside Vitest');
  }
  if (options.targetIpv4 !== GATE_A3_LOOPBACK_PROXY_HOST) {
    throw new Error('Gate A.3 loopback proxy tests may target only numeric loopback');
  }
  const listenPort = options.listenPort ?? 0;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  assertPort(listenPort, true);
  assertPort(options.targetPort, false);
  assertTimeout(connectTimeoutMs);
  assertTimeout(idleTimeoutMs);
  return await startProxy({
    listenPort,
    targetIpv4: options.targetIpv4,
    targetPort: options.targetPort,
    connectTimeoutMs,
    idleTimeoutMs,
  });
}
