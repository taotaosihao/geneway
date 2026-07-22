# geneway Gate A 真实材料分析与 GearJob 单工单只读查询实施合同

workflow_id: 20260723-008-geneway-gate-a-gearjob
task_id: 20260723-008-geneway-gate-a-gearjob
title: geneway Gate A 真实材料分析与 GearJob 单工单只读查询
contract_status: final
current_authoritative_contract: doc/plans/atlas-workflow/20260723-008-geneway-gate-a-gearjob/implementation-contract.final.md
created: 2026-07-23
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
safe_fallback_authority: goal:GA-SAFETY
work_type: implementation
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `GA-PRODUCT`：在 Gate A0 已验证的真实 Model Gateway/Runtime 上，用户从默认 Fast Chat 的可见“分析材料”入口提交合格 `DocumentSnapshot`，选择自动、单专家或专家团，确认固定 Workflow 与 Approval 后，由小纬生成真实材料分析结果；页面可恢复进度、结果、Evidence、Artifact、取消与失败状态。
- `GA-DOCUMENT`：材料上传、扫描、隔离解析、hash、data class、retention、资源范围与 audience 全部由服务端控制；模型只接收允许进入该 route 的 `untrusted_text`。`codex_subscription_dev` 只接收 C0/C1，以及经批准、去标识并重新分类为 C1 的测试材料；C2/C3 原文不得进入该订阅车道。
- `GA-EVIDENCE`：事实、推断、建议与未知项使用结构化输出分开表示；事实 Claim 必须绑定 Control Plane 从 immutable `DocumentSnapshot` 重取并验证的 Evidence locator/hash，未通过 publish guard 的 Claim 不得作为已核验结论发布。
- `GA-EXPERT`：自动、单专家、专家团三种 `ExpertTarget` 都解析到 immutable Agent/Expert versions 和服务端 PromptPolicy，具有相同的数据、动作与工具上限；客户可见作者仍只有小纬，专家身份只作为可审计来源。
- `GA-GEARJOB`：在独立 GearJob preflight 锁定 endpoint、认证、单对象权限点、字段 allowlist、审计和错误语义后，开放 `production.work-order-status.v1`，只查询用户明确输入或选择的一个 Work Order，返回状态、计划数量、已产数量、确定性进度、更新时间与 Evidence；只允许最小 read-only facade，禁止数据库直连、列表浏览、跨对象推断和任何写操作。
- `GA-AUTHORITY`：Control Plane Postgres 是 BusinessTask、WorkflowVersion/hash、ApprovalVersion/subject digest、ModelInvocation、ConnectorInvocation、Claim/Evidence/Lineage、Artifact、事件和终态的唯一业务权威；Runtime、Worker、Model Gateway、Connector Gateway、GearJob facade 和 UI 只是受限执行器或投影。
- `GA-MODEL`：复用 Gate A0 已通过的 provider manifest、CapabilityReleaseRecord、短期 invocation token、fence、预算、取消、错误映射和零旁路 provider egress；材料分析和工单解释只使用逻辑策略，不把 auth-file、provider token、service credential 或内部 route detail 交给浏览器、Runtime 或模型。
- `GA-SAFETY`：Gate A 最高动作等级为 A1，只允许查询、分析和建议；不开放 Hatchet、动态 Workflow/Harness、联网搜索、知识库、通用 Connector、生产写、设备控制或客户生产发布。共享 trusted-local LAN 语义沿用 Gate A0，不新增正式身份或多用户隔离承诺。

### Non-goals

- 不返工 Gate A0 的 ChatTurnDispatch、ChatRunEvent、Model Gateway token、provider manifest、CapabilityReleaseRecord 或共享 LAN 模式；Gate A 只复用已经关闭并仍通过回归的实现。
- 不在 Gate A 内完成 Gate 0.2B.2–0.2B.3；它们必须在 Gate A 进入前按自己的合同关闭。
- 不读取 C2/C3 原始材料到 `codex_subscription_dev`，不把“内部测试”“脱敏”当作自动降级规则；重新分类必须有受控处理记录、hash 和批准证据。
- 不让模型直接访问 Artifact storage、GearJob、数据库、网络或任意工具；材料由 Control Plane 受控投影，工单查询由固定 deterministic handler 经 Connector Gateway/facade 执行。
- 不修改 `/home/gewu/work/gearjob`。若 preflight 证明必须新增或修改 GearJob facade，须另获跨仓实施授权，在 GearJob 仓库独立测试和提交。
- 不开放 GearJob 列表、搜索、批量查询、历史轨迹、异常、日报、排程、设备、质量、BOM、库存或任何写接口。
- 不引入 Hatchet、多 Agent durable orchestration、动态 Harness/Workflow、Agent 生成 WorkflowDraft/Patch、condition、parallel、wait 或运行中改图。
- 不引入知识库、Embedding、联网搜索、MCP、飞书、企微、小程序、第二 Runtime 或外部 Agent。
- 不承诺客户生产身份、多用户隔离、客户 VPC、正式 API key、多 provider、并发共享订阅、生产 SLA 或 Capability `graduated`。

