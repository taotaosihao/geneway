# geneway Gate 0.2B Task / Exception Projection 纵切实施合同

workflow_id: 20260722-009-geneway-gate-0-2b-task-exception-projection
task_id: 20260722-009-geneway-gate-0-2b-task-exception-projection
title: geneway Gate 0.2B 任务与异常投影纵切
contract_status: final
current_authoritative_contract: doc/plans/atlas-workflow/20260722-009-geneway-gate-0-2b-task-exception-projection/implementation-contract.final.md
created: 2026-07-22
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
team_convergence: CONSENSUS
review_verdict_digest: 9d75f4590c59f80913133897dece3b0f3a0443d1f1a1cc3fd96280985778447f
safe_fallback_authority: goal:G0.2B-SAFETY
work_type: implementation
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `G0.2B-PRODUCT`：交付一个真实 served 产品纵切：用户进入“异常与待办”，看到版本固定且显著标记为模拟的产能进度落后记录，查看其 Evidence、认领待办、选择自动/单专家/专家团并点击“让小纬分析”；系统以冻结的异常版本和分析请求创建唯一绑定任务，展示固定 Workflow 与审批，执行后可在“小纬、我的任务、Workflow”路由恢复同一任务、WorkflowVersion/hash、ApprovalSubject digest、Evidence 和 Artifact。客户消息作者仍只有 `{user, xiaowei}`。
- `G0.2B-AUTHORITY`：Control Plane Postgres 是 BusinessException、BusinessExceptionSourceSnapshot、认领、Exception–Task 绑定、BusinessTask、WorkflowVersion、Approval、Claim/Evidence/Lineage、Artifact metadata 和事件的唯一业务权威；UI、fixture、Worker、SSE、React Flow 和 TanStack Table 只做投影或执行适配。
- `G0.2B-EXCEPTION`：使用合同固定的两个安全 fixture，主 happy path 为产能进度落后，设备报警只作为列表和 Evidence 覆盖；fixture 重放必须按 tenant/source/type/object/window 去重。`operations.exception-assist.v1` 只以 `shadow + fixture-only + fake` 方式预演，不得宣称已毕业或可作真实业务决策。
- `G0.2B-QUERY`：异常与任务列表使用服务端授权、字段 allowlist、稳定 cursor、受限 filter/sort/page size；统一 `EnterpriseTable` 使用稳定 TanStack Table headless core，不能在客户端扩大查询、拼接隐含字段或导出缓存数据。
- `G0.2B-RECOVERY`：路由从 Control Plane 的版本化快照恢复；异常页按 aggregateVersion 重取快照，任务页按 task event cursor 断线续传。刷新、重复/乱序事件、Worker checkpoint/reclaim 后仍关联同一 exception/task/workflow/hash；`canceled` 继续是终态，不提供“恢复已取消任务”。
- `G0.2B-SCHEMA`：新增或修改的 public wire contract 继续以 Zod 4 为单一来源并生成 JSON Schema artifact；冻结 corpus 证明 Zod runtime 的接受/拒绝结果，并校验生成 artifact 的来源、ID/version、digest、required、enum、discriminator/ref 等结构，不引入 TypeBox、手写平行 schema、第二 validator 或可执行 TS Workflow，也不宣称跨 validator 的完整语义等价。
- `G0.2B-SAFETY`：所有列表、详情、认领、分析、任务、Workflow、Evidence 与 Artifact 访问逐次校验 tenant/principal/resource/data/audience；403/404 不泄漏对象存在性；真实模型、GearJob、真实告警、生产写与外部网络调用全部 fail closed。

### Non-goals

- 不接共享 Codex 订阅、Model Gateway、OpenAI Agents SDK、Claude、AgentScope、DeerFlow 或任何真实模型；继续使用 Gate 0.2A 的服务端 `FakeRuntime`。
- 不读取或修改 `/home/gewu/work/gearjob`、Hive、Sharp Cell、真实 MES/ERP/QMS、设备、告警或生产数据；不创建 Connector、SQL 查询、MCP 或外部 API 路由。
- 不实现真实异常发现规则、轮询、实时数据、生产日报、复杂根因诊断、异常关闭或正式处置动作；设备报警 fixture 不能触发设备控制。
- 不引入 Hatchet，不开放动态 Harness/Workflow Draft/Patch、condition、parallel、wait、运行中改图、自由节点编辑或 LLM 生成代码。
- 不开放 D1/W1/W2/W3，不创建正式工单，不修改排产，不发送生产通知，不接飞书、企微、小程序、Matrix、AgentTeams、A2A 或外部 Agent。
- 不实现内部管理后台、Capability Matrix、知识库、索引、Embedding、Eval、导出或报表中心。
- 不重做 geneway 视觉体系；沿用 assistant-ui + Base UI + React Flow + geneway token。Hive/Sharp Cell UI 仍只作弱参考。

### Likely affected surfaces

- `apps/control-plane/**`：BusinessException、列表/详情/认领/分析绑定、任务列表与 Workflow 列表投影。
- `apps/web/**`：四路由、`EnterpriseTable`、状态矩阵、深链恢复与异常详情。
- `packages/contracts/**`：Zod public wire schema 与生成的 JSON Schema artifact。
- `packages/ui/**`：Base UI wrapper、`EnterpriseTable` 和共用状态组件。
- `packages/workflow/**`：固定 `operations.exception-assist.v1` TS 对象模板；Compiler、canonical JSON/hash 和 Interpreter 仍是唯一流程链。
- `migrations/**`、`scripts/**`：Gate 0.2B migration、fixture loader、真实 E2E 与聚合门禁。

## Fixed Fixture Contract

fixture 只能由受控开发/测试 seed 命令写入 Control Plane，不提供浏览器可调用的 fixture 注入 API。seed 仅允许 `NODE_ENV=test|development`、loopback 和明确 tenant；生产构建或其他环境必须拒绝。浏览器成功路径从真实 Control Plane API 和 Postgres 读取数据，不能 import fixture JSON。

主 happy path 文件：`scripts/fixtures/gate0.2b/capacity-progress-lag.v1.json`。内容按 RFC 8785/JCS canonical 后必须逐字节等于：

