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

- 不返工 Gate A0 的 ChatTurnDispatch、ChatRunEvent、普通聊天 Model Gateway token、上下文/取消协议、provider manifest、CapabilityReleaseRecord 或共享 LAN 模式；Gate A 只复用已经关闭并仍通过回归的实现。默认 `/conversations/new` Composer 始终解析为无材料 `xiaowei.chat.v1`，`/conversations/new?capability=xiaowei.chat.v1` 是等价显式入口；材料、Workflow、Approval 或 GearJob 不能成为普通聊天前置。
- 不在 Gate A 内重新实施或重新关闭 Gate 0.2B.2–0.2B.3。Gate A 只消费各历史 Gate 的 pinned closure receipt 和本合同列出的 task/Workflow、CAS/fence、reauthorization、legacy/live projection 等精确 imported invariants；未命中依赖影响触发器时，不把独立异常 fixture/FakeRuntime 纵切重新拉入 Gate A 关键路径。
- 不读取 C2/C3 原始材料到 `codex_subscription_dev`，不把“内部测试”“脱敏”当作自动降级规则；重新分类必须有受控处理记录、hash 和批准证据。
- 不让模型直接访问 Artifact storage、GearJob、数据库、网络或任意工具；材料由 Control Plane 受控投影，工单查询由固定 deterministic handler 经 Connector Gateway/facade 执行。
- 不把整个 `/home/gewu/work/gearjob` 纳入 Gate A owned paths。当前用户已经授权的 local-dev setup、单工单 read-only facade 所必需修复与定向测试，只能按 canonical `current-execution-admission.json` 列出的目的、仓库、base/head 和禁止项执行；任意 GearJob 重构、其他业务能力、push、PR、部署或客户生产变更仍须另获授权。
- 不开放 GearJob 列表、搜索、批量查询、历史轨迹、异常、日报、排程、设备、质量、BOM、库存或任何写接口。
- 不引入 Hatchet、多 Agent durable orchestration、动态 Harness/Workflow、Agent 生成 WorkflowDraft/Patch、condition、parallel、wait 或运行中改图。
- 不引入知识库、Embedding、联网搜索、MCP、飞书、企微、小程序、第二 Runtime 或外部 Agent。
- 不承诺客户生产身份、多用户隔离、客户 VPC、正式 API key、多 provider、并发共享订阅、生产 SLA 或 Capability `graduated`。

## Execution Order And Authority

1. Gate R、Gate 0.1、Gate 0.2A、Gate 0.2B 与 Gate A0 的既有结论由各自 canonical pinned closure receipt 控制。Gate A 不重新交付历史 Gate；每个 frozen candidate 先运行 dependency-impact manifest：若没有修改该 Gate owned implementation、公共 schema/migration 或共享 Runtime/Gateway 依赖，只运行本合同的 targeted compatibility regression；closure receipt 缺失/不可验证、依赖命中或 targeted regression 失败时，才必须重跑相应 full historical gate。
2. 任一 imported invariant、pinned receipt 或当前 authority revision 无法验证时，只使依赖它的 Gate A candidate/route 保持 `NOT_OPEN`；不得用重新实施无关延期产品纵切代替精确缺失证据，也不得把既有模拟基线宣称为真实。
3. `A.1 live material product vertical` 先于 GearJob live connector；GearJob preflight 可并行进行只读发现。只有 canonical `current-execution-admission.json` 明确列出的 local-dev setup、单工单 facade 必需窄修复与定向验证可以写入 `/home/gewu/work/gearjob`，且不得扩大 geneway/GearJob 凭据、接口或业务范围。
4. `solution.analysis.v1` 和 `production.work-order-status.v1` 独立发布、独立 fail closed。GearJob preflight 或 live gate 失败不得阻断已通过的真实材料分析，也不得让工单 Capability fallback 到模型猜测、数据库直连或其他账号。
5. Gate A0 合同继续控制共享 LAN、模型凭据和 Chat 基础边界；Gate A 只做非退化回归，不重新交付普通聊天协议。默认 Fast Chat 页面必须保持无材料首问、追问、停止与恢复；“分析材料”与“查询工单”都是用户可见但显式选择的独立入口，前者才要求合格 DocumentSnapshot/Workflow/Approval，后者仅在 A.3 preflight 与 release gate 通过后可用。Gate 0.2A 合同继续控制 Artifact/DocumentSnapshot/Evidence/Lineage；Gate 0.2B 合同继续控制任务/Workflow 路由和异常。冲突时只有本合同明确拥有的 Gate A live Runtime 与单工单 connector 行为由本合同控制。
6. 支持性技术附录、路线图和 preflight 报告不能扩大本合同；新 reviewer finding 的 disposition 默认为 `visible-follow-up`。只有它能映射到本合同已存在的 required AC 并证明该 AC 当前不成立、属于当前 candidate 新引入的安全/数据/权限回归，或证明 completion evidence 缺失/伪造/不可重建时，controller 才可在任何修复开始前准入为 `current-required`。
7. 本合同自身不授权产品代码、live credential、跨仓修改或 Capability promotion。当前实施权限只来自 canonical `current-execution-admission.json` 对用户消息的持久化引用：允许修复并完成现有非生产 Gate A candidate，以及完成单工单 read-only flow 所必需的本地 GearJob setup/窄修复；不授权 push、PR、部署、客户生产、生产写、secret 披露或其他 GearJob 业务范围。

### 当前暂停、修订与恢复权威

- 目标会话 `019f8b7f-06b3-73e0-9b15-2bab812db6a7` 在本次合同修订期间为 `PAUSED_FOR_CONTRACT_REPAIR`。该值是执行控制状态，不是 `CapabilityReleaseRecord` 产品枚举；目标会话不得新增 A.3/A.4 产品改动、运行验收/finalizer、续签 admission/conformance、提交或清理 dirty worktree。本次由用户明确授权的合同修订任务可以在逐字节保全旧 canonical artifacts、生成新的 review package 并取得 fresh Atlas v2 verdict/controller 后，原子替换 Gate A canonical authority；半完成或未通过 strict lint 的 revision 不得用于恢复。
- 修订前产品现场由 Git 外 `pause-candidate-source-manifest.json` 冻结；它只记录暂停点，不构成 reviewer approval、acceptance 或 release evidence。在暂停期、canonical brief/contract/review/controller 已冻结且 strict lint 通过后、目标会话恢复前，由只读 freezer 生成新的 exact `resume-candidate-source-manifest.json`，绑定 geneway/GearJob/nested app HEAD、实际 tracked/untracked/ignored policy、所有参与执行的文件 bytes、verifier/test runner、brief/contract/review/controller digests 与非 secret credential version。Digest DAG 明确排除该 manifest 自身和后置的 current-execution-admission；admission 是绑定 manifest 的最终叶节点。恢复后、任何产品编辑或验证命令前，目标会话必须只读重测并确认 observed bytes 完全相等，不等即继续暂停。
- 只有同时满足以下条件才可恢复：Gate A brief/contract/AGENTS/README 指向同一 authority revision；canonical Atlas review-verdict v2 与 controller digest/goal_ref 一致；A.3 私有 receipts 不占用 Atlas canonical 文件名；`pnpm verify:gate-a-contract` 通过；current-execution-admission 绑定合同/controller/resume-candidate source manifest digests；目标会话确认这些 digests 和禁止项。
- 合同修订完成只允许恢复到当前非生产 candidate 的实现与验收准备，不表示 A.3/A.4 或 Gate A ready。恢复时 public/customer route 继续 `NOT_OPEN`，不得自动续用修订前的 admission、review、served 或 aggregate receipt。

### Finding admission 与 candidate 稳定性

- Controller admission 必须在修复代码开始前形成 immutable record，至少绑定 `findingId,candidateManifestDigest,basis,existingAcIds,authorityRefs,affectedPaths,requiredRepair,exitOracle,reviewEvidenceDigest,admittedBy,admittedAt`。Reviewer 的 Critical/Important 标签本身不是 admission。
- 新产品能力、未来生产 hardening、通用 PKI/SBOM/SLSA、持续 Docker 监控、客户 credential 平台或延期 Gate 默认均为 follow-up；只有用户明确扩 scope 并发布新的 authority/contract revision 才能变成当前阻塞。
- 准入新的 `current-required` 会关闭当前 candidate 并创建新的 candidate revision；旧 review/served/aggregate receipts 只能保留为 superseded evidence，禁止通过重命名、续签或拼接变成新 candidate 的通过证据。

## Product And API Contract

### Capability、版本与发布

- `solution.analysis.v1` 保留 capability ID，但真实运行必须创建新的 immutable CapabilityVersion、HarnessVersion、PromptPolicyVersion 和固定 WorkflowVersion；不得原地修改 Gate 0.2A 的 fixture-only/fake 版本或让历史模拟证据变成“真实”。旧模拟版本继续可回归并始终醒目标记模拟。
- `production.work-order-status.v1` 使用独立 immutable CapabilityVersion、PromptPolicyVersion、固定六节点 WorkflowVersion 和 release record；不得借用 `solution.analysis.v1` 的状态或 approval subject。
- 两个 Capability 各自复用 Gate A0 的 append-only `CapabilityReleaseRecord` + CAS active pointer，拥有独立 candidate、aggregate、promotion receipt 与 active pointer；持久化状态仍只允许 `draft → shadow → internal`。`validation-only` 不是新的 release 状态，而是绑定一个 immutable `shadow` candidate 的 run-scoped `InternalAcceptanceAdmission` overlay；public/customer route 始终 `NOT_OPEN`，只有具名本机验收 principal、具名测试对象和本轮 harness 可以访问。
- Pre-open gates 固定为 authority/contract、exact candidate/source manifest、schema/build/targeted integration、provider/connector preflight、owner/credential isolation/egress admission。只有它们全部通过，才可签发一次性 acceptance admission。该 admission 必须绑定 runId、candidate/source/acceptance-manifest digests、authority revision、pre-open receipt digests、allowlisted principal/object、provider/connector `credentialVersionId`、runtime image/topology、issuedAt/expiresAt、declaredMaximumRunDuration、maxInvocationTokenTTL、shutdownGrace 与独立 actor/key identities。Checked-in acceptance manifest 必须把 `declaredMaximumRunDuration` 计算为全部 required command timeout ceilings、具名 fault/restart windows 和 cleanup budget 的和，`maxInvocationTokenTTL` 取本 run 所有 provider/connector token policy 的最大值，`shutdownGrace` 至少 30 秒；`0 < expiresAt - issuedAt <= 8h`，且签发和每次启动前都必须机械满足 `expiresAt - now >= declaredMaximumRunDuration + maxInvocationTokenTTL + shutdownGrace`。任一值缺失、负数、漂移或不满足上限/不等式都在外部 I/O 前失败，不得用更短自报 duration 或超长 lease 绕过。
- Served UI/API/DB/provider/connector correlation、negative/revocation/recovery、精确 persistence/egress oracle 和 source/authority stability 属于 acceptance-only gates，只能在同一 immutable admission 上运行。任一失败、candidate/authority/receipt/credential version 漂移、过期或 runway 不足，立即使本 run 失败；release 保持 `shadow`、public route 保持 `NOT_OPEN`，禁止在同一 run 续签、替换 tuple 或拼接旧子证据。
- 对每个 Capability，只有其自己的 fresh aggregate 证明全部 pre-open 与 acceptance-only gates 在同一 source manifest/run lease 内通过，才允许该 Capability 的新 CAS `shadow → internal`；缺失、failed、expired 三种 gate 都不得 promotion，另一 Capability 的通过或失败不能替代该 aggregate。Gate A 不进入 `graduated` 或 customer-production。
- UI 必须明确显示“可信本机内部验收”，不得把订阅测试车道或 GearJob 测试连接描述为生产可用。

