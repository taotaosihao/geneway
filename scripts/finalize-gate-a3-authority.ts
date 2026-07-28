import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from 'node:crypto';
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import {
  GATE_A3_LOCAL_ADMISSION_ALGORITHM,
  GATE_A3_LOCAL_ADMISSION_KEY_ID,
  GATE_A3_LOCAL_ADMISSION_PUBLIC_KEY_PEM,
  GATE_A3_LOCAL_ADMISSION_SIGNED_PAYLOAD,
  gateA3ControllerAdmissionArtifactSchema,
  gateA3InternalValidationAdmissionArtifactSchema,
  gateA3PreflightArtifactSchema,
} from '@geneway/contracts';
import { GATE_A3_AUTHORITY_FILES, readGateA3AuthorityEnvelopeFromFiles } from
  '../apps/control-plane/src/gate-a3-authority-files.js';

const authorityDirectory =
  '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp';
const canonicalPaths = Object.freeze({
  preflight: `${authorityDirectory}/gearjob-preflight.approved.json`,
  controller: `${authorityDirectory}/gearjob-preflight.controller-admission.json`,
  internal: `${authorityDirectory}/gate-a3-internal-validation.admission.json`,
  review: `${authorityDirectory}/review-verdict.json`,
  verification: `${authorityDirectory}/gate-a3-verification-verdict.json`,
});
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const canonicalDigest = (value: unknown): string => sha256(canonicalize(value));

type Arguments = Readonly<{
  candidate: string;
  review: string;
  verification: string;
  privateKey: string;
  outputDirectory: string;
  install: boolean;
}>;

function parseArguments(): Arguments {
  const options = new Map<string, string>();
  let install = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === '--install') {
      install = true;
      continue;
    }
    const match = argument.match(/^--(candidate|review|verification|private-key|output-dir)=(\/.+)$/u);
    if (match?.[1] === undefined || match[2] === undefined || options.has(match[1])) {
      throw new Error('invalid Gate A.3 authority finalizer arguments');
    }
    options.set(match[1], resolve(match[2]));
  }
  const candidate = options.get('candidate');
  const review = options.get('review');
  const verification = options.get('verification');
  const privateKey = options.get('private-key');
  const outputDirectory = options.get('output-dir');
  if (candidate === undefined || review === undefined || verification === undefined
    || privateKey === undefined || outputDirectory === undefined || options.size !== 5) {
    throw new Error('candidate, review, verification, private-key, and output-dir are required');
  }
  if (!candidate.startsWith('/tmp/geneway-gate-a3-') || !review.startsWith('/tmp/geneway-gate-a3-')
    || !verification.startsWith('/tmp/geneway-gate-a3-')
    || !privateKey.startsWith('/tmp/geneway-gate-a3-signing.')
    || !outputDirectory.startsWith('/tmp/geneway-gate-a3-final-')
    || dirname(outputDirectory) !== '/tmp') {
    throw new Error('Gate A.3 finalizer inputs are outside their bounded private /tmp roots');
  }
  return { candidate, review, verification, privateKey, outputDirectory, install };
}

function ownedRegular0600(path: string, label: string, maximumBytes = 512 * 1_024): Buffer {
  const currentUid = process.getuid?.();
  const stat = lstatSync(path);
  if (currentUid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > maximumBytes
    || realpathSync(path) !== path) {
    throw new Error(`${label} must be an owned real 0600 file`);
  }
  return readFileSync(path);
}

