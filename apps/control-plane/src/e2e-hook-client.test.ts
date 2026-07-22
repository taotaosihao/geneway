import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseE2eHookEndpoint, postE2eHook } from './e2e-hook-client.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

describe('Control Plane E2E hook client', () => {
  it('accepts only the numeric loopback test endpoint and exact Worker token file', () => {
    const tokenFile = '/tmp/geneway-hook-token';
    expect(parseE2eHookEndpoint({
      url: 'http://127.0.0.1:43210/', nodeEnvironment: 'test', tokenFile, expectedTokenFile: tokenFile,
    }).href).toBe('http://127.0.0.1:43210/');
    expect(() => parseE2eHookEndpoint({
      url: 'http://localhost:43210/', nodeEnvironment: 'test', tokenFile, expectedTokenFile: tokenFile,
    })).toThrow(/numeric loopback/u);
    expect(() => parseE2eHookEndpoint({
      url: 'http://127.0.0.1:43210/', nodeEnvironment: 'production', tokenFile, expectedTokenFile: tokenFile,
    })).toThrow(/numeric loopback/u);
  });

  it('fails closed on a 307 redirect without forwarding the POST body', async () => {
    let redirectedRequests = 0;
    const targetPort = await listen(createServer((_request, response) => {
      redirectedRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"action":"inject_error"}');
    }));
    const redirectPort = await listen(createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${String(targetPort)}/captured` });
      response.end();
    }));
    const tokenFile = '/tmp/geneway-hook-token';
    const endpoint = parseE2eHookEndpoint({
      url: `http://127.0.0.1:${String(redirectPort)}/`, nodeEnvironment: 'test', tokenFile, expectedTokenFile: tokenFile,
    });
    await expect(postE2eHook(endpoint, 'test-token', { storageKey: 'sensitive-key' })).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
  });
});