```json
{"dataClass":"C1","detectedAt":"2026-07-21T08:30:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"capacity_progress_lag","fixtureVersion":"gate0.2b-capacity-lag/1","resourceScope":"factory-01/workshop-machining/line-02","severity":"high","sourceObjectRef":"work-order:WO-GATE02B-001","sourceSystem":"fixture-manufacturing","summary":"二号机加工线工单进度落后","values":{"completedQty":48,"elapsedPct":75,"planQty":100,"progressPct":48,"thresholdPct":60}}
```

SHA-256：`0aaf071f5cb062251011970b382e239d3ae5fdcdc4f977b96f325825723b2ed6`。

次要覆盖文件：`scripts/fixtures/gate0.2b/equipment-alarm.v1.json`。内容按 RFC 8785/JCS canonical 后必须逐字节等于：

```json
{"dataClass":"C1","detectedAt":"2026-07-21T08:35:00.000Z","detectionWindow":"2026-07-21T08:00:00.000Z/2026-07-21T09:00:00.000Z","exceptionType":"equipment_alarm","fixtureVersion":"gate0.2b-equipment-alarm/1","resourceScope":"factory-01/workshop-machining/line-02/equipment-CNC-017","severity":"medium","sourceObjectRef":"equipment:CNC-017","sourceSystem":"fixture-manufacturing","summary":"CNC-017 主轴温度报警","values":{"alarmCode":"SPINDLE_TEMP_HIGH","currentValue":78.2,"threshold":75,"unit":"°C"}}
```

SHA-256：`c8de7202aa3d5a395bbc96df13776fbdc68591687d6e0fbd144d1c9a1e5ea593`。

异常去重键固定为：

```text
(tenant_id, source_system, exception_type, source_object_ref, detection_window)
```

重复 seed 返回既有记录，不改变原始 fixture version/hash，不产生第二条活动异常。认领只允许 `open → acknowledged`，由 `aggregateVersion` 做 CAS，保存服务端 principal 和时间；重复认领幂等，其他 principal 争抢返回 409 且不泄漏无权字段。本 Gate 不提供 resolved/closed 转换。

### BusinessExceptionRef 与异常来源

每个异常创建时冻结一份 `BusinessExceptionRef`，后续状态变化不能改写该来源版本：

| 字段 | Gate 0.2B 规则 |
| --- | --- |
| `exceptionId`、`sourceVersionId` | 服务端生成；创建后不可变 |
| `sourceSystem`、`exceptionType`、`sourceObjectRef`、`detectionWindow` | 构成来源与去重语义；创建后不可变 |
| `fixtureVersion`、`fixtureSha256`、`canonicalizationVersion` | 固定为合同值与 `rfc8785-jcs/1`；创建后不可变 |
| `resourceScope`、`dataClass` | 创建时冻结；异常详情每次按 tenant + resourceScope + dataClass 重新授权 |
| `aggregateVersion` | 状态、owner 或 task binding 每次 CAS 成功后递增；不改变 source version |
| `status`、`ownerPrincipalId`、`acknowledgedAt`、`analysisBinding` | 唯一允许按状态机/CAS 修改的投影字段 |

异常创建时保存 task-independent `BusinessExceptionSourceSnapshot`，它不是 `evidence_items` 行，也没有 `business_task_id` 或 conversation audience：

```text
businessExceptionId, sourceVersionId, canonicalBytes, canonicalSha256,
canonicalizationVersion, fixtureVersion, sourceSystem, sourceObjectRef,
detectionWindow, resourceScope, dataClass
```

`sourceVersionId` 是主键，`businessExceptionId` 唯一；canonical bytes/hash 和 tenant/resource/data scope 创建后不可变。异常详情中的“Evidence”是该 snapshot 的受权 `ExceptionSourceProjection`，只返回 allowlisted `jsonPointer`、值、`valueSha256` 和 source hash；每次读取都重新检查 tenant/resource/data，不产生 task Evidence 或 Claim。

两类 audience 使用不同 Zod discriminated variant，不允许字符串混用：

| Variant | Immutable fields | Authorization |
| --- | --- | --- |
| `resource_exception` | `businessExceptionId, resourceScope, dataClass` | 逐次计算 principal 与 tenant/resource/data 的交集；允许多个有权员工在未认领时查看并竞争 CAS 认领 |
| `private_conversation` | `conversationId` | 只允许该 Task requester 及明确获授权成员；用于 task Evidence、Claim、报告 Artifact 与下载 |

source snapshot 保存 `resource_exception` audience。analysis-task 只在重新授权、当前 principal 已认领且权限交集仍覆盖 source 后，创建新的 `private_conversation` projection；转换记录 source audience、task audience、权限交集 digest 与 ApprovalSubject digest，不修改 source。

分析任务创建后，Zod `EvidenceSource` 新增且只新增 `business_exception_snapshot` variant：

```text
kind, businessExceptionId, sourceVersionId, sourceSha256,
canonicalizationVersion, jsonPointer, valueSha256
```

`jsonPointer` 指向 snapshot 中支持具体 Claim 的字段，`valueSha256` 对该字段 canonical value 重算。analysis-task transaction 创建 requester-private Conversation、BusinessTask、binding、ApprovalVersion/outbox，并为允许使用的字段创建 task-scoped `EvidenceItem` 与从 `BusinessExceptionSourceSnapshot → EvidenceItem`、带 `sourceSha256/valueSha256` 的 Lineage link；task Evidence audience 固定为 `{kind: private_conversation, conversationId}`，不能改写 source snapshot。数据库如继续使用 `conversation:<id>`，它只作为该 variant 的内部编码，不能成为第二种 public schema。

seed 命令必须从合同固定 canonical bytes 重算 hash，并在一个 Control Plane repository transaction 中写入 BusinessException、`BusinessExceptionSourceSnapshot`、`business_exception.detected` event、audit 与 outbox；不提前创建 EvidenceItem、Claim、Lineage 或 Conversation，不能直写业务表，也不能信任预置的 `accessible=true`。Worker 读取、Claim publish guard 和 Artifact 发布前都重新校验 source hash/locator、tenant/resource/data 与 task conversation audience；Claim、报告 Artifact 和下载必须同时通过 source scope 与 task audience。报告 Artifact 继续写入 VersityGW/S3。

seed 只能由受控 Control Plane command 执行，要求 `NODE_ENV=test|development`、loopback、明确 tenant 和带 `is_non_production=true` 的目标数据库。应用启动时不得自动 seed。production、非 loopback、错误 tenant、非开发数据库或被篡改 fixture 必须在任何业务行写入前失败，并证明本次 transaction 写入计数为 0。

