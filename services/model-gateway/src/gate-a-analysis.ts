import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createOpenAIOAuth } from '@openai-oauth/ai-sdk';
import { openaiCredentials } from '@openai-oauth/local';
import { generateText, jsonSchema, Output } from 'ai';
import { z } from 'zod';
import {
  buildGateAMaterialProjection,
  buildGateAProviderInputProjection,
  buildGateAProviderUserPrompt,
  canonicalizeGateAProjection,
  digestGateACanonicalSelectionProjection,
  digestGateAMaterialProjection,
  digestGateAPromptPolicyResolvedBytes,
  digestGateAProviderInputProjection,
  gateAAnalysisGatewayReceiptPayloadSchema,
  gateAAnalysisGatewayReceiptSchema,
  gateAAnalysisInvocationTokenClaimsSchema,
  gateA2AnalysisGatewayReceiptPayloadSchema,
  gateAAnalysisResultSchema,
  gateAAgentOutputSchema,
  gateARequirementCandidatesSchema,
  gateAContradictionResultSchema,
  gateAAnalysisWorkerClaimSchema,
  sha256GateABytes,
  type GateAAnalysisGatewayReceipt,
  type GateAAnalysisGatewayReceiptPayload,
  type GateAAnalysisInvocationTokenClaims,
  type GateAAgentOutput,
  type GateAAnalysisWorkerClaim,
} from '@geneway/contracts';

const analysisRequestSchema = z.object({
  claim: gateAAnalysisWorkerClaimSchema,
  toolChoice: z.literal('none'),
}).strict();

const hashCanonical = (value: unknown): string => createHash('sha256')
  .update(canonicalizeGateAProjection(value), 'utf8').digest('hex');

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

function verifyInvocationToken(token: string, secret: string): GateAAnalysisInvocationTokenClaims {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (encoded === undefined || suppliedSignature === undefined || extra !== undefined) throw new Error('invalid invocation token');
  const expectedSignature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error('invalid invocation token');
  const claims = gateAAnalysisInvocationTokenClaimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  const now = Math.floor(Date.now() / 1_000);
  if (claims.iat > now + 5 || claims.exp < now - 5 || claims.exp - claims.iat > 60 || Date.parse(claims.deadline) <= Date.now()) {
    throw new Error('expired invocation token');
  }
  return claims;
}

const authorityClaimKeys = [
  'tenantId', 'principalId', 'conversationId', 'taskId', 'workflowVersionId', 'workflowHash', 'stepId',
  'executionAttemptId', 'stepAttemptId', 'taskFence', 'stepFence', 'modelInvocationId', 'approvalSubjectDigest',
  'capabilityVersionId', 'promptPolicyVersionId', 'expertTargetDigest', 'logicalModelPolicy', 'routeProfile',
  'documentSnapshotId', 'artifactId', 'artifactSha256', 'canonicalTextSha256', 'canonicalPageIndexSha256',
  'parserManifestId', 'parserDigest', 'extractionVersion', 'resourceScope', 'materialProjectionDigest',
  'canonicalSelectionProjectionDigest', 'selectedModelInputSha256', 'promptPolicyResolvedBytesSha256',
  'providerInputProjectionDigest', 'dataClass', 'toolChoice',
  'agentRegistryReference', 'priorStepOutputsDigest', 'outputSchemaVersion', 'maxInputBytes', 'maxOutputTokens', 'deadline',
] as const;