## Execution Order And Authority

1. Gate R、Gate 0.1、Gate 0.2A 与 Gate 0.2B.1 是已关闭基线；Gate A0 和恢复后的 Gate 0.2B.2–0.2B.3 必须在 Gate A 产品实现开始前关闭。
2. 未满足进入条件时，本合同只允许作为未来范围权威和进行隔离、只读的 GearJob preflight；`solution.analysis.v1` 继续保持既有模拟基线，Gate A 的 live release 保持 `NOT_OPEN`。
3. `A.1 live material product vertical` 先于 GearJob live connector；GearJob preflight 可并行进行只读发现，但不得写入 `/home/gewu/work/gearjob` 或扩大 geneway 凭据。
4. `solution.analysis.v1` 和 `production.work-order-status.v1` 独立发布、独立 fail closed。GearJob preflight 或 live gate 失败不得阻断已通过的真实材料分析，也不得让工单 Capability fallback 到模型猜测、数据库直连或其他账号。
5. Gate A0 合同继续控制共享 LAN、模型凭据和 Chat 基础边界；Gate 0.2A 合同继续控制 Artifact/DocumentSnapshot/Evidence/Lineage；Gate 0.2B 合同继续控制任务/Workflow 路由和异常。冲突时只有本合同明确拥有的 Gate A live Runtime 与单工单 connector 行为由本合同控制。
6. 支持性技术附录、路线图和 preflight 报告不能扩大本合同；未列入 Goal 的发现只能记录为 follow-up，除非由当前 controller 正式准入为 `current-required`。
7. 本合同就绪不授权产品代码、live credential 使用、GearJob 修改或 Capability promotion；这些动作仍需用户另行明确授权。

## Product And API Contract

### Capability、版本与发布

- `solution.analysis.v1` 保留 capability ID，但真实运行必须创建新的 immutable CapabilityVersion、HarnessVersion、PromptPolicyVersion 和固定 WorkflowVersion；不得原地修改 Gate 0.2A 的 fixture-only/fake 版本或让历史模拟证据变成“真实”。旧模拟版本继续可回归并始终醒目标记模拟。
- `production.work-order-status.v1` 使用独立 immutable CapabilityVersion、PromptPolicyVersion、固定六节点 WorkflowVersion 和 release record；不得借用 `solution.analysis.v1` 的状态或 approval subject。
- 两个 Capability 都复用 Gate A0 的 append-only `CapabilityReleaseRecord` + CAS active pointer，只允许 `draft → shadow → internal`。每个 capability 的 provider、data、connector、Evidence 和 required verification gate 独立计算；任一 gate 失败时对应 route 派生为 `NOT_OPEN`。
- Gate A 不进入 `graduated` 或 customer-production。UI 必须明确显示“可信本机内部验收”，不得把订阅测试车道或 GearJob 测试连接描述为生产可用。

### `solution.analysis.v1` 真实材料流

- 延续现有 public API 与 Zod 4 单一 schema 来源：上传 Artifact、创建 immutable `DocumentSnapshot`、提交 `solution.analysis.v1` BusinessTask、确认 Workflow/Approval、执行、读取 task snapshot/events、Evidence 和 Artifact。新增或变化的 wire 必须从 Zod 生成 JSON Schema，不增加第二 validator。
- `CreateTaskInput` 的材料 variant 固定绑定 conversationId、`capabilityId=solution.analysis.v1`、documentSnapshotId、ExpertTarget 和 `Idempotency-Key`。tenant、principal、resourceScope、dataClass、audience、model、provider、prompt、budget 与 WorkflowVersion 均由服务端解析，客户端覆盖无效。
- 创建任务前重新授权 Conversation、Artifact、DocumentSnapshot 与 audience；同一 principal、Conversation、DocumentSnapshot、CapabilityVersion、ExpertTarget 和幂等键只创建一个 BusinessTask。相同 key 不同语义返回 409。
- 现有七节点业务拓扑保持固定顺序：`document_ingest → requirement_extract → contradiction_check → solution_design → evidence_verify → result_quality_check → report_publish`。真实版本只能替换为经登记的 handler、AgentVersion、PromptPolicy 与 verification policy 引用；节点、边、权限上限或输入引用的任何改变都产生新 WorkflowVersion/hash 和新 ApprovalSubject digest。
- `document_ingest` 只从 Control Plane 发出的执行期投影读取已验证的 DocumentSnapshot 文本窗口、snapshot hash、resourceScope、dataClass 和 audience；Runtime、模型与 Worker 不获得 storage credential、bucket 任意读取或原始 HTML 执行能力。
- agent 节点使用 Model Gateway 逻辑策略 `business.solution.analysis.standard`。模型输入把材料标记为 `untrusted_text`，明确禁止其中的指令扩大系统提示、工具、数据、预算或动作权限；Gate A 继续使用 `tool_choice=none`，所有非空 tool call 都是协议违规。

