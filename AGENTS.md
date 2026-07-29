# geneway contributor instructions

## Product contract

Before any continuation from the completed Phase 0B Discovery L1, read in order:

1. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/current-authority.json`
2. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-l1-final-manifest.json`
3. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/authority-transition.json`
4. `/home/gewu/.codex/workflow/artifacts/20260729-013-geneway-discovery-l1-team-review-findings-repair/authority-repair-transition.json`
5. `doc/plans/atlas-workflow/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-contract.final.md`
6. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-admission.json`

`current-authority.json` is the only durable current authority pointer. It records Discovery L1 as terminal `BLOCKED_FOR_L2` and binds the activation/repair transitions, final manifest, discovery contract/admission, `AGENTS.md`, and exact repository commit. It grants no continuing discovery or implementation authority. A missing, non-terminal, stale, non-regular, symlinked, or digest-mismatched pointer means `NO_EXECUTION` and every new route remains `NOT_OPEN`.

Gate A0 has historical closure assertions and evidence, but its canonical source-bound closure pin has not been verified for import into a new route. Gate R、Gate 0.1、Gate 0.2A、Gate 0.2B 与 Gate A0 的 historical conclusions are consumed only after their exact pinned closure receipts and dependency-sensitive regressions are verified. Gate A is an `UNCLOSED_CHECKPOINT`; its brief, contract, progress, admission, code, data, receipts, controller findings, and migrations are historical/migration inputs rather than current implementation authority.

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

Phase 0B Discovery L1 is terminated with `BLOCKED_FOR_L2`. The final preflight, legacy disposition, dependency impact and terminal authority state are immutable evidence only; they grant no further source inspection, artifact mutation, product-code edits, service starts, real API calls, credential access, real 5-case data, authenticated WorkBuddy tenant actions, external mutation, push, PR, deployment, release, production/customer routes, production writes, or secret disclosure.

Phase 0B L2 and every product route remain `NOT_OPEN`. A later exact, action-specific overlay may authorize only its named probe or smoke after binding the owners, tenant/endpoints, data class, resource selectors, credential handle/version, TTL, revocation and allowed actions needed for that action. One overlay does not activate another action or Phase 1. Any authority, source, scope, digest, identity or repository mismatch fails closed.