function claimVersionsMatch(
  claims: GateAAnalysisInvocationTokenClaims,
  claim: GateAAnalysisWorkerClaim,
): boolean {
  if (claims.schemaVersion === 'gate-a-analysis-invocation-token/1') {
    return claim.schemaVersion === 'analysis-worker-claim/1';
  }
  return claim.schemaVersion === 'analysis-worker-claim/2'
    && claims.agentVersionId === claim.agentVersionId;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function selectionMatchesTextAndEvidence(claim: GateAAnalysisWorkerClaim, textBytes: Uint8Array): Promise<boolean> {
  const selection = claim.inputRef.canonicalSelectionProjection;
  if (await digestGateACanonicalSelectionProjection(selection) !== claim.canonicalSelectionProjectionDigest
    || claim.canonicalSelectionProjectionDigest !== claim.inputRef.canonicalSelectionProjectionDigest
    || claim.selectedModelInputSha256 !== selection.selectedModelInputSha256
    || textBytes.byteLength !== selection.selectedTotalBytes
    || await sha256GateABytes(textBytes) !== claim.selectedModelInputSha256
    || (!selection.truncated && claim.selectedModelInputSha256 !== claim.canonicalTextSha256)) return false;

  let selectedCursor = 0;
  const selectedParagraphs: Array<Readonly<{
    sourceStart: number;
    sourceEnd: number;
    selectedStart: number;
    selectedEnd: number;
    pageSegments: (typeof selection.selectedParagraphs)[number]['pageSegments'];
  }>> = [];
  for (const paragraph of selection.selectedParagraphs) {
    const selectedEnd = selectedCursor + paragraph.paragraphByteLength;
    const paragraphBytes = textBytes.subarray(selectedCursor, selectedEnd);
    if (paragraphBytes.byteLength !== paragraph.paragraphByteLength
      || await sha256GateABytes(paragraphBytes) !== paragraph.paragraphBytesSha256) return false;
    let paragraphCursor = 0;
    for (const segment of paragraph.pageSegments) {
      const segmentEnd = paragraphCursor + segment.segmentByteLength;
      if (await sha256GateABytes(paragraphBytes.subarray(paragraphCursor, segmentEnd)) !== segment.segmentBytesSha256) return false;
      paragraphCursor = segmentEnd;
    }
    if (paragraph.pageSegments.length > 0 && paragraphCursor !== paragraphBytes.byteLength) return false;
    selectedParagraphs.push({
      sourceStart: paragraph.startByte,
      sourceEnd: paragraph.endByteExclusive,
      selectedStart: selectedCursor,
      selectedEnd,
      pageSegments: paragraph.pageSegments,
    });
    selectedCursor = selectedEnd;
  }
  if (selectedCursor !== textBytes.byteLength) return false;

  const selectedPageSegments = selectedParagraphs.flatMap((paragraph) => paragraph.pageSegments.map((segment) => ({
    ...segment,
    selectedStart: paragraph.selectedStart + segment.absoluteStartByte - paragraph.sourceStart,
    selectedEnd: paragraph.selectedStart + segment.absoluteEndByteExclusive - paragraph.sourceStart,
  })));

  return claim.untrustedText.selectedLocators.every((locator, index) => {
    const candidate = claim.evidenceCandidates[index];
    if (candidate === undefined) return false;
    let selectedStart = -1;
    let selectedEnd = -1;
    if (locator.kind === 'canonical_text_span') {
      const firstIndex = selectedParagraphs.findIndex((entry) => (
        locator.startByte >= entry.sourceStart && locator.startByte < entry.sourceEnd
      ));
      const first = selectedParagraphs[firstIndex];
      if (first !== undefined) {
        selectedStart = first.selectedStart + locator.startByte - first.sourceStart;
        let sourceCursor = locator.startByte;
        for (let paragraphIndex = firstIndex; paragraphIndex < selectedParagraphs.length; paragraphIndex += 1) {
          const paragraph = selectedParagraphs[paragraphIndex];
          if (paragraph === undefined || paragraph.sourceStart > sourceCursor) break;
          sourceCursor = Math.min(locator.endByteExclusive, paragraph.sourceEnd);
          if (sourceCursor === locator.endByteExclusive) {
            selectedEnd = selectedStart + locator.endByteExclusive - locator.startByte;
            break;
          }
        }
      }
    } else {
      const firstIndex = selectedPageSegments.findIndex((segment) => segment.pageIndex === locator.pageIndex
        && locator.startByte >= segment.pageStartByte && locator.startByte < segment.pageEndByteExclusive);
      const first = selectedPageSegments[firstIndex];
      if (first !== undefined) {
        selectedStart = first.selectedStart + locator.startByte - first.pageStartByte;
        let pageCursor = locator.startByte;
        for (let segmentIndex = firstIndex; segmentIndex < selectedPageSegments.length; segmentIndex += 1) {
          const segment = selectedPageSegments[segmentIndex];
          if (segment === undefined || segment.pageIndex !== locator.pageIndex
            || segment.pageStartByte > pageCursor || segment.selectedStart > selectedStart + pageCursor - locator.startByte) break;
          pageCursor = Math.min(locator.endByteExclusive, segment.pageEndByteExclusive);
          if (pageCursor === locator.endByteExclusive) {
            selectedEnd = selectedStart + locator.endByteExclusive - locator.startByte;
            break;
          }
        }
      }
    }
    return selectedStart >= 0 && selectedEnd <= textBytes.byteLength
      && bytesEqual(textBytes.subarray(selectedStart, selectedEnd), new TextEncoder().encode(candidate.excerpt));
  });
}

async function claimMatchesProjection(
  claims: GateAAnalysisInvocationTokenClaims,
  claim: GateAAnalysisWorkerClaim,
): Promise<boolean> {
  const textBytes = new TextEncoder().encode(claim.untrustedText.text);
  const evidenceBytes = claim.evidenceCandidates.reduce(
    (total, candidate) => total + new TextEncoder().encode(candidate.excerpt).byteLength,
    0,
  );
  let coveredBytes = 0;
  const evidenceCoversSelectedText = claim.evidenceCandidates.every((candidate) => {
    const excerptBytes = new TextEncoder().encode(candidate.excerpt);
    const matches = coveredBytes + excerptBytes.byteLength <= textBytes.byteLength
      && bytesEqual(textBytes.subarray(coveredBytes, coveredBytes + excerptBytes.byteLength), excerptBytes);
    coveredBytes += excerptBytes.byteLength;
    return matches;
  }) && coveredBytes === textBytes.byteLength;
  if (!claimVersionsMatch(claims, claim)
    || !authorityClaimKeys.every((key) => claims[key] === claim[key])
    || claims.documentSnapshotId !== claim.inputRef.documentSnapshotId
    || claims.documentSnapshotId !== claim.untrustedText.documentSnapshotId
    || claims.artifactId !== claim.inputRef.artifactId
    || claims.artifactSha256 !== claim.inputRef.artifactSha256
    || claims.canonicalTextSha256 !== claim.inputRef.canonicalTextSha256
    || claims.canonicalTextSha256 !== claim.untrustedText.canonicalTextSha256
    || claims.canonicalPageIndexSha256 !== claim.inputRef.canonicalPageIndexSha256
    || claims.parserManifestId !== claim.inputRef.parserManifestId
    || claims.parserDigest !== claim.inputRef.parserDigest
    || claims.extractionVersion !== claim.inputRef.extractionVersion
    || claims.resourceScope !== claim.inputRef.resourceScope
    || claims.canonicalSelectionProjectionDigest !== claim.inputRef.canonicalSelectionProjectionDigest
    || claims.selectedModelInputSha256 !== claim.inputRef.canonicalSelectionProjection.selectedModelInputSha256
    || claim.inputRef.dataClass !== 'C1'
    || textBytes.byteLength === 0 || textBytes.byteLength > claims.maxInputBytes
    || evidenceBytes === 0 || evidenceBytes > claims.maxInputBytes
    || !evidenceCoversSelectedText
    || hashCanonical(claim.priorStepOutputs) !== claims.priorStepOutputsDigest
    || !await selectionMatchesTextAndEvidence(claim, textBytes)) return false;
  if (claim.evidenceCandidates.length !== claim.untrustedText.selectedLocators.length
    || !claim.evidenceCandidates.every((candidate, index) => (
      candidate.candidateKey === claim.untrustedText.selectedLocators[index]?.candidateKey
    ))) return false;
  if (!claim.untrustedText.selectedLocators.every((locator) => (
    locator.sourceArtifactId === claim.inputRef.artifactId
    && locator.sourceArtifactSha256 === claim.inputRef.artifactSha256
    && locator.documentSnapshotId === claim.inputRef.documentSnapshotId
    && locator.canonicalTextSha256 === claim.inputRef.canonicalTextSha256
    && locator.parserManifestId === claim.inputRef.parserManifestId
    && locator.parserDigest === claim.inputRef.parserDigest
    && locator.extractionVersion === claim.inputRef.extractionVersion
  ))) return false;
  const material = buildGateAMaterialProjection({ inputRef: claim.inputRef, untrustedText: claim.untrustedText });
  const materialProjectionDigest = await digestGateAMaterialProjection(material);
  const promptPolicyResolvedBytesSha256 = await digestGateAPromptPolicyResolvedBytes(claim.systemPrompt);
  if (materialProjectionDigest !== claims.materialProjectionDigest
    || promptPolicyResolvedBytesSha256 !== claims.promptPolicyResolvedBytesSha256) return false;
  const providerInputProjection = buildGateAProviderInputProjection({
    material,
    materialProjectionDigest,
    promptPolicyVersionId: claim.promptPolicyVersionId,
    promptPolicyResolvedBytesSha256,
    systemPrompt: claim.systemPrompt,
    evidenceCandidates: claim.evidenceCandidates,
    priorStepOutputs: claim.priorStepOutputs,
    stepId: claim.stepId,
    agentRegistryReference: claim.agentRegistryReference,
    logicalModelPolicy: claim.logicalModelPolicy,
    routeProfile: claim.routeProfile,
    dataClass: claim.dataClass,
    toolChoice: claim.toolChoice,
    outputSchemaVersion: claim.outputSchemaVersion,
    maxInputBytes: claim.maxInputBytes,
    maxOutputTokens: claim.maxOutputTokens,
    deadline: claim.deadline,
  });
  return await digestGateAProviderInputProjection(providerInputProjection) === claims.providerInputProjectionDigest;
}

function signReceipt(payloadValue: GateAAnalysisGatewayReceiptPayload, secret: string): GateAAnalysisGatewayReceipt {
  const payload = payloadValue.schemaVersion === 'gate-a-analysis-gateway-receipt/2'
    ? gateA2AnalysisGatewayReceiptPayloadSchema.parse(payloadValue)
    : gateAAnalysisGatewayReceiptPayloadSchema.parse(payloadValue);
  const signature = createHmac('sha256', secret)
    .update(canonicalizeGateAProjection(payload), 'utf8').digest('base64url');
  return gateAAnalysisGatewayReceiptSchema.parse({ payload, signature });
}

function parseAgentOutput(claim: GateAAnalysisWorkerClaim, value: unknown): GateAAgentOutput {
  const output = gateAAgentOutputSchema.parse(value);
  const expectedSchema = claim.stepId === 'requirement_extract'
    ? 'analysis.requirement-candidates/1'
    : claim.stepId === 'contradiction_check' ? 'analysis.contradiction/1' : 'analysis-result/1';
  if (output.schemaVersion !== expectedSchema) throw new GateAProviderProtocolError('provider output schema does not match workflow step');
  const allowed = new Set(claim.evidenceCandidates.map((candidate) => candidate.candidateKey));
  const referenced = output.schemaVersion === 'analysis.requirement-candidates/1'
    ? output.requirements.flatMap((item) => item.evidenceCandidateKeys)
    : output.schemaVersion === 'analysis.contradiction/1'
      ? output.contradictions.flatMap((item) => item.evidenceCandidateKeys)
      : output.statements.flatMap((item) => item.evidenceCandidateKeys);
  if (referenced.some((candidateKey) => !allowed.has(candidateKey))) {
    throw new GateAProviderProtocolError('provider returned an unknown Evidence candidate key');
  }
  return output;
}

export function buildGateAProviderOutputJsonSchema(
  claim: Pick<GateAAnalysisWorkerClaim, 'stepId' | 'evidenceCandidates'>,
): Record<string, unknown> {
  const baseSchema = claim.stepId === 'requirement_extract'
    ? gateARequirementCandidatesSchema
    : claim.stepId === 'contradiction_check' ? gateAContradictionResultSchema : gateAAnalysisResultSchema;
  const schema = structuredClone(z.toJSONSchema(baseSchema)) as Record<string, unknown>;
  const collectionKey = claim.stepId === 'requirement_extract'
    ? 'requirements' : claim.stepId === 'contradiction_check' ? 'contradictions' : 'statements';
  const properties = schema.properties;
  const collection = typeof properties === 'object' && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)[collectionKey] : undefined;
  const collectionItems = typeof collection === 'object' && collection !== null && !Array.isArray(collection)
    ? (collection as Record<string, unknown>).items : undefined;
  const itemProperties = typeof collectionItems === 'object' && collectionItems !== null && !Array.isArray(collectionItems)
    ? (collectionItems as Record<string, unknown>).properties : undefined;
  const evidenceCandidateKeys = typeof itemProperties === 'object' && itemProperties !== null
    && !Array.isArray(itemProperties)
    ? (itemProperties as Record<string, unknown>).evidenceCandidateKeys : undefined;
  if (typeof evidenceCandidateKeys !== 'object' || evidenceCandidateKeys === null
    || Array.isArray(evidenceCandidateKeys) || claim.evidenceCandidates.length === 0) {
    throw new GateAProviderProtocolError('provider output schema cannot bind Evidence candidate authority');
  }
  (evidenceCandidateKeys as Record<string, unknown>).items = {
    type: 'string',
    enum: claim.evidenceCandidates.map(({ candidateKey }) => candidateKey),
  };
  return schema;
}