### 安全文档摄取与数据等级

- 上传继续执行 MIME 与扩展名双 allowlist、大小/页数/解压比/嵌套深度限制、恶意文件扫描、隔离解析、canonical text、content hash、retention 和删除状态。首版 live route 只允许 `text/plain`、PDF 和已通过隔离解析的受支持 Office 文档；具体 parser name/version/digest 写入 DocumentSnapshot provenance。
- 解析器输出永远是非可信文本，不渲染或执行源 HTML、宏、脚本、外链、OLE、嵌入对象或公式动作；受密码保护、损坏、扫描失败、解析超时、可疑嵌套或内容类型不一致的文件 fail closed。
- `codex_subscription_dev` route 只允许 C0/C1。C2/C3 原文禁止进入 provider；如果测试材料来源原为 C2，必须先在模型边界之外完成去标识、生成新 Artifact/DocumentSnapshot、记录 transformation version、source hash、output hash、批准者和重新分类为 C1 的依据。缺任一证据时 route 为 `DATA_ROUTE_NOT_ALLOWED`。
- 单任务进入模型的 canonical text 总量上限为 256 KiB；超过时只允许确定性、可审计的完整段落选择，保存选中范围与 hash，不生成隐藏摘要替代来源。模型上下文中的每段文本都能回到 DocumentSnapshot byte/page locator。

### 结构化结果、Claim 与 Evidence

- agent 输出使用 versioned Zod `AnalysisResult`，至少包含 `summary` 和 `statements[]`；每条 statement 固定为 `{id, kind, text, evidenceCandidateKeys, confidence}`，其中 kind 仅为 `fact | inference | recommendation | unknown`。浏览器只消费 Control Plane 验证后的投影，不直读 provider JSON。
- `fact` 必须至少绑定一条可访问 Evidence；`inference` 和 `recommendation` 必须列出所依赖 Evidence 或明确声明无直接来源；`unknown` 必须描述缺失信息。任何 statement 不能同时伪装为多个 kind。
- Runtime 只提交 Evidence locator candidate，不提交权威原文。Control Plane 从 immutable DocumentSnapshot 重取定位范围，验证 snapshot/content/excerpt hash、UTF-8/page boundary、tenant、resourceScope、dataClass 和 audience，再创建 Evidence/Lineage。
- Evidence publish guard 在与 Claim/Artifact 发布相同的 Control Plane transaction 中执行；不匹配、无权、越界、来源已删除或 hash 漂移的 candidate 被拒绝，相关 fact 只能成为 rejected candidate 或 unknown，不能发布为已核验结论。
- Artifact 报告必须由验证后的结构化结果确定性渲染，显示事实、推断、建议、未知项、Evidence 引用、Capability/Workflow/PromptPolicy/Model revision、生成时间和“内部验收”标记；不得保存 provider 原始响应或隐藏 reasoning。

### ExpertTarget 与人工复核

- `auto`、`expert`、`team` 三种 ExpertTarget 继续使用服务端 registry；解析结果冻结为 immutable AgentVersion/ExpertVersion/TeamVersion 列表并进入 ApprovalSubject digest。不存在、停用、越权或数据等级不兼容时 fail closed。
- 三种路线共享相同 resource/data/action/tool ceiling。选择单专家或专家团只能改变已登记 PromptPolicy/AgentVersion 组合，不能获得额外 Connector、模型、预算、数据或动作权限。
- 所有客户可见消息和报告作者仍是小纬；UI 可显示“由哪些专家协作”和版本，但不能把 backend expert 伪装成独立客户消息作者。
- 人工复核复用既有 ApprovalVersion：批准时重新计算主体权限、DocumentSnapshot 可用性、WorkflowVersion/hash、PromptPolicy/Agent versions、ExpertTarget、预算、数据等级和 input digest。任何语义漂移创建新 ApprovalVersion 并使旧 decision 失效，禁止静默复用。

