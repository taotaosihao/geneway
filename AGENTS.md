# geneway contributor instructions

## Product contract

Before implementation, read:

1. `/home/gewu/.codex/workflow/artifacts/20260723-002-geneway-fast-chat/team/sdd/slices/gate-a0-fast-chat/brief.md`
2. `doc/plans/atlas-workflow/20260723-002-geneway-fast-chat/implementation-contract.final.md`

The Gate A0 authority brief defines the stable Goal refs and the Gate A0 implementation contract is the only current executable scope body. Gate 0.2B.2–0.2B.3 is explicitly deferred, not completed or deleted; when that work resumes, its own authority brief and final contract become authoritative for that separate slice. Read the technical appendix, UI ADR, roadmap, and spec pointers only when the current implementation question needs them; they cannot add acceptance, exit conditions, or implementation scope.

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

Gate R、Gate 0.1、Gate 0.2A 和 Gate 0.2B.1 是已关闭基线。当前 SDD authority 与合同只覆盖 Gate A0 Fast Chat；Gate 0.2B.2–0.2B.3 延期且保持未关闭。Gate A0 合同当前为 `changes_required`，其余 controller finding 修订与复审完成前不得开始产品代码实施；即使合同重新就绪，仍需新的明确实施授权才能开始 `A0.1`、启用真实模型通道或开放 `xiaowei.chat.v1`。