### Live 与 legacy 双轨兼容

- Gate A 不修改 legacy canonical payload、历史数据库行、WorkflowVersion/hash、Evidence/Artifact hash 或现有 Zod literal。既有数据库并没有持久化字符串 `business-task.simulation/1`；legacy task/step/claim/evidence 的权威 selector 是各表已冻结的三元组 `(simulation=true,runtime_mode=fake,business_decision_allowed=false)`，legacy event 还必须满足整数 `schema_version=1` 并通过 FK 指向同一 legacy task，task 的内嵌 result 继承 task selector。legacy `simulation_report` Artifact 通过既有 kind、business_task_id 与该 legacy task 的 FK 识别；legacy Workflow 通过既有 canonical payload schema 与冻结 hash 识别。公共投影可把这些精确 selector 派生显示为 `schemaVersion=business-task.simulation/1`，但不得声称该字符串存在于历史行或把它回填进去。
- live 使用新的、非空且逐关系固定的持久化 `record_variant`/schema discriminator；task 固定为 `business-task.live/1` 并与 `(simulation=false,runtime_mode=model_gateway,business_decision_allowed=false)` 联动，event、step、result、claim、evidence、live report Artifact 与 Workflow read model 分别使用自己的 live variant literal，并通过 tenant/task/Workflow/Evidence/Artifact FK 只能连接同一 live root。同表扩展时新列对历史 legacy 行允许 `NULL`，但 additive conditional CHECK 要求任何 live 三元组必须携带唯一允许的非空 live literal，并要求 legacy 三元组只能保持 `NULL`；也可使用独立 live table。禁止 legacy selector 携带 live reference、live selector 携带 legacy result/evidence/report，或任意 mixed combination。
- live input/result/event/evidence/artifact 使用 versioned-discriminated Zod variant；公共读取投影先按上述逐关系持久化 selector 选择精确 parser，再返回共同 envelope。未知 discriminator、NULL live discriminator、event/task selector 不一致、legacy row 携带 live 引用、live row 缺少 ModelInvocation/parser provenance 或跨 variant 字段组合全部 `NOT_OPEN`/integrity failure；不得把旧 literal 改成宽泛 boolean/string union 来伪造兼容。
- migration 只允许新增 live 表/列/index/variant registry，或以事务化、等价保留 legacy 分支的 discriminated CHECK 精确替换现有 `simulation=true/runtime_mode=fake/business_decision_allowed=false` literal CHECK；不得删除 legacy 分支、更新历史数据，或用 DEFAULT/backfill 改写既有行。新增 discriminator 由新 live insert 显式提供，旧行继续以原三元组和 `NULL` 新列匹配 legacy 分支。live 幂等 semantic fingerprint 至少包含 record variant、CapabilityVersion、WorkflowVersion/hash、input snapshot hash、ExpertTarget 与 operation；legacy 和 live key 永不互相重放。task cursor 在各自 task/event schema 内严格递增，不能把 legacy 事件拼入 live stream。
- 兼容回归必须在同一数据库中同时读回一个历史 fixture task 和一个 live task，并逐关系断言 task/event/step/result/claim/evidence/report Artifact/Workflow selector、FK 和 Zod parser 一致，证明二者使用各自 immutable WorkflowVersion/hash、正确的 simulation/live 标记、独立 cursor 和 Evidence/Artifact lineage；旧 API/深链继续只返回历史模拟语义，不能因 active live release 改写。

### 固定多模板 Workflow 权威

- Compiler 新增 immutable `WorkflowTemplateVersion` registry，但不开放动态 Workflow。Zod 4 strict entry 的 canonical object 固定且只包含 `schemaVersion,templateId,capabilityVersionId,harnessVersionId,workflowDraftSchemaVersion,workflowPayloadSchemaVersion,compilerVersion,canonicalizationVersion,nodes,edges,permissionCeiling,registryDigest`；node 只包含 `id,kind,registryReference,inputRefs,outputSchemaId`，edge 只包含 `from,to`，所有数组顺序都是 canonical payload 的一部分且禁止隐式 default。`registryDigest=sha256(RFC8785/JCS(entry without registryDigest))`；compiled Workflow hash 同样只对其 versioned Workflow payload 做 JCS+SHA-256。CapabilityVersion 只能解析到一个被批准的 template version，Compiler 输入只有 registry 中的 template selection，不是可变自由 draft 或任务输入值，并只接受逐字段完全匹配的白名单模板。

| Template | template schema | capabilityVersionId | harnessVersionId | draft / payload schema | compiler / canonicalization |
| --- | --- | --- | --- | --- | --- |
| `workflow-template.solution-fixture/1` | `workflow-template-version/1` | `cap_solution_analysis_v1_1` | `harness_solution_analysis_v1_1` | `workflow-draft.fixed-v1` / `workflow-version.fixed-v1` | `geneway-workflow-compiler/0.1.0` / `RFC8785/JCS-1` |
| `workflow-template.solution-live/1` | `workflow-template-version/1` | `cap_solution_analysis_v1_live_1` | `harness_solution_analysis_v1_live_1` | `workflow-draft.template-v1` / `workflow-version.template-v1` | `geneway-workflow-compiler/0.2.0` / `RFC8785/JCS-1` |
| `workflow-template.work-order-status/1` | `workflow-template-version/1` | `cap_production_work_order_status_v1_1` | `harness_production_work_order_status_v1_1` | `workflow-draft.template-v1` / `workflow-version.template-v1` | `geneway-workflow-compiler/0.2.0` / `RFC8785/JCS-1` |

- live Compiler 输入 `workflow-draft.template-v1` 是 strict selection object，且只包含 `{schemaVersion:"workflow-draft.template-v1",templateId,registryDigest}`；客户端或运行时提交 nodes、edges、permission、task input/value 或额外字段一律拒绝。Compiler 以 templateId 读取 immutable registry entry、重算并匹配 registryDigest 后，确定性生成 strict `workflow-version.template-v1` payload。
- `workflow-version.template-v1` canonical payload 必须且只能包含以下字段：`schemaVersion="workflow-version.template-v1"`、`templateSchemaVersion="workflow-template-version/1"`、`compilerVersion="geneway-workflow-compiler/0.2.0"`、`canonicalizationVersion="RFC8785/JCS-1"`、`featureSet="fixed-template-v1"`、templateId、registryDigest、capabilityVersionId、harnessVersionId、nodes、edges、permissionCeiling。nodes/edges/permissionCeiling 使用 registry entry 的同一 strict nested shape 和数组顺序，禁止 unknown、缺失字段、隐式 default 或重新排序。
- derivation 规则逐字段固定：五个 version/feature 常量取上段 literal；templateId、registryDigest、capabilityVersionId、harnessVersionId、nodes、edges、permissionCeiling 从已验证 registry entry 原样复制；不做合并、扩展或运行时覆盖。template entry 的 workflowDraftSchemaVersion/workflowPayloadSchemaVersion 只用于选择上述 parser，已由 registryDigest 间接绑定，不重复进入 payload。具体 documentSnapshotId/workOrderRef、其 hash、BusinessTask/Conversation/principal、Approval、budget/deadline、ConnectorQuerySpec、attempt/effect/fence 和实际 input value 全部禁止进入 Workflow payload，只进入各自 task/Approval/执行权威。WorkflowVersion id/hash 是 payload JCS+SHA-256 的派生 envelope，也不进入自身 payload。

- legacy `solution.analysis.v1` fixture 模板作为同一 registry 的只读 compatibility entry，继续按原 canonical JSON 与 Workflow hash `be038895345cb58a8f6080bb023b076613379403881eac6ea0f1763e8bd0eca4` readback。registry wrapper、templateId、registryDigest、connectors/modelTools metadata 不进入、不重写历史 WorkflowVersion canonical payload/hash；legacy compiler 只能使用旧 parser/payload。Gate A 的两个 live entry 使用上表新的严格 payload variant，各自产生新的 immutable WorkflowVersion/hash。

| Legacy template | Node | kind | Immutable registry reference | inputRefs | outputSchemaId |
| --- | --- | --- | --- | --- | --- |
| `workflow-template.solution-fixture/1` | `document_ingest` | deterministic | `fixture-reader/1` | `workflow.input.fixtureRef` | `document.snapshot/1` |
| 同上 | `requirement_extract` | agent | `cap_solution_analysis_v1_1` + `harness_solution_analysis_v1_1` | `step.document_ingest.output` | `requirement.candidates/1` |
| 同上 | `contradiction_check` | agent | `cap_solution_analysis_v1_1` + `harness_solution_analysis_v1_1` | `step.requirement_extract.output` | `contradiction.result/1` |
| 同上 | `solution_design` | agent | `cap_solution_analysis_v1_1` + `harness_solution_analysis_v1_1` | `step.requirement_extract.output, step.contradiction_check.output` | `solution.design/1` |
| 同上 | `evidence_verify` | verification | `claim-evidence-minimum/1` | `step.solution_design.output` | `evidence.verdict/1` |
| 同上 | `result_quality_check` | verification | `simulation-quality/1` | `step.evidence_verify.output` | `quality.verdict/1` |
| 同上 | `report_publish` | deterministic | `simulation-publisher/1` | `step.result_quality_check.output` | `report.projection/1` |

- legacy entry 的 edges 固定为上表相邻串行连接；registry wrapper 的 permission ceiling 五个 key 必须全部存在并固定为 actions=`[R0,R1,A1]`、resourceScopes=`[fixture:solution-analysis:v1]`、dataClasses=`[C0,C1]`、connectors=`[]`、modelTools=`[]`。旧 Workflow payload 仍只含旧 schema 已有的三个 permission key；Compiler 对该 entry 只能 readback 或生成与既有 payload/hash 完全相同的 fixture WorkflowVersion，不能把 templateId、registryDigest、connectors/modelTools 或任何 Gate A 新字段注入历史 canonical payload。

