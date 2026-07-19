# geneway contributor instructions

## Product contract

Before implementation, read:

1. `doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/implementation-contract.final.md`
2. `doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/spec.md`
3. `doc/plans/2026-07-18-geneway-v19-technical-appendix.md`
4. `doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/ui-design.md`

The implementation contract is authoritative for scope and gates. Do not expand a gate merely because a later capability appears in the technical appendix.

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

## Current authorized slice

Gate R has established this repository. The next implementation slice is Gate 0.1 only unless the user explicitly authorizes more.
