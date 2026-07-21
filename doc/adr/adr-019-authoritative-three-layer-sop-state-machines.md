# ADR-019：状态机驱动 SOP 采用三层权威与固定 Interpreter 迁移

decision_status: `accepted`

implementation_status: `PARTIAL_GATE_0_1_LINEAR_BASELINE`

future_capability_status: `NOT_AUTHORIZED`

accepted_at: 2026-07-21

decision_scope: geneway Workflow/SOP 的长期执行与状态权威模型

reuse_policy: StaffDeck 仅作外部行为和测试参考，默认净室重实现

authority_effect: 本 ADR 不授予产品代码实施、Gate 扩围、StaffDeck 代码迁移、部署或外部副作用权限

## 决策摘要

状态机驱动 SOP 与 geneway 的 Capability-first、Control Plane 单一权威和不可变 Workflow 原则兼容，正式接受为 geneway Workflow 的核心执行模型。

StaffDeck 的节点/边、start/terminal、`expected_user_info`、Slot filling、等待用户、人工接管、pending task、图形编辑、版本运营、最小邻接上下文投影及相关测试题，可以作为产品行为与验收设计参考；StaffDeck 当前代码、数据库字段和状态推进语义不能直接迁移。默认做法是根据 geneway 权威合同净室重实现，StaffDeck 不成为运行依赖、第二份权威或隐式迁移源。

核心原则是：

> 模型提供结构化事实和建议，平台决定正式状态迁移。

## 已决定的长期不变量

### 1. StaffDeck 行为模式可借鉴，当前权威实现不可迁移

以下产品行为值得吸收：

- 用明确节点、边、start 和 terminal 表达 SOP；
- 用 `expected_user_info`/Slot filling 引导字段收集；
- 支持等待用户、人工接管、pending task 与可恢复交互；
- 提供图形编辑、不可变版本、版本 Diff 与运营可见性；
- 只向 Step Agent 投影当前节点、直接邻接节点、当前字段和允许动作，减少上下文噪声与跳步概率；
- 把合法前进、缺字段、等待恢复、非法跳步、分支、并行与终态设计成可重复测试题。

上述内容只定义期望行为和测试 oracle，不继承 StaffDeck 的表结构、会话字段、调度算法或安全边界。任何未来代码级复用都必须另行取得授权并完成来源、许可证、语义与安全审查；本 ADR 默认且推荐净室重实现。

### 2. 明确拒绝 StaffDeck 当前权威语义

| 被拒绝模式 | geneway 拒绝原因 |
| --- | --- |
| `ChatSession.active_skill_id`、`active_step_id`、`slots_json`、`pending_tasks_json` 作为业务流程权威 | mutable 会话投影不能替代 Control Plane 中的版本化业务状态、审批、attempt/fencing 与审计 |
| 运行只绑定 `skill_id` | 无法证明执行、审批和图形查看的是同一 immutable version/hash |
| LLM Step Agent 直接决定正式 `next_step_id` | 模型建议不能成为权限、审批、边、条件或业务状态迁移权威 |
| condition 使用自由自然语言字符串 | 缺少可重复、可审计、fail-closed 的 `SafeExpression` 或确定性解释器 |
| 服务端只检查目标节点存在 | 不能证明目标是当前节点的直接邻接、边条件已满足、审批/权限边界未被跨越 |
| `_graph_pending_steps` 等并行调度状态塞入 `slots_json` | Slot 不是独立 Step、依赖、attempt、lease、fencing 或 durable join 的权威 |
| 无 attempt/lease/fencing/CAS 的状态推进 | 重试、旧结果晚到和多 Worker 会重复或覆盖正式状态 |
| SOP 节点直接调用有外部副作用的 Tool | 绕过 `ConnectorActionVersion`、人工确认、再授权、幂等与对账链路 |
| 混合来源 Slot 直接作为正式写参数 | 缺少字段级 trust/data class、`EvidenceRef`、`Lineage` 和冻结 payload hash |

### 3. geneway 使用三层状态机并保持权威分离

| 层 | 典型对象/状态 | 权威规则 |
| --- | --- | --- |
| 业务状态机 | Control Plane 中的 `BusinessTask`、`WorkflowRun`、`WorkflowStep`、`ApprovalVersion`、`ConnectorActionVersion` | **唯一业务权威**；负责正式迁移、审批、权限、attempt/lease/fencing、CAS、幂等、副作用与终态 |
| Runtime 子状态机 | `AgentTask` 内部的 `working`、`input_required`、`checkpointed`、`completed` 等 | 非业务权威；只能上报结构化事实、typed `StepResult`、候选迁移、`ConnectorActionDraft`、`WorkflowPatch` 或 interruption |
| 会话/UI 状态机 | 小纬页面的 `drafting`、`awaiting_confirmation`、`running`、`blocked`、`reconciling`、`completed` 等 | 只读投影；从 Control Plane 快照/事件派生，不能反向成为业务真值或绕过命令校验 |

