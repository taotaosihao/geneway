# ADR-017：受控临时编码只能作为固定 Workflow 的有界沙箱步骤

decision_status: `accepted`

implementation_status: `NOT_OPEN`

accepted_at: 2026-07-21

decision_scope: 后续 Gate 长期不变量

authority_effect: 本 ADR 不授予产品代码实施、Gate 扩围、部署或外部系统访问权限

## 背景

某些制造业任务需要按当次输入组合多个已经登记的 MCP/API 调用、执行计算或转换。允许 Agent 在严格边界内生成临时程序，可以降低为每一种一次性组合预先编写固定 handler 的成本；但 StaffDeck 式通用 General Skill runner 会把任意代码、依赖、网络、凭据和长任务控制权引入同一执行面，直接破坏 geneway 的 Workflow、授权、审计和工业系统边界。

本决定补充但不替代 v19 的既有原则：动态 Workflow 仍是版本化数据而不是动态代码，工业访问仍只经 Gateway，Control Plane 仍是唯一业务权威。

## 已决定的长期不变量

### 1. 顶层执行权威不下放给临时代码

未来可以允许 Agent 临时编码，目的仅限于在**一个已经批准的 Workflow Step 内**编排“已登记、版本固定、权限固定”的 MCP/API。临时代码不是新的 Workflow 引擎、Capability 权威、后台守护进程或通用 Skill runner。

下列职责始终归属 Control Plane、不可变 `WorkflowVersion` 和固定 `Workflow Interpreter`：

- 顶层任务与步骤状态；
- 审批、等待、重试和恢复；
- 幂等、补偿、超时和取消；
- attempt/lease/fencing 判定；
- 预算、权限、Evidence 和审计权威。

临时代码只能返回有类型的步骤结果或草稿，不能自行推进 Workflow、变更批准对象、创建第二份长任务状态，或绕过 Interpreter 直接声明任务成功。

### 2. 临时代码默认不可信

沙箱必须默认拒绝以下能力：

| 执行面 | 决定 |
| --- | --- |
| 网络 | 无原始网络；不能自行访问任意 URL、socket 或任意 MCP transport |
| 文件 | 无宿主文件系统；输入只能来自冻结的输入快照，输出只能经受控结果通道返回 |
| 凭据 | 无服务环境变量、生产凭据、Connector credential 或用户 token |
| 进程 | 无任意子进程、shell、daemon 或进程间逃逸面 |
| 依赖 | 无动态 `pip`/`npm` 安装，也不能在执行时下载代码、模型或二进制 |
| 工具 | 只能调用 geneway Tool Broker 暴露的受控 host function；host function 只解析批准集合中的固定 `ToolVersion` |

沙箱隔离是强制执行边界，不能用 prompt 约束、Agent 自律或代码审查替代。

### 3. 每一次 Tool/MCP/API 调用都重新授权

沙箱获准运行不代表其内部调用已经获准。Tool Broker 必须在**每一次**调用时重新检查：

- `AuthorizationService` 判定；
- 当前 `Delegated Capability`；
- tenant、用户与 resource scope；
- data class 与 action class；
- audience；
- 总预算、单次预算、并发和调用次数；
- capability/token/approval 的期限；
- 当前 attempt、lease 与 fencing token；
- `WorkflowVersion` 与该步骤批准的 `ToolVersion` 集合。

检查失败必须 fail closed。不能因为程序 source hash 已批准、上一次调用成功或同一 MCP session 尚未结束，就缓存为后续调用的隐式授权。

### 4. 程序及其执行语义必须版本化并冻结

每个可执行版本至少冻结：

- source 与 source hash；
- runtime image digest；
- input snapshot/hash；
- 精确 `ToolVersion` 集合；
- authorization/policy version；
- CPU、内存、时长、输出、预算、并发与调用次数上限；
- tenant、audience、data/action class 和有效期；
- 所属 `WorkflowVersion`、step、attempt 与 fencing 上下文。