| Template | Node | kind | Immutable registry reference | inputRefs | outputSchemaId |
| --- | --- | --- | --- | --- | --- |
| `workflow-template.solution-live/1` | `document_ingest` | deterministic | `document-snapshot-reader/live-1` | `workflow.input.documentSnapshotId` | `document.snapshot.live/1` |
| 同上 | `requirement_extract` | agent | `agent.solution.requirement/live-1` | `step.document_ingest.output` | `analysis.requirement-candidates/1` |
| 同上 | `contradiction_check` | agent | `agent.solution.contradiction/live-1` | `step.requirement_extract.output` | `analysis.contradiction/1` |
| 同上 | `solution_design` | agent | `agent.solution.architect/live-1` | `step.requirement_extract.output, step.contradiction_check.output` | `analysis.result-candidate/1` |
| 同上 | `evidence_verify` | verification | `claim-evidence-live/1` | `step.solution_design.output` | `evidence.verdict/1` |
| 同上 | `result_quality_check` | verification | `analysis-quality-live/1` | `step.evidence_verify.output` | `analysis.quality-verdict/1` |
| 同上 | `report_publish` | deterministic | `analysis-report-publisher/live-1` | `step.result_quality_check.output` | `artifact.analysis-report/1` |
| `workflow-template.work-order-status/1` | `validate_work_order_ref` | deterministic | `work-order-ref-validator/1` | `workflow.input.workOrderRef` | `work-order.ref/1` |
| 同上 | `fetch_authorized_status` | deterministic | `gearjob-work-order-status-reader/1` | `step.validate_work_order_ref.output` | `connector.work-order-snapshot/1` |
| 同上 | `compute_progress` | deterministic | `work-order-progress/1` | `step.fetch_authorized_status.output` | `work-order.progress/1` |
| 同上 | `explain_status` | agent | `agent.production.work-order-status/1` | `step.fetch_authorized_status.output, step.compute_progress.output` | `work-order.explanation/1` |
| 同上 | `evidence_verify` | verification | `connector-evidence/1` | `step.fetch_authorized_status.output, step.explain_status.output` | `evidence.verdict/1` |
| 同上 | `publish_status_card` | deterministic | `work-order-card-publisher/1` | `step.fetch_authorized_status.output, step.compute_progress.output, step.explain_status.output, step.evidence_verify.output` | `work-order-status-card/1` |

- 两个新模板的 edges 严格按表内顺序串行相邻连接，live permission ceiling 五个 key 全部 required、禁止未知 key 和默认补值。solution live canonical 值固定为 actions=`[R0,R1,A1]`、resourceScopes=`[document-snapshot:approval-subject-bound]`、dataClasses=`[C0,C1]`、connectors=`[]`、modelTools=`[]`；work-order canonical 值固定为 actions=`[R0,R1,A1]`、resourceScopes=`[gearjob-work-order:connector-query-spec-bound]`、dataClasses=`[C0,C1]`、connectors=`[gearjob.work-order-status.read/1]`、modelTools=`[]`。这两个 resource scope 都是 template-level symbolic scope，不含 documentSnapshotId、workOrderRef 或其 hash；每任务具体资源只能进入 BusinessTask、ApprovalSubject 以及对应 execution grant/ConnectorQuerySpec/token。
- 引入每个 template 的首个实现提交必须 checked in 一份受审查、不可变的完整 canonical fixture、registry version、由上述算法算出的 registryDigest、compiled Workflow canonical JSON/hash 和独立 golden expected；测试不得在同一次运行中从当前可变 fixture/registry 重新计算 expected 后自证通过。合同不手写尚未由 fixture 产生的未来 live digest/hash literal，但实现提交一旦固定后任何字段变化都必须创建新 WorkflowTemplateVersion、Capability/Harness binding、WorkflowVersion/hash 和 ApprovalSubject，不能更新既有 fixture。
- 未登记 template/capability/harness/schema/compiler 组合、registry digest 不匹配、跨 capability template 置换、节点增删/换序、不同 kind/ref/input/output、自由 URL/code、condition、parallel、wait、loop、在 nodes/edges/permission ceiling 或其他 canonical Workflow 字段注入具体 documentSnapshotId/workOrderRef，或超出 permission ceiling，全部 `NOT_OPEN`。golden tests 对三个允许模板做 canonical hash/readback，并证明任意跨模板字段置换失败；两个不同合法 DocumentSnapshot 生成相同 solution-live WorkflowVersion/hash、两个不同合法 workOrderRef 生成相同 work-order WorkflowVersion/hash，但各自产生不同的 ApprovalSubject digest，且工单还产生不同的 ConnectorQuerySpec hash。

### `solution.analysis.v1` 真实材料流

- 延续现有 public API 与 Zod 4 单一 schema 来源：上传 Artifact、创建 immutable `DocumentSnapshot`、提交 `solution.analysis.v1` BusinessTask、确认 Workflow/Approval、执行、读取 task snapshot/events、Evidence 和 Artifact。新增或变化的 wire 必须从 Zod 生成 JSON Schema，不增加第二 validator。
- `CreateTaskInput` 的材料 variant 固定绑定 conversationId、`capabilityId=solution.analysis.v1`、documentSnapshotId、ExpertTarget 和 `Idempotency-Key`。tenant、principal、resourceScope、dataClass、audience、model、provider、prompt、budget 与 WorkflowVersion 均由服务端解析，客户端覆盖无效。
- 创建任务前重新授权 Conversation、Artifact、DocumentSnapshot 与 audience；同一 principal、Conversation、DocumentSnapshot、CapabilityVersion、ExpertTarget 和幂等键只创建一个 BusinessTask。相同 key 不同语义返回 409。
- 真实材料业务拓扑严格使用 `workflow-template.solution-live/1`；节点、边、registry reference、权限上限或输入引用的任何改变都必须先形成新的受审查 WorkflowTemplateVersion，再产生新 WorkflowVersion/hash 和新 ApprovalSubject digest，不能由运行时配置替换。
- `document_ingest` 只从 Control Plane 发出的执行期投影读取已验证的 DocumentSnapshot 文本窗口、snapshot hash、resourceScope、dataClass 和 audience；Runtime、模型与 Worker 不获得 storage credential、bucket 任意读取或原始 HTML 执行能力。
- agent 节点使用 Model Gateway 逻辑策略 `business.solution.analysis.standard`。模型输入把材料标记为 `untrusted_text`，明确禁止其中的指令扩大系统提示、工具、数据、预算或动作权限；Gate A 继续使用 `tool_choice=none`，所有非空 tool call 都是协议违规。

### 安全文档摄取与数据等级

- 上传继续执行 MIME 与扩展名双 allowlist、大小/页数/解压比/嵌套深度限制、恶意文件扫描、隔离解析、canonical text、content hash、retention 和删除状态。首版 live route 只允许 `text/plain`、PDF 和已通过隔离解析的受支持 Office 文档。
- 每个允许格式必须绑定 immutable `ParserManifest`：至少固定 parser 与依赖 name@version、registry/upstream source、lock resolution/integrity、实际 executable/package digest、license、approval actor/time 和唯一允许的转换配置。每次 parser 启动和任务执行前机器核验实际 bytes；manifest 缺失、过期或不匹配时对应 live route 保持 `NOT_OPEN`，不得先执行再只记录 digest。
- parser 使用独立低权限 OS identity 和一次性工作目录，只读一个输入、只写有界 canonical output；不挂载应用目录、其他上传物、对象存储/provider/GearJob credential 或宿主 secret，无 DNS/TCP、外链获取、宏/OLE/脚本执行和不受控子进程。强制 CPU、内存、wall time、页数、嵌套深度、解压比和输出大小上限；崩溃、超时、受密码保护、损坏、扫描失败、可疑嵌套或内容类型不一致全部 fail closed 并清理临时目录。
- parser 输出永远是 `untrusted_text`，不渲染或执行源 HTML、宏、脚本、外链、OLE、嵌入对象或公式动作。DocumentSnapshot provenance 固定 parserManifestId、parser/依赖 digest、extractionVersion、canonical text/page index hash 和资源限制版本；parser manifest tamper、恶意 PDF/Office、外链、嵌入对象、压缩炸弹、崩溃/超时测试必须证明零 DNS/TCP 和零凭据读取。
- `codex_subscription_dev` route 只允许 C0/C1，C2/C3 原文禁止进入 provider。Gate 0.2A 的“派生数据等级只能保持或升高”继续默认生效；Gate A 唯一窄化例外是模型边界之外受控完成的 `DeidentificationReclassificationRecord`，不能推广为通用降级能力。
- 该 immutable record 至少绑定 source Artifact/DocumentSnapshot/hash/dataClass=C2、output Artifact/DocumentSnapshot/hash/dataClass=C1、转换器 name/version/digest、deidentificationPolicyVersion、确定性检测结果、lineage、`role:gate-a-data-reclassification-approver` 的具名 actor 和 approvedAt。只有受控转换、服务端复检和当前有效的授权批准全部通过，才能创建一个新的 C1 snapshot；源 C2 与输出 C1 使用不同 ID/hash 并保持不可混淆 lineage。
- 客户端、模型、普通上传 metadata、共享 trusted-local principal 或 parser 不能触发 data class 降级。provider 只能获得输出 C1 的 canonical text；C3 输入、记录缺失、检测失败、hash 漂移、批准撤销/过期或 source/output 绑定不一致全部在零 provider I/O 下返回 `DATA_ROUTE_NOT_ALLOWED`。
- 单任务进入模型的 canonical text 总量上限为 256 KiB；超过时只允许确定性、可审计的完整段落选择，保存选中 locator 与 hash，不生成隐藏摘要替代来源。

### Live Evidence locator