function parseReceipt(path: string, label: string): Record<string, unknown> {
  const value = JSON.parse(ownedRegular0600(path, label).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function preflightDigest(value: unknown): string {
  const input = structuredClone(value) as Record<string, unknown>;
  const integrity = input.integrity as Record<string, unknown>;
  delete integrity.canonical_sha256;
  const release = input.release_admission as { required_tuple: Record<string, unknown> };
  release.required_tuple.approvedPreflightDigest = 'TO_BE_FILLED';
  return canonicalDigest(input);
}

function assertFreshReceipts(
  review: Record<string, unknown>,
  verification: Record<string, unknown>,
  digest: string,
  gearjobCommit: string,
): void {
  if (review.schemaVersion !== 'geneway-gate-a3-fresh-review/1' || review.verdict !== 'ADMIT'
    || review.candidateDigest !== digest || review.gearjobCommit !== gearjobCommit
    || review.critical !== 0 || review.important !== 0 || review.recommendation !== 'PROCEED_TO_SIGNING'
    || typeof review.reviewer !== 'string' || !review.reviewer.startsWith('codex-team:')) {
    throw new Error('fresh Gate A.3 reviewer did not admit the exact candidate');
  }
  if (verification.schemaVersion !== 'geneway-gate-a3-fresh-verification/1' || verification.verdict !== 'PASS'
    || verification.candidateDigest !== digest || verification.gearjobCommit !== gearjobCommit
    || verification.critical !== 0 || verification.important !== 0
    || verification.recommendation !== 'ADMIT_ISOLATED_LOCAL_INTERNAL_VALIDATION'
    || typeof verification.verifier !== 'string' || !verification.verifier.startsWith('codex-team:')
    || verification.exactSourceAndRuntime !== true || verification.focusedChecksPassed !== true) {
    throw new Error('fresh Gate A.3 verifier did not pass the exact candidate');
  }
}

function verifyPrivateKey(path: string): ReturnType<typeof createPrivateKey> {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !/^geneway-gate-a3-signing\.[A-Za-z0-9_-]+$/u.test(basename(parent))
    || dirname(parent) !== '/tmp' || !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || parentStat.uid !== currentUid || (parentStat.mode & 0o777) !== 0o700 || realpathSync(parent) !== parent) {
    throw new Error('Gate A.3 signing key parent is unsafe');
  }
  const keyBytes = ownedRegular0600(path, 'Gate A.3 signing private key', 16 * 1_024);
  const privateKey = createPrivateKey({ key: keyBytes, format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Gate A.3 signing key is not Ed25519');
  const observedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim();
  if (observedPublic !== GATE_A3_LOCAL_ADMISSION_PUBLIC_KEY_PEM.trim()) {
    throw new Error('Gate A.3 signing key does not match the pinned local admission root');
  }
  return privateKey;
}

function writePrepared(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

function backupCanonical(path: string): void {
  const bytes = ownedRegular0600(path, `canonical ${basename(path)}`);
  const backup = `${path}.superseded-${sha256(bytes).slice(0, 16)}.json`;
  try {
    copyFileSync(path, backup, fsConstants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' || !readFileSync(backup).equals(bytes)) throw error;
  }
}

const arguments_ = parseArguments();
const candidate = gateA3PreflightArtifactSchema.parse(parseReceipt(arguments_.candidate, 'Gate A.3 preflight candidate'));
const candidateDigest = preflightDigest(candidate);
if (candidate.integrity.canonical_sha256 !== candidateDigest
  || candidate.release_admission.required_tuple.approvedPreflightDigest !== candidateDigest) {
  throw new Error('Gate A.3 preflight candidate digest is invalid');
}
const review = parseReceipt(arguments_.review, 'Gate A.3 fresh review receipt');
const verification = parseReceipt(arguments_.verification, 'Gate A.3 fresh verification receipt');
assertFreshReceipts(review, verification, candidateDigest, candidate.verification.gearjob_commit);

const now = new Date();
if (Date.parse(candidate.approved_at) > now.getTime() || Date.parse(candidate.expires_at) <= now.getTime()) {
  throw new Error('Gate A.3 preflight candidate is not currently effective');
}
const tuple = candidate.release_admission.required_tuple;
const controller = gateA3ControllerAdmissionArtifactSchema.parse({
  schema_version: 'geneway.gearjob-preflight-controller-admission/1',
  task_id: '20260723-008-geneway-gate-a-gearjob',
  slice_id: 'gate-a-business-mvp',
  decision: 'ADMIT_LOCAL_DEVELOPMENT_A3_PRODUCT_CODE',
  decided_at: now.toISOString(),
  controller: 'codex-team:/root',
  authority: {
    approval_owner: 'workspace-user:geneway-authorizing-user',
    environment_class: 'isolated-local-development',
    production_authority: false,
    forbidden: ['customer production credentials or data', 'push, pull request, deploy, publish or release', 'contract Non-goals'],
  },
  required_tuple: {
    gearjob_commit: candidate.verification.gearjob_commit,
    approved_preflight_digest: candidateDigest,
    connector_profile_version: tuple.connectorProfileVersion,
    field_mask_version: tuple.fieldMaskVersion,
    invocation_token_schema_version: tuple.invocationTokenSchemaVersion,
    response_schema_version: tuple.responseSchemaVersion,
    card_schema_version: tuple.cardSchemaVersion,
    runtime_authority_digest: tuple.runtimeAuthorityDigest,
    dynamic_authority_digest: tuple.dynamicAuthorityDigest,
    runtime_image_id: tuple.runtimeImageId,
  },
  fresh_team_inputs: {
    reviewer: {
      reviewer: review.reviewer, verdict: review.verdict, critical: review.critical, important: review.important,
      receipt_sha256: sha256(ownedRegular0600(arguments_.review, 'Gate A.3 fresh review receipt')),
    },
    verifier: {
      verifier: verification.verifier, verdict: verification.verdict,
      critical: verification.critical, important: verification.important,
      receipt_sha256: sha256(ownedRegular0600(arguments_.verification, 'Gate A.3 fresh verification receipt')),
    },
  },
  controller_resolution: {
    prior_runtime_topology_blocker: 'closed',
    a3_product_code_may_start: true,
    production_work_order_route_status: 'NOT_OPEN',
    route_may_open_after_preflight_only: false,
    isolated_local_internal_validation_may_start: true,
    production_release_may_open: false,
    remaining_required: ['fresh-served-ui-api-db-egress-validation', 'gate-a-aggregate-regression'],
  },
});
const controllerDigest = canonicalDigest(controller);
const currentInternal = parseReceipt(canonicalPaths.internal, 'current Gate A.3 internal admission');
const renewalOf = (currentInternal.integrity as { canonical_sha256?: unknown } | undefined)?.canonical_sha256;
if (typeof renewalOf !== 'string' || !/^[a-f0-9]{64}$/u.test(renewalOf)) {
  throw new Error('current Gate A.3 internal admission lineage is invalid');
}
const privateKey = verifyPrivateKey(arguments_.privateKey);
const internalUnsigned = {
  schema_version: 'geneway.gate-a3-internal-validation-admission/1',
  task_id: '20260723-008-geneway-gate-a-gearjob',
  slice_id: 'gate-a-business-mvp',
  decision: 'ADMIT_ISOLATED_LOCAL_INTERNAL_VALIDATION',
  decided_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
  controller: 'codex-team:/root',
  renewal_of: renewalOf,
  authority: {
    approval_owner: 'workspace-user:geneway-authorizing-user',
    environment_class: 'isolated-local-development',
    production_authority: false,
  },
  required_tuple: {
    approved_preflight_digest: candidateDigest,
    preflight_controller_admission_digest: controllerDigest,
    gearjob_commit: candidate.verification.gearjob_commit,
    runtime_authority_digest: tuple.runtimeAuthorityDigest,
    dynamic_authority_digest: tuple.dynamicAuthorityDigest,
    runtime_image_id: tuple.runtimeImageId,
  },
  verifier: {
    receipt_sha256: sha256(ownedRegular0600(arguments_.verification, 'Gate A.3 fresh verification receipt')),
    verdict: 'PASS',
    recommendation: 'ADMIT_ISOLATED_LOCAL_INTERNAL_VALIDATION',
    fresh_tuple_checked_at: verification.verifiedAt,
    exact_source_and_runtime: true,
    focused_checks_passed: true,
  },
  release_scope: {
    maximum_state: 'internal',
    internal_acceptance_only: true,
    production_release_may_open: false,
  },
  forbidden: ['production-route-open', 'customer-production-credentials', 'push', 'pull-request', 'deployment', 'release'],
  remaining_required: ['fresh-served-ui-api-db-egress-validation', 'gate-a-aggregate-regression'],
  admission_signature: {
    key_id: GATE_A3_LOCAL_ADMISSION_KEY_ID,
    algorithm: GATE_A3_LOCAL_ADMISSION_ALGORITHM,
    signed_payload: GATE_A3_LOCAL_ADMISSION_SIGNED_PAYLOAD,
  },
  integrity: {
    canonicalization_version: 'RFC8785/JCS-1',
  },
} as Record<string, unknown>;
const signaturePayload = structuredClone(internalUnsigned);
const signature = signPayload(
  null,
  Buffer.from(canonicalize(signaturePayload), 'utf8'),
  privateKey,
).toString('base64url');
(internalUnsigned.admission_signature as Record<string, unknown>).signature = signature;
const internalDigestInput = structuredClone(internalUnsigned);
const internalDigest = canonicalDigest(internalDigestInput);
(internalUnsigned.integrity as Record<string, unknown>).canonical_sha256 = internalDigest;
const internal = gateA3InternalValidationAdmissionArtifactSchema.parse(internalUnsigned);

mkdirSync(arguments_.outputDirectory, { recursive: false, mode: 0o700 });
chmodSync(arguments_.outputDirectory, 0o700);
const preparedPaths = {
  preflight: `${arguments_.outputDirectory}/gearjob-preflight.approved.json`,
  controller: `${arguments_.outputDirectory}/gearjob-preflight.controller-admission.json`,
  internal: `${arguments_.outputDirectory}/gate-a3-internal-validation.admission.json`,
  review: `${arguments_.outputDirectory}/review-verdict.json`,
  verification: `${arguments_.outputDirectory}/gate-a3-verification-verdict.json`,
};
writePrepared(preparedPaths.preflight, candidate);
writePrepared(preparedPaths.controller, controller);
writePrepared(preparedPaths.internal, internal);
writePrepared(preparedPaths.review, review);
writePrepared(preparedPaths.verification, verification);

let installed = false;
if (arguments_.install) {
  const previous = new Map(Object.values(canonicalPaths).map((path) => [
    path,
    existsSync(path) ? ownedRegular0600(path, `canonical ${basename(path)}`) : null,
  ]));
  for (const [path, bytes] of previous) {
    if (bytes !== null) backupCanonical(path);
  }
  try {
    renameSync(preparedPaths.preflight, canonicalPaths.preflight);
    renameSync(preparedPaths.controller, canonicalPaths.controller);
    renameSync(preparedPaths.review, canonicalPaths.review);
    renameSync(preparedPaths.verification, canonicalPaths.verification);
    // The signed internal admission is the activation record and is installed last.
    // Until this rename, any mixed chain fails closed instead of becoming active.
    renameSync(preparedPaths.internal, canonicalPaths.internal);
    for (const path of Object.values(canonicalPaths)) chmodSync(path, 0o600);
    const installedEnvelope = await readGateA3AuthorityEnvelopeFromFiles(GATE_A3_AUTHORITY_FILES);
    if (installedEnvelope.gearjobCommit !== candidate.verification.gearjob_commit
      || installedEnvelope.approvedPreflightDigest !== candidateDigest
      || installedEnvelope.runtimeAuthorityDigest !== tuple.runtimeAuthorityDigest
      || installedEnvelope.dynamicAuthorityDigest !== tuple.dynamicAuthorityDigest
      || installedEnvelope.runtimeImageId !== tuple.runtimeImageId) {
      throw new Error('installed Gate A.3 authority chain did not read back as the exact candidate');
    }
  } catch (error) {
    for (const [path, bytes] of previous) {
      if (bytes === null) {
        if (existsSync(path)) rmSync(path, { force: false });
        continue;
      }
      const restorePath = `${arguments_.outputDirectory}/restore-${basename(path)}`;
      writeFileSync(restorePath, bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(restorePath, 0o600);
      renameSync(restorePath, path);
    }
    throw error;
  }
  installed = true;
  const signingRoot = dirname(arguments_.privateKey);
  if (!signingRoot.startsWith('/tmp/geneway-gate-a3-signing.') || dirname(signingRoot) !== '/tmp') {
    throw new Error('refusing to clean an unexpected Gate A.3 signing root');
  }
  rmSync(signingRoot, { recursive: true, force: false });
}

writePrepared(`${arguments_.outputDirectory}/finalization-summary.json`, {
  schemaVersion: 'geneway-gate-a3-authority-finalization/1',
  checked: true,
  installed,
  candidateDigest,
  controllerDigest,
  internalAdmissionDigest: internalDigest,
  gearjobCommit: candidate.verification.gearjob_commit,
  runtimeAuthorityDigest: tuple.runtimeAuthorityDigest,
  dynamicAuthorityDigest: tuple.dynamicAuthorityDigest,
  runtimeImageId: tuple.runtimeImageId,
  reviewReceiptSha256: sha256(ownedRegular0600(arguments_.review, 'Gate A.3 fresh review receipt')),
  verificationReceiptSha256: sha256(ownedRegular0600(arguments_.verification, 'Gate A.3 fresh verification receipt')),
  privateKeyRetained: !installed,
});
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'geneway-gate-a3-authority-finalization/1', installed, candidateDigest,
  controllerDigest, internalAdmissionDigest: internalDigest,
})}\n`);
