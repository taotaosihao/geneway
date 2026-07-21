# geneway 架构决策索引

状态：`durable-decision-ledger`

文档角色：记录已经由用户确认、可供后续 Gate authority slice 与实施合同引用的长期架构决定。本索引和所列 ADR **不授予产品代码实施范围**；`decision_status=accepted` 也不等于能力已经实现或开放。

## 使用规则

- 当前产品事实、可执行范围和验收条件仍以对应 Gate 的 authority brief、最终实施合同及验证证据为准。
- 后续 Gate 只有在新建 authority slice、形成可审计合同并获得用户明确授权后，才能把 ADR 转成实现范围。
- ADR 中的“推荐 Gate”只表达依赖顺序，不自动扩大该 Gate，也不反向修改已经完成的 Gate 0.1。
- 原 v19 的 ADR-001～ADR-016 保留在[产品设计来源](../reference/制造业数字员工平台_内部能力内核细节终审与兼容实施方案_v19.md#23-修订后的-adr)中；本目录从 ADR-017 起记录 v19 之后确认的增量决定，不复制或重写原文。

## 已接受决定

| ID | 决定 | 决策状态 | 实施/开放状态 | 后续落地入口 |
| --- | --- | --- | --- | --- |
| [ADR-017](adr-017-controlled-ephemeral-orchestration-code.md) | 临时编码只能作为调用固定 ToolVersion 的有界沙箱步骤 | accepted | `NOT_OPEN` | Gate A 先完成 Gateway/Registry/Broker 基础；Gate C 或独立后续 Gate 再另行授权沙箱 |
| [ADR-018](adr-018-human-confirmation-for-external-side-effects.md) | 任何外部业务副作用默认绑定不可变 ActionVersion 并由用户确认 | accepted | 真实写 Connector 与 D1/W1/W2/W3 均 `NOT_OPEN` | 首个申请开放外部写动作的后续 Gate 必须完整吸收，不得拆除确认或再授权链路 |
| [ADR-019](adr-019-authoritative-three-layer-sop-state-machines.md) | 状态机驱动 SOP 采用三层权威与固定 Interpreter 迁移 | accepted | Gate 0.1 只有固定线性基线；动态条件、真正并行、durable wait/人机恢复和 Agent 生成的动态 Workflow 均 `NOT_OPEN` | Gate B/C 或独立后续 Gate；StaffDeck 仅作行为/测试参考并默认净室重实现 |
| [ADR-020](adr-020-hybrid-knowledge-and-business-capability-matrix.md) | 知识采用权威源快照链；Business Capability Matrix 只投影不可变版本对象 | accepted | 知识摄取/索引/检索、真实知识 Connector 和业务能力矩阵均 `NOT_OPEN` | Gate 0.2/A 先完成只读知识与证据链；Gate C/G 再另行授权治理和运营 |

## 外部参考与候选目录

- [StaffDeck 借鉴候选目录](../reference/staffdeck-adoption-candidate-catalog.md)：保存 ADR-017～020 之外值得在未来 Gate 重新评估的产品、可靠性、知识与运营模式；其中已提升部分只以对应 ADR 为权威。目录状态为 `candidate_recorded`，不是实施合同，也不授予代码/资产复制权限。

## 当前 Gate 0.1 快照

截至 2026-07-21，Gate 0.1 的实际产品能力是固定 `solution.analysis.v1`、预置只读脱敏输入、不可变 `WorkflowVersion`、整体 Workflow 审批、普通 Interpreter 和服务端 fake Runtime。它已经具备固定七节点的最小线性状态机与 step attempt/lease/fencing，但不具备动态条件、真正并行或 durable wait。所有结果保持 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`。

当前页面中的“批准并运行”只批准上述固定模拟 Workflow；它不是 `ConnectorActionDraft` 的确认表单，也没有创建工单或写入 MES/ERP/QMS/WMS/EAM/SCADA。未开放能力继续返回结构化 `NOT_OPEN`。依据见 [Gate 0.1 最终实施合同](../plans/atlas-workflow/20260720-010-geneway-gate-0-1/implementation-contract.final.md)与 [阶段复核证据](../plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-phase-review.md)。

Gate 0.1 也没有原生知识库、真实知识 Connector、文档摄取/索引/检索链或 `Business Capability Matrix`。当前固定 Capability/ExpertCatalog/Harness 只是最小版本化 seed，不能描述为 ADR-020 已实现。