Runtime 和 UI 可以有自己的瞬时状态以改善执行和交互，但它们不得保存第二份正式 Workflow 游标，不得直接把业务 Step 标记为完成，也不得自行使 Approval、Action 或 Task 进入新状态。

### 4. Workflow/SOP 必须编译成不可变版本

正式版本链路固定为：

```text
WorkflowDraft
→ Zod 4 structural validation
→ Compiler + Registry resolution
→ topology / reference / permission / budget / side-effect validation
→ RFC 8785/JCS canonical JSON + SHA-256
→ immutable WorkflowVersion
```

`BusinessTask`/`WorkflowRun`、`ApprovalVersion`、图形投影和 `Workflow Interpreter` 必须绑定同一 `WorkflowVersion id + hash`。Registry 中的 Capability、Tool、Handler、Policy 和其他执行引用也必须解析到精确版本，不能只保存逻辑名称。

运行中任何会改变执行语义的节点、边、条件、引用、输入、权限、预算、副作用或终态变化，都必须生成新 `WorkflowVersion` 和新 hash；旧 `ApprovalVersion` 进入 `superseded`，不能原位修改已批准版本。

### 5. 正式迁移只能由固定 Workflow Interpreter 决定

Agent 可以：

- 抽取字段并返回带类型、trust 和 Evidence 的结构化事实；
- 生成 typed `StepResult`；
- 提出候选下一步；
- 生成结构化 `WorkflowPatch`；
- 请求用户输入、人工接管或其他 interruption。

Agent 不能：

- 直接提交正式 `next_step_id` 并使业务状态推进；
- 裁决权限、审批或外部写动作；
- 越过服务器端边、条件、依赖或终态检查；
- 用自然语言声称“已完成”来替代 Control Plane CAS 更新。

固定 `Workflow Interpreter` 必须根据当前权威 `WorkflowStep` 状态、typed `StepResult`、`SafeExpression`/确定性 Handler、显式 dependency、审批、权限、attempt/lease/fencing 与 CAS 结果决定正式迁移。候选目标即使存在，也必须被证明是当前节点的直接邻接节点，并且边条件、依赖、审批和权限全部满足；否则 fail closed。

### 6. StaffDeck 概念映射到 geneway 的正式合同

| StaffDeck 概念 | geneway 映射 |
| --- | --- |
| `skill_id` / active step | 绑定 immutable `WorkflowVersion id + hash` 的 `WorkflowRun`/`WorkflowStep` |
| 自由自然语言 condition | 有限、可静态校验的 `SafeExpression`，或 Registry 中已登记、版本固定的确定性 Handler |
| `allowed_actions` | 已登记、版本固定的 Capability/Tool/Handler 引用及 permission ceiling；临时编码还须遵守 [ADR-017](adr-017-controlled-ephemeral-orchestration-code.md) |
| `slots_json` | 分拆为 Workflow input snapshot、typed `StepResult`、`ContextPacket`、`TrustLabel`、`EvidenceRef` 与 `Lineage` |
| pending task | 独立 `BusinessTask` 或 child workflow，具有自己的状态、版本、审批、attempt 和审计 |
| awaiting input | durable wait；等待条件与恢复 token 由 Control Plane 权威保存 |
| handoff | 正式 actor/owner 变更、可见 audit 和权限重算；恢复使用 CAS 与新 attempt/fencing |
| `_graph_pending_steps` | 正式 Workflow dependency、独立 Step 状态与 durable join |

Slot filling 仍可作为交互模式，但每个字段都必须有 schema、来源、trust/data class、Evidence/Lineage 和当前版本语义。不同来源的字段不能在一个无类型 JSON bag 中混合后直接用于正式外部写入。

### 7. 并行、汇合、等待和恢复必须 durable

真正并行必须为每个分支建立独立 `WorkflowStep` 状态、dependency、attempt、lease 和 fencing token；汇合由固定 Interpreter 根据 durable join 条件推进。不能把 sibling step 的顺序队列、完成标记或待执行列表塞进 Slot/会话 JSON。

等待用户、人工接管或外部事件时，业务状态机进入正式 durable wait，保存等待原因、允许恢复 actor、权限与 expiry。恢复必须读取同一 Workflow/Step 版本，重新鉴权，并通过 CAS 和新的 attempt/fencing 推进；Runtime checkpoint 或 UI 点击本身不能成为恢复权威。

### 8. 外部写动作遵守不可变 ActionVersion 与人工确认

状态机中的写节点不能直接调用产生外部副作用的 Tool。以“创建工单”SOP 为例，正式链路必须是：

```text
collect fields
→ ConnectorActionDraft
→ validate + freeze ConnectorActionVersion / canonical payload hash
→ 小纬可信 Schema 表单
→ human ApprovalVersion
→ Connector Gateway re-authorization + execute
→ reconcile / typed result / Evidence / Lineage / audit
```

