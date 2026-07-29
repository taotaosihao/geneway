# geneway contributor instructions

## Product contract

Before current Phase 0B discovery, read in order:

1. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/current-authority.json`
2. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/authority-transition.json`
3. `doc/plans/atlas-workflow/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-contract.final.md`
4. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-admission.json`

`current-authority.json` is the only durable current authority pointer. It binds the transition, discovery contract, discovery admission, `AGENTS.md`, and exact repository commit. A missing, inactive, stale, non-regular, symlinked, or digest-mismatched pointer means `NO_EXECUTION` and every new route remains `NOT_OPEN`.

Gate A0 remains the closed Fast Chat baseline. Gate R、Gate 0.1、Gate 0.2A、Gate 0.2B 与 Gate A0 的 historical conclusions are consumed only through their pinned closure receipts and dependency-sensitive regressions. Gate A is an `UNCLOSED_CHECKPOINT`; its brief, contract, progress, admission, code, data, receipts, controller findings, and migrations are historical/migration inputs rather than current implementation authority.

## Core rules

- Product and package names use lowercase `geneway`.
- Customer-facing messages have one author: 小纬. Experts remain backend collaborators.
- Workflow approval and execution use the same immutable canonical JSON `WorkflowVersion` and hash.
- Use Zod 4 as the MVP structural schema source; do not add a parallel TypeBox/Ajv schema system.
- Agent-generated workflows are structured `WorkflowDraft` or `WorkflowPatch`, never executable TypeScript.
- Control Plane Postgres is the business source of truth. Runtime, Hatchet, channels, and UI are projections or execution adapters.
- Model and Tool/Connector Gateways are mandatory boundaries; permissions cannot live only in prompts.
- Web, Control Plane, Worker, Runtime, Model Gateway, and Connector Gateway must not hold Docker daemon access. Deployment topology verification belongs to a separate pre-launch verifier and is consumed only as a bounded receipt.
- Do not add `@paperclipai/*` runtime dependencies or a Paperclip upstream remote.
- Reuse old code only by the file-level migration process in `doc/migrations/legacy-migration-manifest.md`.
- Default product and implementation documents to Chinese.

## Current authority slice

The previous Gate A admission is `SUSPENDED_NO_IMPLICIT_RESUME`. It cannot authorize product implementation, service/test execution, credential issuance, GearJob setup/fixes, validation, finalization, promotion, or cross-repository mutation.

Current authority covers Phase 0B Discovery L1 only: local/public read-only inspection of geneway, GearJob, and Hive source/docs/tests/schema/Git metadata; writing the single workflow `discovery-preflight.md`; and authority-document maintenance. It does not authorize product-code edits, service starts, real API calls, credential access, real 5-case data, authenticated WorkBuddy tenant actions, external mutation, push, PR, deployment, release, production/customer routes, production writes, or secret disclosure.

Phase 0B L2 and every product route remain `NOT_OPEN` until a later exact overlay admission binds named owners, tenant/endpoints, data class, resource selectors, credential handle/version, TTL, revocation, and allowed actions. Any authority, source, scope, digest, identity, or repository mismatch fails closed.