- live 文档使用 versioned Zod `EvidenceLocator` discriminated union，不复用或放宽 legacy fixture locator。公共 variant 固定为：`canonical_text_span` 使用 canonical UTF-8 `startByte/endByteExclusive`；`canonical_page_span` 使用零基 `pageIndex` 和该页 immutable canonical UTF-8 `startByte/endByteExclusive`。分页坐标从不表示 PDF/Office 原始二进制 byte offset。
- 两个文档 variant 的公共字段固定包含 sourceArtifactId、sourceArtifactSha256、documentSnapshotId、canonicalTextSha256、parserManifestId、parserDigest、extractionVersion、excerptSha256。`excerptBytes` 必须是冻结 canonical text 或单页 canonical text 在 `[startByte,endByteExclusive)` 上的原样 byte slice；`excerptSha256` 与最大 16 KiB 限制都直接作用于这段 bytes，`startByte < endByteExclusive` 且只能落在同一冻结范围内。locator 验证阶段禁止再次做 Unicode、换行、trim 或任何文本 normalization；只有 byte boundary、UTF-8 合法性、hash 和大小全部通过后，浏览器投影才可解码显示。
- Control Plane 只从当前授权的 immutable DocumentSnapshot 冻结 canonical representation/page index 重取并验证 locator、UTF-8 boundary、excerpt bytes/hash、tenant、resourceScope、dataClass、audience 和 retention；Runtime/模型只能提交 locator candidate，不能提交权威原文、重解析器选择或 bucket/object path。golden/negative corpus 必须覆盖 NFC/NFD、CRLF/LF、多字节字符中间边界、恰好 16 KiB 和超出 1 byte。
- 浏览器逐次重新授权后只获得 kind、pageIndex（如适用）、canonical span、excerptSha256、source display label 和精确有界 excerpt；不得返回 bucket/object key、临时或 parser 内部路径、相邻未引用内容、源 C2 原文或未发布 candidate。跨页、Unicode、重排、恶意 locator、删除/撤权和浏览器字段泄漏必须 fail closed。

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

- live route 的硬前置是独立 GearJob preflight artifact。`gearjob-preflight/1`、controller admission 与 validation admission 的顶层和所有安全关键 nested object 都必须使用 Zod 4 `.strict()`；unknown、缺失 required、隐式 default 或跨字段矛盾一律拒绝。Preflight 必须固定唯一 base URL/endpoint、认证方式与 `credentialVersionId`、单 Work Order resource authorization 点、请求/响应 schema、字段 allowlist、not-found/forbidden 等价策略、timeout/retry、审计字段、速率上限、允许的 operational side effects、具名测试对象以及 expected/observed source manifests；任何未锁定或不一致项使 route 为 `NOT_OPEN`。
- Deployment、credential、API/authorization、data/test-object owner 必须对同一个最终 preflight candidate digest 明确批准，或由用户逐项委托给预先登记的主体。通用“可访问/可 setup/可修 bug”授权不能自动解释为这些技术事实已批准；implementer、reviewer、verifier、controller、signer 不能自行任命缺失 owner。
- `expectedSourceManifestDigest` 在 candidate 构建前由批准主体冻结，按排序后的 exact `{path,sha256,kind}` entries 覆盖 Dockerfile/compose、entrypoint/verifier、Connector facade/auth、实际 image 会加载的启动源和测试/verification runners；`observedSourceManifestDigest` 由独立 preflight verifier 测量。两者必须逐项完全相等，稳定 dirty/untracked bytes 也必须显式列入，不能仅比较运行前后相等。
- geneway 只允许通过本机 Connector Gateway 调用最小 GearJob read-only facade。每个 GearJob/provider credential 都有不含 secret 的 immutable `credentialVersionId`；内容轮换、owner/path/identity 变化都创建新 version，preflight/profile/conformance/release/run lease 必须绑定 exact version，旧 conformance 不得仅凭相同 path/mode 复用。
- GearJob service credential 必须通过独立 Unix UID、独立 mount/user namespace 或只向 Connector Gateway 提供 opaque handle 的 secret broker 隔离；只有 Connector Gateway PID 可以看到 credential/canary。Web、Control Plane、Worker、Runtime、Model Gateway 和 test runner 的 environment、mountinfo、open FDs 均不得出现该 path/handle，实际 `stat/open` 必须返回 `ENOENT/EACCES`。同 UID `0600`、删除环境变量或源码字符串扫描均不构成隔离证明。
- Provider conformance receipt 必须由与 implementer 不同的 verifier 认证签发，绑定 provider/model、manifest digest、opaque account/credentialVersionId、实际 stream/cancel receipt digest、issuedAt/expiresAt 与 nonce；同路径同 mode 轮换 credential version 后，旧 conformance 必须在任何 provider I/O 前失效。
- public `CreateTaskInput` 新增严格 variant `{capabilityId:"production.work-order-status.v1", inputRef:{kind:"work_order", workOrderRef}}`；`workOrderRef` 是 1–128 字符的 opaque ID，只允许 `[A-Za-z0-9._:-]`。客户端不能提交 endpoint、method、profile、field mask、tenant、principal、resource context、model、provider、budget 或 ExpertTarget；该 capability 固定解析到 `agent.production.work-order-status/1`。SQL、URL、路径、filter、sort、include、字段列表或额外查询参数均由 Zod strict schema 拒绝。
- Control Plane 在 task-create transaction 内、插入初始 ApprovalVersion 之前，依据已冻结 release/preflight/profile、opaque workOrderRef、principal/resourceContext、Workflow、预算/deadline 和 card schema，纯本地生成并不可变持久化 `ConnectorQuerySpec`；该步骤零 DNS/TCP/GearJob I/O。specId/canonical hash 同时写入 BusinessTask 与 ApprovalSubject，subject 还绑定 workOrderRef hash、resourceContextDigest 和 profile/preflight/field-mask policy。批准后禁止补填或替换 spec；任何改变 spec hash 的 policy、resource、release、profile、endpoint/method、field mask、工单、预算或 card schema 漂移都必须先生成新 ConnectorQuerySpec 和新 ApprovalVersion/subject，使旧 decision 失效，新 subject 获批后才可签发 token。
- ConnectorQuerySpec 至少固定 capabilityVersion/releaseRecord、approvedPreflightDigest、connectorProfileVersion、精确 base URL + endpoint + read-only method allowlist digest、fieldMaskVersion、opaque workOrderRef、principal/resourceContextDigest、WorkflowVersion/hash、stepId=`fetch_authorized_status`、budget/deadline、public error policy 和 WorkOrderStatusCard schema version。WorkflowVersion/hash 只绑定 QuerySpec schema version、connector profile/preflight/endpoint-method/field-mask policy 和 card schema，不绑定每任务不同的 workOrderRef；具体 specId/hash、workOrderRef hash 与 resourceContextDigest 只进入 task/Approval/token。重试只能复用同一已批准 spec 和稳定 effectId。
- ConnectorQuerySpec、allowlisted response payload 和 connector Evidence field value 分别使用 strict versioned Zod object `connector-query-spec/1`、`connector-work-order-response/1`、`connector-evidence-field/1`，共同固定 `canonicalizationVersion=RFC8785/JCS-1`。流程唯一为：先由对应 strict schema 完整解析并物化所有 required/null 字段，拒绝 unknown、缺失 required、`undefined`、NaN、Infinity、BigInt 与非 schema 类型；再对解析结果做 RFC 8785/JCS，取 UTF-8 bytes 后 SHA-256。时间字段只接受 schema 定义的唯一 ISO datetime 表示并原样进入 JCS，hash 阶段禁止时区、精度或字符串改写。
- `connector-work-order-response/1` 的九个 key 全部 required：workOrderRef/status/sourceRevision/updatedAt 为非空字符串（updatedAt 为唯一 ISO datetime），planQty/completedQty 为非负有限 number 或 null，unit 为非空 string 或 null，plannedStart/plannedEnd 为唯一 ISO datetime 或 null；unknown/额外字段在 canonicalization 前拒绝。`connector-evidence-field/1` 固定 `{schemaVersion,canonicalizationVersion,fieldName,fieldType,canonicalValue}`，fieldName 必须来自 field mask，fieldType 必须与响应 schema 一致，field hash 对整个 versioned object 的 JCS bytes 计算，禁止直接对语言运行时值 stringify。
- facade 必须同时验证 connector service identity、短期 token、单对象权限与固定 field mask；存在但无权与不存在对浏览器返回等价公开结果。响应必须是 strict 单对象，且在任何 Control Plane 业务落库、ConnectorSourceSnapshot、Evidence、模型输入或卡片生成前，`response.workOrderRef` 必须与 ConnectorQuerySpec 的 opaque workOrderRef 按精确 UTF-8 bytes 相等。由于公开 ref 已限制为 ASCII allowlist，禁止 trim、大小写折叠、Unicode normalization、别名或路径解析；缺失/不同 ref、数组、多对象、嵌套批量包裹、重复对象或额外对象全部按 `zero-gearjob-business-mutation + zero-geneway-business-publication` fail closed，且不得产生模型 I/O。只允许返回 workOrderRef、status、planQty、completedQty、unit、plannedStart、plannedEnd、updatedAt 和 sourceRevision；未在 allowlist 的客户、价格、人员、工艺、设备、备注或扩展字段不得进入 geneway。
- 固定六节点拓扑使用 `workflow-template.work-order-status/1`。`fetch_authorized_status` 是经 Connector Gateway/facade 的 deterministic handler；`compute_progress` 用确定性代码计算并处理 planQty 为零/空；只有 `explain_status` 调用 Model Gateway，且只接收 allowlisted snapshot 与计算结果，`tool_choice=none`。
- `effectId` 是同一 BusinessTask、`fetch_authorized_status` step 和 ConnectorQuerySpec 语义跨 retry 稳定的幂等身份；`ConnectorInvocationId` 是每个 attempt/实际网络调用唯一的身份；jti/nonce 对每个 ConnectorInvocation 唯一且只能原子消费一次，三者不得作为同义字段。Control Plane 仅在当前 task 已批准、release 仍开放、当前 step/attempt/fence 有效且重新授权通过后，为该 attempt 创建新的 ConnectorInvocationId/jti 并签发 connector token。token 固定 issuer=`geneway-control-plane`、audience=`gearjob-work-order-status-connector`、最大 TTL 60 秒、最大时钟偏差 5 秒，分别绑定 tenant、principal、taskId、workflowVersionId/hash、stepId、attemptId、稳定 effectId、唯一 ConnectorInvocationId、ConnectorQuerySpec hash、connectorProfileVersion、workOrderRef hash、fieldMaskVersion、resourceContextDigest、deadline、当前 fence 和 jti/nonce；Worker 不得自签、扩 claim 或将 token 用于 Model Gateway。
- Connector Gateway/facade 在任何 DNS lookup、TCP connect 或 GearJob request 前，通过本机认证通道原子消费 jti，并检查 token、当前 Approval/ConnectorQuerySpec/release/task terminal/deadline/attempt/fence/ConnectorInvocationId 与 exact endpoint/method/field mask。只有 Control Plane 重验全部 current authority 后才可为同一 effect 的新 attempt 创建新 invocation/jti；旧 attempt/fence/invocation 在网络前拒绝。取消、terminal、approval invalidation、release 关闭、profile/spec drift、过期或旧 claim 使未消费 token 失效；已发出的迟到响应还必须在 Control Plane terminal/snapshot CAS 时因旧 attempt/fence/invocation 被拒绝。
- `ConnectorInvocation` 至少记录 ConnectorQuerySpec hash、connectorProfileVersion、workOrderRef hash、fieldMaskVersion、request principal/resource context digest、attemptId、稳定 effectId、唯一 ConnectorInvocationId、fence、jti digest、deadline、startedAt、terminalAt、status、errorClass、responseRefMatched、sourceRevision、response canonical hash 和 redacted audit；不保存 service credential 或未允许字段。
- 只有完成 strict 单对象、workOrderRef bytes、field mask 与 schema 验证的 allowlisted 响应才能固化为 immutable `ConnectorSourceSnapshot`。snapshot 至少绑定 taskId、成功的唯一 ConnectorInvocationId、稳定 effectId、attemptId/fence、ConnectorQuerySpec hash、由已批准 spec 生成的 workOrderRef hash、`responseRefMatched=true`、fieldMaskVersion、sourceRevision、sourceAsOf、canonical allowlisted payload/hash、resourceScope、dataClass、audience 和 createdAt。同一 effectId 最终最多接受一个 ConnectorSourceSnapshot、一张卡片和一个 terminal result。
- Connector Evidence 使用独立于文档 locator 的 strict versioned Zod union：`connector_snapshot_field` 与 `connector_snapshot_whole`。公共字段绑定 ConnectorSourceSnapshotId、ConnectorInvocationId、effectId、ConnectorQuerySpec hash、canonical allowlisted payload hash、workOrderRef hash、fieldMaskVersion、sourceRevision 和 sourceAsOf；field variant 还绑定冻结 field-mask allowlist 中的唯一 field name、canonical field value/type/hash，whole variant 只表示完整 allowlisted canonical snapshot，绝不表示 raw response。Control Plane 从 immutable snapshot 重取并重新授权 resourceScope/dataClass/audience，校验 payload/field hash、存在性与类型后才创建 Evidence。浏览器只得到公开 source label、sourceAsOf/revision、已允许字段及其 Evidence 关联，不得得到 endpoint/profile、credential、内部路径、raw payload、内部审计或未 allowlist 字段。
- 公开 `WorkOrderStatusCard/1` 固定为 strict Zod object：workOrderRef/string、status/non-empty string、planQty/completedQty/非负有限 number 或 null、unit/non-empty string 或 null、progressPct/0–100 finite number 或 null、updatedAt/sourceAsOf/ISO datetime、`evidenceRefs`/strict object（status、planQty、completedQty、updatedAt、sourceAsOf 均为 non-empty Evidence ID）、readOnly/literal true。每个引用都必须重取到同一个获准 ConnectorSourceSnapshot 的 field/whole locator；`progressPct` 只由已验证 planQty/completedQty 的确定性 handler 计算并保留两者 Evidence，模型不能修改确定性数值、原始状态或补造缺失字段。
- 查询是读操作但仍使用稳定 idempotency/effect ID；超时/reclaim 只允许同一 approved spec/effect 下的新 attempt/new ConnectorInvocationId/new jti，不得产生第二个 BusinessTask、第二张完成卡片、第二个被接受 snapshot 或跨工单响应。写方法、非 allowlisted endpoint 或模型直连必须在外部 I/O 前以 `zero-request` 拒绝；重定向、跨 host 或额外 DNS/egress 必须满足 `zero-unexpected-egress`；任何已收到但被拒绝的响应都必须满足 `zero-gearjob-business-mutation + zero-geneway-business-publication`。
- receiver/egress negative oracle 必须覆盖过期、并发重放、错误 issuer/audience/profile/spec/method/endpoint/ref/fieldMask/attempt/effect/ConnectorInvocationId/fence、response ref 缺失/不同、数组/多对象/批量包裹、connector locator field/whole tamper、字段不在 mask、snapshot/payload hash 漂移、撤权后的浏览器重取、同 effect 新 attempt、跨 effect、迟到响应 CAS、redirect、跨 host 和额外 DNS。网络前拒绝 case 必须 `zero-request`；响应拒绝 case 必须 `zero-gearjob-business-mutation + zero-geneway-business-publication`；所有 retry case 只能产生单一被接受 snapshot、卡片和终态结果。