### `production.work-order-status.v1` 单工单只读流

- live route 的硬前置是独立 GearJob preflight artifact，必须固定：唯一 base URL/endpoint、认证方式和 credential owner、单 Work Order resource authorization 点、请求/响应 schema、字段 allowlist、not-found/forbidden 等价策略、timeout/retry、审计字段、速率上限以及测试对象。任何未锁定项使 route 为 `NOT_OPEN`。
- geneway 只允许通过本机 Connector Gateway 调用最小 GearJob read-only facade。GearJob service credential 只挂载到该 connector plugin；Web、Control Plane、Worker、Runtime、Model Gateway 和模型都不得读取或转发它。
- 用户提交的 `workOrderRef` 是 opaque ID，经 Zod 限制为 1–128 个允许字符；不接受 SQL、URL、路径、filter、sort、include、字段列表或任意查询参数。Control Plane 从服务端 principal/resource context 生成短期、单次 connector token，固定 issuer/audience、tenant、principal、workOrderRef、fieldMask、deadline、fence 和 jti。
- facade 必须同时验证 connector service identity、短期 token、单对象权限与固定 field mask；存在但无权与不存在对浏览器返回等价公开结果。只允许返回 workOrderRef、status、planQty、completedQty、unit、plannedStart、plannedEnd、updatedAt 和 sourceRevision；未在 allowlist 的客户、价格、人员、工艺、设备、备注或扩展字段不得进入 geneway。
- 固定六节点拓扑为 `validate_work_order_ref → fetch_authorized_status → compute_progress → explain_status → evidence_verify → publish_status_card`。`fetch_authorized_status` 是通过 Connector Gateway/facade 的 deterministic handler；`compute_progress` 用确定性代码计算并处理 planQty 为零/空；只有 `explain_status` 调用 Model Gateway，且只接收 allowlisted snapshot 与计算结果，`tool_choice=none`。
- `ConnectorInvocation` 至少记录 connectorProfileVersion、workOrderRef hash、fieldMaskVersion、request principal/resource context digest、attemptId、fence、deadline、startedAt、terminalAt、status、errorClass、sourceRevision、response canonical hash 和 redacted audit；不保存 service credential 或未允许字段。
- GearJob 响应先固化为 immutable `ConnectorSourceSnapshot`，再生成 Evidence locator 与 `WorkOrderStatusCard`。公开卡片固定包含 workOrderRef、status、planQty、completedQty、unit、progressPct、updatedAt、sourceAsOf、evidenceRef 和 `readOnly=true`；模型不能修改确定性数值或补造缺失字段。
- 查询是读操作但仍使用稳定 idempotency/effect ID，超时后的重试不得产生第二个 BusinessTask、第二张完成卡片或跨工单响应。任何写方法、非 allowlisted endpoint、重定向、跨 host、额外 DNS/egress 或模型直连均以零 GearJob 写和零非预期请求失败。

## Runtime, Connector And Authority Contract

- Worker 继续只通过 Control Plane UDS 命令 claim/execute/checkpoint/terminal，不直读业务数据库。每次 step mutation 携带 taskId、workflowVersionId/hash、stepId、attemptId 和 monotonic fence，由 Control Plane CAS 校验。
- agent step 复用 Gate A0 的 Model Gateway invocation token 和本机认证通道；connector step 使用独立 Connector Gateway token、audience、jti store 与 egress allowlist。两类 token 不能互换、透传或由 Worker 自签。
- Model Gateway 与 Connector Gateway 都不能成为业务权威。所有 checkpoint、ModelInvocation/ConnectorInvocation terminal、Evidence/Lineage、Artifact manifest 和 task event/cursor 在 Control Plane transaction 中提交后才可投影。
- 用户取消、deadline、approval invalidation、task terminal 或 fence 变化同时使未消费的 model/connector token 失效；迟到模型输出、connector response 或 step completion 不能覆盖 canceled/failed 或生成第二结果。
- 真实材料分析和工单能力分别设置预算与 deadline；`codex_subscription_dev` 仍保持单 active provider invocation。超过上限返回明确 busy/retry 信息，不无限排队，不切换账号/API key/provider。
- 系统提示、provider/connector raw payload、token、auth-file/service credential 路径、内部 route、错误堆栈和未 allowlist GearJob 字段只进入必要且脱敏的审计，不进入客户消息、Artifact、截图或浏览器网络响应。

## Internal Slice Map

