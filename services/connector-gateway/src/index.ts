import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  GATE_A3_CONNECTOR_PROFILE_VERSION,
  GATE_A3_FIELD_MASK_VERSION,
  GATE_A3_GEARJOB_BASE_URL,
  GATE_A3_GEARJOB_ENDPOINT,
  canonicalizeGateA3Jcs,
  digestGateA3Jcs,
  gateA3ConnectorCurrentAuthorityRequestSchema,
  gateA3ConnectorCurrentAuthorityResponseSchema,
  gateA3ConnectorGatewayReceiptPayloadSchema,
  gateA3ConnectorGatewayReceiptSchema,
  gateA3ConnectorGatewayRequestSchema,
  gateA3ConnectorInvocationTokenClaimsSchema,
  gateA3ConnectorWorkOrderResponseSchema,
  type GateA3ConnectorCurrentAuthorityRequest,
  type GateA3ConnectorCurrentAuthorityResponse,
  type GateA3ConnectorGatewayReceipt,
  type GateA3ConnectorGatewayReceiptPayload,
  type GateA3ConnectorInvocationTokenClaims,
} from '@geneway/contracts';
import {
  GEARJOB_RESPONSE_MAX_BYTES,
  GearJobHttpProtocolError,
  GearJobHttpTimeoutError,
  requestGearJobFacade,
} from './gearjob-http.js';

export {
  GEARJOB_CONNECT_TIMEOUT_MS,
  GEARJOB_FACADE_HOST_HEADER,
  GEARJOB_RESPONSE_MAX_BYTES,
  GEARJOB_RESPONSE_TIMEOUT_MS,
  GearJobHttpTimeoutError,
} from './gearjob-http.js';

export const CONNECTOR_GATEWAY_PATH = '/internal/connector-gateway/v1/work-order-status' as const;
export const CONNECTOR_INTROSPECTION_PATH = '/internal/connector-gateway/v1/introspect' as const;
export const CONNECTOR_READINESS_PATH = '/internal/connector-gateway/v1/readiness' as const;
export const GEARJOB_RESPONSE_CONTENT_TYPE = 'application/json; charset=utf-8' as const;
export const CONNECTOR_RATE_LIMIT_PER_MINUTE = 120;

type Fetch = typeof globalThis.fetch;

export type ConnectorGatewayOptions = Readonly<{
  serviceToken: string;
  invocationSecret: string;
  receiptSecret: string;
  controlPlaneUrl: string;
  facadeBaseUrl: string;
  gearJobCredential: string;
  logger?: boolean;
  fetchImpl?: Fetch;
  gearJobRequestForTest?: (target: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
  authorizeInvocationForTest?: (
    request: GateA3ConnectorCurrentAuthorityRequest,
    claims: GateA3ConnectorInvocationTokenClaims,
  ) => Promise<GateA3ConnectorCurrentAuthorityResponse>;
}>;

class ConnectorFailure extends Error {
  constructor(
    readonly errorClass: zConnectorErrorClass,
    readonly statusCode: number,
    readonly responseRefMatched: boolean | null = null,
  ) {
    super(errorClass);
  }
}

type zConnectorErrorClass =
  | 'CONNECTOR_AUTH_FAILED'
  | 'CONNECTOR_RATE_LIMITED'
  | 'CONNECTOR_ROUTE_UNAVAILABLE'
  | 'CONNECTOR_TIMEOUT'
  | 'CONNECTOR_PROTOCOL_VIOLATION'
  | 'CONNECTOR_NOT_FOUND_OR_FORBIDDEN';

function exactLoopbackOrigin(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.origin !== value) {
    throw new Error(`${label} must be an exact IPv4 loopback origin`);
  }
  return url;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function verifyInvocationToken(token: string, secret: string, nowMs: number): GateA3ConnectorInvocationTokenClaims {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
  const expectedSignature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
  }
  let claims: GateA3ConnectorInvocationTokenClaims;
  try {
    claims = gateA3ConnectorInvocationTokenClaimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch {
    throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
  }
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (claims.iat > nowSeconds + 5 || claims.exp < nowSeconds - 5 || Date.parse(claims.deadline) <= nowMs) {
    throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
  }
  return claims;
}

async function sha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const stable = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stable).set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stable);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const authorityIdentityKeys = [
  'tenantId', 'principal', 'taskId', 'workflowVersionId', 'workflowHash', 'stepId', 'attemptId', 'effectId',
  'connectorInvocationId', 'connectorQuerySpecHash', 'connectorProfileVersion', 'workOrderRefHash',
  'fieldMaskVersion', 'resourceContextDigest', 'deadline', 'fence', 'jti',
] as const;

