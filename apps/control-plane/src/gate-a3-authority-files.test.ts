import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import {
  inspectGateA3BoundSourceIdentity,
  verifyGateA3InternalAdmissionSignature,
} from './gate-a3-authority-files.js';

const signedAdmission = {
  schema_version: 'geneway.gate-a3-internal-validation-admission/1',
  task_id: '20260723-008-geneway-gate-a-gearjob',
  slice_id: 'gate-a-business-mvp',
  decision: 'ADMIT_ISOLATED_LOCAL_INTERNAL_VALIDATION',
  decided_at: '2026-07-28T01:00:00.000Z',
  expires_at: '2026-07-29T01:00:00.000Z',
  controller: 'codex-team:/root',
  authority: { environment_class: 'isolated-local-development', production_authority: false },
  required_tuple: {
    approved_preflight_digest: 'a'.repeat(64),
    preflight_controller_admission_digest: 'b'.repeat(64),
    gearjob_commit: 'c'.repeat(40),
    runtime_authority_digest: '1'.repeat(64),
    dynamic_authority_digest: '2'.repeat(64),
    runtime_image_id: `sha256:${'3'.repeat(64)}`,
  },
  release_scope: {
    maximum_state: 'internal', internal_acceptance_only: true, production_release_may_open: false,
  },
  forbidden: ['production-route-open'],
  admission_signature: {
    key_id: 'geneway-gate-a3-local-admission-root/1',
    algorithm: 'Ed25519',
    signed_payload: 'RFC8785/JCS internal admission with integrity.canonical_sha256 and admission_signature.signature omitted',
    signature: 'qy-TzorFOY2AyWlBx0APW2F70kYrOBwbBfP7Mpw2iXQgfrO8JSfxnVqFSpkLZ8aiUxPCitY0SE49a8OrMNkTBQ',
  },
  integrity: { canonicalization_version: 'RFC8785/JCS-1', canonical_sha256: 'd'.repeat(64) },
} as const;

describe('Gate A.3 local admission signature root', () => {
  it('accepts the code-pinned controller signature', () => {
    expect(verifyGateA3InternalAdmissionSignature(signedAdmission)).toBe(true);
  });

  it('rejects a rewritten tuple even when ordinary digests are recomputed', () => {
    const rewritten = structuredClone(signedAdmission) as Record<string, unknown>;
    rewritten.required_tuple = {
      ...(rewritten.required_tuple as Record<string, unknown>),
      gearjob_commit: 'e'.repeat(40),
    };
    rewritten.integrity = {
      canonicalization_version: 'RFC8785/JCS-1', canonical_sha256: 'f'.repeat(64),
    };
    expect(verifyGateA3InternalAdmissionSignature(rewritten)).toBe(false);
  });

  it.each([
    ['runtime_authority_digest', '4'.repeat(64)],
    ['dynamic_authority_digest', '5'.repeat(64)],
    ['runtime_image_id', `sha256:${'6'.repeat(64)}`],
  ] as const)('rejects rewritten signed runtime tuple field %s', (field, value) => {
    const rewritten = structuredClone(signedAdmission) as Record<string, unknown>;
    rewritten.required_tuple = {
      ...(rewritten.required_tuple as Record<string, unknown>),
      [field]: value,
    };
    expect(verifyGateA3InternalAdmissionSignature(rewritten)).toBe(false);
  });

  it('rejects an artifact-selected trust root or signature metadata drift', () => {
    const rewritten = structuredClone(signedAdmission) as Record<string, unknown>;
    rewritten.admission_signature = {
      ...(rewritten.admission_signature as Record<string, unknown>),
      key_id: 'artifact-selected-key',
      public_key: 'attacker-controlled',
    };
    expect(verifyGateA3InternalAdmissionSignature(rewritten)).toBe(false);
  });
});

describe('Gate A.3 Frappe bind-source identity', () => {
  it('binds the canonical real path and rejects a same-path inode replacement', async () => {
    const parent = await mkdtemp('/tmp/geneway-gate-a3-bind-');
    const source = `${parent}/source`;
    const displaced = `${parent}/displaced`;
    try {
      await mkdir(source);
      const identity = await inspectGateA3BoundSourceIdentity({
        source, destination: source, sourceKind: 'directory', containerPid: process.pid,
      });
      expect(identity.realPath).toBe(source);
      expect(identity.inode).toBeGreaterThan(0);
      await rename(source, displaced);
      await mkdir(source);
      await expect(inspectGateA3BoundSourceIdentity({
        source, destination: source, sourceKind: 'directory', containerPid: process.pid,
        expected: identity,
      })).rejects.toThrow(/bind source/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