#### Persistence 与 egress oracle 的唯一口径

- 本合同禁止裸用“zero-write”。`zero-request` 表示在 DNS/TCP/HTTP 前拒绝，GearJob 和非预期 host 收到 0 request。
- `zero-gearjob-business-mutation` 表示一次获准只读请求前后，Work Order 及其具名业务关联表/业务事件流的 semantic snapshot 完全不变。Preflight 明确列出的 access audit/request log 可以 append；cache/session/metrics 只有在列出 exact key space、用途和上限且不承载授权或业务真相时才允许。MariaDB/Redis 全字节零变化不是默认 oracle，只有它们被 preflight 声明为该业务真相源时才要求。
- `zero-geneway-business-publication` 表示被拒绝响应不能创建 ConnectorSourceSnapshot、Evidence、成功卡片/Artifact 或 completed result；允许保存失败的 ConnectorInvocation terminal、task failure 与最小脱敏安全审计。
- `zero-unexpected-egress` 表示除当前 admission 允许的 exact GearJob endpoint 和 Model Gateway route 外，DNS/TCP/HTTP 观察为 0。网络前失败使用 `zero-request`；已发出请求但响应被拒绝使用 `zero-gearjob-business-mutation + zero-geneway-business-publication`；正常只读成功使用 `zero-gearjob-business-mutation`；redirect/跨 host 使用 `zero-unexpected-egress`。

## Runtime, Connector And Authority Contract

- Worker 继续只通过 Control Plane UDS 命令 claim/execute/checkpoint/terminal，不直读业务数据库。每次 step mutation 携带 taskId、workflowVersionId/hash、stepId、attemptId 和 monotonic fence，由 Control Plane CAS 校验。
- agent step 复用 Gate A0 的 Model Gateway invocation token 和本机认证通道；connector step 使用上述独立 GearJob ConnectorQuerySpec/token/jti/egress 边界。两类 token 不能互换、透传或由 Worker 自签。
- Model Gateway 与 Connector Gateway 都不能成为业务权威。所有 checkpoint、ModelInvocation/ConnectorInvocation terminal、Evidence/Lineage、Artifact manifest 和 task event/cursor 在 Control Plane transaction 中提交后才可投影。
- Web、Control Plane、Worker、Runtime、Model Gateway 与 Connector Gateway 都不得拥有 `/var/run/docker.sock`、`DOCKER_HOST`、docker CLI 执行权或等价容器管理权限。Docker/image/topology 检查只能由启动前的独立低权限 preflight verifier 执行；它不得持有 Business Postgres、Control Plane service token、provider/GearJob credential，也不得修改 task/release，只能输出 strict、JCS-hashed、短期 receipt。Control Plane 只验证持久化 release tuple、receipt digest/effective interval 和最小 Gateway readiness projection，不能读取 Codex workflow artifact 路径或触发 Docker 检查。
- Actor tuple 固定为 `candidateDigest,implementerActorId,implementerSessionId,reviewerActorId,reviewerSessionId,reviewerKeyId,verifierActorId,verifierSessionId,verifierKeyId,controllerActorId,controllerSessionId,controllerKeyId,signerActorId,signerSessionId,signerKeyId,reviewReceiptDigest,verificationReceiptDigest`。Reviewer、verifier、controller、signer 四个 actor/session/key 三元组必须两两不同且均不等于 implementer；pre-open strict ActorRegistry 在 candidate 前冻结每个 actor/session 到独立 public key 的映射，receipt 必须由对应私钥认证并绑定同一 candidate digest、不可复用 task/session ID、actual command manifest、raw output digest、时间与 nonce，单纯不同的自由字符串不构成身份分离。Controller 只能聚合 receipts，signer 只能签已完成的 controller record，二者不能生成或修改 candidate；各角色私钥只能对对应独立进程可见，fresh-DB verifier 必须验证全链签名、role/key/session collision 与 nonce replay。
- Atlas v2 contract verdict、A.3 review、verification、controller、preflight 与 signed admission 使用互不冲突的 canonical 文件名。`review-verdict.json` 只保留 Atlas schema v2；运行时 private receipt 不得覆盖、重命名或代替它。Fresh DB 必须在自己的信任边界重新验签完整 admission bytes/key id/parent chain，或使用 `renewal_of=null` 的 genesis admission；`externalSignatureVerified=true` 布尔值不能代替签名链。
- 用户取消、deadline、approval invalidation、task terminal 或 fence 变化同时使未消费的 model/connector token 失效；迟到模型输出、connector response 或 step completion 不能覆盖 canceled/failed 或生成第二结果。
- 真实材料分析和工单能力分别设置预算与 deadline；`codex_subscription_dev` 仍保持单 active provider invocation。超过上限返回明确 busy/retry 信息，不无限排队，不切换账号/API key/provider。
- 系统提示、provider/connector raw payload、token、auth-file/service credential 路径、内部 route、错误堆栈和未 allowlist GearJob 字段只进入必要且脱敏的审计，不进入客户消息、Artifact、截图或浏览器网络响应。

## Internal Slice Map

| Slice | Owned behavior | Required checks and exit oracle | Allowed conclusion |
| --- | --- | --- | --- |
| `A.1 live material product vertical` | live/legacy 双轨、新 immutable live Capability/Harness/Prompt/Workflow、auto ExpertTarget、真实 Model Gateway agent steps、安全 C1 DocumentSnapshot、最小 AnalysisResult 分类；每个 published fact 都通过 Control Plane Evidence publish guard 并各自绑定 verified accessible Evidence，失败 candidate 只能 rejected/unknown；deterministic Artifact、Approval 重授权、刷新/取消/失败最低恢复和真实 served UI；只回归而不重做 Gate A0 默认无材料 Fast Chat | contract/contracts/integration/security/model-gateway；真实 served Web + live provider 完成 auto 路线 C1 材料分析；逐 fact Evidence oracle；刷新保持同 task/result，取消/失败不伪装 completed；默认 Composer 首问/追问/停止/恢复零 BusinessTask；UI/API/Postgres/Worker/Gateway 同 task/workflow/modelInvocation/Evidence/Artifact 关联 | 只能声明“auto ExpertTarget 的真实材料分析纵切就绪”；单专家、专家团、GearJob 和 Gate A 整体均未就绪 |
| `A.2 evidence/expert/review hardening` | 在 A.1 已有逐 fact publish guard 上扩展单专家/专家团、三路线 immutable registry/相同权限上限、完整 Evidence tamper/hash/audience/locator、approval stale/replay、Worker reclaim 和浏览器恢复 hardening | 三路线 live run；完整 negative matrix；approval stale/cancel/replay/reclaim；浏览器恢复同一 Evidence/Artifact，A.1 和默认 Fast Chat 行为不退化；fresh `solution.analysis.v1` aggregate 后才 CAS 该 Capability 到 internal | 只能声明“三种 ExpertTarget 的真实材料分析能力就绪”；GearJob 与 Gate A 整体仍未就绪 |
| `A.3 GearJob single-work-order` | Strict approved preflight、expected/observed source equality、credentialVersion/process isolation、Connector Gateway/profile、单对象 facade、六节点固定 Workflow、ConnectorSourceSnapshot/Evidence/WorkOrderStatusCard | pre-open gates 后签发单轮 shadow acceptance admission；同一 lease 上完成真实/脱敏 Work Order served run、权限/字段/egress/persistence/recovery oracle；fresh A.3 aggregate 后才 CAS 到 internal | 只能声明“单工单只读查询能力就绪”；Gate A 整体仍未就绪；任一 gate 不通过时 public route 保持 NOT_OPEN |
| `A.4 hardening and aggregate` | 两 Capability 独立 release、quota/timeout/retry/fence、进程恢复、LAN targeted regression、dependency-sensitive historical regression 与 frozen gate manifest | `pnpm verify:gate-a`；验证两条 Capability 各自的 fresh aggregate/promotion receipt 都绑定当前 source/authority，并在 A.4 frozen regression run 中通过两条真实 served 用户流、negative matrix 与 credential/egress/persistence scan；A.4 不执行第二次 promotion | 只能声明可信本机 internal 的 Gate A ready；customer-production 仍 NOT_OPEN |

