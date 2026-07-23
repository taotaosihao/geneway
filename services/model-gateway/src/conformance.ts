import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createOpenAIOAuth } from '@openai-oauth/ai-sdk';
import { openaiCredentials } from '@openai-oauth/local';
import { streamText } from 'ai';
import { mapProviderError, redactedProviderFailure } from './index.js';
import { verifyProviderAuthFile, verifyProviderManifest } from './provider-manifest.js';

const authFilePath = process.env.GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE;
const outputFilePath = process.env.GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE;
if (authFilePath === undefined || outputFilePath === undefined) {
  throw new Error('GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE and GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE are required');
}

const verified = await verifyProviderManifest();
await verifyProviderAuthFile(authFilePath, verified.manifest);
const startedAt = new Date();
const deadline = new Date(startedAt.getTime() + 2 * 60_000);
const remainingTimeout = (maximumMs: number): number => Math.max(1, Math.min(maximumMs, deadline.getTime() - Date.now()));
const openai = createOpenAIOAuth(openaiCredentials({ authFilePath, ensureFresh: false }));
const result = streamText({
  model: openai(verified.manifest.providerModel),
  system: 'Return one short plain-text acknowledgement. Do not call tools.',
  prompt: 'geneway Gate A0 live conformance',
  maxOutputTokens: 32,
  toolChoice: 'none',
  abortSignal: AbortSignal.timeout(remainingTimeout(30_000)),
});
let deltaCount = 0;
for await (const part of result.fullStream) {
  if (part.type === 'text-delta' && part.text.length > 0) deltaCount += 1;
  if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error') {
    throw new Error('Provider violated tool_choice=none during conformance');
  }
}
const finishReason = await result.finishReason;
if (deltaCount === 0 || !['stop', 'length'].includes(finishReason)) throw new Error('Provider did not produce a conforming text stream');
const usage = await result.totalUsage;
if (typeof usage.totalTokens !== 'number' || usage.totalTokens <= 0) throw new Error('Provider did not return conforming usage');
const cancelController = new AbortController();
const cancelResult = streamText({
  model: openai(verified.manifest.providerModel),
  system: 'Return a long plain-text explanation. Do not call tools.',
  prompt: 'Explain safe local model gateway boundaries in detail.',
  maxOutputTokens: 512,
  toolChoice: 'none',
  abortSignal: AbortSignal.any([cancelController.signal, AbortSignal.timeout(remainingTimeout(60_000))]),
});
let cancelSawDelta = false;
try {
  for await (const part of cancelResult.fullStream) {
    if (part.type === 'text-delta' && part.text.length > 0) {
      cancelSawDelta = true;
      cancelController.abort();
      break;
    }
  }
} catch (error) {
  if (!cancelController.signal.aborted) throw error;
}
if (!cancelSawDelta || !cancelController.signal.aborted) throw new Error('Provider cancellation conformance failed');
const localFaultMapping = {
  quota: mapProviderError(new Error('synthetic local quota 429')).errorClass,
  authentication: mapProviderError(new Error('synthetic local authentication 401')).errorClass,
  timeout: mapProviderError(new Error('synthetic local timeout')).errorClass,
  protocol: mapProviderError(new Error('synthetic local tool protocol violation')).errorClass,
  unknown: mapProviderError(new Error('synthetic local unknown provider failure')).errorClass,
};
if (localFaultMapping.quota !== 'MODEL_QUOTA'
  || localFaultMapping.authentication !== 'MODEL_AUTH_FAILED'
  || localFaultMapping.timeout !== 'MODEL_TIMEOUT'
  || localFaultMapping.protocol !== 'MODEL_PROTOCOL_VIOLATION'
  || localFaultMapping.unknown !== 'MODEL_STREAM_INTERRUPTED') {
  throw new Error('Stable provider error mapping conformance failed');
}
const secretCanary = `geneway-secret-canary-${randomBytes(24).toString('hex')}`;
const redactedFailure = redactedProviderFailure(new Error(`synthetic authentication failure ${secretCanary}`));
const publicErrorSerialization = JSON.stringify(redactedFailure.publicFailure);
const auditSerialization = JSON.stringify(redactedFailure.audit);
if (publicErrorSerialization.includes(secretCanary) || auditSerialization.includes(secretCanary)) {
  throw new Error('Provider failure redaction leaked the synthetic secret canary');
}
if (Date.now() > deadline.getTime()) throw new Error('Live conformance exceeded its declared deadline');

const passedAt = new Date();
const expiresAt = new Date(passedAt.getTime() + 24 * 60 * 60 * 1_000);
await writeFile(outputFilePath, `${JSON.stringify({
  schemaVersion: 'geneway-live-conformance/1',
  profile: 'codex_subscription_dev',
  manifestDigest: verified.digest,
  providerModel: verified.manifest.providerModel,
  passedAt: passedAt.toISOString(),
  deadline: deadline.toISOString(),
  expiresAt: expiresAt.toISOString(),
  checks: {
    stream: true,
    cancel: true,
    usage: true,
    toolChoiceNone: true,
    localFaultMapping: { mode: 'synthetic-local-faults', ...localFaultMapping },
    secretRedaction: {
      mode: 'synthetic-canary',
      canarySha256: createHash('sha256').update(secretCanary, 'utf8').digest('hex'),
      publicErrorSerialization: true,
      auditSerialization: true,
    },
  },
})}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`codex_subscription_dev conformance passed; attestation=${outputFilePath}\n`);