任何执行语义变化都必须产生新版本和新 hash，旧批准不能沿用。具体 wire object 名称与 Zod 4 schema 由获得授权的后续 Gate 合同冻结；本 ADR 只冻结语义，不提前创造当前产品接口。

每次 Tool 调用的输入、版本、授权判定和输出必须进入 typed `ToolResult`、`Evidence`、`Lineage` 与不可变审计。临时代码的 stdout、自由文本或进程退出码不能直接成为已发布业务结论。

### 5. 首次开放只允许低副作用用途

首期只允许：

- 只读查询的受控组合；
- 分析与确定性计算；
- 数据转换；
- 生成仅保存在 geneway 内部的草稿。

对于外部写入或控制，临时代码最多生成结构化 `ConnectorActionDraft`，不能调用写 Connector、不能直接产生外部副作用，也不能替代 [ADR-018](adr-018-human-confirmation-for-external-side-effects.md) 的冻结、人工确认、再授权和执行链路。

## 推荐启用顺序

| 阶段 | 应先具备的能力 | 明确不包含 |
| --- | --- | --- |
| 已完成 Gate 0.1 | 固定 Workflow、普通 Interpreter、fake Runtime、`NOT_OPEN` 负向边界 | Tool/Connector Gateway、真实 MCP/API、临时编码沙箱 |
| 建议 Gate A 合同 | 真实 Tool/Connector Gateway、Registry、Tool Broker、逐次授权、typed `ToolResult`、`Evidence`/`Lineage`，先跑固定只读 `ToolVersion` | 通用 runner、沙箱内任意网络/依赖、外部写动作 |
| Gate C 或独立后续 Gate | 在上述基础已验收后，另建 authority slice 引入 orchestration sandbox；首次只开放只读、分析、转换和草稿 | 顶层 Workflow 代码化、StaffDeck General Skill runner、直接外部副作用 |

这里的 Gate 标注是依赖顺序建议，不是现有 Gate A/C 合同，也不授予其实现权限。如果 Gateway、Registry、Broker、逐次授权或 typed Evidence 尚未形成真实闭环，沙箱必须保持 `NOT_OPEN`。

## 后续 Gate 必须证明的验收输入

首个申请实现本 ADR 的合同至少需要把以下内容转成可机器验证的验收条件：

1. 沙箱没有原始网络、宿主文件、服务环境变量、任意子进程和动态依赖安装能力；
2. 未登记、版本不匹配、超出批准集合的 Tool/MCP/API 调用全部失败；
3. 每次调用都执行完整授权、预算、期限、attempt/fencing 检查，撤权后下一次调用立即失败；
4. 同一冻结版本可复现 source/runtime/input/tool/policy 组合，任一变化得到新 hash；
5. Tool 结果进入 typed `ToolResult`、`Evidence`、`Lineage` 和不可变审计，无法从 stdout 旁路发布；
6. 沙箱超时、崩溃、重放和旧 attempt 晚到都不能重复推进任务或产生第二份外部效果；
7. 写入/控制请求只能产出 `ConnectorActionDraft`，外部系统无直接副作用。

## 被拒绝的替代方案

- 迁移或开放 StaffDeck 式通用 General Skill runner；
- 让 Agent 生成可接管顶层任务的 TypeScript/Python Workflow；
- 给沙箱生产凭据、任意 MCP transport 或互联网出口，再依赖 prompt 限制用途；
- 只在程序启动时授权一次，让后续 Tool 调用继承无限期权限；
- 让临时代码自己管理审批、等待、重试、恢复、幂等或补偿。

## 当前 Gate 0.1 事实

Gate 0.1 没有 Tool/Connector Gateway、真实 MCP/API 调用面或 orchestration sandbox。唯一执行器是服务端 fake Runtime；所有未开放 Runtime/Tool/Connector kind 必须结构化拒绝。当前产品不得宣称已经支持临时编码、General Skill、真实 Tool 编排或外部系统访问。