## First Code Slice Guard

- first_code_slice: Implement product behavior for `A.1 live material vertical`（实现真实产品功能）; 其可验证单位是 frozen candidate，不是主观“首个逻辑提交”。Candidate manifest 必须绑定 source tree、migration、Web/API/Postgres、Worker、Model Gateway、tests 与 served evidence 使用的 exact bytes，并让用户从可见“分析材料”入口完成一份合格 C1 DocumentSnapshot 的任务创建、Workflow/Approval 确认、真实模型执行、结构化结果和来源引用查看。
- first_code_slice_kind: product
- first_code_owner: `role:gate-a-implementation-owner`；获得产品代码实施授权后必须解析为具名负责人。
- first_code_verification: `candidateManifestDigest + required pre-open receipts + pnpm test:e2e -- --project=gate-a-live gate-a-solution-analysis.spec.ts + served correlation summary`；核对同一 task、workflowVersion/hash、approval digest、modelInvocation、Evidence 和 Artifact 在 UI、API、Postgres、Worker 与 Model Gateway audit 中一致。Commit 数量、边界和消息不是完成条件。
- allowed_contract_gate_only_until: Gate A authority revision、本最终合同、strict new-authoring lint、pinned baselines/dependency-impact manifest 与 pre-open gates 完成，并形成首个 frozen A.1 candidate。不能以 GearJob preflight、schema、fixture 或 headless conformance 代替真实材料产品纵切。
- stop_if_no_code_by_phase: 未能形成包含真实产品纵切全部所需 owned paths 的 frozen A.1 candidate，或 manifest 与 served run 使用的 bytes 不一致时停止。
- gate_parallelization_or_deferral_plan: `A.1 → A.2 → A.3 → A.4` 为产品主线；A.1 自身必须完成 auto 路线逐 fact Evidence、Artifact、Approval 重授权与最低恢复，不能推迟到 A.2。GearJob preflight 可与 A.1/A.2 并行只读调研，但只有 preflight artifact 被批准后才能进入 A.3 代码。preflight 失败时 A.3 保持 `NOT_OPEN`，A.1/A.2 可独立完成。
- First-code rule: migration-only、schema-only、provider/connector conformance-only、FakeRuntime、fixture-only 或静态 UI 都不算 A.1 可用。
- Safety rule: C0/C1 route、DocumentSnapshot authorization、Model Gateway 唯一出口、Evidence publish guard、无 FakeRuntime fallback 和无模型工具调用必须与 A.1 served UI 同门完成。

## Product/UI Acceptance Gate