export type GateAAnalysisProviderResult = Readonly<{
  output: unknown;
  providerRevision: string;
  modelRevision: string;
  usage: Readonly<Record<string, unknown>>;
  toolCallCount?: number;
}>;

export type GateAAnalysisReadiness = Readonly<{
  authFilePath: string;
  model: 'gpt-5.4-mini';
  manifestDigest: string;
}>;

export type GateAAnalysisRouteOptions = Readonly<{
  serviceToken: string;
  invocationSecret: string;
  controlPlaneUrl: string;
  resolveReadiness: () => Promise<Readonly<{ ready: true } & GateAAnalysisReadiness> | Readonly<{ ready: false; reason: string }>>;
  acquireProviderSlot: () => boolean;
  releaseProviderSlot: () => void;
  providerCallForTest?: (input: Readonly<{ claim: GateAAnalysisWorkerClaim; signal: AbortSignal }>) => Promise<GateAAnalysisProviderResult>;
  authorizeInvocationForTest?: (claims: GateAAnalysisInvocationTokenClaims) => Promise<boolean>;
}>;

type AnalysisFailureClass =
  | 'MODEL_ROUTE_UNAVAILABLE'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_QUOTA'
  | 'MODEL_TIMEOUT'
  | 'MODEL_STREAM_INTERRUPTED'
  | 'MODEL_PROTOCOL_VIOLATION'
  | 'MODEL_BUSY';