function authorityMatchesClaims(
  authority: GateA3ConnectorCurrentAuthorityResponse,
  claims: GateA3ConnectorInvocationTokenClaims,
): authority is Extract<GateA3ConnectorCurrentAuthorityResponse, { active: true }> {
  return authority.active && authorityIdentityKeys.every((key) => authority[key] === claims[key]);
}

function claimsMatchQuerySpec(
  claims: GateA3ConnectorInvocationTokenClaims,
  request: ReturnType<typeof gateA3ConnectorGatewayRequestSchema.parse>,
  expectedFacadeOrigin: string,
): Promise<boolean> {
  return Promise.all([
    digestGateA3Jcs(request.querySpec),
    sha256Utf8(request.querySpec.workOrderRef),
  ]).then(([querySpecHash, workOrderRefHash]) => (
    querySpecHash === request.querySpecHash
    && request.querySpecHash === claims.connectorQuerySpecHash
    && workOrderRefHash === claims.workOrderRefHash
    && request.querySpec.baseUrl === expectedFacadeOrigin
    && request.querySpec.endpoint === GATE_A3_GEARJOB_ENDPOINT
    && request.querySpec.method === 'GET'
    && request.querySpec.tenantId === claims.tenantId
    && request.querySpec.principal === claims.principal
    && request.querySpec.workflowVersionId === claims.workflowVersionId
    && request.querySpec.workflowHash === claims.workflowHash
    && request.querySpec.stepId === claims.stepId
    && request.querySpec.connectorProfileVersion === claims.connectorProfileVersion
    && request.querySpec.fieldMaskVersion === claims.fieldMaskVersion
    && request.querySpec.resourceContextDigest === claims.resourceContextDigest
    && request.querySpec.deadline === claims.deadline
  ));
}

function receiptIdentity(claims: GateA3ConnectorInvocationTokenClaims): Pick<
GateA3ConnectorGatewayReceiptPayload,
typeof authorityIdentityKeys[number]
> {
  return Object.fromEntries(authorityIdentityKeys.map((key) => [key, claims[key]])) as Pick<
  GateA3ConnectorGatewayReceiptPayload,
  typeof authorityIdentityKeys[number]
  >;
}

function signReceipt(
  claims: GateA3ConnectorInvocationTokenClaims,
  outcome: Readonly<{
    outcome: 'completed'; responseRefMatched: true; sourceRevision: string; responseCanonicalHash: string;
  }> | Readonly<{
    outcome: zConnectorErrorClass; responseRefMatched: boolean | null; retryNotBefore?: string;
  }>,
  secret: string,
  nowMs: number,
): GateA3ConnectorGatewayReceipt {
  const payload = gateA3ConnectorGatewayReceiptPayloadSchema.parse({
    schemaVersion: 'gate-a3-connector-gateway-receipt/1',
    issuer: 'geneway-connector-gateway',
    audience: 'geneway-control-plane',
    receiptJti: randomUUID(),
    ...receiptIdentity(claims),
    issuedAt: new Date(nowMs).toISOString(),
    ...outcome,
    ...(outcome.outcome === 'completed' ? {} : { sourceRevision: null, responseCanonicalHash: null }),
  });
  const signature = createHmac('sha256', secret).update(canonicalizeGateA3Jcs(payload), 'utf8').digest('base64url');
  return gateA3ConnectorGatewayReceiptSchema.parse({ payload, signature });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type') !== GEARJOB_RESPONSE_CONTENT_TYPE) {
    throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
  }
  if (response.body === null) throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > GEARJOB_RESPONSE_MAX_BYTES) throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
  }
}

