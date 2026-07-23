# geneway Gate 0.2B.2–0.2B.3 联合恢复实施合同

workflow_id: 20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3
task_id: 20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3
title: geneway Gate 0.2B.2–0.2B.3 联合恢复
contract_status: final
current_authoritative_contract: doc/plans/atlas-workflow/20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3/implementation-contract.final.md
created: 2026-07-23
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
team_convergence: CONSENSUS
review_verdict_digest: 0bb036c578cc24ffda3c01aaadd752782310e585588fbde8389744c5a285becc
safe_fallback_authority: goal:G02B23-SAFETY
work_type: implementation
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `G02B23-PRODUCT`：在真实 served geneway Web 中恢复并完成异常 fixture vertical。用户从 `/exceptions` 查看两个版本固定且醒目标记模拟的 DB fixture，查看 Evidence、认领主异常、选择自动/单专家/专家团并点击“让小纬分析”；系统创建唯一绑定任务，展示固定 Workflow hash 与独立 ApprovalSubject digest，批准执行后可从 Conversation、Task 和 Workflow 路由恢复同一权威对象。
- `G02B23-AUTHORITY`：Control Plane Postgres 是 BusinessException、BusinessExceptionSourceSnapshot、认领状态、analysis binding、BusinessTask、WorkflowVersion/hash、ApprovalVersion/subject digest、Claim/Evidence/Lineage、Artifact metadata 和事件的唯一业务权威；fixture、UI、Worker、SSE、React Flow 和轻量语义表格只作投影或执行适配。
- `G02B23-EXCEPTION`：严格使用 combined Gate 0.2B 合同固定的两个安全 fixture、source snapshot、去重键、受控 seed、认领 CAS 与 singleton analysis binding；不改成真实业务数据，不把 fixture 结果描述为真实异常诊断。
- `G02B23-QUERY`：异常列表/详情与已关闭的 Task/Workflow 路由继续使用服务端 tenant/principal/resource/data/audience 授权、字段 allowlist、稳定 querySnapshot cursor 和受限 filter/sort/page size；浏览器不做跨页权威过滤、拼接或导出。
- `G02B23-WORKFLOW`：`operations.exception-assist.v1` 只以 `shadow + fixture-only + fake` 运行，固定 A1 ceiling、七节点六边和 immutable registry refs。ExpertTarget 不改变 Workflow hash，只进入 BusinessTask 与 ApprovalSubject digest；输出持续显示 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`。
- `G02B23-RECOVERY`：用真实或明确负向 oracle 关闭适用路由的 loading、empty、filtered-empty、403/404、409、5xx/offline、stale、canceled、reclaim；异常按 aggregateVersion 重取，Task 按 eventCursor 续传，Worker checkpoint/reclaim 不创建第二结果。
- `G02B23-SCHEMA`：所有 Gate 新增或修改的 public wire contract 以 Zod 4 为唯一 authored schema 并生成 JSON Schema artifact；同一冻结 corpus 证明 Zod runtime accept/reject，结构/digest golden 校验生成 artifact，不引入第二 authored schema、TypeBox、Ajv 或第二 validator 权威。
- `G02B23-SAFETY`：所有列表、详情、认领、分析、Task、Workflow、Evidence 和 Artifact 访问都在服务端边界逐次授权；403/404 不泄漏对象存在性；真实 provider、Model Gateway、GearJob、真实告警、客户生产数据、生产写和外部网络全部 fail closed。
- `G02B23-ORDERING`：只按 `0.2B.2 → 0.2B.3 → pnpm verify:gate0.2b` 串行关闭。内部切片通过不能冒充整个 Gate 关闭；只有聚合门、独立 review/verifier 与 source-bound 证据全部通过才允许声明 Gate 0.2B closed。
- `G02B23-REGRESSION`：Gate 0.2A（含 Gate 0.1）与 Gate 0.2B.1 已关闭基线保持通过；Gate A0 只作为已有 source-bound closure/no-touch 基线，本 Gate 不读取 auth、不启动 Model Gateway 或 live provider/LAN，通过禁止路径 diff 与定向本地路由回归证明默认 `/conversations/new` 仍是无需材料的 Fast Chat；Gate 0.2B 不开放 Gate A 真实材料能力。

### Normative Inputs And Conflict Rule

1. 本合同是 combined Gate 0.2B 最终合同中 0.2B.2–0.2B.3 的联合恢复投影；combined contract 的 fixture bytes/hash、BusinessException 权威、querySnapshot、固定 Workflow、route-state oracle、验收和 Non-goals 在本合同明确引用或重述的部分继续有效。
2. Gate 0.2B.1 已关闭，其 Task/Workflow/Conversation 路由、授权投影和 querySnapshot 基础只复用、不重做；只有本合同明确拥有的异常业务、恢复加固和聚合门由本合同修改。
3. Gate A0 已关闭；本合同不得修改 `services/model-gateway/**` 或把 Fast Chat 变成材料/异常前置。Gate A 仍保持 `NOT_OPEN`，直到本合同真实关闭且 Gate A 其余进入条件另行满足。
4. 路线图、技术附录、分析文档和 reviewer 建议不能扩大本合同。只有当前 SDD v2 controller 以 `current-required` 正式准入的 Goal blocker、安全、数据完整性或权限 finding 可以进入 final executable requirements。

### Non-goals

- 不接真实模型、共享 Codex 订阅、Model Gateway、OpenAI Agents SDK、Claude、AgentScope、DeerFlow 或任何 provider；继续复用服务端 FakeRuntime。
- 不读取或修改 `/home/gewu/work/gearjob`、Hive、Sharp Cell、真实 MES/ERP/QMS、设备、告警、工单或客户生产数据；不创建 Connector、数据库直连、SQL 查询、MCP 或外部 API 路由。
- 不实现真实异常发现规则、轮询、实时数据、生产日报、复杂根因诊断、异常关闭或正式处置动作；设备报警 fixture 不能触发设备控制。
- 不引入 Hatchet，不开放动态 Harness/Workflow Draft/Patch、condition、parallel、wait、loop、运行中改图、自由节点编辑或 LLM 生成代码。
- 不开放 D1/W1/W2/W3，不创建正式工单，不修改排产，不发送生产通知，不接飞书、企微、小程序、Matrix、AgentTeams、A2A 或外部 Agent。
- 不实现内部管理后台、Capability Matrix、知识库、索引、Embedding、Eval、导出或报表中心。
- 不重做 geneway 视觉体系，不引入重型表格框架；沿用 assistant-ui、Base UI、React Flow 和 geneway token。
- 不修改 `/home/gewu/.codex` 或 `/home/gewu/.codex/auth.json` 的权限、内容或位置；本 Gate 不读取、复制、刷新或投影 provider credential。
- 不 push、不建 PR、不部署、不发布到客户生产。

### Owned And Forbidden Surfaces

Owned paths 仅限 authority brief 中列出的：

```text
apps/control-plane/**
apps/web/**
apps/worker/src/worker-loop.ts
apps/worker/src/interpreter.ts
apps/worker/src/worker-loop.test.ts
packages/contracts/**
packages/ui/**
packages/runtime/src/index.ts
packages/runtime/src/runtime.test.ts
packages/workflow/**
migrations/**
scripts/**
package.json
pnpm-lock.yaml
README.md
AGENTS.md
doc/plans/atlas-workflow/20260723-022-geneway-gate-a-gate-0-2b-2-0-2b-3/**
```

以下路径和系统禁止修改：

```text
services/model-gateway/**
connectors/gearjob/**
infra/hatchet/**
apps/channel-gateway/**
/home/gewu/work/gearjob/**
/home/gewu/work/hive/**
/home/gewu/work/sharp-cell/**
/home/gewu/.codex/auth.json
```

若实现必须修改未列入 owned paths 的其他 `apps/worker/**`、`packages/runtime/**` 或产品路径，立即停止并提交路径、必要性、最小 diff 和替代方案的权限决策包；不得把“集成需要”或已授权五个文件当作目录级隐式授权。

Fresh path audit 已把原 open 决定收敛为以下五个精确文件；用户已在当前线程明确“确认授权”，并已同步进 authority brief：

```text
apps/worker/src/worker-loop.ts
apps/worker/src/interpreter.ts
apps/worker/src/worker-loop.test.ts
packages/runtime/src/index.ts
packages/runtime/src/runtime.test.ts
```

该授权只允许既有 Worker 验证第二个固定 Workflow 与 `business_exception_snapshot`、同一 FakeRuntime 执行冻结 exception steps、以及相应单测；不允许修改 `apps/worker/src/chat-*`、`packages/runtime/src/chat-runtime.ts` 或打开 provider/Connector/外网。`packages/evidence/**`、`packages/authorization/**`、`packages/storage/**` 经只读核查均可由现有 API 加上已 owned 的 Control Plane/contracts/migration 路径完成，继续保持 no-touch；package manifest、tsconfig、lockfile 也不因本决定预授权修改。授权证据为 `team/reports/path-authority-user-decision.md`。

## Fixed Fixture And Exception Authority

fixture 只能由受控 Control Plane seed command 写入；不提供浏览器可调用的 fixture 注入 API。seed 只允许 `NODE_ENV=test|development`、loopback、明确 tenant 和 `is_non_production=true` 数据库；production、非 loopback、错误 tenant、非开发数据库或 fixture hash 不符时必须在任何业务行写入前失败，并证明相关表本次写入计数为 0。

主 fixture `scripts/fixtures/gate0.2b/capacity-progress-lag.v1.json` 的 RFC 8785/JCS canonical bytes 固定为：

```json
{"dataClass":"C1","detectedAt":"2026-07-21T08:30:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"capacity_progress_lag","fixtureVersion":"gate0.2b-capacity-lag/1","resourceScope":"factory-01/workshop-machining/line-02","severity":"high","sourceObjectRef":"work-order:WO-GATE02B-001","sourceSystem":"fixture-manufacturing","summary":"二号机加工线工单进度落后","values":{"completedQty":48,"elapsedPct":75,"planQty":100,"progressPct":48,"thresholdPct":60}}
```

SHA-256：`0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6`。

次 fixture `scripts/fixtures/gate0.2b/equipment-alarm.v1.json` 的 RFC 8785/JCS canonical bytes 固定为：

```json
{"dataClass":"C1","detectedAt":"2026-07-21T08:35:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"equipment_alarm","fixtureVersion":"gate0.2b-equipment-alarm/1","resourceScope":"factory-01/workshop-machining/line-02/equipment-CNC-017","severity":"medium","sourceObjectRef":"equipment:CNC-017","sourceSystem":"fixture-manufacturing","summary":"CNC-017 主轴温度报警","values":{"alarmCode":"SPINDLE_TEMP_HIGH","currentValue":78.2,"threshold":75,"unit":"°C"}}
```

SHA-256：`c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593`。

去重键固定为：

```text
(tenant_id, source_system, exception_type, source_object_ref, detection_window)
```

重复 seed 返回既有记录，不改变 fixture version/hash，不产生第二条活动异常。认领只允许 `open → acknowledged`，由 `aggregateVersion` CAS 保存服务端 principal 与时间；同 principal 重放幂等，其他 principal 争抢返回不泄漏赢家字段的 409。本 Gate 不提供 `resolved/closed` 转换。

### BusinessExceptionRef、source snapshot 与 audience

- `exceptionId`、`sourceVersionId`、`sourceSystem`、`exceptionType`、`sourceObjectRef`、`detectionWindow`、`fixtureVersion/hash`、`canonicalizationVersion`、`resourceScope`、`dataClass` 创建后不可变。
- `status`、`ownerPrincipalId`、`acknowledgedAt`、`analysisBinding` 只能通过 aggregateVersion CAS 修改；每次成功 mutation 与 `business_exception_events`、audit、outbox 在同一 transaction 提交。
- `BusinessExceptionSourceSnapshot` 是 task-independent 权威，最少保存 `businessExceptionId, sourceVersionId, canonicalBytes, canonicalSha256, canonicalizationVersion, fixtureVersion, sourceSystem, sourceObjectRef, detectionWindow, resourceScope, dataClass`；`sourceVersionId` 为主键且 `businessExceptionId` 唯一。
- source projection 使用 `{kind: resource_exception, businessExceptionId, resourceScope, dataClass}` audience；task Evidence 使用 `{kind: private_conversation, conversationId}` audience。两者是 Zod discriminated variants，不允许字符串别名混用。
- analysis task 只在重新授权、当前 principal 已认领且 source scope 仍覆盖时，派生新的 private Conversation/Evidence projection；转换冻结 source audience、task audience、权限交集 digest 与 ApprovalSubject digest，不修改 source snapshot。
- `EvidenceSource` 只新增 `business_exception_snapshot` variant：`kind, businessExceptionId, sourceVersionId, sourceSha256, canonicalizationVersion, jsonPointer, valueSha256`。禁止 `business_exception_fixture` 平行别名。
- seed transaction 写入 BusinessException、source snapshot、detected event、audit 和 outbox；创建异常时不得提前创建 Conversation、BusinessTask、EvidenceItem、Claim 或 Lineage。
- publish/download 前重算 source hash/locator，并同时检查 source scope 与 task audience；失败时不得发布 Claim、报告 Artifact 或下载内容。

### Singleton analysis binding

每个 `sourceVersionId` 最多一个 analysis binding。第一次成功请求在同一 transaction 冻结：

```text
sourceVersionId + capabilityVersionId + requesterPrincipalId +
privateConversationId + requestedExpertTarget + resolvedExpertTarget +
expertCatalogVersion + permissionCeiling + inputDigest
```

同 transaction 创建 private Conversation、BusinessTask、binding、task Evidence/Lineage、ApprovalVersion 和 outbox。完全相同的规范化请求与 idempotency key 在重新授权后返回既有任务；任一 requester、conversation、ExpertTarget、权限或 input digest 不同，统一返回不含旧 task/owner/conversation ID 的 `409 ANALYSIS_BINDING_CONFLICT`，且不创建第二 binding、Approval、Workflow、Claim 或 Artifact。

## Fixed Shadow Workflow

`operations.exception-assist.v1` 的状态固定为 `shadow`，最高动作等级 A1；A1 只产生显著模拟的建议，不做业务写入。TS 模板输出标准 `WorkflowDraft`，Compiler 产出的 immutable canonical `WorkflowVersion` 是 Approval、React Flow、Interpreter 与 diff 的唯一流程权威。

固定模板头：

| Field | Fixed value |
| --- | --- |
| `schemaVersion` | `workflow-draft.fixed-v1` |
| `capabilityVersionId` | `cap_operations_exception_assist_v1_shadow_1` |
| `harnessVersionId` | `harness_operations_exception_assist_fake_v1_1` |
| `featureSet` | `fixed-v1` |
| `permissionCeiling.actions` | `[R0, R1, A1]` |
| `permissionCeiling.resourceScopes` | 当前 `BusinessExceptionRef.resourceScope` 精确值 |
| `permissionCeiling.dataClasses` | `[C1]` |
| `routingPolicyVersion` | `expert-catalog.gate0.2b/1`，只作 registry 校验，不进入 Workflow payload |

固定节点与边：

| Order | Node id | Kind | Immutable registry reference | inputRefs | outputSchemaId |
| ---: | --- | --- | --- | --- | --- |
| 1 | `exception_snapshot_load` | deterministic | `business-exception-source-reader/1` | `workflow.input.businessExceptionRef` | `business-exception.snapshot/1` |
| 2 | `deterministic_baseline` | deterministic | `exception-baseline-calculator/1` | `step.exception_snapshot_load.output` | `exception.baseline/1` |
| 3 | `expert_route_resolve` | deterministic | `approved-expert-binding-reader/1` | `step.deterministic_baseline.output` | `expert.routing-projection/1` |
| 4 | `impact_analysis` | agent | capability/harness 取模板头固定值 | `step.deterministic_baseline.output`, `step.expert_route_resolve.output` | `exception.impact-analysis/1` |
| 5 | `action_recommendation` | agent | capability/harness 取模板头固定值 | `step.impact_analysis.output` | `exception.action-recommendation/1` |
| 6 | `evidence_quality_check` | verification | `claim-evidence-minimum/2` | `step.action_recommendation.output` | `evidence.verdict/2` |
| 7 | `report_publish` | deterministic | `simulation-publisher/2` | `step.evidence_quality_check.output` | `report.projection/2` |

边固定为相邻节点的六条有向边。Compiler 只接受 Gate 0.1 已有 `solution.analysis.v1` 精确模板和本模板；节点增删、换序、未知引用、自由 URL/code、condition/parallel/wait/loop 返回 `NOT_OPEN`。template → Draft → Compiler → stored readback 必须有 canonical JSON/hash golden oracle。

ExpertTarget 不进入 Workflow hash。`requestedExpertTarget`、`resolvedExpertTarget`、`expertCatalogVersion` 与 `inputDigest` 进入 BusinessTask，其 canonical digest 进入 ApprovalSubject。UI 必须分别显示 Workflow hash 与 ApprovalSubject digest；审批后 ExpertTarget、输入、权限或目录版本变化要求新的 ApprovalVersion，不允许改写既有 singleton binding。

FakeRuntime 输出必须区分 fixture 事实、模拟分析、A1 建议和未知项。事实字段只能来自受权 Evidence；模型样式文本不得覆盖数量、阈值、时间、设备或工单标识。无可访问 Evidence 时不得发布 Claim 或报告 Artifact。

## Route, API And Query Contract

核心入口：

| Route | Owned behavior |
| --- | --- |
| `/exceptions` | 异常与待办列表、服务端筛选/排序/cursor、模拟来源和更新时间 |
| `/exceptions/:exceptionId` | source Evidence、认领、ExpertTarget 与“让小纬分析” |
| `/conversations/:conversationId` | 复用 0.2B.1 受权 Conversation 深链并返回仍可读的 `latestTaskId` |
| `/tasks`, `/tasks/:taskId`, `/tasks/:taskId/workflow` | 复用 0.2B.1 任务、审批、取消、Evidence/Artifact 与 task-scoped Workflow 深链 |
| `/workflows`, `/workflows/:workflowVersionId` | 复用 0.2B.1 只读 immutable WorkflowVersion 投影 |
| `/conversations/new` | 保持 Gate A0 默认无材料 Fast Chat，不自动创建异常或 BusinessTask |

Control Plane 新增：

```text
GET  /api/business-exceptions
GET  /api/business-exceptions/:id
POST /api/business-exceptions/:id/acknowledge
POST /api/business-exceptions/:id/analysis-task
```

列表 query 使用 Zod strict schema。`limit` 默认 25，范围 1–100。异常 filter 只允许 `status=open|acknowledged`、`severity=critical|high|medium|low`、`exceptionType=capacity_progress_lag|equipment_alarm` 与已授权 resourceScope 精确值/后代匹配；sort 只允许 `detectedAt`、`severity` 及降序，默认 `detectedAt desc, id asc`。

公开字段 allowlist：

| Endpoint | Allowed fields |
| --- | --- |
| 异常列表 | `id, exceptionType, summary, severity, status, resourceScope, dataClass, detectedAt, aggregateVersion, simulation` |
| 异常详情 | 列表字段 + `sourceObjectRef, detectionWindow, acknowledgedAt, ownerDisplayState, analysisDisplayState, evidence[]`；owner 只允许 `unassigned|mine|assigned` |
| analysis-task result | 当前调用者重新授权后可见的 `taskId, conversationId, workflowVersion{id,hash}, approvalSubjectDigest, simulation` |

public projection 必须 `strict()`，不得返回 tenantId、requester/owner principal 内部 ID、原始 source payload、凭据、策略内部字段或数据库未列入字段。

异常列表复用 0.2B.1 `querySnapshot` 基础：第一页在 Postgres 冻结授权后的有序 ID/排序键，并绑定 tenant、principal、authorizationEpoch、canonical query、field-mask version、asOf、queryVersion 与 15 分钟 TTL；opaque HMAC cursor 只含 snapshot id、position、expiry。每页重新授权；跨 principal/tenant/query、篡改、过期、授权 epoch 变化或 snapshot 缺失统一 `CURSOR_INVALID`，不降级全量查询。

异常详情使用 `ETag=aggregateVersion`，恢复后重取完整快照，不新增异常 SSE。Task 继续使用 task-local append-only `eventCursor`；paginationCursor、eventCursor 与 aggregateVersion 是三种不可互换的类型。轻量语义表格只展示当前页并驱动服务端 query，不做浏览器权限过滤、跨页排序、缓存拼接或导出。

最小新增持久化：

| Table | Invariant |
| --- | --- |
| `business_exceptions` | immutable source + mutable aggregate；combined contract 去重唯一键 |
| `business_exception_source_snapshots` | task-independent canonical bytes/hash/scope；source version 主键、exception 唯一 |
| `business_exception_events` | append-only；与 aggregate mutation 同 transaction |
| `business_exception_analysis_bindings` | source version 唯一；冻结 requester/conversation/expert/capability/permission/input/task |

既有 `query_snapshots`、BusinessTask、WorkflowVersion、ApprovalVersion、task Evidence/Claim/Lineage、Artifact、outbox/inbox 与 audit 继续复用；不得为异常页面另建第二套 Task、Workflow 或 Evidence 权威。

## Internal Slice Map

| Slice | Owned behavior | Required exit oracle | Allowed conclusion |
| --- | --- | --- | --- |
| `0.2B.2 exception fixture vertical` | migration、固定 fixture/source snapshot seed、异常去重/认领、exception query consumer、轻量表格、固定 shadow Workflow、singleton binding 与主 happy path | `pnpm verify:gate0.2b.2`；真实 served 浏览器看到两条 DB fixture，主异常只绑定一个 task，UI/API/Postgres/Worker/S3 同对象关联 | 只能声明 exception fixture vertical ready |
| `0.2B.3 state/authenticity hardening` | route-state oracle、schema artifact parity、403/404/409/5xx/offline/stale/canceled/reclaim、task SSE replay/乱序、视觉、Gate 0.2A/0.2B.1 回归与 Gate A0 no-touch 路由回归 | `pnpm verify:gate0.2b.3`；每个适用状态有真实/负向 oracle，成功路径无浏览器数据拦截 | 只能声明 state/authenticity hardening ready |
| `Gate 0.2B` | 两个恢复 slice 与已关闭 0.2B.1 的同一集成结果 | `pnpm verify:gate0.2b` 从清洁测试状态聚合全部 required checks，任一失败非零 | 唯一允许的 Gate 关闭结论 |

### Route-state oracle

每个状态根节点使用稳定 `data-state` selector；不要求每页机械实现所有状态：

| Route | State | Real trigger and recovery | Forbidden |
| --- | --- | --- | --- |
| `/exceptions`, `/tasks`, `/workflows` | `loading`, `empty`, `filtered-empty` | 延迟真实 API、受控空 DB、合法 filter 无匹配；清除 filter/重新加载 | 浏览器拼数据、把 filtered-empty 当全局空态 |
| `/exceptions`, `/tasks` | `forbidden` | 无列表权限 principal；响应与等价无数据不泄漏计数/元数据 | 显示 tenant、owner 或隐藏计数 |
| 所有详情 | `not-found` | 存在但无权与不存在分别请求；status/body/尺寸/元数据不可区分 | 泄漏 ID、owner、Evidence 摘要 |
| `/exceptions/:id` | `stale`, `binding-conflict` | 旧 aggregateVersion CAS；并发不同 ExpertTarget；刷新重取 | 静默覆盖/复用、泄漏旧 task |
| `/tasks/:taskId/workflow` | `approval-stale` | repository setup 生成更高 ApprovalVersion，旧 digest 执行返回 409 | 伪造“重新审批”产品 API |
| 列表与详情 | `offline`, `server-error` | 初次成功后停止真实 Control Plane，或 negative-only repository setup 触发一次 5xx；服务恢复后重取 | success project 使用 `route.fulfill` |
| `/tasks/:taskId` | `canceled` | 取消独立运行中 task 并重放 event；保持终态 | “恢复已取消任务”或第二结果 |
| `/tasks/:taskId` | `recovering` | kill/restart Worker 后 checkpoint/lease reclaim | 新建 task/Claim/Artifact |

negative-only setup 只能通过 repository command、服务启停或进程故障实现，测试后清理；不得新增浏览器/产品 fault-injection API。视觉与结构验收固定 `1440×900` 和 `390×844`，截图仅覆盖稳定区域，独立 reviewer 检查信息层级、模拟标记、主动作、恢复和窄屏溢出；关键动作同时有 role/name 或稳定 `data-testid` 断言。

## First Code Slice Guard

- first_code_slice: `0.2B.2 exception product vertical` 必须在同一首个逻辑实现结果中实现真实产品功能与服务端接口逻辑，并新增真实 served `/exceptions` 列表与详情、Control Plane API/Postgres 权威记录、可见来源引用和模拟来源标记，让浏览器从真实服务完成列表到详情导航；必要的结构、迁移、受控开发数据和验证与该产品纵切同门交付，不能独立充当首个结果。
- first_code_slice_kind: product
- first_code_owner: `role:gate-0.2b-2-3-integration-owner`
- first_code_verification: `pnpm test:contracts && pnpm test:integration && pnpm test:e2e -- --project=gate0.2b-success gate-0.2b-exception-flow.spec.ts` 的首段列表/详情 correlation，并核对同一 exception/sourceVersion/hash 在 UI、API 与 Postgres 一致。
- allowed_contract_gate_only_until: 当前 authority brief、final contract、strict new-authoring lint 与 fresh Team review/controller 准入完成；之后不得继续只产出合同、扫描器、fixture 或证据。
- stop_if_no_code_by_phase: `0.2B.2 exception fixture vertical` 第一个逻辑实施提交。
- gate_parallelization_or_deferral_plan: `0.2B.2 → 0.2B.3` 串行；Control Plane/schema/Web/workflow 由一个 integration owner 写入。只有路径互不重叠且不依赖未稳定接口的验证/fixture 辅助工作可分配其他 writer；reviewer/verifier 只读。
- Safety rule: tenant/principal/resource/data/audience、seed 环境、source hash 与字段 allowlist 必须和首个 UI/API slice 同门完成，不允许先开放无授权列表再补安全。

## Product/UI Acceptance Gate

- first_operable_user_flow: 打开 `/exceptions`，看到两条固定、醒目标记模拟的异常；筛选主异常、查看 source Evidence、认领、选择 ExpertTarget、点击“让小纬分析”，确认 Workflow hash 与 ApprovalSubject digest、批准并执行；随后在 Task、task-scoped Workflow、immutable WorkflowVersion 和 Conversation 深链查看同一 task/evidence/artifact。刷新、SSE 重连、取消和 Worker reclaim 使用独立对象验证。
- browser_entrypoint: http://localhost:3200/exceptions
- served_ui_validation_action: Playwright 使用 `page.goto("http://localhost:3200/exceptions")` 打开真实 Vite HTTP 页面并完成上述用户流；主 HTML、JS/CSS 与异常/Task/Workflow/Evidence/Artifact API 都由真实服务返回。成功路径所有 ID/hash 必须与 Postgres、outbox/inbox、Worker 和 VersityGW/S3 关联。
- ui_data_mode: 真实 Control Plane API、Postgres、独立 Worker、普通 Interpreter、VersityGW/S3；输入仅来自固定 fixture，分析仅来自服务端 FakeRuntime，页面全程标记模拟且不可用于业务决策。
- required_safety_gates: tenant/principal/resource/data/audience、A1 ceiling、field allowlist、fixture 环境、去重、认领 CAS、singleton binding、Workflow hash/ApprovalSubject digest 分离、Evidence publish/download reauthorization、403/404 等价、三种 cursor 分离、canceled 终态、Worker reclaim、零真实 provider/Connector/外部网络。
- allowed_headless_only_until: fresh authority/controller 准入；第一个实施提交必须包含真实 served `/exceptions` UI/API/Postgres correlation。
- stop_if_no_ui_by_phase: `0.2B.2 exception fixture vertical` 第一个逻辑实施提交。
- Served UI reverse guard: `page.setContent`、主文档/bundle/API `route.fulfill`、HAR 回放、Service Worker、浏览器 import fixture JSON、静态页面、build-only 或 headless model 不能作为 success evidence。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | `/exceptions` 与详情由真实 served app 提供，两条 DB fixture 醒目标记模拟；只有小纬是客户消息作者 | yes | success Playwright + served asset/API/DB correlation | goal:G02B23-PRODUCT |
| AC-PRODUCT-02 | 主异常完成 Evidence→认领→ExpertTarget→让小纬分析→审批→执行→Task/Workflow/Artifact/Conversation 完整流 | yes | `gate-0.2b-exception-flow.spec.ts` + UI/API/DB/Worker/S3 correlation | goal:G02B23-PRODUCT |
| AC-AUTHORITY-01 | exception/source snapshot/认领/binding/task/workflow/approval/evidence/artifact/event 只由 Control Plane Postgres 权威保存 | yes | migration constraints、transaction/restart integration | goal:G02B23-AUTHORITY |
| AC-EXCEPTION-01 | 两个 fixture bytes/hash 精确匹配；重复/并发 seed 不新增或改写；设备 fixture 不产生控制动作 | yes | hash、seed replay/concurrency、negative route scan | goal:G02B23-EXCEPTION |
| AC-EXCEPTION-02 | sourceVersion singleton binding 同语义幂等，不同 principal/conversation/expert/permission/input 无泄漏 409；无 Evidence 不发布 | yes | concurrency/cross-principal integration + E2E + publish guard | goal:G02B23-EXCEPTION |
| AC-SOURCE-01 | task-independent source snapshot 与 task Evidence projection 保留 sourceVersion/sourceSha256/jsonPointer/valueSha256 和 immutable Lineage | yes | DB/E2E/hash tamper/publish/download tests | goal:G02B23-EXCEPTION |
| AC-AUDIENCE-01 | `resource_exception` 与 `private_conversation` audience 结构和转换冻结；资源可见性不授予他人 private Task/Artifact | yes | cross-principal source/task/artifact tests | goal:G02B23-SAFETY |
| AC-SEED-01 | seed 单 transaction 写 exception/source/event/audit/outbox，非法环境/hash/tenant/DB 零业务写入 | yes | seed environment/tamper/zero-write integration | goal:G02B23-SAFETY |
| AC-QUERY-01 | 服务端 filter/sort/limit/field mask/querySnapshot cursor；浏览器不跨页排序、过滤、拼接或导出 | yes | contract/integration/browser pagination and field-leak tests | goal:G02B23-QUERY |
| AC-QUERY-02 | cursor 绑定 tenant/principal/auth epoch/query/TTL/field mask；无权与不存在连同元数据不可区分 | yes | cursor corpus/concurrency/oracle-equivalence security tests | goal:G02B23-SAFETY |
| AC-WORKFLOW-01 | 固定头、七节点、六边、registry refs、A1 ceiling 与 golden hash 可机器核对 | yes | template→Draft→Compiler→stored readback/hash oracle | goal:G02B23-WORKFLOW |
| AC-WORKFLOW-02 | ExpertTarget 不改变 Workflow hash，只进入 Task/ApprovalSubject；旧 digest 不执行 | yes | workflow/approval parity + stale digest test | goal:G02B23-WORKFLOW |
| AC-PERMISSION-01 | Capability、Workflow、Approval、UI 与测试一致使用 A1 ceiling 和 fake/simulation/no-business-decision | yes | contract/integration/UI permission oracle | goal:G02B23-SAFETY |
| AC-SCHEMA-01 | public Zod schema 生成 artifact；冻结 corpus 与结构/digest golden 通过，无第二 authored schema/validator | yes | `pnpm test:contracts` + dependency/schema scan | goal:G02B23-SCHEMA |
| AC-STATE-01 | 有界 route-state 表每行有真实 trigger、selector、恢复动作和禁止项；desktop/narrow 独立审查 | yes | negative/recovery Playwright + screenshot/selector report | goal:G02B23-RECOVERY |
| AC-RECOVERY-01 | aggregateVersion、paginationCursor、eventCursor 分离；SSE replay/乱序、canceled 终态、Worker reclaim 单次完成 | yes | replay/cancel/reclaim integration + browser/DB assertions | goal:G02B23-RECOVERY |
| AC-SAFETY-01 | 跨 tenant/resource/data/audience、撤权、非法 query/cursor、真实 runtime/connector 全部 fail closed | yes | `pnpm test:security` + negative E2E + egress/dependency scan | goal:G02B23-SAFETY |
| AC-ORDER-01 | 0.2B.2 和 0.2B.3 各自只声明内部 ready，聚合门前不声明 Gate closed | yes | slice ledger、source binding、aggregate verifier | goal:G02B23-ORDERING |
| AC-REGRESSION-01 | Gate 0.2A 与 0.2B.1 完整回归；Gate A0 forbidden paths no-touch，默认 Fast Chat 由不读取 auth、不启动 Model Gateway 的本地路由回归证明无材料，异常能力不开放 Gate A | yes | `pnpm verify:gate0.2a && pnpm verify:gate0.2b.1` + forbidden-path diff + targeted local routing tests | goal:G02B23-REGRESSION |
| AC-PATH-AUTHORITY-01 | 真实 Worker/FakeRuntime 只可修改已明确授权并同步到 brief/合同的五个精确源码/测试文件；其他 Worker/Runtime/chat/provider/shared-package 路径继续 no-touch | yes | `team/reports/path-authority-user-decision.md` + brief schema/path scan + forbidden no-diff oracle + `team/reports/path-authority-audit.md` | goal:G02B23-SAFETY |
| AC-A0-SCOPE-01 | Gate 0.2B 聚合不得调用完整 `pnpm verify:gate-a0`、读取 auth、启动 Model Gateway 或访问 live provider/LAN；只做 source-bound no-touch 和定向本地路由回归 | yes | aggregate command scan + process/egress/credential oracle | goal:G02B23-REGRESSION |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V1 | authority + contract | SDD brief validation；strict new-authoring contract lint；fresh Team review/controller | task/goal/finding refs、owned/forbidden paths、first-code/UI fields 合法且无 open current-required finding | `evidence/gate-0.2b-2-3-contract.txt` |
| V2 | quality + schema | `pnpm lint && pnpm typecheck && pnpm test && pnpm exec vitest run apps/worker/src/worker-loop.test.ts packages/runtime/src/runtime.test.ts && pnpm build && pnpm test:contracts` | Zod corpus、生成 artifact、两个 fixed Workflow golden/readback、Worker input/workflow fail-closed 与 FakeRuntime no-external-route 全通过 | `evidence/gate-0.2b-quality-summary.md` |
| V3 | API/DB authority | `pnpm test:integration` | source snapshot、seed transaction、CAS、querySnapshot、singleton binding、Task/Approval/Workflow、Evidence/Lineage 全通过 | `evidence/gate-0.2b-integration-summary.md` |
| V4 | security | `pnpm test:security` | tenant/resource/data/audience、field/cursor、fixture/runtime/connector、403/404 oracle 全部 fail closed | `evidence/gate-0.2b-safety-summary.md` |
| V5 | 0.2B.2 served product | `pnpm verify:gate0.2b.2` | success project 真实 UI/API/Postgres/Worker/S3 correlation，两条 fixture 与 singleton flow 通过 | `evidence/gate-0.2b-2-ui-summary.md` |
| V6 | 0.2B.3 state/recovery | `pnpm verify:gate0.2b.3` | negative/recovery/visual、SSE replay、cancel/reclaim、schema parity 和 regressions 通过 | `evidence/gate-0.2b-3-recovery-summary.md` |
| V7 | closed baselines | `pnpm verify:gate0.2a && pnpm verify:gate0.2b.1`，再检查 Gate A0 forbidden paths diff 与 targeted local routing tests | Gate 0.1/0.2A/0.2B.1 仍通过；Gate A0 source-bound closure 保持 no-touch，默认 Fast Chat 路由不退化；零 auth 读取、Model Gateway 启动、provider/LAN 流量 | `evidence/gate-0.2b-regression-summary.md` |
| V8 | aggregate | `pnpm verify:gate0.2b` 从清洁测试状态串行运行 | 聚合 V2–V7、secret/source/listener/egress scan；任一失败非零；无残留进程/端口/容器 | `evidence/phase-review.md`, `evidence/gate-checklist.md`, `evidence/evidence-index.md` |

每个真实 run 在开始和结束时计算同一候选源码集合的 SHA-256/file count/HEAD；源漂移立即失败。原始日志、Playwright JSON、trace、video、HAR、批量截图、API/DB dump、监听器和进程信息写入 `/tmp/geneway-runs/<run-id>/gate-0.2b/`。Git 证据最多 10 个文件、合计不超过 1 MiB，只保存结论、run id、命令、退出码、关键计数和原始位置。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| fixture 重放、并发或篡改 | 同去重键一条 exception；source/event/audit 同 transaction；篡改零写入失败 | yes | goal:G02B23-EXCEPTION |
| task 前查看 Evidence | 只读 source snapshot projection，不创建隐藏 Task/Conversation/EvidenceItem | yes | goal:G02B23-AUTHORITY |
| 两名有权员工竞争认领 | 两者可看 resource source；一个 CAS 成功；失败者不能看赢家 private Task/Artifact | yes | goal:G02B23-SAFETY |
| 同语义 analysis 重放 | owner 重新授权后返回既有 task，不新增 Approval/Claim/Artifact | yes | goal:G02B23-EXCEPTION |
| requester/conversation/expert/permission/input 变化 | `409 ANALYSIS_BINDING_CONFLICT`，不泄漏旧对象，不创建第二 binding | yes | goal:G02B23-SAFETY |
| 无权/不存在 object | status/body/尺寸/列表元数据不可区分 | yes | goal:G02B23-SAFETY |
| 非法/过期/跨用户 cursor | `CURSOR_INVALID`，不降级全量查询 | yes | goal:G02B23-QUERY |
| 旧 ApprovalVersion/digest | 409 并刷新既有版本，旧版本不执行 | yes | goal:G02B23-WORKFLOW |
| SSE 断线、重复、乱序 | event ID 去重并从 eventCursor 续传；不创建第二结果 | yes | goal:G02B23-RECOVERY |
| Worker 重启 | checkpoint/lease reclaim，同 task 单次完成 | yes | goal:G02B23-RECOVERY |
| task 取消 | `canceled` 终态，不显示或执行恢复 | yes | goal:G02B23-RECOVERY |
| Evidence/Artifact hash 异常或撤权 | publish/download fail closed，页面不得显示成功 | yes | goal:G02B23-SAFETY |
| production/非 loopback/错误 tenant/非开发 DB seed | 命令 fail closed，相关表本次写入为 0 | yes | goal:G02B23-SAFETY |
| 真实 Runtime/Connector/provider 请求 | `NOT_OPEN`，零外部网络、凭据或业务数据访问 | yes | goal:G02B23-SAFETY |
| 默认 `/conversations/new` | 继续 Fast Chat，不创建 BusinessException/BusinessTask，不要求材料 | yes | goal:G02B23-REGRESSION |
| 实现试图触碰五个精确 Worker/Runtime 文件之外的未 owned 路径 | 立即停止；保持 Capability `NOT_OPEN`；提交新的独立路径决策包，不得退化为目录级隐式扩权 | yes | goal:G02B23-SAFETY |
| Gate 0.2B 聚合试图运行 Gate A0 live gate | contract/script scan 必须失败；不得读取 auth 或产生 provider/LAN 流量 | yes | goal:G02B23-REGRESSION |

## Failure And Stop Conditions

- Stop and ask the user when：必须修改未授权路径或 `/home/gewu/work/gearjob`；fixture 必须换成真实业务数据；需要真实模型、外部网络、生产写、Hatchet、动态 Workflow、新渠道或客户生产凭据；需要改变现有 `0775/0600` 权限；核心路由无法避免第二业务权威。
- Treat the task as failed when：只交付 schema/migration/fixture/headless test；success 依赖浏览器 mock/static data；fixture 被描述为真实；exception/task/binding 重复；权限或 403/404 泄漏；旧审批执行；closed baseline 回归失败；真实 provider/Connector/外部网络被调用；`pnpm verify:gate0.2b` 非零或 source drift。
- Required safe fallback: `goal:G02B23-SAFETY`——保持 Gate 0.2B.1 与 Gate A0 基线可用；未完整通过的异常路由、列表和 shadow Capability 全部保持 `NOT_OPEN`，不得用部分 UI、feature flag、FakeRuntime 标签或 fixture 文件冒充关闭。

## Finding Provenance

既有 combined Gate 0.2B controller 已解决的安全语义通过本 authority 的 stable Goal refs 被完整保留；历史 reviewer prose 或 severity 不授予新权限。当前 fresh review 的 canonical verdict digest 为 `040eca8badd1ab0ceda81b0a98586625e503c3f226eb0d0a7bad33c732ab1f5d`，controller 只准入以下两项：

| Finding ID | Disposition | Repair status | Projection |
| --- | --- | --- | --- |
| `PATH_AUTHORITY_WORKER_RUNTIME` | historical round-1 | resolved | 用户已明确确认五个精确文件；投影到 `AC-PATH-AUTHORITY-01`、对应 Edge Case、`team/reports/path-authority-audit.md` 与 `team/reports/path-authority-user-decision.md`，不产生目录级权限 |
| `GATE_A0_LIVE_PROVIDER_SCOPE` | historical round-1 | resolved | `AC-A0-SCOPE-01`、`AC-REGRESSION-01`、V7 与对应 Edge Case；完整 live Gate A0 已从本 Gate 聚合移除 |

`visible-follow-up` 与 `informational` 只保留为非执行 provenance。产品实现、check entrypoints 与其他共享 package ownership 仍是 controller 的 open evidence gaps，不能由合同文字伪造关闭。

## Completion Check

- [ ] Scope stayed inside this authority and the combined contract
- [x] Fresh Team review/controller has no open `current-required` finding
- [x] Historical `PATH_AUTHORITY_WORKER_RUNTIME` has an explicit user decision and the five exact files are reflected in brief/contract paths
- [x] Historical `GATE_A0_LIVE_PROVIDER_SCOPE` is resolved without credential/provider scope expansion
- [ ] `0.2B.2 → 0.2B.3` completed in order
- [ ] All required acceptance criteria and V1–V8 have source-bound evidence
- [ ] `pnpm verify:gate0.2b` passed from a clean test state
- [ ] Gate 0.2A、Gate 0.2B.1 regressions passed，Gate A0 no-touch/local-routing oracle passed
- [ ] Independent reviewer/verifier accepted the integrated result
- [ ] Residual risks and capability status remain explicit
