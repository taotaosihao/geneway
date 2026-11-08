import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export async function createLocalCertificate(root) {
  await mkdir(root, { recursive: true });
  const keyFile = path.join(root, 'server.key.pem'), certFile = path.join(root, 'server.cert.pem');
  const generated = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  return { keyFile, certFile };
}
// Trust only the explicitly generated experiment CA; default TLS verification stays on.
export async function createWireFetch({ caFile, token, logFile, fromProcess = process.pid, targetProcess = null }) {
  const ca = caFile ? await readFile(caFile) : undefined;
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = options.method ?? 'GET', headers = Object.fromEntries(new Headers(options.headers).entries());
    if (token) headers.authorization = `Bearer ${token}`;
    const body = options.body ?? null;
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, ...(url.protocol === 'https:' && ca ? { ca } : {}), signal: options.signal }, async response => {
        const safeHeaders = { ...headers }; delete safeHeaders.authorization;
        if (logFile) await appendFile(logFile, JSON.stringify({ at: startedAt, fromProcess, toProcess: targetProcess, direction: 'outbound', method, url: String(url), headers: safeHeaders, requestBody: body && String(body), requestBytes: body ? Buffer.byteLength(String(body)) : 0, status: response.statusCode }) + '\n');
        resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key,value]) => [key, Array.isArray(value) ? value.join(', ') : value])) }));
      });
      request.once('error', reject);
      if (body) request.write(body); request.end();
    });
  };
}
export async function createA2aClient({ origin, token, caFile, logFile, targetProcess }) {
  const {ClientFactory,JsonRpcTransportFactory,DefaultAgentCardResolver}=await import('@a2a-js/sdk/client');
  const fetchImpl = await createWireFetch({ token, caFile, logFile, targetProcess });
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(origin);
}
export function applicationMessage(messageId, value) { return { message: { messageId, role: 1, parts: [{ content: { $case: 'data', value }, mediaType: 'application/json', filename: '' }], extensions: [], referenceTaskIds: [] } }; }
export function applicationReply(result) { const message = result.message ?? result; return message.parts?.find(part => part.content?.$case === 'data')?.content.value; }