class GateAProviderProtocolError extends Error {}

function mapAnalysisProviderError(error: unknown): Readonly<{ errorClass: AnalysisFailureClass; retryNotBefore?: string }> {
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429')) {
    return { errorClass: 'MODEL_QUOTA', retryNotBefore: new Date(Date.now() + 60_000).toISOString() };
  }
  if (text.includes('auth') || text.includes('token') || text.includes('401') || text.includes('403')) return { errorClass: 'MODEL_AUTH_FAILED' };
  if (text.includes('abort') || text.includes('timeout') || text.includes('deadline')) return { errorClass: 'MODEL_TIMEOUT' };
  if (text.includes('tool') || error instanceof z.ZodError || error instanceof GateAProviderProtocolError) {
    return { errorClass: 'MODEL_PROTOCOL_VIOLATION' };
  }
  return { errorClass: 'MODEL_STREAM_INTERRUPTED' };
}

function receiptPayload(
  claim: GateAAnalysisWorkerClaim,
  input: Readonly<{
    outcome: 'completed' | AnalysisFailureClass;
    output: GateAAgentOutput | null;
    providerRevision: string | null;
    modelRevision: string | null;
    usage: Readonly<Record<string, unknown>> | null;
    retryNotBefore?: string;
  }>,
): GateAAnalysisGatewayReceiptPayload {
  const payload = {
    schemaVersion: claim.schemaVersion === 'analysis-worker-claim/2'
      ? 'gate-a-analysis-gateway-receipt/2' as const
      : 'gate-a-analysis-gateway-receipt/1' as const,
    issuer: 'geneway-model-gateway',
    audience: 'geneway-control-plane',
    receiptJti: randomUUID(),
    tenantId: claim.tenantId,
    principalId: claim.principalId,
    conversationId: claim.conversationId,
    taskId: claim.taskId,
    workflowVersionId: claim.workflowVersionId,
    workflowHash: claim.workflowHash,
    stepId: claim.stepId,
    agentRegistryReference: claim.agentRegistryReference,
    executionAttemptId: claim.executionAttemptId,
    stepAttemptId: claim.stepAttemptId,
    taskFence: claim.taskFence,
    stepFence: claim.stepFence,
    modelInvocationId: claim.modelInvocationId,
    approvalSubjectDigest: claim.approvalSubjectDigest,
    capabilityVersionId: claim.capabilityVersionId,
    promptPolicyVersionId: claim.promptPolicyVersionId,
    expertTargetDigest: claim.expertTargetDigest,
    documentSnapshotId: claim.documentSnapshotId,
    artifactId: claim.artifactId,
    artifactSha256: claim.artifactSha256,
    canonicalTextSha256: claim.canonicalTextSha256,
    canonicalPageIndexSha256: claim.canonicalPageIndexSha256,
    parserManifestId: claim.parserManifestId,
    parserDigest: claim.parserDigest,
    extractionVersion: claim.extractionVersion,
    resourceScope: claim.resourceScope,
    canonicalSelectionProjectionDigest: claim.canonicalSelectionProjectionDigest,
    selectedModelInputSha256: claim.selectedModelInputSha256,
    materialProjectionDigest: claim.materialProjectionDigest,
    promptPolicyResolvedBytesSha256: claim.promptPolicyResolvedBytesSha256,
    providerInputProjectionDigest: claim.providerInputProjectionDigest,
    priorStepOutputsDigest: claim.priorStepOutputsDigest,
    logicalModelPolicy: claim.logicalModelPolicy,
    dataClass: claim.dataClass,
    routeProfile: claim.routeProfile,
    toolChoice: claim.toolChoice,
    maxInputBytes: claim.maxInputBytes,
    outputSchemaVersion: claim.outputSchemaVersion,
    maxOutputTokens: claim.maxOutputTokens,
    deadline: claim.deadline,
    outputPayloadDigest: input.output === null ? null : hashCanonical(input.output),
    providerRevision: input.providerRevision,
    modelRevision: input.modelRevision,
    usage: input.usage,
    outcome: input.outcome,
    issuedAt: new Date().toISOString(),
    ...(claim.schemaVersion === 'analysis-worker-claim/2' ? { agentVersionId: claim.agentVersionId } : {}),
    ...(input.retryNotBefore === undefined ? {} : { retryNotBefore: input.retryNotBefore }),
  };
  return payload.schemaVersion === 'gate-a-analysis-gateway-receipt/2'
    ? gateA2AnalysisGatewayReceiptPayloadSchema.parse(payload)
    : gateAAnalysisGatewayReceiptPayloadSchema.parse(payload);
}

