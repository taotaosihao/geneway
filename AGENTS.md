# geneway contributor instructions

## Product contract

Before implementation, read:

1. `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/implementation-contract.final.md`
2. `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/spec.md`
3. `doc/plans/2026-07-18-geneway-v19-technical-appendix.md`
4. `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/ui-design.md`

The implementation contract is the only executable scope authority. The spec is a pointer, and the technical appendix, UI ADR, and roadmap cannot grant additional scope.

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

Gate R has established this repository. The current contract and SDD authority cover Gate 0.1 only. Contract readiness does not itself authorize product-code implementation; explicit user authorization is still required.
