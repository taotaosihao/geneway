# geneway contributor instructions

## Product contract

Before current Gate A implementation, read:

1. `/home/gewu/.codex/workflow/artifacts/20260723-002-geneway-fast-chat/team/sdd/slices/gate-a0-fast-chat/brief.md`
2. `doc/plans/atlas-workflow/20260723-002-geneway-fast-chat/implementation-contract.final.md`
3. `/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp/brief.md`
4. `doc/plans/atlas-workflow/20260723-008-geneway-gate-a-gearjob/implementation-contract.final.md`
5. `/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp/current-execution-admission.json`

Gate A0 remains the closed Fast Chat baseline. The Gate A brief defines the stable Goal refs, the Gate A final contract is the current product scope body, and `current-execution-admission.json` is the only durable source for the current user implementation/cross-repo authorization and its prohibitions. Historical Gate closures are consumed through pinned receipts and dependency-sensitive regressions; they are not silently reimplemented by Gate A. Read the technical appendix, UI ADR, roadmap, and spec pointers only when the current implementation question needs them; they cannot add acceptance, exit conditions, or implementation scope.

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

Gate R、Gate 0.1、Gate 0.2A、Gate 0.2B 与 Gate A0 的既有结论由各自 pinned closure receipts 控制。当前 SDD authority 覆盖 Gate A 非生产内部验收；实施与必要的 local-dev GearJob setup/窄修复只按 `current-execution-admission.json` 继续。Public/customer route 默认 `NOT_OPEN`；合同、brief、controller、source manifest 或 admission 任一不一致时必须停在 `shadow`。当前授权不包含 push、PR、部署、客户生产、生产写、secret 披露或其他 GearJob 业务改动。
