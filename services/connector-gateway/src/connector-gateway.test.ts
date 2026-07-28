import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATE_A3_CANONICALIZATION_VERSION,
  GATE_A3_CONNECTOR_PROFILE_VERSION,
  GATE_A3_FIELD_MASK_VERSION,
  GATE_A3_GEARJOB_ENDPOINT,
  GATE_A3_WORK_ORDER_FIELD_MASK,
  canonicalizeGateA3Jcs,
  digestGateA3Jcs,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorWorkOrderResponseSchema,
  type GateA3ConnectorCurrentAuthorityResponse,
  type GateA3ConnectorInvocationTokenClaims,
  type GateA3ConnectorQuerySpec,
} from '@geneway/contracts';
import {
  CONNECTOR_GATEWAY_PATH,
  CONNECTOR_READINESS_PATH,
  CONNECTOR_RATE_LIMIT_PER_MINUTE,
  GEARJOB_RESPONSE_CONTENT_TYPE,
  createConnectorGateway,
} from './index.js';

const invocationSecret = 'invocation-secret-value-at-least-32-bytes';
const receiptSecret = 'receipt-secret-value-at-least-32-bytes-xxxx';
const serviceToken = 'service-token-value-at-least-32-bytes-xxxxx';
const gearJobCredential = 'api-key-value:api-secret-value-at-least-32-bytes';
const nowMs = Date.parse('2026-07-27T01:02:03.004Z');
const deadline = '2026-07-27T01:03:00.000Z';
const digest = 'a'.repeat(64);
const apps: Array<ReturnType<typeof createConnectorGateway>> = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function uuid(number: number, prefix = '1'): string {
  return `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${number.toString(16).padStart(12, '0')}`;
}

function signToken(claims: unknown): string {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', invocationSecret).update(encoded, 'utf8').digest('base64url')}`;
}

async function fixture(index = 1): Promise<Readonly<{
  claims: GateA3ConnectorInvocationTokenClaims;
  spec: GateA3ConnectorQuerySpec;
  token: string;
  body: Readonly<Record<string, unknown>>;
}>> {
  const workOrderRef = 'WO_2026-0001:REV.2';
  const workOrderRefHash = await rawDigest(workOrderRef);
  const spec: GateA3ConnectorQuerySpec = {
    schemaVersion: 'connector-query-spec/1', canonicalizationVersion: GATE_A3_CANONICALIZATION_VERSION,
    specId: 'spec.1', capabilityVersionId: 'cap_production_work_order_status_v1_1', releaseRecordId: 'release.1',
    approvedPreflightDigest: digest, connectorProfileVersion: GATE_A3_CONNECTOR_PROFILE_VERSION,
    baseUrl: 'http://127.0.0.1:8100', endpoint: GATE_A3_GEARJOB_ENDPOINT, method: 'GET',
    endpointMethodAllowlistDigest: digest, fieldMaskVersion: GATE_A3_FIELD_MASK_VERSION,
    fieldMask: [...GATE_A3_WORK_ORDER_FIELD_MASK], workOrderRef, tenantId: 'tenant_local', principal: 'user_local',
    resourceContextDigest: digest, workflowVersionId: 'workflow.1', workflowHash: digest,
    stepId: 'fetch_authorized_status', budget: { maxAttempts: 2, timeoutMs: 2_000 }, deadline,
    publicErrorPolicyVersion: 'gearjob.not-found-forbidden-equivalent/1', cardSchemaVersion: 'WorkOrderStatusCard/1',
  };
  const querySpecHash = await digestGateA3Jcs(spec);
  const claims: GateA3ConnectorInvocationTokenClaims = {
    schemaVersion: 'connector-invocation-token/1', iss: 'geneway-control-plane',
    aud: 'gearjob-work-order-status-connector', tenantId: spec.tenantId, principal: spec.principal,
    taskId: 'task.1', workflowVersionId: spec.workflowVersionId, workflowHash: spec.workflowHash,
    stepId: 'fetch_authorized_status', attemptId: `attempt.${index}`, effectId: 'effect.1',
    connectorInvocationId: uuid(index, '1'), connectorQuerySpecHash: querySpecHash,
    connectorProfileVersion: spec.connectorProfileVersion, workOrderRefHash,
    fieldMaskVersion: spec.fieldMaskVersion, resourceContextDigest: spec.resourceContextDigest,
    deadline, fence: index, jti: uuid(index, '2'), iat: Math.floor(nowMs / 1_000), exp: Math.floor(nowMs / 1_000) + 60,
  };
  const token = signToken(claims);
  return {
    claims, spec, token,
    body: { schemaVersion: 'gate-a3-connector-gateway-request/1', invocationToken: token, querySpec: spec, querySpecHash },
  };
}