export function createConnectorGateway(options: ConnectorGatewayOptions): FastifyInstance {
  if (options.serviceToken.length < 32 || options.invocationSecret.length < 32 || options.receiptSecret.length < 32
    || options.gearJobCredential.length < 16) throw new Error('Connector Gateway authority secrets are too short');
  const controlPlaneOrigin = exactLoopbackOrigin(options.controlPlaneUrl, 'Control Plane URL');
  const facadeOrigin = exactLoopbackOrigin(options.facadeBaseUrl, 'GearJob facade URL');
  if (facadeOrigin.origin !== GATE_A3_GEARJOB_BASE_URL) throw new Error('GearJob facade URL does not match the approved preflight');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const gearJobRequest = options.gearJobRequestForTest ?? requestGearJobFacade;
  const now = options.now ?? Date.now;
  const rateWindows = new Map<string, number[]>();

  const consumeRate = (claims: GateA3ConnectorInvocationTokenClaims): boolean => {
    const timestamp = now();
    const key = `${claims.tenantId}\u0000${claims.principal}\u0000${claims.connectorProfileVersion}`;
    const current = (rateWindows.get(key) ?? []).filter((entry) => entry > timestamp - 60_000);
    if (current.length >= CONNECTOR_RATE_LIMIT_PER_MINUTE) {
      rateWindows.set(key, current);
      return false;
    }
    current.push(timestamp);
    rateWindows.set(key, current);
    return true;
  };

  const introspect = async (
    request: GateA3ConnectorCurrentAuthorityRequest,
    claims: GateA3ConnectorInvocationTokenClaims,
  ): Promise<GateA3ConnectorCurrentAuthorityResponse> => {
    if (options.authorizeInvocationForTest !== undefined) return options.authorizeInvocationForTest(request, claims);
    const target = new URL(CONNECTOR_INTROSPECTION_PATH, controlPlaneOrigin);
    const response = await fetchImpl(target, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': GEARJOB_RESPONSE_CONTENT_TYPE },
      body: JSON.stringify(request), signal: AbortSignal.timeout(2_000),
    });
    if ((response.url !== '' && response.url !== target.href) || (response.status !== 200 && response.status !== 401)) {
      throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
    }
    const parsed = gateA3ConnectorCurrentAuthorityResponseSchema.parse(await readBoundedJson(response));
    if ((response.status === 200) !== parsed.active) throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
    return parsed;
  };

  const app = Fastify({ logger: options.logger ?? false, trustProxy: false, bodyLimit: 256 * 1_024 });
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.headers.origin !== undefined) done(new Error('browser-originated Connector Gateway requests are denied'));
    else done();
  });
  app.get('/health', () => ({ ok: true, service: 'geneway-connector-gateway' }));
  app.get(CONNECTOR_READINESS_PATH, (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.serviceToken)) {
      return reply.status(401).send({ ready: false });
    }
    // Readiness is authority-neutral: it proves this configured Connector
    // Gateway process is available, but never touches a business resource.
    // The Control Plane separately revalidates the signed runtime topology;
    // only a consumed invocation JTI plus current-authority introspection may
    // cause the exact GearJob Work Order GET below.
    return { ready: true, profile: GATE_A3_CONNECTOR_PROFILE_VERSION, receiver: 'invocation-authority-required' };
  });
  app.post(CONNECTOR_GATEWAY_PATH, async (rawRequest, reply) => {
    if (!bearerMatches(rawRequest.headers.authorization, options.serviceToken)) {
      return reply.status(401).send({ errorClass: 'CONNECTOR_AUTH_FAILED' });
    }
    const requestResult = gateA3ConnectorGatewayRequestSchema.safeParse(rawRequest.body);
    if (!requestResult.success) return reply.status(401).send({ errorClass: 'CONNECTOR_AUTH_FAILED' });
    const request = requestResult.data;
    let claims: GateA3ConnectorInvocationTokenClaims;
    try {
      claims = verifyInvocationToken(request.invocationToken, options.invocationSecret, now());
      if (!await claimsMatchQuerySpec(claims, request, facadeOrigin.origin)) throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
    } catch (error) {
      const failure = error instanceof ConnectorFailure ? error : new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
      return reply.status(failure.statusCode).send({ errorClass: failure.errorClass });
    }

    const gatewayRequestDigest = await digestGateA3Jcs({
      schemaVersion: request.schemaVersion, querySpec: request.querySpec, querySpecHash: request.querySpecHash,
    });
    const authorityRequest = gateA3ConnectorCurrentAuthorityRequestSchema.parse({
      schemaVersion: 'gate-a3-connector-current-authority-request/1',
      invocationToken: request.invocationToken,
      gatewayRequestDigest,
    });
    let authority: GateA3ConnectorCurrentAuthorityResponse;
    try {
      authority = gateA3ConnectorCurrentAuthorityResponseSchema.parse(await introspect(authorityRequest, claims));
    } catch {
      return reply.status(401).send({ errorClass: 'CONNECTOR_AUTH_FAILED' });
    }
    if (!authorityMatchesClaims(authority, claims)) return reply.status(401).send({ errorClass: 'CONNECTOR_AUTH_FAILED' });

    if (!consumeRate(claims)) {
      const retryNotBefore = new Date(now() + 60_000).toISOString();
      const receipt = signReceipt(claims, {
        outcome: 'CONNECTOR_RATE_LIMITED', responseRefMatched: null, retryNotBefore,
      }, options.receiptSecret, now());
      return reply.status(429).send({ errorClass: 'CONNECTOR_RATE_LIMITED', retryNotBefore, receipt });
    }

    const target = new URL(GATE_A3_GEARJOB_ENDPOINT, facadeOrigin);
    target.searchParams.set('work_order_ref', request.querySpec.workOrderRef);
    if (target.origin !== facadeOrigin.origin || target.pathname !== GATE_A3_GEARJOB_ENDPOINT
      || [...target.searchParams.keys()].length !== 1
      || target.searchParams.getAll('work_order_ref').length !== 1 || target.hash !== '') {
      return reply.status(503).send({ errorClass: 'CONNECTOR_ROUTE_UNAVAILABLE' });
    }
    try {
      const facadeResponse = await gearJobRequest(target, {
        method: 'GET', redirect: 'manual',
        headers: {
          authorization: `token ${options.gearJobCredential}`,
          accept: GEARJOB_RESPONSE_CONTENT_TYPE,
          'x-geneway-connector-token': request.invocationToken,
          'x-geneway-connector-invocation-id': claims.connectorInvocationId,
          'x-geneway-field-mask-version': GATE_A3_FIELD_MASK_VERSION,
          'x-geneway-connector-profile': GATE_A3_CONNECTOR_PROFILE_VERSION,
        },
      });
      if (facadeResponse.url !== '' && facadeResponse.url !== target.href) {
        throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
      }
      if (facadeResponse.status === 401) {
        throw new ConnectorFailure('CONNECTOR_AUTH_FAILED', 401);
      }
      if (facadeResponse.status === 403 || facadeResponse.status === 404) {
        throw new ConnectorFailure('CONNECTOR_NOT_FOUND_OR_FORBIDDEN', 404);
      }
      if (facadeResponse.status >= 300 && facadeResponse.status < 400) {
        throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
      }
      if (!facadeResponse.ok) throw new ConnectorFailure('CONNECTOR_ROUTE_UNAVAILABLE', 503);
      const responseValue = await readBoundedJson(facadeResponse);
      const responseResult = gateA3ConnectorWorkOrderResponseSchema.safeParse(responseValue);
      if (!responseResult.success) throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502);
      if (responseResult.data.workOrderRef !== request.querySpec.workOrderRef) {
        throw new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502, false);
      }
      const responseCanonicalHash = await digestGateA3Jcs(responseResult.data);
      const receipt = signReceipt(claims, {
        outcome: 'completed', responseRefMatched: true, sourceRevision: responseResult.data.sourceRevision,
        responseCanonicalHash,
      }, options.receiptSecret, now());
      return reply.status(200).send({ response: responseResult.data, receipt });
    } catch (error) {
      const failure = error instanceof ConnectorFailure
        ? error
        : error instanceof GearJobHttpTimeoutError
          ? new ConnectorFailure('CONNECTOR_TIMEOUT', 504)
          : error instanceof GearJobHttpProtocolError
            ? new ConnectorFailure('CONNECTOR_PROTOCOL_VIOLATION', 502)
            : error instanceof DOMException && error.name === 'TimeoutError'
              ? new ConnectorFailure('CONNECTOR_TIMEOUT', 504)
              : new ConnectorFailure('CONNECTOR_ROUTE_UNAVAILABLE', 503);
      const receipt = signReceipt(claims, {
        outcome: failure.errorClass, responseRefMatched: failure.responseRefMatched,
      }, options.receiptSecret, now());
      return reply.status(failure.statusCode).send({ errorClass: failure.errorClass, receipt });
    }
  });
  return app;
}
