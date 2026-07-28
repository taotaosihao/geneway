import { Agent, createServer, type Server } from 'node:http';
import { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GATE_A3_GEARJOB_BASE_URL, GATE_A3_GEARJOB_ENDPOINT } from '@geneway/contracts';
import {
  GEARJOB_CONNECT_TIMEOUT_MS,
  GEARJOB_FACADE_HOST_HEADER,
  GEARJOB_RESPONSE_TIMEOUT_MS,
  GearJobHttpProtocolError,
  GearJobHttpTimeoutError,
  requestGearJobFacade,
} from './gearjob-http.js';

type TimerEntry = {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
};

function manualTimers() {
  const entries: TimerEntry[] = [];
  return {
    api: {
      setTimeout(callback: () => void, delayMs: number): TimerEntry {
        const entry = { callback, delayMs, cleared: false };
        entries.push(entry);
        return entry;
      },
      clearTimeout(handle: unknown): void {
        (handle as TimerEntry).cleared = true;
      },
    },
    entries,
    fire(delayMs: number): void {
      const entry = entries.find((candidate) => !candidate.cleared && candidate.delayMs === delayMs);
      if (entry === undefined) throw new Error(`missing active ${delayMs}ms timer`);
      entry.cleared = true;
      entry.callback();
    },
  };
}

const servers: Server[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }));
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function target(workOrderRef = 'WO_2026-0001:REV.2'): URL {
  const value = new URL(GATE_A3_GEARJOB_ENDPOINT, GATE_A3_GEARJOB_BASE_URL);
  value.searchParams.set('work_order_ref', workOrderRef);
  return value;
}

const requestInit = {
  method: 'GET',
  redirect: 'manual',
  headers: { accept: 'application/json; charset=utf-8' },
} as const satisfies RequestInit;

describe('GearJob literal-loopback HTTP transport', () => {
  it('uses a strict 2s socket-connect budget and never retries a stalled connection', async () => {
    const timers = manualTimers();
    const socket = new Socket();
    Object.defineProperty(socket, 'connecting', { value: true, writable: true });
    let connectAttempts = 0;
    const agent = new Agent();
    agents.push(agent);
    agent.createConnection = () => {
      connectAttempts += 1;
      return socket;
    };

    const pending = requestGearJobFacade(target(), requestInit, { agent, timers: timers.api });
    expect(timers.entries).toEqual([
      expect.objectContaining({ delayMs: GEARJOB_CONNECT_TIMEOUT_MS, cleared: false }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    timers.fire(GEARJOB_CONNECT_TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({
      name: 'GearJobHttpTimeoutError',
      phase: 'connect',
    });
    expect(connectAttempts).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.destroyed).toBe(true);
    expect(timers.entries.some((entry) => entry.delayMs === GEARJOB_RESPONSE_TIMEOUT_MS)).toBe(false);
  });

  it('moves an actual TCP socket from the 2s connect budget to a strict 5s response budget', async () => {
    const timers = manualTimers();
    let requestCount = 0;
    let observedHost: string | undefined;
    let observedRemoteAddress: string | undefined;
    let markRequestSeen: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => { markRequestSeen = resolve; });
    const server = createServer((request, response) => {
      requestCount += 1;
      observedHost = request.headers.host;
      observedRemoteAddress = request.socket.remoteAddress;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.write('{"workOrderRef":');
      markRequestSeen?.();
      // Intentionally leave the response body open to exercise the full response phase.
    });
    const port = await listen(server);

    const pending = requestGearJobFacade(target(), requestInit, { connectPort: port, timers: timers.api });
    await requestSeen;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestCount).toBe(1);
    expect(observedHost).toBe(GEARJOB_FACADE_HOST_HEADER);
    expect(observedRemoteAddress).toBe('127.0.0.1');
    expect(timers.entries).toEqual([
      expect.objectContaining({ delayMs: GEARJOB_CONNECT_TIMEOUT_MS, cleared: true }),
      expect.objectContaining({ delayMs: GEARJOB_RESPONSE_TIMEOUT_MS, cleared: false }),
    ]);

    timers.fire(GEARJOB_RESPONSE_TIMEOUT_MS);
    await expect(pending).rejects.toBeInstanceOf(GearJobHttpTimeoutError);
    await expect(pending).rejects.toMatchObject({ phase: 'response' });
    expect(requestCount).toBe(1);
  });

  it('sends fixed Host and never follows a redirect or issues a second request', async () => {
    let redirectedRequests = 0;
    const redirected = createServer((_request, response) => {
      redirectedRequests += 1;
      response.end('must not be reached');
    });
    const redirectedPort = await listen(redirected);

    let sourceRequests = 0;
    let observedHost: string | undefined;
    let observedUrl: string | undefined;
    const source = createServer((request, response) => {
      sourceRequests += 1;
      observedHost = request.headers.host;
      observedUrl = request.url;
      response.writeHead(302, { location: `http://127.0.0.1:${redirectedPort}/unexpected` });
      response.end();
    });
    const sourcePort = await listen(source);

    const result = await requestGearJobFacade(target(), requestInit, { connectPort: sourcePort });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.status).toBe(302);
    expect(sourceRequests).toBe(1);
    expect(redirectedRequests).toBe(0);
    expect(observedHost).toBe(GEARJOB_FACADE_HOST_HEADER);
    expect(observedUrl).toBe(
      `${GATE_A3_GEARJOB_ENDPOINT}?work_order_ref=WO_2026-0001%3AREV.2`,
    );
  });

  it('handles bodyless statuses and rejects statuses outside the Fetch range without hanging', async () => {
    const noContentServer = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const noContentPort = await listen(noContentServer);
    await expect(requestGearJobFacade(target(), requestInit, { connectPort: noContentPort }))
      .resolves.toMatchObject({ status: 204 });

    const invalidStatusServer = createServer((_request, response) => {
      response.writeHead(600);
      response.end();
    });
    const invalidStatusPort = await listen(invalidStatusServer);
    await expect(requestGearJobFacade(target(), requestInit, { connectPort: invalidStatusPort }))
      .rejects.toBeInstanceOf(GearJobHttpProtocolError);
  });
});