async function rawDigest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function authority(claims: GateA3ConnectorInvocationTokenClaims): GateA3ConnectorCurrentAuthorityResponse {
  const identity = Object.fromEntries(Object.entries(claims).filter(([key]) => (
    !['schemaVersion', 'iss', 'aud', 'iat', 'exp'].includes(key)
  ))) as Omit<GateA3ConnectorInvocationTokenClaims, 'schemaVersion' | 'iss' | 'aud' | 'iat' | 'exp'>;
  return {
    schemaVersion: 'gate-a3-connector-current-authority-response/1', active: true,
    checkedAt: new Date(nowMs).toISOString(), ...identity,
  };
}

const successfulPayload = {
  workOrderRef: 'WO_2026-0001:REV.2', status: 'In Process', planQty: 100, completedQty: 40, unit: 'Nos',
  plannedStart: '2026-07-27T00:00:00.000000Z', plannedEnd: null,
  updatedAt: '2026-07-27T01:02:03.004000Z', sourceRevision: 'modified:2026-07-27T01:02:03.004000Z',
} as const;

function response(body: unknown = successfulPayload, status = 200, contentType: string = GEARJOB_RESPONSE_CONTENT_TYPE): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

async function post(app: ReturnType<typeof createConnectorGateway>, body: unknown) {
  return app.inject({
    method: 'POST', url: CONNECTOR_GATEWAY_PATH,
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' }, payload: body as object,
  });
}

function parseRecord(body: string): Readonly<Record<string, unknown>> {
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object response');
  return value as Readonly<Record<string, unknown>>;
}

