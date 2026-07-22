# geneway contributor instructions

## Product contract

Before implementation, read:

1. `/home/gewu/.codex/workflow/artifacts/20260722-003-geneway-gate-0-2a-artifact-evidence/team/sdd/slices/gate-0-2a-artifact-evidence/brief.md`
2. `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/implementation-contract.final.md`

The authority brief defines the stable Goal refs and the implementation contract is the only executable scope body. Read the technical appendix, UI ADR, roadmap, and spec pointer only when the current implementation question needs them; they cannot add acceptance, exit conditions, or implementation scope.

## Core rules

- Product and package names use lowercase `geneway`.
- Customer-facing messages have one author: 小纬. Experts remain backend collaborators.
- Workflow approval and execution use the same immutable canonical JSON `WorkflowVersion` and hash.
- Use Zod 4 as the MVP structural schema source; do not add a parallel TypeBox/Ajv schema system.
- Agent-generated workflows are structured `WorkflowDraft` or `WorkflowPatch`, never executable TypeScript.
- Control Plane Postgres is the business source of truth. Runtime, Hatchet, channels, and UI are projections or execution adapters.
- Model and Tool/Connector Gateways are mandatory boundaries; permissions cannot live only in prompts.
- Do not add `@paperclipai/*` runtime dependencies or a Paperclip upstream remote.
- Reuse old code only by the file-level migration process in `doc/migrations/legacy-migration-manifest.md`.
- Default product and implementation documents to Chinese.

## Current authority slice

Gate R and Gate 0.1 are established baselines. The current contract and SDD authority cover Gate 0.2A only. Contract readiness does not itself authorize product-code implementation; explicit user authorization is still required.
