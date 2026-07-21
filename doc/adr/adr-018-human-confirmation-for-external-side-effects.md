# ADR-018：外部业务副作用默认必须绑定不可变版本并由用户确认

decision_status: `accepted`

implementation_status: `NOT_OPEN`

accepted_at: 2026-07-21

decision_scope: 首个及以后所有外部写能力 Gate 的长期不变量

authority_effect: 本 ADR 不授予真实 Connector、D1/W1/W2/W3、自动写、部署或跨系统操作权限

## 背景

制造业系统的创建、更新、删除、提交、发送、审批、触发和控制会改变工单、库存、质量结论、设备状态或对外承诺。自然语言意图、模型输出、浏览器表单和 Runtime 内部状态都不是可靠的执行权威；如果执行参数可在审批后被原位修改，或用户确认被视为永久授权，系统将无法证明“用户确认的内容”和“Connector 实际执行的内容”完全相同。

因此，人工确认必须建立在 Control Plane 的不可变动作版本上，并与执行前再授权、幂等、对账、Evidence 和审计组成同一链路。

## 已决定的长期不变量

### 1. 外部副作用默认逐次人工确认

任何未来 MVP slice 一旦开放外部业务副作用，默认都必须由用户确认。范围至少包括外部系统的：

- `create` / `update` / `delete`；
- `submit` / `send` / `approve`；
- `trigger` / `control`；
- 语义等价的批量写入、状态迁移、业务承诺或设备动作。

Agent、专家 Runtime、临时代码和 `Workflow Interpreter` 均不能直接写 MES、ERP、QMS、WMS、EAM、SCADA，不能直接对外发送，也不能把 Workflow 整体审批解释为任意外部写授权。

### 2. Control Plane 内部权威持久化不属于外部确认范围

下列操作仍由 Control Plane 按既有权限、事务和审计规则持久化，不需要为每一条记录单独弹出外部副作用确认：

- `Conversation`、`BusinessTask` 和 `Event`；
- `Evidence`、`Lineage` 与审计日志；
- 仅保存在 geneway 内部、尚未影响外部系统的 `WorkflowDraft`；
- 仅保存在 geneway 内部、尚未影响外部系统的 `ConnectorActionDraft`。

此例外只区分“内部权威记录”和“外部业务副作用”，不允许把待外发消息、待执行 payload 或隐藏 Connector 调用伪装成普通内部持久化。

### 3. 所有写动作使用同一权威链路

统一链路是：

```text
用户意图
→ Agent 生成结构化 ConnectorActionDraft
→ Control Plane 校验 Schema、权限、Evidence、影响范围和幂等语义
→ 冻结 immutable ConnectorActionVersion + canonical payload hash
→ 小纬通过可信 Schema UI 展示确认卡
→ 用户修改 / 取消 / 确认
→ ApprovalVersion 绑定精确 ActionVersion 与 payload hash
→ Connector Gateway 执行前重新授权
→ 执行固定 payload
→ 保存外部 ID、回执、Evidence、Lineage 与不可变审计
```

`ApprovalVersion` 继续由 Control Plane 权威保存。面向 Connector 动作时，其 subject 必须绑定精确 `ConnectorActionVersion`、canonical payload hash、用户、tenant、目标 Connector/资源、影响摘要、有效期和必要的幂等语义；它不是一段可复用的自然语言“同意”。

### 4. 确认 UI 只渲染可信 Schema

小纬在对话中展示由平台可信 UI 根据结构化 Schema 渲染的表单卡。模型不能生成任意 HTML、脚本、隐藏字段或最终执行 payload。

例如“创建工单”确认卡至少应按对应 Connector schema 展示：

- 目标系统；
- 设备或产线；
- 工单类型与描述；
- 优先级与计划时间；
- 负责人；
- 停机影响；
- 支撑该动作的 Evidence；
- 权限、风险或数据完整性警告；
- `修改`、`取消`、`确认创建` 三类明确动作。

字段的 required/optional、枚举、资源选择器和风险提示由版本化 Schema/Connector policy 决定，不能由模型临时弱化。

### 5. 修改执行语义必须生成新版本并使旧批准失效

用户、Agent 或系统修改任一执行语义字段时，必须创建新的 Draft、`ConnectorActionVersion` 和 payload hash。旧 `ApprovalVersion` 进入 `superseded`，禁止原位修改已经批准的对象。

浏览器确认请求只提交 `approvalId + decision`，不得再次提交执行参数。服务端必须从 Control Plane 读取冻结的 `ConnectorActionVersion` 和 payload，验证 hash 后交给 Connector Gateway。浏览器、Agent 或 Runtime 重新拼装的参数不能覆盖冻结版本。

### 6. 人工确认不替代执行前授权

Connector Gateway 在产生副作用前仍须重新检查：