| Slice | Owned behavior | Required checks and exit oracle | Allowed conclusion |
| --- | --- | --- | --- |
| `A.1 live material product vertical` | 新 immutable live Capability/Harness/Prompt/Workflow versions；真实 Model Gateway agent steps；安全 DocumentSnapshot 投影；默认页可见入口后的真实材料分析 served UI | contract/contracts/integration/security/model-gateway；真实 served Web + live provider 完成一份批准的 C1 材料分析；UI/API/Postgres/Worker/Gateway 同 task/workflow/modelInvocation 关联 | 只能声明 real solution analysis ready |
| `A.2 evidence/expert/review` | AnalysisResult 分类、Evidence locator/publish guard、deterministic report、三种 ExpertTarget、ApprovalVersion 重授权、取消/失败/恢复 | evidence tamper/hash/audience tests；三路线 live run；approval stale/cancel/replay；浏览器恢复 Evidence/Artifact | 只能声明 evidence/expert/review ready |
| `A.3 GearJob single-work-order` | 已批准 preflight、Connector Gateway/profile、单对象 facade contract、六节点固定 Workflow、ConnectorSourceSnapshot/Evidence/WorkOrderStatusCard | preflight verifier；contract receiver；真实或脱敏 Work Order read-only served run；权限/字段/egress/zero-write oracle | 只能声明 work-order status ready；preflight 不通过时保持 NOT_OPEN |
| `A.4 hardening and aggregate` | 两 Capability 独立 release、quota/timeout/retry/fence、进程恢复、LAN 回归、已关闭 Gate 回归和聚合门 | `pnpm verify:gate-a`；两条真实 served 用户流、negative matrix、secret/egress/zero-write scan 全通过 | 只能声明 Gate A ready |

## First Code Slice Guard

- first_code_slice: `A.1 live material product vertical` 必须在同一首个逻辑结果中实现真实产品功能与运行时逻辑，并新增 Web、Control Plane API/Postgres、Worker 与 Model Gateway 纵切，让用户从可见“分析材料”入口完成一份合格 C1 DocumentSnapshot 的任务创建、Workflow/Approval 确认、真实模型执行、结构化结果和来源引用查看。
- first_code_slice_kind: product
- first_code_owner: `role:gate-a-implementation-owner`；获得产品代码实施授权后必须解析为具名负责人。
- first_code_verification: `pnpm test:e2e -- --project=gate-a-live gate-a-solution-analysis.spec.ts`，并核对同一 task、workflowVersion/hash、approval digest、modelInvocation、Evidence 和 Artifact 在 UI、API、Postgres、Worker 与 Model Gateway audit 中一致。
- allowed_contract_gate_only_until: Gate A authority brief、本最终合同和 strict new-authoring lint 完成；Gate A 代码开始前必须验证 A0/0.2B 进入门已经关闭，未关闭即停止。获得 Gate A 实施授权后，不能以 GearJob preflight、schema、fixture 或 headless conformance 代替首个真实材料产品纵切。
- stop_if_no_code_by_phase: `A.1 live material product vertical` 首个逻辑提交。
- gate_parallelization_or_deferral_plan: `A.1 → A.2 → A.3 → A.4` 为产品主线；GearJob preflight 可与 A.1/A.2 并行只读调研，但只有 preflight artifact 被批准后才能进入 A.3 代码。preflight 失败时 A.3 保持 `NOT_OPEN`，A.1/A.2 可独立完成。
- First-code rule: migration-only、schema-only、provider/connector conformance-only、FakeRuntime、fixture-only 或静态 UI 都不算 A.1 可用。
- Safety rule: C0/C1 route、DocumentSnapshot authorization、Model Gateway 唯一出口、Evidence publish guard、无 FakeRuntime fallback 和无模型工具调用必须与 A.1 served UI 同门完成。

## Product/UI Acceptance Gate