describe('Connector Gateway receiver and provider boundary', () => {
  it('keeps readiness authority-neutral with zero GearJob business requests', async () => {
    let calls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: 'http://127.0.0.1:8100',
      gearJobRequestForTest: () => {
        calls += 1;
        return Promise.reject(new Error('readiness must not touch GearJob'));
      },
    });
    apps.push(app);
    expect((await app.inject({
      method: 'GET', url: CONNECTOR_READINESS_PATH,
      headers: { authorization: `Bearer ${serviceToken}` },
    })).json()).toEqual({
      ready: true,
      profile: GATE_A3_CONNECTOR_PROFILE_VERSION,
      receiver: 'invocation-authority-required',
    });
    expect(calls).toBe(0);
    const unauthorized = await app.inject({
      method: 'GET', url: CONNECTOR_READINESS_PATH,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ ready: false });
    expect(calls).toBe(0);
  });

  it('introspects first, then sends one exact loopback GET and returns a signed strict receipt', async () => {
    const input = await fixture();
    const order: string[] = [];
    const calls: Array<Readonly<{ input: string; init: RequestInit | undefined }>> = [];
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => { order.push('introspect'); return Promise.resolve(authority(claims)); },
      gearJobRequestForTest: (request, init) => {
        order.push('gearjob');
        calls.push({ input: request.href, init });
        return Promise.resolve(response());
      },
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(200);
    expect(order).toEqual(['introspect', 'gearjob']);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const url = new URL(call.input);
    expect(url.origin).toBe(input.spec.baseUrl);
    expect(url.pathname).toBe(GATE_A3_GEARJOB_ENDPOINT);
    expect([...url.searchParams]).toEqual([['work_order_ref', input.spec.workOrderRef]]);
    expect(call.init?.method).toBe('GET');
    expect(call.init?.redirect).toBe('manual');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBe(`token ${gearJobCredential}`);
    expect(headers.get('x-geneway-connector-token')).toBe(input.token);
    const body = parseRecord(result.body);
    expect(gateA3ConnectorWorkOrderResponseSchema.parse(body.response)).toEqual(successfulPayload);
    const receipt = gateA3ConnectorGatewayReceiptSchema.parse(body.receipt);
    expect(receipt.payload.outcome).toBe('completed');
    const expectedSignature = createHmac('sha256', receiptSecret)
      .update(canonicalizeGateA3Jcs(receipt.payload), 'utf8').digest('base64url');
    expect(receipt.signature).toBe(expectedSignature);
    expect(result.body).not.toContain(gearJobCredential);
  });

  it('uses the exact authenticated production introspection receiver before the GearJob origin', async () => {
    const input = await fixture();
    const calls: string[] = [];
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      fetchImpl: (request, init) => {
        const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
        calls.push(url);
        expect(url).toBe('http://127.0.0.1:3100/internal/connector-gateway/v1/introspect');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${serviceToken}`);
        const requestBody = init?.body;
        if (typeof requestBody !== 'string') throw new Error('introspection body must be JSON text');
        expect(requestBody).not.toContain(gearJobCredential);
        return Promise.resolve(response(authority(input.claims)));
      },
      gearJobRequestForTest: (request) => {
        calls.push(request.href);
        return Promise.resolve(response());
      },
    });
    apps.push(app);
    expect((await post(app, input.body)).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('http://127.0.0.1:3100/internal/connector-gateway/v1/introspect');
    expect(new URL(calls[1]!).origin).toBe(input.spec.baseUrl);
  });

  it.each([
    ['different response ref', { ...successfulPayload, workOrderRef: 'WO-DIFFERENT' }],
    ['array response', [successfulPayload]],
    ['single-key wrapper', { data: successfulPayload }],
    ['multi-object wrapper', { items: [successfulPayload, successfulPayload] }],
    ['extra response field', { ...successfulPayload, customer: 'must-not-cross' }],
    ['non-finite wire value', '{"workOrderRef":"WO_2026-0001:REV.2","status":"x","planQty":1e999,"completedQty":0,"unit":null,"plannedStart":null,"plannedEnd":null,"updatedAt":"2026-07-27T01:02:03.004000Z","sourceRevision":"r"}'],
  ])('rejects strict receiver violation: %s', async (_label, bodyValue) => {
    const input = await fixture();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
      gearJobRequestForTest: () => {
        facadeCalls += 1;
        return Promise.resolve(typeof bodyValue === 'string'
          ? new Response(bodyValue, { headers: { 'content-type': GEARJOB_RESPONSE_CONTENT_TYPE } })
          : response(bodyValue));
      },
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(502);
    expect(parseRecord(result.body).errorClass).toBe('CONNECTOR_PROTOCOL_VIOLATION');
    expect(facadeCalls).toBe(1);
    expect(result.body).not.toContain('customer');
  });

  it('maps forbidden and absent responses to one public result', async () => {
    for (const status of [403, 404]) {
      const input = await fixture(status);
      const app = createConnectorGateway({
        serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
        controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
        authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
        gearJobRequestForTest: () => Promise.resolve(response({ code: 'details-must-not-cross' }, status)),
      });
      apps.push(app);
      const result = await post(app, input.body);
      expect(result.statusCode).toBe(404);
      expect(parseRecord(result.body).errorClass).toBe('CONNECTOR_NOT_FOUND_OR_FORBIDDEN');
      expect(result.body).not.toContain('details-must-not-cross');
    }
  });

  it('maps a rejected GearJob service credential to a signed authentication failure receipt', async () => {
    const input = await fixture();
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
      gearJobRequestForTest: () => Promise.resolve(response({ detail: 'must-not-cross' }, 401)),
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(401);
    const body = parseRecord(result.body);
    expect(body.errorClass).toBe('CONNECTOR_AUTH_FAILED');
    const receipt = gateA3ConnectorGatewayReceiptSchema.parse(body.receipt);
    expect(receipt.payload.outcome).toBe('CONNECTOR_AUTH_FAILED');
    expect(result.body).not.toContain('must-not-cross');
  });
});

describe('Connector Gateway replay, rate, redirect and zero-pre-network-request gates', () => {
  it('atomically denies a concurrent replay before a second GearJob request', async () => {
    const input = await fixture();
    const consumed = new Set<string>();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => {
        if (consumed.has(claims.jti)) return Promise.resolve({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false } as const);
        consumed.add(claims.jti);
        return Promise.resolve(authority(claims));
      },
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    const [first, replay] = await Promise.all([post(app, input.body), post(app, input.body)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 401]);
    expect(facadeCalls).toBe(1);
  });

  it('performs current-authority introspection before the 120/min tenant+principal+profile rate limit', async () => {
    const input = await fixture();
    let introspections = 0;
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => { introspections += 1; return Promise.resolve(authority(claims)); },
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    let lastStatus = 0;
    for (let index = 1; index <= CONNECTOR_RATE_LIMIT_PER_MINUTE + 1; index += 1) {
      const attempt = await fixture(index);
      lastStatus = (await post(app, attempt.body)).statusCode;
    }
    expect(lastStatus).toBe(429);
    expect(introspections).toBe(CONNECTOR_RATE_LIMIT_PER_MINUTE + 1);
    expect(facadeCalls).toBe(CONNECTOR_RATE_LIMIT_PER_MINUTE);
  });

  it.each([
    ['redirect', () => response({}, 302)],
    ['cross-host response', () => {
      const redirected = response();
      Object.defineProperty(redirected, 'url', { value: 'http://127.0.0.1:9999/unexpected' });
      return redirected;
    }],
  ])('rejects %s without following or making a second request', async (_label, responseFactory) => {
    const input = await fixture();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
      gearJobRequestForTest: (_request, init) => {
        facadeCalls += 1;
        expect(init?.redirect).toBe('manual');
        return Promise.resolve(responseFactory());
      },
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(502);
    expect(facadeCalls).toBe(1);
  });

  it.each([
    ['bad HMAC', (input: Awaited<ReturnType<typeof fixture>>) => ({ ...input.body, invocationToken: `${input.token}x` })],
    ['spec hash drift', (input: Awaited<ReturnType<typeof fixture>>) => ({ ...input.body, querySpecHash: 'b'.repeat(64) })],
    ['wrong ref binding', (input: Awaited<ReturnType<typeof fixture>>) => ({
      ...input.body, querySpec: { ...input.spec, workOrderRef: 'WO-OTHER' },
    })],
    ['wrong method', (input: Awaited<ReturnType<typeof fixture>>) => ({
      ...input.body, querySpec: { ...input.spec, method: 'POST' },
    })],
    ['wrong endpoint', (input: Awaited<ReturnType<typeof fixture>>) => ({
      ...input.body, querySpec: { ...input.spec, endpoint: '/api/method/another' },
    })],
    ['wrong field mask', (input: Awaited<ReturnType<typeof fixture>>) => ({
      ...input.body, querySpec: { ...input.spec, fieldMask: [...input.spec.fieldMask].reverse() },
    })],
  ])('rejects %s with zero introspection and zero GearJob request', async (_label, mutate) => {
    const input = await fixture();
    let introspections = 0;
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => { introspections += 1; return Promise.resolve(authority(claims)); },
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    const result = await post(app, mutate(input));
    expect(result.statusCode).toBe(401);
    expect(introspections).toBe(0);
    expect(facadeCalls).toBe(0);
  });

  it.each([
    ['issuer', (claims: GateA3ConnectorInvocationTokenClaims) => ({ ...claims, iss: 'worker' })],
    ['audience', (claims: GateA3ConnectorInvocationTokenClaims) => ({ ...claims, aud: 'local-model-gateway' })],
    ['profile', (claims: GateA3ConnectorInvocationTokenClaims) => ({ ...claims, connectorProfileVersion: 'profile.drift' })],
    ['expired time', (claims: GateA3ConnectorInvocationTokenClaims) => ({ ...claims, iat: claims.iat - 120, exp: claims.iat - 60 })],
  ])('rejects signed token %s drift before introspection/network', async (_label, mutateClaims) => {
    const input = await fixture();
    let introspections = 0;
    let facadeCalls = 0;
    const invocationToken = signToken(mutateClaims(input.claims));
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => { introspections += 1; return Promise.resolve(authority(claims)); },
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    expect((await post(app, { ...input.body, invocationToken })).statusCode).toBe(401);
    expect(introspections).toBe(0);
    expect(facadeCalls).toBe(0);
  });

  it.each([
    ['attemptId', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, attemptId: 'attempt.drift' })],
    ['effectId', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, effectId: 'effect.drift' })],
    ['connectorInvocationId', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, connectorInvocationId: uuid(999, '3') })],
    ['fence', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, fence: 999 })],
    ['connectorQuerySpecHash', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, connectorQuerySpecHash: 'b'.repeat(64) })],
    ['connectorProfileVersion', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, connectorProfileVersion: 'profile.drift' })],
    ['workOrderRefHash', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, workOrderRefHash: 'b'.repeat(64) })],
    ['fieldMaskVersion', (value: GateA3ConnectorCurrentAuthorityResponse) => ({ ...value, fieldMaskVersion: 'mask.drift' })],
  ])('rejects current-authority %s drift before GearJob I/O', async (_label, mutateAuthority) => {
    const input = await fixture();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => Promise.resolve(mutateAuthority(authority(claims)) as GateA3ConnectorCurrentAuthorityResponse),
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    expect((await post(app, input.body)).statusCode).toBe(401);
    expect(facadeCalls).toBe(0);
  });

  it('fails closed on current-authority rejection with zero GearJob request', async () => {
    const input = await fixture();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: () => Promise.resolve({ schemaVersion: 'gate-a3-connector-current-authority-response/1', active: false }),
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.resolve(response()); },
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(401);
    expect(facadeCalls).toBe(0);
  });

  it('enforces exact content type and bounded response body', async () => {
    for (const facadeResponse of [
      response(successfulPayload, 200, 'application/json'),
      new Response('x'.repeat(64 * 1_024 + 1), { headers: { 'content-type': GEARJOB_RESPONSE_CONTENT_TYPE } }),
    ]) {
      const input = await fixture();
      const app = createConnectorGateway({
        serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
        controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
        authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
        gearJobRequestForTest: () => Promise.resolve(facadeResponse),
      });
      apps.push(app);
      expect((await post(app, input.body)).statusCode).toBe(502);
    }
  });

  it('maps the bounded facade timeout without retry or a second request', async () => {
    const input = await fixture();
    let facadeCalls = 0;
    const app = createConnectorGateway({
      serviceToken, invocationSecret, receiptSecret, gearJobCredential, now: () => nowMs,
      controlPlaneUrl: 'http://127.0.0.1:3100', facadeBaseUrl: input.spec.baseUrl,
      authorizeInvocationForTest: (_request, claims) => Promise.resolve(authority(claims)),
      gearJobRequestForTest: () => { facadeCalls += 1; return Promise.reject(new DOMException('timeout', 'TimeoutError')); },
    });
    apps.push(app);
    const result = await post(app, input.body);
    expect(result.statusCode).toBe(504);
    expect(parseRecord(result.body).errorClass).toBe('CONNECTOR_TIMEOUT');
    expect(facadeCalls).toBe(1);
  });
});