- first_operable_user_flow: 运行 `pnpm dev-up`，打开默认 `/conversations/new`，不上传材料完成 `xiaowei.chat.v1` 首问、追问、停止与刷新恢复；该路径只创建 Conversation、Message、ModelInvocation 与审计，零 BusinessTask/Workflow/Evidence/Artifact。随后从同页点击可见“分析材料”，进入 `solution.analysis.v1` 后才上传或选择一份已批准 C1 测试材料，选择自动专家路线，查看固定 Workflow/hash 与 Approval subject，批准并执行；看到真实进度和结构化的事实、推断、建议、未知项，打开 Evidence 定位与报告 Artifact，刷新后恢复同一 task/result。A.3 完成后才显示或启用“查询工单”入口；未完成时显示通道未配置/不可用且不影响普通聊天或材料分析。
- browser_entrypoint: http://localhost:3200/conversations/new
- served_ui_validation_action: Playwright 使用 `page.goto("http://localhost:3200/conversations/new")` 打开真实 Vite HTTP 页面，先回归无材料 Fast Chat 和零 BusinessTask oracle，再显式点击材料入口完成 live provider 材料分析。A.3 使用独立的 GearJob served case 验证单工单只读查询，不能让其前置材料 A.1/A.2 的结论。主 HTML、JS/CSS、API、SSE、Artifact/Evidence 与结果全部来自真实服务，禁止合成主文档/bundle/API/SSE、浏览器构造成功数据或 FakeRuntime 冒充 live。
- ui_data_mode: 真实 Web、Control Plane/Postgres、Artifact storage、UDS Worker、loopback/UDS Model Gateway、`codex_subscription_dev` live provider；GearJob 路径只在 preflight 后使用真实或批准的脱敏 GearJob 测试对象与最小 read-only facade。negative tests 可使用隔离 receiver/fault harness，但必须与成功证据明确分开。
- required_safety_gates: 默认 `xiaowei.chat.v1` 无材料且零 BusinessTask、共享 `tenant_local/user_local` 信任模型、服务端资源授权、C0/C1 provider route、DocumentSnapshot provenance、prompt-injection boundary、固定 Workflow/hash、Approval 重授权、Evidence publish guard、Model/Connector Gateway 唯一出口、双 token audience、secret redaction、A1 上限、GearJob field allowlist 与四类精确 persistence/egress oracle。
- allowed_headless_only_until: A.1/A.3 的 pre-open candidate admission。签发 acceptance admission 后，必须由同一个 candidate manifest 和 immutable run lease 完成真实 served UI；served 前后不得改写候选、authority、receipt 或 credential version。
- stop_if_no_ui_by_phase: 当前 frozen A.1/A.3 candidate 的 acceptance run；不以“首个逻辑提交”作为时间或提交边界。若 declared runway 不足或 UI 使用的 manifest 不同，必须在启动任何外部 I/O 前失败。
- Served UI evidence: browser trace 之外必须有 task/workflow/approval/modelInvocation/connectorInvocation/Evidence/Artifact 的服务端关联摘要、secret-free receiver/egress/persistence oracle，以及同一 run lease/candidate/source manifest 的 digest 证明。
- Reverse guard: 默认 Composer 要求材料或创建 BusinessTask、继续运行 Gate 0.2A FakeRuntime、只改“模拟”标签、只显示静态 AI 文本、直接在浏览器请求 GearJob、或让模型猜测工单状态均不算 Gate A 交付。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-GA-PRODUCT-01 | 用户从默认页可见入口完成一份合格材料的真实 `solution.analysis.v1` served flow，并恢复同一 task、Workflow/hash、Approval、结构化结果、Evidence 和 Artifact；A.3 后可从可见入口完成单 Work Order 只读查询 | yes | live provider + real served browser + API/DB/audit correlation | goal:GA-PRODUCT |
| AC-GA-DOCUMENT-01 | 上传、扫描、隔离解析、provenance、retention、授权和 deterministic selection 通过；provider 只收到允许的 C0/C1 `untrusted_text`，C2/C3 和 prompt injection 不能扩大 route/tool/action | yes | parser corpus + malicious document + data-route/egress + snapshot locator tests | goal:GA-DOCUMENT |
| AC-GA-EVIDENCE-01 | AnalysisResult 明确区分 fact/inference/recommendation/unknown；每个 published fact 绑定 Control Plane 重取验证的 Evidence，tamper、越权、越界或 hash 漂移时 fail closed | yes | Zod contract + Evidence tamper/audience/hash + deterministic report tests | goal:GA-EVIDENCE |
| AC-GA-EXPERT-01 | auto、单专家、专家团分别解析到 immutable versions，三者具有相同权限上限并可审计；Approval 语义漂移使旧 decision 失效，客户消息作者仍只有小纬 | yes | registry/permission matrix + three-route live E2E + stale approval tests | goal:GA-EXPERT |
| AC-GA-GEARJOB-01 | 经批准 preflight 后只允许一个 Work Order、固定 endpoint/field mask 和只读方法；卡片确定性数值来自 immutable connector snapshot/Evidence，模型不能补造；所有路径满足适用的 zero-request、zero-gearjob-business-mutation、zero-geneway-business-publication 与 zero-unexpected-egress | yes | preflight verifier + contract receiver + field/permission/redirect/egress/persistence oracle + served E2E | goal:GA-GEARJOB |
| AC-GA-AUTHORITY-01 | Control Plane 是 task/workflow/approval/model/connector/evidence/artifact/event 唯一权威；刷新、重放、取消、超时、旧 fence 或进程恢复不创建第二结果或覆盖终态 | yes | transaction/CAS/idempotency/restart/replay integration tests | goal:GA-AUTHORITY |
| AC-GA-MODEL-01 | 两 Capability 只按逻辑策略经 Model Gateway 使用 `codex_subscription_dev`，复用 manifest/token/jti/fence/budget/error contract；无 credential、route detail、未脱敏 payload 或非 Gateway provider I/O | yes | live conformance + token replay/fence + receiver/process egress + secret canary | goal:GA-MODEL |
| AC-GA-SAFETY-01 | Gate A 保持 A1、固定 Workflow、无模型工具、无知识库/联网/Hatchet/动态 Workflow/生产写；共享 LAN 仍是明确的 trusted-local 非生产模式，未满足 gate 的 route 为 `NOT_OPEN` | yes | capability/status/dependency/network scan + negative policy E2E | goal:GA-SAFETY |
| AC-GA-REGRESSION-01 | Gate A0、Gate 0.2A 与 Gate 0.2B pinned closure receipts 保持有效；本 candidate 对默认 Fast Chat、legacy simulation、task/workflow/exception projection 执行 targeted compatibility regression，只有 dependency-impact trigger 命中时才运行对应 full historical gate | yes | pinned receipt/digest check + `pnpm verify:gate-a-imports` + dependency-triggered full gate | goal:GA-AUTHORITY |
| AC-GA-SLICE-01 | A.1 auto 路线自身交付分类结果、逐 fact verified Evidence、deterministic Artifact、Approval 重授权和最低恢复且结论仅 auto；A.2 才可声明三 ExpertTarget 材料分析就绪，A.3 只声明工单能力，只有 A.4 可声明 Gate A ready | yes | per-slice gate assertions + auto live E2E + A.2 three-route/negative matrix + exact conclusion scan | current-required:GATE_A_SLICE_OWNERSHIP |
| AC-GA-LIVE-COMPAT-01 | legacy 以既有三元组/event v1/FK 派生标签，live 使用 additive conditional discriminator/constraint；task/event/step/result/claim/evidence/report/Workflow 同库读回不回填或改写旧 literal/hash，互不选择、连接或重放 | yes | migration compatibility + per-relation selector/FK + dual-readback + cross-variant rejection + cursor tests | current-required:LIVE_LEGACY_PROJECTION_COMPATIBILITY |
| AC-GA-TEMPLATE-01 | legacy 与两个 live WorkflowTemplateVersion 冻结 strict canonical entry、顶层 capability/harness/schema/compiler、完整节点/边/权限 key、fixture/digest/hash；Compiler 只接受 registry selection，任意跨模板或具体资源注入均 `NOT_OPEN` | yes | checked-in independent golden fixtures + canonical digest/hash/readback + mutation/cross-template/resource negative tests | current-required:MULTI_TEMPLATE_FIXED_WORKFLOW_AUTHORITY |
| AC-GA-C2-01 | 只有 immutable DeidentificationReclassificationRecord、服务端复检和授权批准可形成新的 C1 snapshot；C3、客户端覆盖、缺失/失败/漂移/撤销全部零 provider I/O 拒绝 | yes | record/lineage/policy/role + C2 positive + C2/C3/override/revocation negative receiver tests | current-required:C2_RECLASSIFICATION_AUTHORITY |
| AC-GA-PARSER-01 | 每个 parser 的实际 bytes 与 immutable manifest 一致，并在低权限、单输入、有界输出、无凭据/挂载/网络/外链/宏/OLE/脚本/不受控子进程沙箱执行；tamper 和恶意 corpus fail closed | yes | manifest verifier + sandbox process inspection + malicious PDF/Office/zip-bomb/crash/timeout + zero DNS/TCP/secret oracle | current-required:PARSER_SUPPLY_CHAIN_SANDBOX |
| AC-GA-LOCATOR-01 | text/page EvidenceLocator 的 span 是冻结 canonical bytes 原样切片，hash 与 16 KiB 都作用于 bytes 且禁二次 normalization；Control Plane 重取后浏览器才解码，NFC/NFD、CRLF、多字节和边界可重验 | yes | Zod/JSON Schema + byte golden corpus + Unicode/cross-page/reorder/tamper/revoke + browser boundary tests | current-required:PAGED_EVIDENCE_LOCATOR |
| AC-GA-CONNECTOR-AUTH-01 | QuerySpec 在 Approval 前同事务无网络冻结；token 分别绑定稳定 effect/唯一 invocation/attempt/jti；响应 ref 单对象精确匹配，field/whole Evidence 可重取；网络前与响应 CAS 拒绝、重放、漂移均满足适用的 zero-request 或 zero-gearjob-business-mutation + zero-geneway-business-publication 且单一结果 | yes | approval/spec order + token/jti/retry concurrency + response identity + connector Evidence/tamper/revoke + receiver/DNS/egress/persistence oracle | current-required:GEARJOB_QUERY_APPROVAL_TOKEN_AUTHORITY |
| AC-GA-DEFAULT-CHAT-01 | 默认 `/conversations/new` 始终是无材料 `xiaowei.chat.v1`；首问、追问、停止与恢复只创建 Chat 对象，零 BusinessTask/Workflow/Evidence/Artifact；材料和工单仅显式入口且各自 fail closed | yes | real served Fast Chat regression + API/DB zero-task oracle + visible material/disabled GearJob navigation | current-required:DEFAULT_FAST_CHAT_PRESERVATION |
| AC-GA-RELEASE-01 | Validation-only 只通过 run-scoped admission 访问 immutable shadow candidate；pre-open 先于 served，served/recovery/stability 共用同一 lease并满足机械 runway inequality；每个 Capability 仅在自己的 fresh aggregate 后 CAS 到 internal，A.4 不重复 promotion；public/customer route 始终 NOT_OPEN | yes | per-capability state/CAS + admission expiry/runway inequality + tuple drift/renewal negative + served/aggregate/promotion correlation | goal:GA-AUTHORITY |
| AC-GA-PREFLIGHT-AUTH-01 | Strict preflight required locks 齐全、expected/observed source manifests 完全相等，具名 deployment/credential/API/data owners 对 exact candidate digest 授权，不能由 implementer/controller 自任 | yes | schema deletion/unknown/conflict negatives + source manifest equality + owner receipt verification | goal:GA-GEARJOB |
| AC-GA-CREDENTIAL-01 | GearJob credential 只对 Connector Gateway PID 可见；provider/GearJob conformance 与 release/lease 绑定 exact credentialVersionId，轮换立即令旧 receipt 在 I/O 前失效 | yes | PID namespace/environment/FD + stat/open ENOENT/EACCES + canary scan + same-path rotation oracle | goal:GA-SAFETY |
| AC-GA-ATTESTATION-01 | Implementer、reviewer、verifier、controller、signer 使用 pre-candidate 冻结的独立 actor/session/key 身份并对同一 candidate/source/command/output digests 签发不可重放 receipts；Atlas contract verdict 与 A.3 runtime receipts 使用不同 canonical 名称 | yes | actor/session/key tuple + authenticated signature/nonce/role collision + canonical namespace + fresh-DB chain verification | goal:GA-AUTHORITY |
| AC-GA-RUNTIME-ISOLATION-01 | Control Plane 等业务进程无 Docker socket/CLI/Codex artifact 读取权限；独立 pre-launch verifier 只发布受限 signed topology receipt，缺失/过期只使对应 route NOT_OPEN | yes | PID env/mountinfo/open-FD/exec scan + blocked-docker business API + missing/tampered receipt negative | goal:GA-SAFETY |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V1 | pre-open: authority + contract | `pnpm verify:gate-a-contract` | canonical Atlas v2 verdict/controller/goal_ref、contract digest、First-code/UI 字段、scope attribution 与 receipt namespaces 全合法 | Git 外 run summary |
| V2 | pre-open: exact source + quality | frozen expected source manifest；`pnpm lint && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm build` | 实测 source 与独立 expected manifest 完全相等；live/legacy schema、模板、结果、locator、card 与包边界通过 | Content-addressed source/command summary |
| V3 | pre-open: document + Evidence | `pnpm test:integration && pnpm test:storage && pnpm test:security` | parser sandbox、C2/data route、snapshot/approval、逐 fact Evidence/Lineage/Artifact、locator 与 recovery 通过 | Git 外 run summary |
| V4 | pre-open: provider + attestation | `pnpm test:model-gateway && pnpm test:gate-a-runtime` | provider schema/parser 等价、credentialVersion-bound conformance、actor receipts、stream/cancel/token/fence/secret/egress 通过 | Signed conformance/verification receipts |
| V5 | pre-open: GearJob + credential boundary | `pnpm verify:gearjob-preflight && pnpm test:connector-gateway -- --profile=gearjob-work-order-status` | Strict required locks、owners、expected/observed source、credential PID isolation、QuerySpec/response/Evidence/retry/CAS 与精确 persistence/egress oracles 通过 | Signed preflight/receiver summary；签发单轮 run lease |
| V6 | acceptance-only: served live product | `pnpm test:e2e -- --project=gate-a-live` | 同一 immutable shadow admission 上，默认 Fast Chat、真实材料三 ExpertTarget、获准单工单卡片全部来自真实服务；无成功 mock | Trace/screenshots + correlation + lease/source digests |
| V7 | acceptance-only: recovery + regression | fault/restart matrix；`pnpm verify:gate-a-imports`；dependency-impact 触发的 full historical gates | 默认 Chat 零 task、取消/迟到/重放/恢复不重复；pinned historical behavior 不退化；整个 run 不续签或换 tuple | Git 外 run summary + dependency-impact manifest |
| V8 | post-capability aggregate | `pnpm verify:gate-a` | 验证 V1–V7、两条 Capability 各自的 fresh aggregate/promotion receipt 与当前 source/authority；required skip=0；credential/lease 全程稳定；失败非零；V8 不执行第二次 promotion | Content-addressed evidence manifest、独立 verifier 结论与 run id |