export function buildUntrustedAnalysisPrompt(
  evidenceCandidates: ReadonlyArray<Readonly<{ candidateKey: string; excerpt: string }>>,
  priorStepOutputs: GateAAnalysisWorkerClaim['priorStepOutputs'] = [],
): string {
  return buildGateAProviderUserPrompt(evidenceCandidates, priorStepOutputs);
}

export function registerGateAAnalysisRoute(app: FastifyInstance, options: GateAAnalysisRouteOptions): void {
  app.post('/internal/model-gateway/v1/analysis', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.serviceToken)) {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    const parsedInput = analysisRequestSchema.safeParse(request.body);
    if (!parsedInput.success) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    const input = parsedInput.data;
    let claims: GateAAnalysisInvocationTokenClaims;
    try {
      claims = verifyInvocationToken(input.claim.invocationToken, options.invocationSecret);
    } catch {
      return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    }
    if (!await claimMatchesProjection(claims, input.claim)) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });

    const controlPlaneUrl = new URL(options.controlPlaneUrl);
    if (controlPlaneUrl.protocol !== 'http:' || controlPlaneUrl.hostname !== '127.0.0.1'
      || controlPlaneUrl.username !== '' || controlPlaneUrl.password !== '' || controlPlaneUrl.pathname !== '/') {
      return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    }
    let authorized = false;
    try {
      if (options.authorizeInvocationForTest !== undefined) authorized = await options.authorizeInvocationForTest(claims);
      else {
        const introspection = await fetch(new URL('/internal/model-gateway/v1/introspect', controlPlaneUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ invocationToken: input.claim.invocationToken }),
          signal: AbortSignal.timeout(2_000),
        });
        authorized = introspection.ok && (await introspection.json() as { active?: unknown }).active === true;
      }
    } catch {
      authorized = false;
    }
    if (!authorized) return reply.status(401).send({ errorClass: 'MODEL_AUTH_FAILED' });
    const readiness = await options.resolveReadiness();
    if (!readiness.ready) return reply.status(503).send({ errorClass: 'MODEL_ROUTE_UNAVAILABLE' });
    if (!options.acquireProviderSlot()) {
      const receipt = signReceipt(receiptPayload(input.claim, {
        outcome: 'MODEL_BUSY', output: null, providerRevision: null, modelRevision: null, usage: null,
      }), options.invocationSecret);
      return reply.status(409).send({ errorClass: 'MODEL_BUSY', receipt });
    }

    const providerAbort = new AbortController();
    const abortProvider = (): void => {
      if (!providerAbort.signal.aborted) providerAbort.abort(new Error('downstream analysis canceled'));
    };
    request.raw.once('aborted', abortProvider);
    reply.raw.once('close', abortProvider);
    try {
      let terminal: GateAAnalysisProviderResult;
      if (options.providerCallForTest !== undefined) {
        terminal = await options.providerCallForTest({ claim: input.claim, signal: providerAbort.signal });
      } else {
        const openai = createOpenAIOAuth(openaiCredentials({ authFilePath: readiness.authFilePath, ensureFresh: false }));
        const providerOutputSchema = jsonSchema(buildGateAProviderOutputJsonSchema(input.claim));
        const result = await generateText({
          model: openai(readiness.model),
          system: input.claim.systemPrompt,
          prompt: buildGateAProviderUserPrompt(input.claim.evidenceCandidates, input.claim.priorStepOutputs, {
            stepId: input.claim.stepId, agentRegistryReference: input.claim.agentRegistryReference,
            outputSchemaVersion: input.claim.outputSchemaVersion,
          }),
          output: Output.object({ schema: providerOutputSchema }),
          maxOutputTokens: input.claim.maxOutputTokens,
          toolChoice: 'none',
          abortSignal: AbortSignal.any([
            providerAbort.signal,
            AbortSignal.timeout(Math.max(1, Date.parse(input.claim.deadline) - Date.now())),
          ]),
        });
        terminal = {
          output: result.output,
          providerRevision: '@openai-oauth/ai-sdk@2.0.0',
          modelRevision: readiness.model,
          usage: {
            inputTokens: result.totalUsage.inputTokens,
            outputTokens: result.totalUsage.outputTokens,
            totalTokens: result.totalUsage.totalTokens,
          },
          toolCallCount: result.toolCalls.length,
        };
      }
      if ((terminal.toolCallCount ?? 0) !== 0) throw new Error('provider returned a forbidden tool call');
      const output = parseAgentOutput(input.claim, terminal.output);
      const receipt = signReceipt(receiptPayload(input.claim, {
        outcome: 'completed', output, providerRevision: terminal.providerRevision,
        modelRevision: terminal.modelRevision, usage: terminal.usage,
      }), options.invocationSecret);
      return reply.status(200).send({ output, receipt });
    } catch (error) {
      const mapped = mapAnalysisProviderError(error);
      const receipt = signReceipt(receiptPayload(input.claim, {
        outcome: mapped.errorClass,
        output: null,
        providerRevision: '@openai-oauth/ai-sdk@2.0.0',
        modelRevision: readiness.model,
        usage: null,
        ...(mapped.retryNotBefore === undefined ? {} : { retryNotBefore: mapped.retryNotBefore }),
      }), options.invocationSecret);
      return reply.status(mapped.errorClass === 'MODEL_AUTH_FAILED' ? 401 : mapped.errorClass === 'MODEL_QUOTA' ? 429 : 502).send({
        errorClass: mapped.errorClass,
        receipt,
        ...(mapped.retryNotBefore === undefined ? {} : { retryNotBefore: mapped.retryNotBefore }),
      });
    } finally {
      request.raw.off('aborted', abortProvider);
      reply.raw.off('close', abortProvider);
      options.releaseProviderSlot();
    }
  });
}