- 当前用户与 tenant；
- Capability ceiling；
- `WorkflowVersion` 已批准 scope；
- audience；
- Connector policy；
- delegated token/capability；
- Evidence 可访问性；
- Approval/Capability/token expiry；
- 当前 attempt、lease 与 fencing token。

任一条件变化或失效都必须拒绝执行或要求生成新版本/新批准。用户确认不能把无权限动作变成有权限动作，也不能成为跨 tenant、跨资源或无限期授权。

### 7. 写动作必须幂等并能处理不确定结果

每个外部动作必须有稳定 idempotency key：

- 同 key + 同 payload：返回第一次已保存的结果或继续对账，不重复产生副作用；
- 同 key + 不同 payload：返回结构化冲突，不覆盖第一次动作；
- timeout/断线/进程崩溃：先查询外部系统或回执进行对账，不能盲目重试；
- 旧 attempt 或旧 fencing token：不能再次执行或覆盖新结果。

用户可见状态至少区分：

```text
awaiting_confirmation
executing
succeeded
failed
outcome_unknown_reconciling
canceled
expired
superseded
```

`failed` 只用于已经确定没有成功或已得到确定失败回执的情况；无法确认外部结果时必须保持 `outcome_unknown_reconciling`，不得伪装成可安全重试的失败。

### 8. 高风险动作升级审批；自动写只能显式例外

高风险批量写、删除、财务承诺、质量放行、设备参数修改与设备/产线启停，必须支持更高级审批或多人审批。对应门槛、审批角色、职责分离和 expiry 由版本化 policy 决定。

未来如果业务确需“自动写”，只能通过单独授权的 immutable `AutomationPolicyVersion` 建立显式例外。该版本必须限制：

- tenant、Capability 和 Connector；
- 资源范围与 audience；
- 动作、字段和值域；
- 数据/动作等级与风险上限；
- 单次/累计预算、频率、并发和调用次数；
- 有效期、撤销条件和责任 owner；
- Evidence 要求、幂等、对账与审计。

`AutomationPolicyVersion` 不能由 prompt、普通 Workflow 审批、历史确认或用户沉默隐式创建，也不能绕过 Connector Gateway 的逐次再授权。

## 推荐实施顺序

1. Gate A 如获授权，先完成真实 Tool/Connector Gateway、Registry、Broker、逐次授权、只读 `ConnectorActionVersion`、typed result 与 Evidence/Lineage 闭环；所有外部写动作继续 `NOT_OPEN`。
2. 首个申请开放外部写能力的后续 Gate，必须一次性实现本 ADR 的 Draft → immutable ActionVersion/hash → trusted Schema UI → ApprovalVersion → 再授权 → 幂等执行 → 对账/Evidence 全链路，不能只实现 Connector 写方法。
3. 高风险/多人审批在对应风险动作首次开放前完成；未达到审批能力时该动作保持 `NOT_OPEN`。
4. `AutomationPolicyVersion` 只能在人工确认基线稳定并另获授权后引入，不能作为首个写 Gate 的捷径。

以上是依赖顺序建议，不构成 Gate A 或任何写 Gate 的当前实施合同。

## 后续 Gate 必须证明的验收输入

首个申请开放外部写动作的合同至少需要覆盖：

1. Agent/Runtime/Interpreter/临时代码不能直接访问写 Connector；只可产生结构化 Draft；
2. canonical payload/hash golden vectors，批准后任一语义修改都会生成新版本并 supersede 旧批准；
3. 浏览器只提交 `approvalId + decision`，篡改或夹带执行参数无效；
4. 执行前完整再授权，撤权、过期、跨 tenant、超 scope、Evidence 不可访问和旧 fencing 全部 fail closed；
5. 同 idempotency key 的同 payload 去重、不同 payload 冲突；超时先对账且不盲目重试；
6. 八种最小 UI 状态具有可恢复、可审计的 Control Plane 权威转换；
7. Connector 外部 ID、回执、Evidence、Lineage 与审计绑定同一 ActionVersion/attempt；
8. 高风险动作需要对应等级/人数的审批，未满足时无外部副作用；
9. 没有显式有效的 `AutomationPolicyVersion` 时，任何自动写尝试均失败。

## 当前 Gate 0.1 事实

Gate 0.1 的“批准并运行”只绑定固定 `WorkflowVersion` 并触发服务端 fake Runtime 模拟执行。它不是创建工单确认表单，也没有 `ConnectorActionDraft` → `ConnectorActionVersion` → 写 Connector 的产品链路。

当前所有真实写 Connector 和 D1/W1/W2/W3 均未开放，外部写操作必须返回或保持 `NOT_OPEN`。Gate 0.1 内部保存 Conversation、BusinessTask、Event、Evidence、审计和 Workflow 审批等权威状态，不代表存在任何 MES/ERP/QMS/WMS/EAM/SCADA 写能力。
