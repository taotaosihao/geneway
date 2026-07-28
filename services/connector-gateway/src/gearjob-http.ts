import {
  request as httpRequest,
  type Agent,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {
  GATE_A3_GEARJOB_BASE_URL,
  GATE_A3_GEARJOB_ENDPOINT,
} from '@geneway/contracts';

export const GEARJOB_CONNECT_TIMEOUT_MS = 2_000;
export const GEARJOB_RESPONSE_TIMEOUT_MS = 5_000;
export const GEARJOB_FACADE_HOST_HEADER = 'dev.localhost' as const;
export const GEARJOB_RESPONSE_MAX_BYTES = 64 * 1_024;

export class GearJobHttpTimeoutError extends Error {
  constructor(readonly phase: 'connect' | 'response') {
    super(`GearJob ${phase} timeout`);
    this.name = 'GearJobHttpTimeoutError';
  }
}

export class GearJobHttpProtocolError extends Error {
  constructor() {
    super('GearJob HTTP protocol violation');
    this.name = 'GearJobHttpProtocolError';
  }
}

type TimerApi = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type GearJobHttpTestHooks = Readonly<{
  agent?: Agent;
  connectPort?: number;
  timers?: TimerApi;
}>;

const systemTimers: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function assertExactTarget(target: URL, init: RequestInit): void {
  const keys = [...target.searchParams.keys()];
  if (target.origin !== GATE_A3_GEARJOB_BASE_URL
    || target.pathname !== GATE_A3_GEARJOB_ENDPOINT
    || target.username !== '' || target.password !== '' || target.hash !== ''
    || keys.length !== 1 || keys[0] !== 'work_order_ref'
    || target.searchParams.getAll('work_order_ref').length !== 1
    || init.method !== 'GET' || init.redirect !== 'manual' || init.body !== undefined) {
    throw new GearJobHttpProtocolError();
  }
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Performs exactly one HTTP request to the frozen literal-loopback GearJob
 * facade. A fresh socket is used so the connect and response budgets remain
 * distinct and observable; redirect handling and retries are deliberately
 * absent from this transport.
 */
export function requestGearJobFacade(
  target: URL,
  init: RequestInit,
  testHooks: GearJobHttpTestHooks = {},
): Promise<Response> {
  assertExactTarget(target, init);
  const timers = testHooks.timers ?? systemTimers;
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set('host', GEARJOB_FACADE_HOST_HEADER);
  requestHeaders.set('connection', 'close');

  return new Promise<Response>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let connectTimer: unknown;
    let responseTimer: unknown;
    let settled = false;

    const clearTimers = (): void => {
      if (connectTimer !== undefined) timers.clearTimeout(connectTimer);
      if (responseTimer !== undefined) timers.clearTimeout(responseTimer);
      connectTimer = undefined;
      responseTimer = undefined;
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      response?.destroy(error);
      request?.destroy(error);
      reject(error);
    };
    const beginResponsePhase = (): void => {
      if (settled || responseTimer !== undefined) return;
      if (connectTimer !== undefined) timers.clearTimeout(connectTimer);
      connectTimer = undefined;
      responseTimer = timers.setTimeout(
        () => fail(new GearJobHttpTimeoutError('response')),
        GEARJOB_RESPONSE_TIMEOUT_MS,
      );
    };

    connectTimer = timers.setTimeout(
      () => fail(new GearJobHttpTimeoutError('connect')),
      GEARJOB_CONNECT_TIMEOUT_MS,
    );

    try {
      request = httpRequest({
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: testHooks.connectPort ?? 8_100,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers: Object.fromEntries(requestHeaders.entries()),
        setHost: false,
        agent: testHooks.agent ?? false,
      }, (incoming) => {
        response = incoming;
        beginResponsePhase();
        const chunks: Uint8Array[] = [];
        let length = 0;
        incoming.on('data', (value: Buffer) => {
          if (settled) return;
          length += value.byteLength;
          if (length > GEARJOB_RESPONSE_MAX_BYTES) {
            fail(new GearJobHttpProtocolError());
            return;
          }
          chunks.push(value);
        });
        incoming.once('aborted', () => fail(new GearJobHttpProtocolError()));
        incoming.once('error', (error) => fail(error));
        incoming.once('end', () => {
          if (settled) return;
          const status = incoming.statusCode;
          const bodyForbidden = status === 204 || status === 205 || status === 304;
          if (status === undefined || status < 200 || status > 599 || (bodyForbidden && length !== 0)) {
            fail(new GearJobHttpProtocolError());
            return;
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          let result: Response;
          try {
            result = new Response(bodyForbidden ? null : bytes.buffer, {
              status,
              headers: responseHeaders(incoming),
            });
          } catch {
            fail(new GearJobHttpProtocolError());
            return;
          }
          settled = true;
          clearTimers();
          resolve(result);
        });
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error('GearJob request failed'));
      return;
    }

    request.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', beginResponsePhase);
      else if (!socket.destroyed) beginResponsePhase();
    });
    request.once('error', (error) => fail(error));
    request.end();
  });
}