## Fixed Shadow Workflow

`operations.exception-assist.v1` 在本 Gate 的 Capability 状态固定为 `shadow`，输入固定为可访问的 immutable `BusinessExceptionRef`，最高动作等级为 A1；A1 只允许生成显著标记的模拟建议，不允许业务写入。TS 对象模板只是开发者编写层，输出标准 `WorkflowDraft`；审批与执行只认 Compiler 产出的不可变 canonical `WorkflowVersion`。

固定模板头：

| Field | Fixed value |
| --- | --- |
| `schemaVersion` | `workflow-draft.fixed-v1` |
| `capabilityVersionId` | `cap_operations_exception_assist_v1_shadow_1` |
| `harnessVersionId` | `harness_operations_exception_assist_fake_v1_1` |
| `featureSet` | `fixed-v1` |
| `permissionCeiling.actions` | `[R0, R1, A1]` |
| `permissionCeiling.resourceScopes` | 当前 `BusinessExceptionRef.resourceScope` 的精确值 |
| `permissionCeiling.dataClasses` | `[C1]` |
| `routingPolicyVersion` | `expert-catalog.gate0.2b/1`，注册表校验项；不进入 Workflow payload |

固定节点与边：

| Order | Node id | Kind | Immutable registry reference | inputRefs | outputSchemaId |
| ---: | --- | --- | --- | --- | --- |
| 1 | `exception_snapshot_load` | deterministic | `business-exception-source-reader/1` | `workflow.input.businessExceptionRef` | `business-exception.snapshot/1` |
| 2 | `deterministic_baseline` | deterministic | `exception-baseline-calculator/1` | `step.exception_snapshot_load.output` | `exception.baseline/1` |
| 3 | `expert_route_resolve` | deterministic | `approved-expert-binding-reader/1` | `step.deterministic_baseline.output` | `expert.routing-projection/1` |
| 4 | `impact_analysis` | agent | capability/harness 取模板头固定值 | `step.deterministic_baseline.output`、`step.expert_route_resolve.output` | `exception.impact-analysis/1` |
| 5 | `action_recommendation` | agent | capability/harness 取模板头固定值 | `step.impact_analysis.output` | `exception.action-recommendation/1` |
| 6 | `evidence_quality_check` | verification | `claim-evidence-minimum/2` | `step.action_recommendation.output` | `evidence.verdict/2` |
| 7 | `report_publish` | deterministic | `simulation-publisher/2` | `step.evidence_quality_check.output` | `report.projection/2` |

边固定为上表相邻节点的六条有向边。Compiler 只把 Gate 0.1 已有 `solution.analysis.v1` 精确拓扑和本表精确拓扑注册为两个固定模板；节点增删、换序、未知引用、自由 URL/code、condition/parallel/wait/loop 仍返回 `NOT_OPEN`。template → Draft → Compiler → stored readback 必须做 canonical JSON/hash golden oracle，Approval、React Flow、Interpreter 与 Diff 只读取同一份已存 `WorkflowVersion`。

