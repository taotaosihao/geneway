# geneway contributor instructions

## Product contract

Before any synthetic MVP implementation, test, service or browser action, read in order:

1. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/current-authority.json`
2. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/activation-ack.json`
3. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/implementation-admission.json`
4. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/authority-transition.json`
5. `doc/plans/atlas-workflow/20260730-004-geneway-synthetic-e2e-mvp-slice-2/implementation-contract.final.md`
6. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/team/sdd/slices/synthetic-production-brief-six-scenarios/brief.json`
7. `/home/gewu/.codex/workflow/artifacts/20260730-004-geneway-synthetic-e2e-mvp-slice-2/user-checkpoint-verdict.json`
8. `/home/gewu/.codex/workflow/artifacts/20260730-001-geneway-synthetic-e2e-mvp-slice-0-2/slice1-user-checkpoint-readiness.json`
9. `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/clarify.md`
10. `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/team/decision.md`
11. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/current-authority.json`
12. `/home/gewu/.codex/workflow/artifacts/20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi/discovery-l1-final-manifest.json`

The 20260730-004 task `current-authority.json` is the only durable current authority pointer. It opens only the exact local synthetic Slice 2 six-scenario and safety-degradation route after all bound files, repository base, Team execute admission and activation ACK match. The accepted Slice 1 product commit and checkpoint readiness are immutable parent evidence, not a route that can be implicitly resumed. A missing, inactive, stale, non-regular, symlinked or digest-mismatched pointer/ACK means `NO_EXECUTION`. MCP and every real/external route remain closed.

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

Phase 0B Discovery L1 remains terminated with `BLOCKED_FOR_L2`; its final artifacts are immutable historical evidence. The 20260730-004 transition supersedes its `NO_EXECUTION` conclusion only for the local, deterministic, credential-free synthetic MVP Slice 2 named by the current pointer. It does not reopen Discovery L2 or import historical Gate A closure.

The user checkpoint message `continue` opens only Slice 2 on top of accepted commit `7379fe2a1754e722b8fda5ba6816a3b94744d2ec`. Current executable scope is to complete `SCN-NORMAL`, `SCN-BEHIND-STOP`, `SCN-CRITICAL-ALARM`, `SCN-STALE`, `SCN-UNMAPPED`, and `SCN-MULTIPLE` through `Web -> Control Plane synchronous Application API -> production.work_order_equipment_brief.v1 -> bounded loopback synthetic Connector Gateway -> GearJob/Hive synthetic adapters`, with deterministic facts and the atomic degradation matrix. The sole four-state decision rubric lives in the Control Plane. The synthetic Gateway remains a separate entrypoint and must not modify or reuse the credentialed `createConnectorGateway`/Gate A.3 receiver.

Owned and forbidden paths, tests, services, ports, TTL, revocation and local commit boundaries come only from the current admission and brief. In every case `apps/worker/**`, `packages/runtime/**`, `packages/workflow/**`, migrations, Gate A.3 work-order/task/lease/worker-command files, the credentialed Connector Gateway entrypoint, Model Gateway, real Provider configuration and `pnpm-lock.yaml` remain forbidden.

The Slice 2 terminal checkpoint is a user product decision: `ACCEPT_SYNTHETIC_WEDGE | REVISE_SYNTHETIC_MVP | STOP_CURRENT_WEDGE`. Neither Team nor automated checks may synthesize it. MCP requires `ACCEPT_SYNTHETIC_WEDGE` plus a later independent admission. Real GearJob/Hive APIs or data, credentials, authenticated WorkBuddy, external mutation, push, PR, deployment, release, public/customer and production routes remain `NOT_OPEN`. Any authority, source, scope, digest, identity, repository or route mismatch fails closed.