从 `awaiting_confirmation` 到 `executing` 的正式迁移，只能由 Control Plane 在验证精确 `ConnectorActionVersion`、payload hash、`ApprovalVersion`、权限、attempt/fencing 与幂等状态后执行。Agent 的候选 `next_step_id`、Runtime completion 或 UI 本地状态均不能推进该迁移。完整外部副作用不变量见 [ADR-018](adr-018-human-confirmation-for-external-side-effects.md)。

### 9. 最小邻接上下文是 Harness 优化，不是安全边界

值得直接吸收的 StaffDeck 行为模式是：Step Agent 默认只看到当前节点、直接邻接节点、当前需要/已收集字段，以及该 Step 获准使用的版本固定工具或 Handler。这样可减少上下文、成本和模型提出非法跳步的概率。

该投影必须由当前 immutable `WorkflowVersion` 和权威 Step 状态生成；不能由 Agent 自己声明邻接关系。即使投影正确，Control Plane、Compiler 和 Interpreter 仍必须独立验证拓扑、直接邻接、条件、依赖、权限、审批和 fencing。Harness 最小化上下文不能替代服务器端校验。

## 当前实现、未来实现与授权边界

### 当前 Gate 0.1 已实现

- 固定 `solution.analysis.v1` 七节点线性拓扑；
- Zod 4/Compiler、canonical JSON、SHA-256 和 immutable `WorkflowVersion id + hash`；
- Task、整体 `ApprovalVersion`、只读图形投影和普通 Interpreter 绑定同一版本；
- Control Plane 权威 Step 状态、attempt/lease/fencing、前序依赖检查、CAS 风格状态推进和陈旧 completion 拒绝；
- 服务端 fake Runtime，且 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`。

这只是三层状态机长期模型的**最小固定线性基线**。Gate 0.1 没有动态 condition、真正 parallel/join、durable wait/人机恢复、Agent 生成的动态 `WorkflowDraft`/`WorkflowPatch`、`ConnectorActionVersion` 写链路或真实外部副作用。

### 后续 Gate 的推荐入口

- Gate B 或独立后续 Gate：在不改变 Control Plane/WorkflowVersion 权威的前提下，引入 durable wait/recovery、child workflow、真正 parallel/join、跨 Worker lease/fencing 与 Runtime 子状态机恢复。
- Gate C 或独立后续 Gate：引入 Agent 生成的结构化 `WorkflowDraft`/`WorkflowPatch`、`SafeExpression`、动态条件、Registry 引用解析、图形/version Diff 和重新审批。
- 首个开放外部写动作的 Gate：必须同时满足 ADR-018 的 ActionVersion、可信确认、再授权、幂等和对账链路。

这些是依赖顺序与未来合同输入，不是 Gate B/C 的现有实施合同，也不授予任何产品代码实现。未获得新 authority slice、可审计合同和用户明确授权前，相关能力保持 `NOT_OPEN`。

## 后续 Gate 必须证明的验收输入

首个申请实现本 ADR 动态能力的合同至少需要把以下内容转成可机器验证的验收条件：

1. 同一 `WorkflowDraft` 得到稳定 canonical JSON/hash，Task、Approval、图形和 Interpreter 的 `WorkflowVersion id + hash` 完全一致；
2. 任一执行语义变化生成新版本并使旧 Approval `superseded`，不能原位修改；
3. Agent 提出不存在或非直接邻接的 `next_step_id` 时，服务器拒绝且业务状态不变；
4. `SafeExpression`/确定性 Handler 对同一冻结输入得到同一结果，未知字段、非法表达式和未注册 Handler fail closed；
5. Runtime/UI 不能直接写正式 Step/Task/Approval/Action 状态，只能提交受 schema 校验的命令或结构化事实；
6. 旧 attempt、过期 lease、错误 fencing token、重复 completion 与 CAS 冲突都不能推进状态；
7. parallel 分支具有独立状态和 lease，durable join 不因重放、乱序或部分完成而提前推进；
8. durable wait 经重启仍可恢复，未经授权 actor、过期 resume 或旧 fencing 不能恢复；
9. pending task 映射为独立 BusinessTask/child workflow，不以 Slot 队列冒充；
10. 混合来源字段保留 trust/data class/Evidence/Lineage，不能直接成为写 payload；
11. `awaiting_confirmation → executing` 只有在精确 ActionVersion/payload hash 与 Approval 校验通过后发生；
12. Step Agent 的最小邻接上下文投影正确，但即使构造恶意候选迁移，服务器仍独立拒绝越边、越条件、越权和越审批。

## 被拒绝的替代方案

- 把 StaffDeck ChatSession/Slot/pending task 数据结构作为 geneway 业务权威；
- 直接复制 StaffDeck 状态推进代码，再逐步补版本、审批和 fencing；
- 让 LLM 输出的 `next_step_id` 直接驱动正式状态；
- 用 prompt 或自然语言 condition 替代确定性表达式/Handler；
- 把最小邻接上下文视为足以阻止越权跳步的安全边界；
- 把并行、等待或 child task 状态塞进 `slots_json`；
- 让 SOP 节点绕过 ADR-018 直接调用外部写 Tool。