`impact_analysis` 与 `action_recommendation` 使用服务端 FakeRuntime；事实字段只能来自 fixture Evidence，模型样式文本不能覆盖数量、阈值、时间、设备或工单标识。输出必须持续显示 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`，并区分 fixture 事实、模拟分析、A1 建议和未知项。没有可访问 Evidence 时不得发布 Claim 或报告 Artifact。

### Exception–Task Binding 与 ExpertTarget

每个 `sourceVersionId` 最多存在一个 `analysisBinding`。创建分析任务前必须重新授权，且异常必须已经由当前 principal 认领为 `acknowledged`。第一次成功请求在同一 transaction 内冻结：

```text
sourceVersionId + capabilityVersionId + requesterPrincipalId +
privateConversationId + requestedExpertTarget + resolvedExpertTarget +
expertCatalogVersion + permissionCeiling + inputDigest
```

并在一个 transaction 中创建私有 Conversation、BusinessTask、binding、task Evidence/Lineage、ApprovalVersion 与 outbox；唯一约束和 CAS 保证并发下只有一个成功。完全相同的规范化请求与 idempotency key 重放，在重新授权后返回原任务。相同来源版本但 ExpertTarget、conversation、requester、权限或输入摘要不同，一律返回不含旧 task/owner/conversation ID 的 `409 ANALYSIS_BINDING_CONFLICT`，不得静默复用，也不得创建第二个 Approval、Workflow、Claim 或 Artifact。

专家选择不改变固定流程拓扑，因此不进入 `WorkflowVersion/hash`。`requestedExpertTarget`、`resolvedExpertTarget`、`expertCatalogVersion` 与 `inputDigest` 进入 BusinessTask，且其 canonical digest 进入 `ApprovalSubject`；UI 分别显示 Workflow hash 和 ApprovalSubject digest。审批后任何专家、输入、权限或目录版本变化都要求新 ApprovalVersion，本 Gate 不允许改写已存在的 singleton binding。分析任务不会自动认领、关闭或修改异常。

## Route And Query Contract

核心入口固定为：

| Route | 主要职责 |
| --- | --- |
| `/conversations/new?capability=solution.analysis.v1` | 保留当前小纬材料分析入口 |
| `/conversations/:conversationId` | 受权恢复服务端 Conversation；异常分析创建/绑定的私有会话从此深链恢复，不依赖 localStorage |
| `/exceptions`、`/exceptions/:exceptionId` | 异常与待办列表、详情、Evidence、认领和“让小纬分析” |
| `/tasks`、`/tasks/:taskId`、`/tasks/:taskId/workflow` | 我的任务列表、步骤时间线、审批、取消、Evidence、Artifact，以及绑定该任务的 Workflow/Approval 运行投影 |
| `/workflows`、`/workflows/:workflowVersionId` | 当前 principal 可见任务所引用的 Workflow 列表；详情严格只展示不可变 WorkflowVersion 和只读 React Flow 图，不凭版本 ID 猜测 Task/Approval |

Control Plane 至少提供：

```text
GET  /api/business-exceptions
GET  /api/business-exceptions/:id
POST /api/business-exceptions/:id/acknowledge
POST /api/business-exceptions/:id/analysis-task
GET  /api/business-tasks
GET  /api/business-tasks/:id
GET  /api/business-tasks/:id/events?after=<eventCursor>
GET  /api/conversations/:id
GET  /api/workflow-versions
GET  /api/workflow-versions/:id
```

列表 query 由 Zod strict schema 接收。`limit` 默认 25、范围 1–100。异常 filter 只允许 `status=open|acknowledged`、`severity=critical|high|medium|low`、`exceptionType=capacity_progress_lag|equipment_alarm` 与服务端规范化的 `resourceScope`；resourceScope 只支持当前 principal 已授权 scope 的精确值或后代匹配。任务 filter 只允许已注册 `status` 和 `capabilityId`。异常 sort 只允许 `detectedAt`、`severity` 及降序；severity 顺序固定为 `critical > high > medium > low`。任务 sort 只允许 `createdAt`、`updatedAt` 及降序。异常默认 `detectedAt desc, id asc`，任务默认 `updatedAt desc, id asc`。

### Public projection allowlist

| Endpoint | 允许返回的业务字段 |
| --- | --- |
| 异常列表 | `id, exceptionType, summary, severity, status, resourceScope, dataClass, detectedAt, aggregateVersion, simulation` |
| 异常详情 | 列表字段 + `sourceObjectRef, detectionWindow, acknowledgedAt, ownerDisplayState, analysisDisplayState, evidence[]`；`ownerDisplayState` 只能是 `unassigned|mine|assigned` |
| 任务列表 | `id, capabilityId, status, title, conversationId, workflowVersion{id,hash}, approvalStatus, createdAt, updatedAt, aggregateVersion, simulation` |
| 任务详情 | 列表字段 + `expertTargetDisplay, approval, steps, claims, evidence, artifacts, result, eventWatermark` |
| Workflow 列表 | `id, hash, capabilityVersionId, harnessVersionId, createdAt, simulation` |
| Workflow 详情 | 列表字段 + `compilerVersion, canonicalizationVersion, featureSet, nodes, edges, permissionCeiling` |

public Zod projection 必须 `strict()`。任何 endpoint 都不得返回 `tenantId`、requester/owner principal 内部 ID、原始 source payload、凭据、策略内部字段或未列入 allowlist 的数据库列。`conversationId` 与对象 ID 只在调用者重新授权后返回。

### Pagination cursor 与事件恢复

`paginationCursor` 与任务事件 `eventCursor` 是两种独立类型，不可互换。列表第一页在 Postgres 创建 15 分钟 TTL 的 `querySnapshot`，冻结授权后的有序 ID/排序键，并绑定 tenant、principal、authorizationEpoch、canonical filter/sort/limit、`asOf`、`queryVersion` 和 field-mask version。服务端签发的不透明 cursor 仅含 snapshot id、position、expiry 和 HMAC；每一页仍重新授权。跨 principal/tenant/query、篡改、过期、authorizationEpoch 变化或 snapshot 缺失统一返回 `CURSOR_INVALID`，不降级成全量查询。`nextCursor` 与其他列表元数据不得暴露无权对象数量。

异常详情使用 `ETag=aggregateVersion`；刷新或网络恢复后按条件 GET 重取完整快照，本 Gate 不增加异常 SSE。任务详情继续使用 append-only task event stream；`eventCursor` 是事件水位，按 event id 去重并允许断线续传。异常创建、acknowledge 与 analysis binding 各自必须把 aggregate mutation、对应 `business_exception_events`、audit 和 outbox 在一个 transaction 中提交。

TanStack Table 只消费该响应，负责交互状态，不在浏览器做跨页排序、权限过滤、数据导出或缓存行拼接。URL 保存允许的 filter/sort/cursor；tenant、principal、data class、audience 和字段 mask 永远不由客户端提交。

### Minimum persistence changes

| Authority table | Minimum role / invariant |
| --- | --- |
| `business_exceptions` | immutable source fields + mutable aggregate fields；唯一键 `(tenant_id, source_system, exception_type, source_object_ref, detection_window)` |
| `business_exception_source_snapshots` | task-independent canonical bytes/hash 与 tenant/resource/data scope；`source_version_id` 主键、`business_exception_id` 唯一，二者不可改写 |
| `business_exception_events` | append-only event id/watermark；与每次异常 aggregate mutation 同 transaction |
| `business_exception_analysis_bindings` | `source_version_id` 唯一；冻结 requester/conversation/ExpertTarget/capability/permission/input digest 与 task id |
| `query_snapshots`、`query_snapshot_items` | principal/authorizationEpoch/query/field-mask 绑定的短期分页快照；TTL 清理 |

既有 `business_tasks`、WorkflowVersion、ApprovalVersion、task-scoped Evidence/Claim/Lineage、Artifact/manifest、outbox/inbox 与 audit 表继续复用。`evidence_items.business_task_id` 保持非空；异常创建前的 source snapshot 不冒充 task Evidence。不得为页面另建一套任务、Workflow 或 Evidence 权威。

## Internal Slice Map

| Slice | Owned behavior | Required checks and exit oracle | Allowed conclusion |
| --- | --- | --- | --- |
| `0.2B.1 task/workflow routes` | 用真实 API/DB 将已有任务、Conversation、Workflow/hash、ApprovalSubject digest、Evidence、Artifact 投影成 `/tasks`、`/workflows` 与 task-scoped Workflow 可刷新深链，并形成核心应用壳；不创建 BusinessException | `pnpm lint && pnpm typecheck && pnpm test:contracts && pnpm test:integration && pnpm test:e2e -- --project=gate0.2b-success gate-0.2b-task-workflow-routes.spec.ts`；同一 task/workflow/hash/approval digest 在 UI、API、Postgres 和 Worker 关联 | 只能声明 task/workflow routes ready |
| `0.2B.2 exception fixture vertical` | migration、受控 fixture/source Evidence seed、BusinessException 去重/认领、querySnapshot、`EnterpriseTable`、固定 shadow Workflow、singleton analysis binding 和主 happy path | `pnpm test:contracts && pnpm test:integration && pnpm test:security && pnpm test:e2e -- --project=gate0.2b-success gate-0.2b-exception-flow.spec.ts`；浏览器看到两条 DB fixture，主异常只绑定一个任务并生成可重验 Evidence/Artifact | 只能声明 exception fixture vertical ready |
| `0.2B.3 state/authenticity hardening` | 有界 route-state oracle、Zod corpus 与生成 artifact 结构 parity、403/404/409/5xx/offline/stale/canceled/reclaim、task SSE replay/乱序、独立视觉回归和 Gate 0.2A 回归 | `pnpm verify:gate0.2b.3`；每个状态有真实或明确负向 oracle，成功路径无浏览器数据拦截 | 只能声明 state/authenticity hardening ready |
| `Gate 0.2B` | 上述三个 slice 的同一集成结果，不进入任何 Non-goal | `pnpm verify:gate0.2b` 聚合全部检查，任一子项失败非零 | 唯一允许的 Gate 通过结论 |

### Route-state oracle

九类状态在整个产品面覆盖，不要求每个页面机械实现所有状态。每个状态根节点使用稳定 `data-state` selector：

| Route | State / selector | 真实触发与期望 | 禁止项 |
| --- | --- | --- | --- |
| `/exceptions`、`/tasks`、`/workflows` | `loading`、`empty`、`filtered-empty` | 延迟真实 API；受控空 DB；合法 filter 无匹配；显示 skeleton、首次空态或清除筛选动作 | 不把 filtered-empty 当全局空态，不从浏览器拼数据 |
| `/exceptions`、`/tasks` | `forbidden` | negative project 使用无列表权限 principal；status/body/`nextCursor`/`asOf`/`queryVersion` 与等价无数据响应不泄漏对象数量 | 不显示 tenant、owner 或计数 |
| 所有详情路由 | `not-found` | 对“存在但无权”和“不存在”分别请求；status、body、尺寸和元数据不可区分 | 不显示 ID、owner、Evidence 摘要 |
| `/exceptions/:id` | `stale`、`binding-conflict` | 先读旧 aggregateVersion 后由 repository CAS 更新；并发不同 ExpertTarget 请求触发安全 409；刷新后重取 | 不静默覆盖/复用，不泄漏旧 task |
| `/tasks/:taskId/workflow` | `approval-stale` | test-only DB setup 创建已存在的新 ApprovalVersion，再用旧 digest 执行得到 409；页面只允许刷新已存在版本 | 不提供伪“重新审批”产品 API |
| 列表与详情 | `offline`、`server-error` | initial load 后停止真实 Control Plane，或由 negative-only test setup 产生一次可识别 5xx；恢复服务后按快照重取 | 成功 project 不得 `route.fulfill` |
| `/tasks/:taskId` | `canceled` | 取消一个独立运行中任务并重放 event；保持终态且无第二结果 | 不显示“恢复已取消任务” |
| `/tasks/:taskId` | `recovering` | kill/restart Worker 后由 checkpoint/lease reclaim；同 task/event lineage 继续并只完成一次 | 不新建 task/Claim/Artifact |

negative-only setup 只能通过 test fixture/repository command、服务启停或进程故障完成，必须在测试结束后清理；不增加浏览器或产品可调用的 fault-injection API。视觉与结构验收固定 desktop `1440×900` 和 narrow `390×844` 两个 viewport，截图基线只覆盖稳定页面区域，并由独立 reviewer 检查信息层级、模拟标记、主要动作、错误恢复和窄屏溢出；关键动作同时使用 role/name 或稳定 `data-testid` 做结构断言。

## First Code Slice Guard

- first_code_slice: `0.2B.1 task/workflow routes` 在真实 served Web 中增加 `/tasks` 与 `/workflows` 路由，读取 Gate 0.2A 已有真实 Control Plane/Postgres/Worker 数据并完成深链恢复；同一首个逻辑提交包含 UI、API/list projection 和浏览器外 correlation。
- first_code_slice_kind: product
- first_code_owner: `role:gate-0.2b-implementation-owner`；实施授权后必须解析为具名负责人。
- first_code_verification: `pnpm test:e2e -- --project=gate0.2b-success gate-0.2b-task-workflow-routes.spec.ts`，并核对同一 task/workflow/hash 的 UI、API、Postgres 与 Worker 记录。
- allowed_contract_gate_only_until: SDD v2 authority brief、最终合同、strict new-authoring lint 和 Team Review 完成；获得产品代码实施授权后不得继续只产出合同、schema、fixture 或证据。
- stop_if_no_code_by_phase: `0.2B.1 task/workflow routes` 首个逻辑提交。
- gate_parallelization_or_deferral_plan: `0.2B.1 → 0.2B.2 → 0.2B.3` 串行收敛；只读 A-preflight 可另立任务并行，但不得写入本 Gate 工作树或完成声明。
- Ordering rule: contract、schema、fixture 和证据准备必须在首个实现 diff 前有界，不能成为实施后的唯一交付。
- First-code rule: 首个 code slice 必须改变真实 served 产品/API 行为；静态页面、headless model、migration-only 或仅有 fixture 的改动不算。
- Safety rule: tenant、principal、状态恢复和真实性门禁必须与 UI slice 同门完成，不能先开放无授权列表或浏览器本地数据再补安全。

### Kimi frontend implementation lane

前端实现继续优先尝试 Kimi Code CLI，但每次 eligible dispatch 都要重新记录 binary/version/hash、独立 workspace、只允许目标前端路径、无客户数据、指定 provider/region、provider-only egress 与无额外 MCP/宿主写权限。只有 candidate patch 经主控制器 admission、应用到真实工作树并通过独立浏览器验收后才可计为 Kimi 贡献。任何预检或执行失败先写 receipt，再由 Codex 主控制器按同一 scope 接管；不得把 Codex 修复记为纯 Kimi 产出，也不得因 Kimi 不可用阻塞 Gate。

## Product/UI Acceptance Gate

- first_operable_user_flow: 打开 `/exceptions`，看到主产能落后与次设备报警 fixture 的模拟来源和更新时间；筛选主异常、查看 Evidence、认领并选择专家路线，点击“让小纬分析”，确认固定 Workflow hash 与独立 ApprovalSubject digest、批准并执行；随后在 `/tasks/:taskId` 查看步骤、Claim/Evidence/Artifact，在 `/tasks/:taskId/workflow` 查看该任务的 Workflow/Approval 投影，在 `/workflows/:workflowVersionId` 查看同一不可变只读图，并通过 `/conversations/:conversationId` 返回同一小纬会话。刷新与 task SSE 重连后对象 ID/hash 不变；取消和 Worker reclaim 由独立任务做负向/恢复验证。
- browser_entrypoint: http://localhost:3200/exceptions
- served_ui_validation_action: Playwright 调用 `page.goto("http://localhost:3200/exceptions")` 访问真实 HTTP 服务并完成上述用户流；主 HTML、JS/CSS、异常/任务/Workflow/Evidence/Artifact API 均由真实服务返回。成功路径浏览器生成/选择的 exception、task、workflow、approval、evidence、artifact ID/hash 必须在 API、Postgres、outbox/inbox、Worker 和 VersityGW 中关联。
- ui_data_mode: 真实 Control Plane API、Postgres、独立 Worker、普通 Interpreter、VersityGW/S3，输入仅来自版本固定 fixture，分析仅来自服务端 FakeRuntime；所有页面显著标记模拟且不可用于业务决策。
- required_safety_gates: tenant/principal/resource/data/audience、A1 动作上限、public projection allowlist、fixture 环境边界、异常去重、认领 CAS、analysis binding 幂等/冲突、Workflow hash 与 ApprovalSubject digest 分离、Evidence publish guard、download reauthorization、403/404 不泄漏、pagination/event cursor 分离、canceled 终态、Worker reclaim、无真实 provider/Connector/外部网络。
- allowed_headless_only_until: `0.2B.1` 的 migration/contract/list API 测试首次通过；同一首个逻辑提交必须完成真实 served `/tasks` 与 `/workflows` 路由。
- stop_if_no_ui_by_phase: `0.2B.1 task/workflow routes` 首个逻辑提交。
- Served UI evidence: 主文档和 bundle 必须由真实 HTTP 服务提供；成功 project 禁止 `page.setContent`、主文档/bundle/API `route.fulfill`、HAR 回放或 Service Worker 替代。
- Reverse guard: UI 可见 fixture 或表格不等于 Gate 通过；如果 Postgres 权威、授权、去重、任务绑定、Workflow/hash、Evidence、Worker 或恢复任一无法关联，必须失败。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | 核心入口、Conversation 与 task-scoped Workflow 详情深链由真实 served app 提供；只有小纬发言，专家只出现在选择器、任务和 Workflow 元数据中 | yes | `gate-0.2b-task-workflow-routes.spec.ts` + served asset/API correlation | goal:G0.2B-PRODUCT |
| AC-PRODUCT-02 | 主异常完成“查看 Evidence → 认领 → 选择专家路线 → 让小纬分析 → 审批 → 执行 → 任务/Workflow/Artifact 查看”完整用户流 | yes | `gate-0.2b-exception-flow.spec.ts` + browser/API/DB/Worker/S3 correlation | goal:G0.2B-PRODUCT |
| AC-AUTHORITY-01 | BusinessException、认领、Exception–Task、Task、Workflow/hash、Approval、Evidence/Artifact 和事件只由 Control Plane Postgres 权威保存 | yes | integration queries、唯一约束、snapshot/cursor 与 restart test | goal:G0.2B-AUTHORITY |
| AC-EXCEPTION-01 | 两个 fixture 精确匹配合同 hash；重复 seed 不新增异常，不更改版本/hash；设备报警只作覆盖且不能产生设备动作 | yes | fixture hash test、seed replay integration、negative route scan | goal:G0.2B-EXCEPTION |
| AC-EXCEPTION-02 | 同一 sourceVersion 只有一个冻结 analysis binding；同语义重放返回既有任务，不同 requester/conversation/expert/权限/输入返回无泄漏 409；无 Evidence 不发布结果 | yes | idempotency/concurrency/cross-principal integration + E2E + publish-guard test | goal:G0.2B-EXCEPTION |
| AC-QUERY-01 | 异常和任务列表执行服务端 filter/sort/cursor/limit/field mask；`EnterpriseTable` 不做客户端权威过滤或导出 | yes | contract/integration tests、浏览器翻页/筛选、403 field leak negative | goal:G0.2B-QUERY |
| AC-RECOVERY-01 | 适用路由按有界 oracle 覆盖九类状态；异常按 aggregateVersion 重取，任务按 event cursor 续传，canceled 保持终态，Worker reclaim 不重复完成 | yes | success/negative/recovery Playwright projects + DB event assertions | goal:G0.2B-RECOVERY |
| AC-SCHEMA-01 | Gate 新增/修改 public Zod schema 都生成 wire JSON Schema artifact；冻结 corpus 验证 Zod accept/reject，并校验 artifact 的结构 golden/digest，无第二 authored schema/validator | yes | `pnpm test:contracts` 中 runtime corpus + generated artifact structure parity | goal:G0.2B-SCHEMA |
| AC-SAFETY-01 | 跨 tenant、越 resource/data/audience、撤权、非法 cursor/filter/sort、fixture 生产启用及未开放真实 runtime/connector 全部 fail closed | yes | `pnpm test:security` + negative E2E + dependency/egress scan | goal:G0.2B-SAFETY |
| AC-REGRESSION-01 | Gate 0.2A 聚合门保持通过（其中已包含 Gate 0.1），既有 Artifact/Evidence/恢复/联合备份合同不退化 | yes | `pnpm verify:gate0.2a` 由 `verify:gate0.2b` 聚合 | goal:G0.2B-AUTHORITY |
| AC-PERMISSION-01 | Capability、Workflow、Approval、delegated capability、UI 与测试一致使用 A1 上限，同时保持 simulation/fake/no-business-decision | yes | contract/integration/UI permission oracle | current-required:P001 |
| AC-EVIDENCE-01 | `BusinessExceptionSourceSnapshot → EvidenceSource.kind=business_exception_snapshot → task EvidenceItem + immutable Lineage` 保留 `sourceVersionId/sourceSha256/jsonPointer/valueSha256`；resource_exception 转 private_conversation 后仍同时重验 source scope 与 task audience | yes | schema/migration/hash tamper/publish/download tests | current-required:P002 |
| AC-SEED-01 | seed 经受控 repository command 单 transaction 写入异常、source snapshot、event 与 audit，不提前创建 task Evidence/Lineage；环境/tenant/DB/hash 不合法时零写入 | yes | seed replay/tamper/environment/zero-write tests | current-required:S05 |
| AC-BINDING-01 | singleton analysis binding 跨 principal 和不同 requester/conversation/expert/权限/输入语义不泄漏、不静默复用 | yes | unique/concurrency/idempotency/cross-principal tests | current-required:P003 |
| AC-EXCEPTION-AUTHORITY-01 | BusinessExceptionRef 冻结来源字段；认领与 binding 都用 aggregateVersion CAS 并与事件/outbox 单 transaction | yes | DB constraints/CAS/event transaction tests | current-required:S01 |
| AC-WORKFLOW-01 | expert binding 不改变 Workflow hash，只进入 Task 与 ApprovalSubject digest；UI 分开展示并按 digest 防旧审批执行 | yes | task/workflow/approval parity + stale digest test | current-required:P004 |
| AC-WORKFLOW-02 | 第二固定模板的头、七节点、六边、Registry refs、A1 ceiling 与 golden hash 可机器核对 | yes | template→Draft→Compiler→stored readback/hash oracle | current-required:S02 |
| AC-NAV-01 | 服务端 `/conversations/:conversationId` 和 `/tasks/:taskId/workflow` 可授权深链；WorkflowVersion 详情不猜测某次运行 | yes | refresh/share/cross-principal negative E2E | current-required:P005 |
| AC-STATE-01 | route-state 表每一行都有真实 trigger、稳定 selector、恢复动作和禁止项；desktop/narrow 有独立视觉/结构审查 | yes | state oracle matrix + screenshot/selector report | current-required:P006 |
| AC-RECOVERY-02 | paginationCursor、eventCursor、aggregate snapshot 分离；task SSE 可续传、canceled 终态、Worker reclaim 单次完成 | yes | cursor type/replay/cancel/reclaim tests | current-required:S04 |
| AC-QUERY-02 | public projection allowlist 和 snapshot cursor 冻结；cursor 绑定授权 epoch/query/TTL 并防篡改，存在但无权与不存在连同元数据不可区分 | yes | contract corpus + pagination concurrency + oracle-equivalence tests | current-required:S03 |
| AC-SCHEMA-02 | 本 Gate 只证明 Zod runtime corpus 与生成 JSON Schema 的结构/digest parity，不宣称未指定 validator 的完整语义等价 | yes | generated-artifact golden test + dependency scan | current-required:S06 |
| AC-SOURCE-01 | task-independent `BusinessExceptionSourceSnapshot` 支持任务前 Evidence 查看；analysis-task 只派生带 hash/Lineage 的 task Evidence，不改写 source | yes | pre-task source DB/E2E + task correlation + tamper tests | current-required:R2P01 |
| AC-AUDIENCE-01 | `resource_exception` 与 `private_conversation` audience 结构、转换和权限交集冻结；第二用户不能读取首个用户 Task/Artifact，但可按资源权限查看未认领异常并竞争 CAS | yes | cross-principal source/task/artifact authorization tests | current-required:R2S01 |
| AC-EVIDENCE-NAME-01 | public schema、migration source kind、Worker parser、publish guard、corpus 与合同只使用 `business_exception_snapshot`；不得保留 `business_exception_fixture` 平行别名 | yes | repository-wide discriminant scan + schema/DB/parser parity | current-required:R3S01 |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V1 | authority + contract | SDD brief validation；contract strict new-authoring lint | task/goal refs、first-code/UI 字段和 scope attribution 全合法 | `evidence/gate-0.2b-contract.txt` |
| V2 | quality + schema | `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:contracts` | Zod corpus accept/reject、生成 artifact ID/version/digest/required/enum/discriminator/ref、固定 Workflow golden/readback 全通过 | `evidence/gate-0.2b-quality-summary.md` |
| V3 | API/DB authority | `pnpm test:integration` | source snapshot、task Evidence projection/Lineage、seed transaction、认领 CAS、querySnapshot cursor、singleton binding、Task/Approval/Workflow authority 与 migration 通过 | `evidence/gate-0.2b-integration-summary.md` |
| V4 | security | `pnpm test:security` | tenant/resource/field/cursor/fixture/runtime/connector 负向全部 fail closed；存在但无权与不存在的 status/body/list metadata 不可区分 | `evidence/gate-0.2b-safety-summary.md` |
| V5 | served product | `pnpm test:e2e -- --project=gate0.2b-success` | 核心路由和主异常流来自真实服务，UI/API/DB/Worker/S3 同对象关联；`1440×900` 与 `390×844` 结构/视觉通过 | `evidence/gate-0.2b-ui-summary.md` |
| V6 | state/recovery | `pnpm test:e2e -- --project=gate0.2b-negative && pnpm test:e2e -- --project=gate0.2b-recovery` | route-state oracle、task SSE replay、canceled 终态、Worker reclaim 和 snapshot refresh 无重复结果 | `evidence/gate-0.2b-recovery-summary.md` |
| V7 | regression | `pnpm verify:gate0.2a` | Gate 0.2A（含 Gate 0.1）完整通过 | `evidence/gate-0.2b-regression-summary.md` |
| V8 | aggregate | `pnpm verify:gate0.2b` 从清洁测试状态运行 | 聚合 V2–V7；任一失败非零；无测试资源残留 | `evidence/phase-review.md`、`evidence/gate-checklist.md`、`evidence/evidence-index.md` |

原始日志、Playwright JSON、trace、video、HAR、截图集、API/DB dump、端口和进程信息写入 `/tmp/geneway-runs/<run-id>/gate-0.2b/`，Git 只保存结论、run id、命令、计数和原始位置。

## Evidence Budget

- Git 证据最多 10 个文件、合计不超过 1 MiB：V1–V7 摘要、`phase-review.md`、`gate-checklist.md`、`evidence-index.md`；能合并时不新增文件。
- 证据不得复制完整日志、fixture 大样本、调试 JSONL、批量截图、HAR 或中间 repair 输出。
- 任何 required validation row 缺少可追溯 run id、命令、退出码和关键计数时不得关闭 Gate。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| fixture 重放、并发或篡改 seed | 同一去重键只有一条异常；BusinessException/source snapshot/event/audit 同 transaction；不提前创建 task Evidence/Lineage；版本/hash 漂移或篡改在零业务写入前失败 | yes | current-required:S05 |
| 分析任务创建前查看异常 Evidence | 读取 task-independent source snapshot projection；不创建隐藏 Task/Conversation/EvidenceItem | yes | current-required:R2P01 |
| 两名有资源权限员工同时查看/认领 | 未认领时都可看 source；只有一个 CAS 认领成功；失败者不能读取赢家的 private Task/Artifact | yes | current-required:R2S01 |
| 同一异常完全同语义重放 | 当前 owner 重新授权后返回既有绑定任务；不新增 Approval、Claim 或 Artifact | yes | current-required:P003 |
| 同一异常改变 ExpertTarget、conversation、principal、权限或输入 | 统一 `409 ANALYSIS_BINDING_CONFLICT`；不返回旧 task/owner/conversation，不创建第二 binding | yes | current-required:P003 |
| 未认领或其他用户已认领后请求分析 | CAS/授权失败；不覆盖 owner、不创建任务、不泄漏无权字段 | yes | current-required:S01 |
| 跨 tenant/无权 ID | status、body、响应长度级别和列表元数据与不存在对象不可区分 | yes | current-required:S03 |
| 非法/过期/跨用户 cursor 或未知 filter/sort | `CURSOR_INVALID` 或 strict reject；不回退到全量列表；授权 epoch 变化使快照失效 | yes | current-required:S03 |
| 旧 ApprovalVersion/digest | 已存在更高版本时返回 409 并刷新差异；旧版本不执行；本 Gate 不凭空创建伪重新审批 | yes | current-required:S04 |
| task SSE 重放、乱序或断线 | 按 event id 去重并从 eventCursor 续传；异常详情按 aggregateVersion 重取；两种 cursor 不混用 | yes | current-required:S04 |
| Worker 在分析中重启 | 从 checkpoint/lease reclaim；同 task 只完成一次且不产生第二结果 | yes | current-required:S04 |
| 任务取消 | `canceled` 保持终态；不显示或执行“恢复已取消任务” | yes | current-required:S04 |
| Evidence/Artifact 缺失或 hash 异常 | 重算 locator/hash 并检查 audience；禁用 publish/download，进入明确失败；不得显示成功 | yes | current-required:P002 |
| production、非 loopback、错误 tenant 或非开发数据库尝试 seed | 命令 fail closed，所有相关业务表本次写入计数为 0 | yes | current-required:S05 |
| 真实 Runtime/Connector 路由请求 | `NOT_OPEN`，无外部网络、凭据或业务数据访问 | yes | goal:G0.2B-SAFETY |

## Failure And Stop Conditions

- Stop and ask the user when：主异常 fixture 需要改变为真实业务数据；需要跨仓修改 GearJob/Hive/Sharp Cell；需要开放外部写、真实模型、Hatchet、动态 Workflow 或新渠道；核心路由无法在不建立第二权威的情况下实现；Kimi 不可用本身不构成停工条件。
- Treat the task as failed when：只交付 schema/migration/fixture/headless test；成功路径依赖浏览器 mock/静态数据；fixture 被展示为真实异常；同一异常/任务重复；权限或 403/404 泄漏；旧审批仍可执行；Gate 0.1/0.2A 回归失败；真实 provider/Connector/外部网络被调用；`pnpm verify:gate0.2b` 非零。
- Required safe fallback: goal:G0.2B-SAFETY——保持 Gate 0.2A 基线可用；未完整通过的异常、列表、路由和 shadow Capability 全部保持 `NOT_OPEN`，不得以部分 UI 或 feature flag 默认开放。
- Optional fallback notes：如果 TanStack Table 自身阻断，可保留服务端查询合同并用最小自有表格完成内部诊断，但不能宣布 AC-QUERY-01 或 Gate 0.2B 通过；需要用户决定是否修改产品依赖要求。

## Finding Provenance

两名独立 reviewer 三轮共提出 15 项 Important finding。主控制器逐项判断都属于当前 Gate 的权限、权威、恢复或真实性闭环，因此全部录为 `current-required`；合同只吸收修复这些缺口所需的最小语义，没有开放 Non-goal。

| Finding ID | Disposition | Source | Follow-up |
| --- | --- | --- | --- |
| P001 | current-required | product review：R1 与建议语义冲突 | 统一为 A1 shadow ceiling |
| P002 | current-required | product review：异常 Evidence 来源未冻结 | 增加可重验 BusinessExceptionSourceSnapshot 与 `business_exception_snapshot` task Evidence |
| P003 | current-required | product review：singleton 与受众/ExpertTarget 冲突 | 冻结 binding 与无泄漏 409 |
| P004 | current-required | product review：ExpertTarget 与 Workflow hash 权威歧义 | Workflow hash 与 ApprovalSubject digest 分离 |
| P005 | current-required | product review：Conversation/task Workflow 深链缺失 | 增加服务端深链 |
| P006 | current-required | product review：route-state oracle 不可验 | 增加有界矩阵、viewport 与 selector |
| S01 | current-required | security review：异常版本、认领与 binding CAS 不完整 | 冻结 BusinessExceptionRef 与单 transaction |
| S02 | current-required | security review：固定 Workflow 只有文字节点 | 增加机器可核对模板头、节点、边与 Registry |
| S03 | current-required | security review：projection/cursor 存在泄漏与不稳定 | 字段 allowlist + querySnapshot + HMAC cursor |
| S04 | current-required | security review：异常/任务恢复通道混淆 | 分离 snapshot、paginationCursor、eventCursor 与 canceled 终态 |
| S05 | current-required | security review：seed 可绕过 Evidence/事件权威 | 受控 repository command、重算与零写失败 |
| S06 | current-required | security review：schema parity 口径隐含第二 validator | 收敛为 Zod corpus + 生成 artifact 结构 parity |
| R2P01 | current-required | product re-review：source Evidence 与 task Conversation 生命周期冲突 | 拆出 task-independent source snapshot 与 task Evidence projection |
| R2S01 | current-required | security re-review：source/task audience 混淆 | 冻结 resource_exception/private_conversation variants 与转换 |
| R3S01 | current-required | security final review：旧 Evidence discriminant 残留会形成第二权威 | 全合同统一 `business_exception_snapshot`，禁止平行别名 |

## Completion Check

- [ ] Scope stayed inside the contract
- [ ] `0.2B.1 → 0.2B.2 → 0.2B.3` completed in order
- [ ] Required acceptance criteria passed
- [ ] Required validation rows have evidence
- [ ] Every finding-derived executable requirement cites `current-required:<finding_id>`
- [ ] Visible follow-up and informational findings remain provenance only
- [ ] `pnpm verify:gate0.2b` passed from a clean test state
- [ ] Residual risks and capability status remain explicit