原始日志、Playwright JSON、trace、视频、HAR、截图集、provider/connector receiver 记录、端口状态、API/DB dump 和调试输出写入 `/tmp/geneway-runs/<run-id>/gate-a/`；不得记录 provider auth-file、GearJob service credential、原始 C2/C3 文档、未 allowlist 工单字段或未脱敏 payload。Closure 只消费一个 Git 外、content-addressed evidence manifest：它绑定 acceptance manifest、repo/tree/source/authority/credential-version/run-lease digests、exact argv、required membership、exit code、raw artifact SHA-256 与保留期限；原始 secret-bearing bytes 可受限存放，但不得只凭可替换的 `/tmp` summary 自证通过。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| Historical pinned closure 缺失/不可验证、dependency-impact 命中或 targeted regression 失败 | 依赖该 invariant 的 Gate A route 保持 `NOT_OPEN`；只重跑受影响 full gate，不重新实施无关历史纵切，也不把模拟基线宣称为真实 | yes | goal:GA-SAFETY |
| 合格材料进入真实分析 | 创建新 live version 的 task/Workflow/Approval/ModelInvocation；旧 fixture-only version 和证据不被改写 | yes | goal:GA-PRODUCT |
| 文件 MIME/扩展不一致、含宏/脚本、密码、损坏、扫描失败或解析超时 | 摄取 fail closed，不创建可执行 DocumentSnapshot，不把原始内容传给模型 | yes | goal:GA-DOCUMENT |
| C2/C3 材料或缺少去标识/重新分类证据 | 返回 `DATA_ROUTE_NOT_ALLOWED`，零 provider 调用；不得因 trusted-local 或“测试”绕过 | yes | goal:GA-DOCUMENT |
| 材料包含“忽略系统提示/调用工具/泄露数据”等指令 | 作为 `untrusted_text` 分析，不改变 PromptPolicy、tool_choice、数据、预算、动作或 route | yes | goal:GA-DOCUMENT |
| Evidence locator 越界、hash 漂移、来源删除或当前 principal 无权 | Claim 不发布为 fact；task 明确 failed/rejected/unknown，不生成伪证据 | yes | goal:GA-EVIDENCE |
| 模型把无 Evidence 内容标成 fact | publish guard 拒绝；可降为明确 inference/unknown 需要新验证，不静默发布 | yes | goal:GA-EVIDENCE |
| ExpertTarget 在批准后被停用、版本变化或权限收窄 | 旧 ApprovalVersion 失效，执行停止并要求基于新 subject 明确复核 | yes | goal:GA-EXPERT |
| 同一任务重复提交、事件重放或 Worker reclaim | 返回同一权威对象并使用新 attempt/fence 恢复；只产生一个 terminal 结果和 Artifact | yes | goal:GA-AUTHORITY |
| GearJob preflight 缺字段，或修复超出 current execution admission 的路径/目的 | 工单 route 保持 `NOT_OPEN`；停止并请求新的独立跨仓授权，不用数据库直连或扩大 credential | yes | goal:GA-GEARJOB |
| Work Order 存在但无权与不存在 | 对浏览器的状态、body 与 metadata 等价；不泄漏客户、状态或数量 | yes | goal:GA-GEARJOB |
| GearJob 返回额外字段、重定向、跨 host 或非 GET/约定只读方法 | connector 拒绝；适用 case 分别证明 zero-request、zero-gearjob-business-mutation、zero-geneway-business-publication 与 zero-unexpected-egress | yes | goal:GA-GEARJOB |
| planQty 为零、空、负数或 completedQty 异常 | deterministic validator 不计算误导性进度；卡片显示未知/数据异常并保留 Evidence，不让模型补数 | yes | goal:GA-GEARJOB |
| provider/connector quota、timeout、崩溃或取消竞争 | Control Plane 以稳定错误终止；旧 token/fence 失效，不切账号、不 fallback FakeRuntime、不产生第二结果 | yes | goal:GA-MODEL |
| 从 192/10 的另一个设备打开或取消任务 | 按 Gate A0 共享 `tenant_local/user_local` 语义允许；内部服务、provider 与 GearJob credential 仍不暴露 | yes | goal:GA-SAFETY |
| A.1 结果含多个 fact、Evidence candidate 失败或状态说明未限定 | 每个 published fact 分别通过重取验证并绑定 Evidence；失败 candidate 只能 rejected/unknown；A.1 只能声明 auto，A.2 才能声明三 ExpertTarget，A.3 只声明工单，A.4 才声明 Gate A | yes | current-required:GATE_A_SLICE_OWNERSHIP |
| 同库同时存在 legacy fake 与 Gate A live task | legacy 由既有三元组/event v1/FK 派生标签，live 用 conditional discriminator；逐关系 parser/FK 拒绝 NULL live 或 mixed combination，不回填/改写历史，幂等 key/cursor 不跨 variant | yes | current-required:LIVE_LEGACY_PROJECTION_COMPATIBILITY |
| template/capability/harness/schema/compiler/digest 错配、fixture 自证或节点/ref/权限被替换 | Compiler 在持久化 WorkflowVersion 前拒绝并返回 `NOT_OPEN`；独立 golden expected 保持三个合法模板 hash，具体资源不进入 Workflow canonical payload | yes | current-required:MULTI_TEMPLATE_FIXED_WORKFLOW_AUTHORITY |
| C2 降级记录缺失/撤销、检测失败、hash 漂移、客户端伪造或输入为 C3 | 不创建/不选择输出 C1 snapshot，返回 `DATA_ROUTE_NOT_ALLOWED` 且 receiver 观测零 provider 调用 | yes | current-required:C2_RECLASSIFICATION_AUTHORITY |
| parser manifest/bytes 漂移，文档含外链、宏/OLE、脚本、嵌入对象或压缩炸弹 | 对应 route `NOT_OPEN` 或 task fail closed；临时目录清理，零 DNS/TCP、零 credential/宿主文件读取 | yes | current-required:PARSER_SUPPLY_CHAIN_SANDBOX |
| PDF/Office locator 混用原始 byte、二次 normalization、跨页、NFC/NFD/CRLF、多字节截断、超过 16 KiB、越界或撤权 | Control Plane 按冻结 canonical bytes 原样切片拒绝重取；浏览器返回零 excerpt/路径/相邻内容，Claim 不发布 | yes | current-required:PAGED_EVIDENCE_LOCATOR |
| QuerySpec 在批准后补填；token 跨 task/profile/spec/ref/fieldMask/attempt/effect/invocation/fence；响应 ref 缺失/不同/多对象；connector locator/hash/字段篡改；迟到响应或 redirect/跨 host | 批准前同事务冻结 spec；网络前错误满足 zero-request，响应错误满足 zero-gearjob-business-mutation + zero-geneway-business-publication，redirect/跨 host 满足 zero-unexpected-egress；同 effect 只接受一个 snapshot、卡片与终态 | yes | current-required:GEARJOB_QUERY_APPROVAL_TOKEN_AUTHORITY |
| 默认 `/conversations/new` 无材料聊天、材料入口或未开放工单入口 | 普通首问/追问/停止/恢复继续走 `xiaowei.chat.v1` 且零 BusinessTask；材料仅显式入口后要求 snapshot；工单未开放时显示不可用且不阻断前两者 | yes | current-required:DEFAULT_FAST_CHAT_PRESERVATION |
| Pre-open 未全绿却请求 served、runway 不足、lease 中途过期/续签、tuple/source/credential version 漂移 | 在外部 I/O 前拒绝或使整 run 失败；不得拼接旧子证据，release 保持 shadow，public route 保持 NOT_OPEN | yes | goal:GA-AUTHORITY |
| 非 Connector Gateway 进程可见 credential/canary，或任一业务进程可访问 Docker socket/CLI/Codex authority path | 对应 candidate 立即 NOT_OPEN；不得用源码扫描、同 UID 0600 或声明性布尔值替代 PID 级负向 oracle | yes | goal:GA-SAFETY |

## Failure And Stop Conditions

- Stop and ask the user when：需要超出 `current-execution-admission.json` 的 GearJob 路径/目的、push/PR/deploy/release、客户生产 route/credential/data、C2/C3 原文进入订阅模型、API key/其他账号、数据库直连、列表/批量工单、写操作、知识库、联网、Hatchet、动态 Workflow 或其他跨仓系统；具名 owner 无权或拒绝 exact preflight candidate；需要把 follow-up 扩成新 current scope。
- Treat the Gate as failed when：默认 Composer 要求材料或创建 BusinessTask；真实结果来自 FakeRuntime/mock；旧模拟 CapabilityVersion 被改写；模型直读 Artifact/GearJob 或执行 tool call；事实无 Evidence；C2/C3 进入 provider；GearJob 未经 strict preflight、credential/process isolation 失败、返回错对象/越权字段或违反精确 persistence/egress oracle；业务进程持有 Docker/Codex authority 权限；actor roles 冲突；source/authority/credential/lease 漂移；取消后仍 completed；成功依赖合成服务数据；`pnpm verify:gate-a` 非零。
- Required safe fallback: 保留已关闭 Gate A0 的无材料 Fast Chat 和醒目标记的 `solution.analysis.v1` 模拟版本；对应 live release 保持 `NOT_OPEN`。只有 A.1 通过时只能声明 auto 材料纵切，A.2 通过后才能声明三 ExpertTarget 材料分析；GearJob 不可用时工单入口显示“只读工单通道未配置或不可用”，不得显示猜测结果或阻断前两条能力。
- Optional fallback notes：GearJob preflight、provider conformance、parser corpus 可在隔离环境继续修复，但不能替代真实 served UI、权限、Evidence、精确 persistence/egress oracle 或 live provider 证据。

## Finding Provenance

本合同直接投影 Gate A authority brief、Gate A0 最终合同、Gate 0.2A/0.2B 已有权威边界以及“真实材料分析 + GearJob 单 Work Order 只读查询”的既定方向。历史 Team Review findings 及本次合同/authority 修复 findings 的唯一 canonical 集合，以当前 `review-verdict.json`、`controller-resolution.json` 的 exact digests 和 records 为准；自然语言数量不是第二真相源。共享 LAN 身份没有重新成为 finding；无配对、TLS、多 principal 或设备隔离门槛。本次修订不表示任何产品 slice、served run 或 aggregate 已通过；执行权限只来自 `current-execution-admission.json`，且仍不包含 push、PR、部署或客户生产。

## Completion Check

- [ ] Scope stayed inside Gate A Goal、owned paths 与 bounded GearJob execution admission
- [ ] Gate A brief、contract、controller、AGENTS、README 与 current-execution-admission share one authority revision/digest chain
- [ ] Canonical Atlas review-verdict v2、controller verdict digest、goal_ref 与 contract digest validate；A.3 private receipts use separate names
- [ ] Historical pinned closure receipts remain valid；targeted imports and dependency-triggered full regressions passed
- [ ] `A.1 → A.2 → A.3 → A.4` product line completed in order; GearJob preflight preceded A.3 code
- [ ] Required acceptance criteria and V1–V8 passed on one immutable candidate/source manifest and run lease
- [ ] Canonical controller 中本 authority revision 的全部 current-required findings 都有同一 candidate 绑定的 passed exit oracle
- [ ] A.1/A.2 ownership, live/legacy dual-track and fixed multi-template compiler gates passed
- [ ] C2 record, parser manifest/sandbox and versioned paged locator gates passed
- [ ] Default no-material Fast Chat remained usable with zero BusinessTask/Workflow/Evidence/Artifact
- [ ] ConnectorQuerySpec/Approval/effect/invocation/token/jti/response identity/connector Evidence/current-authority 与适用 zero-request/zero-gearjob-business-mutation/zero-geneway-business-publication/zero-unexpected-egress gates passed
- [ ] Real material analysis used live provider and real served UI without FakeRuntime fallback
- [ ] C0/C1 route, DocumentSnapshot provenance, prompt-injection boundary and Evidence publish guard passed
- [ ] auto、单专家、专家团和 Approval reauthorization passed with one customer-facing author: 小纬
- [ ] Strict GearJob preflight、具名 owner、expected/observed source、single-object permission、fixed field mask、Evidence、credential PID isolation 与 zero-bypass passed
- [ ] Model/Connector credentials stayed outside Git/DB/S3/log/trace/screenshot/browser/model input
- [ ] Business processes held no Docker socket/CLI or Codex authority file access；pre-launch verifier remained least privilege
- [ ] Reviewer/verifier/controller/signer roles、receipts、nonces 与 fresh-DB signature chain passed
- [ ] No admission/conformance renewal、candidate mutation or tuple replacement occurred during the accepted run
- [ ] `pnpm verify:gate-a` passed from the frozen expected source manifest；每个 Capability 的 shadow→internal 只发生在自己的 fresh aggregate 后，A.4 未重复 promotion，customer-production remained NOT_OPEN