- first_operable_user_flow: 运行 `pnpm dev-up`，打开 `/conversations/new`，点击可见“分析材料”，上传或选择一份已批准 C1 测试材料，选择自动专家路线，查看固定 Workflow/hash 与 Approval subject，批准并执行；看到真实进度和结构化的事实、推断、建议、未知项，打开 Evidence 定位与报告 Artifact，刷新后恢复同一 task/result。A.3 完成后，从可见“查询工单”入口输入预批准的单个 Work Order ref，确认只读 Workflow/Approval，获得带 Evidence 和更新时间的 `WorkOrderStatusCard`。
- browser_entrypoint: http://localhost:3200/conversations/new
- served_ui_validation_action: Playwright 使用 `page.goto("http://localhost:3200/conversations/new")` 打开真实 Vite HTTP 页面，再点击产品入口完成 live provider 材料分析和获准后的单工单只读查询；主 HTML、JS/CSS、API、SSE、Artifact/Evidence 与结果全部来自真实服务，禁止合成主文档/bundle/API/SSE、浏览器构造成功数据或 FakeRuntime 冒充 live。
- ui_data_mode: 真实 Web、Control Plane/Postgres、Artifact storage、UDS Worker、loopback/UDS Model Gateway、`codex_subscription_dev` live provider；GearJob 路径只在 preflight 后使用真实或批准的脱敏 GearJob 测试对象与最小 read-only facade。negative tests 可使用隔离 receiver/fault harness，但必须与成功证据明确分开。
- required_safety_gates: 共享 `tenant_local/user_local` 信任模型、服务端资源授权、C0/C1 provider route、DocumentSnapshot provenance、prompt-injection boundary、固定 Workflow/hash、Approval 重授权、Evidence publish guard、Model/Connector Gateway 唯一出口、双 token audience、secret redaction、A1 上限、GearJob field allowlist 与 zero-write/zero-bypass oracle。
- allowed_headless_only_until: `A.1` 的 schema/migration、document/provider contract integration 和必要的 A0/0.2B 进入门首次通过；同一首个逻辑实现结果必须提供真实 served 材料分析 UI。A.3 的 connector headless preflight 通过后，同一 A.3 逻辑结果必须提供真实 served 单工单卡片。
- stop_if_no_ui_by_phase: `A.1 live material product vertical` 首个逻辑提交；GearJob UI 不晚于 `A.3 GearJob single-work-order` 首个逻辑提交。
- Served UI evidence: browser trace 之外必须有 task/workflow/approval/modelInvocation/connectorInvocation/Evidence/Artifact 的服务端关联摘要和 secret-free receiver/egress oracle。
- Reverse guard: 继续运行 Gate 0.2A FakeRuntime、只改“模拟”标签、只显示静态 AI 文本、直接在浏览器请求 GearJob、或让模型猜测工单状态均不算 Gate A 交付。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-GA-PRODUCT-01 | 用户从默认页可见入口完成一份合格材料的真实 `solution.analysis.v1` served flow，并恢复同一 task、Workflow/hash、Approval、结构化结果、Evidence 和 Artifact；A.3 后可从可见入口完成单 Work Order 只读查询 | yes | live provider + real served browser + API/DB/audit correlation | goal:GA-PRODUCT |
| AC-GA-DOCUMENT-01 | 上传、扫描、隔离解析、provenance、retention、授权和 deterministic selection 通过；provider 只收到允许的 C0/C1 `untrusted_text`，C2/C3 和 prompt injection 不能扩大 route/tool/action | yes | parser corpus + malicious document + data-route/egress + snapshot locator tests | goal:GA-DOCUMENT |
| AC-GA-EVIDENCE-01 | AnalysisResult 明确区分 fact/inference/recommendation/unknown；每个 published fact 绑定 Control Plane 重取验证的 Evidence，tamper、越权、越界或 hash 漂移时 fail closed | yes | Zod contract + Evidence tamper/audience/hash + deterministic report tests | goal:GA-EVIDENCE |
| AC-GA-EXPERT-01 | auto、单专家、专家团分别解析到 immutable versions，三者具有相同权限上限并可审计；Approval 语义漂移使旧 decision 失效，客户消息作者仍只有小纬 | yes | registry/permission matrix + three-route live E2E + stale approval tests | goal:GA-EXPERT |
| AC-GA-GEARJOB-01 | 经批准 preflight 后只允许一个 Work Order、固定 endpoint/field mask 和只读方法；卡片确定性数值来自 immutable connector snapshot/Evidence，模型不能补造；所有负向路径保持零写、零旁路 | yes | preflight verifier + contract receiver + field/permission/redirect/egress/zero-write oracle + served E2E | goal:GA-GEARJOB |
| AC-GA-AUTHORITY-01 | Control Plane 是 task/workflow/approval/model/connector/evidence/artifact/event 唯一权威；刷新、重放、取消、超时、旧 fence 或进程恢复不创建第二结果或覆盖终态 | yes | transaction/CAS/idempotency/restart/replay integration tests | goal:GA-AUTHORITY |
| AC-GA-MODEL-01 | 两 Capability 只按逻辑策略经 Model Gateway 使用 `codex_subscription_dev`，复用 manifest/token/jti/fence/budget/error contract；无 credential、route detail、未脱敏 payload 或非 Gateway provider I/O | yes | live conformance + token replay/fence + receiver/process egress + secret canary | goal:GA-MODEL |
| AC-GA-SAFETY-01 | Gate A 保持 A1、固定 Workflow、无模型工具、无知识库/联网/Hatchet/动态 Workflow/生产写；共享 LAN 仍是明确的 trusted-local 非生产模式，未满足 gate 的 route 为 `NOT_OPEN` | yes | capability/status/dependency/network scan + negative policy E2E | goal:GA-SAFETY |
| AC-GA-REGRESSION-01 | Gate A0、Gate 0.2A 和完整 Gate 0.2B 已关闭行为继续通过；历史模拟分析仍醒目标记模拟且不会被新 live version 改写 | yes | `pnpm verify:gate-a0 && pnpm verify:gate0.2a && pnpm verify:gate0.2b` + version/status assertions | goal:GA-AUTHORITY |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V1 | authority + contract | strict new-authoring contract lint with Gate A authority slice | task/goal refs、First-code/UI 字段和 scope attribution 全合法 | Git 外 run summary |
| V2 | quality + schema | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm build` | Zod/JSON Schema、Workflow compiler、AnalysisResult、card 与包边界通过 | Git 外 run summary |
| V3 | document + Evidence | `pnpm test:integration && pnpm test:storage && pnpm test:security` | parser/data route、snapshot、task/approval、Evidence/Lineage/Artifact、tamper 和恢复通过 | Git 外 run summary |
| V4 | model | `pnpm test:model-gateway && pnpm test:gate-a-runtime` | provider manifest、live structured output、stream/cancel/quota/error、token/fence、零旁路与 secret redaction 通过 | Git 外 run summary |
| V5 | GearJob preflight + connector | `pnpm verify:gearjob-preflight && pnpm test:connector-gateway -- --profile=gearjob-work-order-status` | 固定 endpoint/auth/permission/field mask；单对象 read-only、redirect/egress/zero-write、timeout/replay 全通过 | Git 外 preflight/receiver summary |
| V6 | served live product | `pnpm test:e2e -- --project=gate-a-live` | 真实材料分析、三 ExpertTarget、Evidence/Artifact/恢复，以及获准后的单工单卡片全部来自真实服务；无成功 mock | Git 外 trace/screenshots + correlation summary |
| V7 | recovery + regression | fault/restart matrix；`pnpm verify:gate-a0 && pnpm verify:gate0.2a && pnpm verify:gate0.2b` | 取消、迟到、重放、恢复不重复；已关闭 Gate 与模拟历史不退化 | Git 外 run summary |
| V8 | aggregate | `pnpm verify:gate-a` | 聚合 V2–V7，任一 required 项失败则非零；GearJob 未获 preflight 时不得把 partial result 报为 Gate A complete | 简洁验收结论与 run id |

原始日志、Playwright JSON、trace、视频、HAR、截图集、provider/connector receiver 记录、端口状态、API/DB dump 和调试输出写入 `/tmp/geneway-runs/<run-id>/gate-a/`；不得记录 provider auth-file、GearJob service credential、原始 C2/C3 文档、未 allowlist 工单字段或未脱敏 payload。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| Gate A0 或 Gate 0.2B.2–0.2B.3 尚未关闭 | Gate A live release 保持 `NOT_OPEN`；可保留合同和隔离 preflight，但不把模拟基线宣称为真实 | yes | goal:GA-SAFETY |
| 合格材料进入真实分析 | 创建新 live version 的 task/Workflow/Approval/ModelInvocation；旧 fixture-only version 和证据不被改写 | yes | goal:GA-PRODUCT |
| 文件 MIME/扩展不一致、含宏/脚本、密码、损坏、扫描失败或解析超时 | 摄取 fail closed，不创建可执行 DocumentSnapshot，不把原始内容传给模型 | yes | goal:GA-DOCUMENT |
| C2/C3 材料或缺少去标识/重新分类证据 | 返回 `DATA_ROUTE_NOT_ALLOWED`，零 provider 调用；不得因 trusted-local 或“测试”绕过 | yes | goal:GA-DOCUMENT |
| 材料包含“忽略系统提示/调用工具/泄露数据”等指令 | 作为 `untrusted_text` 分析，不改变 PromptPolicy、tool_choice、数据、预算、动作或 route | yes | goal:GA-DOCUMENT |
| Evidence locator 越界、hash 漂移、来源删除或当前 principal 无权 | Claim 不发布为 fact；task 明确 failed/rejected/unknown，不生成伪证据 | yes | goal:GA-EVIDENCE |
| 模型把无 Evidence 内容标成 fact | publish guard 拒绝；可降为明确 inference/unknown 需要新验证，不静默发布 | yes | goal:GA-EVIDENCE |
| ExpertTarget 在批准后被停用、版本变化或权限收窄 | 旧 ApprovalVersion 失效，执行停止并要求基于新 subject 明确复核 | yes | goal:GA-EXPERT |
| 同一任务重复提交、事件重放或 Worker reclaim | 返回同一权威对象并使用新 attempt/fence 恢复；只产生一个 terminal 结果和 Artifact | yes | goal:GA-AUTHORITY |
| GearJob preflight 缺字段或需要修改远端仓库 | 工单 route 保持 `NOT_OPEN`；停止并请求独立跨仓授权，不用数据库直连或扩大 credential | yes | goal:GA-GEARJOB |
| Work Order 存在但无权与不存在 | 对浏览器的状态、body 与 metadata 等价；不泄漏客户、状态或数量 | yes | goal:GA-GEARJOB |
| GearJob 返回额外字段、重定向、跨 host 或非 GET/约定只读方法 | connector 拒绝，未允许字段不落库/不进模型，receiver 证明零写和零非预期 egress | yes | goal:GA-GEARJOB |
| planQty 为零、空、负数或 completedQty 异常 | deterministic validator 不计算误导性进度；卡片显示未知/数据异常并保留 Evidence，不让模型补数 | yes | goal:GA-GEARJOB |
| provider/connector quota、timeout、崩溃或取消竞争 | Control Plane 以稳定错误终止；旧 token/fence 失效，不切账号、不 fallback FakeRuntime、不产生第二结果 | yes | goal:GA-MODEL |
| 从 192/10 的另一个设备打开或取消任务 | 按 Gate A0 共享 `tenant_local/user_local` 语义允许；内部服务、provider 与 GearJob credential 仍不暴露 | yes | goal:GA-SAFETY |

## Failure And Stop Conditions

- Stop and ask the user when：需要修改 `/home/gewu/work/gearjob` 或新增远端 facade；没有可用且获准的 `codex_subscription_dev`/GearJob credential owner；需要 C2/C3 原文进入订阅模型；需要 API key、其他账号、客户生产 route、数据库直连、列表/批量工单、写操作、知识库、联网、Hatchet、动态 Workflow 或跨仓系统；Gate A0/0.2B 进入条件无法关闭。
- Treat the Gate as failed when：真实材料结果来自 FakeRuntime/mock；旧模拟 CapabilityVersion 被原地改写；模型直读 Artifact/GearJob 或执行 tool call；事实无可验证 Evidence；C2/C3 进入 provider；GearJob 未经 preflight、返回越权字段或产生任何写/旁路；取消后仍 completed；成功路径依赖合成主文档/bundle/API/SSE 或浏览器构造数据；`pnpm verify:gate-a` 非零。
- Required safe fallback: 保留已关闭 Gate 和醒目标记的 `solution.analysis.v1` 模拟版本；对应 live release 保持 `NOT_OPEN`。A.1/A.2 已通过而 GearJob 不可用时，只能声明真实材料分析切片就绪，工单入口显示“只读工单通道未配置或不可用”，不得显示猜测结果。
- Optional fallback notes：GearJob preflight、provider conformance、parser corpus 可在隔离环境继续修复，但不能替代真实 served UI、权限、Evidence、zero-write 或 live provider 证据。

## Finding Provenance

本合同直接投影 Gate A authority brief、Gate A0 最终合同、Gate 0.2A/0.2B 已有权威边界以及非执行路线图中“真实材料分析 + GearJob 单工单只读查询”的既定方向。当前未引入 controller finding；后续 review 发现只有经 canonical controller 标记为 `current-required` 后才进入本合同执行范围。本合同的建立不表示 Gate A0、Gate 0.2B.2–0.2B.3 或 Gate A 产品实现已经完成，也不授权跨仓 GearJob 修改。

## Completion Check

- [ ] Scope stayed inside Gate A Goal and owned paths
- [ ] Gate A0 and Gate 0.2B.2–0.2B.3 entry conditions were closed before live implementation
- [ ] `A.1 → A.2 → A.3 → A.4` product line completed in order; GearJob preflight preceded A.3 code
- [ ] Required acceptance criteria and V1–V8 passed
- [ ] Real material analysis used live provider and real served UI without FakeRuntime fallback
- [ ] C0/C1 route, DocumentSnapshot provenance, prompt-injection boundary and Evidence publish guard passed
- [ ] auto、单专家、专家团和 Approval reauthorization passed with one customer-facing author: 小纬
- [ ] GearJob preflight, single-object permission, fixed field mask, Evidence, zero-write and zero-bypass passed
- [ ] Model/Connector credentials stayed outside Git/DB/S3/log/trace/screenshot/browser/model input
- [ ] Gate A0、Gate 0.2A、Gate 0.2B and historical simulation regressions passed
- [ ] `pnpm verify:gate-a` passed from a clean test state
