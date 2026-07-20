# Gate 0.1 权威与安全摘要

真实 PostgreSQL 集成与安全测试证明：

- Control Plane 是 Conversation、Task、Event、WorkflowVersion、ApprovalVersion、Step、Claim 和 Evidence 的唯一权威；
- tenant、loopback principal、Origin、delegated capability、Approval expiry/subject、幂等、fencing 和 publish guard 均 fail closed；
- `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false` 在 Task/Event/Step/Result/Claim/Evidence 和 UI/API 投影中一致；
- 无证据候选“当前材料要求直接控制设备”只记录为 rejected，不进入 published；
- Evidence 不只做自哈希，还必须匹配 Task `inputSnapshot` 中固定 fixture 的 ref、version、source、excerpt 和 content hash；安全负例证明替换文本后重新计算 hash 仍被拒绝且不会入库；
- 未知 capability 和未开放 upload/download/business-exception/runtime kind 均返回 `NOT_OPEN`；
- production manifest 未引入 Paperclip、TypeBox、Ajv、真实 provider、GearJob、Hatchet 或工业 Connector。

命令：`pnpm test:integration && pnpm test:security`，结果分别为 6/6 与 10/10 通过。
