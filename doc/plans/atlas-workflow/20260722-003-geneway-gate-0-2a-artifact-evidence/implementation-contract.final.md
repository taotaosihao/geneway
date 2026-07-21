# geneway Gate 0.2A Artifact / Evidence 纵切最终实施合同

workflow_id: 20260722-003-geneway-gate-0-2a-artifact-evidence
task_id: 20260722-003-geneway-gate-0-2a-artifact-evidence
title: geneway Gate 0.2A 真实 Artifact / Evidence 纵切
contract_status: final
current_authoritative_contract: ./implementation-contract.final.md
created: 2026-07-22
finalized: 2026-07-22
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
safe_fallback_authority: goal:G0.2A-SAFETY
work_type: implementation
execution_authority: not_granted_by_contract_authoring
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `G0.2A-PRODUCT`：在真实 served 小纬 WebChat 中完成一个可操作纵切：上传受支持文档、形成不可变输入快照、选择 `auto`、一个专家或一个专家团、确认并运行现有固定 `solution.analysis.v1` Workflow、查看模拟结果及 Claim/Evidence/Lineage、查看并下载 Artifact；客户消息作者仍只有 `{user, xiaowei}`。
- `G0.2A-AUTHORITY`：Control Plane Postgres 是 Conversation、BusinessTask、DocumentSnapshot、Artifact metadata/manifest、Claim、Evidence、Lineage、Inbox/Outbox、Approval 和恢复状态的唯一权威；VersityGW/S3 只保存不可变对象字节，UI、Worker、Runtime 和 S3 均不得保存第二份业务权威。
- `G0.2A-EVIDENCE`：关键 Claim 必须关联可访问、hash 有效、来源可追溯的 EvidenceItem/EvidenceLink，并形成“上传对象 → DocumentSnapshot → Workflow/Runtime 输出 → Evidence → Claim → 报告 Artifact”的 Lineage；自由文本、模型断言或未来检索命中不能冒充 Evidence。
- `G0.2A-STORAGE`：使用与 Hive/Sharp Cell 同类的 S3-compatible 服务边界和 VersityGW 本地部署，不使用 MinIO；对象写入、读取、下载、重试、缺失、篡改、孤儿清理及 Postgres+S3 联合备份/恢复均有确定、fail-closed、可审计语义。
- `G0.2A-RELIABILITY`：任务执行从 Gate 0.1 的进程内 fire-and-forget 收敛为真实 Worker 投递；跨服务使用 outbox/inbox、稳定事件 ID、幂等键、lease/fencing、cursor/watermark 和 CAS。重复、乱序、断线、取消、重启及旧 attempt 不得重复推进任务或生成第二份 Claim/Artifact。
- `G0.2A-SAFETY`：上传、快照、对象读取、Evidence 和下载每次都检查 tenant、服务端 principal、resource scope、data class、audience、大小、类型、hash 和 retention；不受支持格式、内容篡改、跨租户、过期授权、审批语义漂移及未开放能力全部 fail closed。

### Non-goals

- 不支持 PDF、Word、Excel、PowerPoint、图片 OCR、压缩包、富文本 HTML 或任意格式解析；Gate 0.2A 只支持受控 UTF-8 `.txt`/`.md`。
- 不调用共享 Codex 订阅、OpenAI Agents SDK、Claude、GearJob、真实模型或真实工业 Connector；继续使用 Gate 0.1 的服务端 fake Runtime 和模拟标记。
- 不实现知识库、KnowledgeDocumentSnapshot、切块、Embedding、向量检索、Business Capability Matrix 或检索 UI。
- 不实现真实设备异常、产能落后、生产日报、异常中心、任务中心、TanStack Table 或四类真实业务入口；这些属于后续 Gate 0.2B/A/F。
- 不引入 Hatchet，不开放动态 WorkflowDraft/WorkflowPatch、条件、并行、等待、运行中改图或 TS 动态代码执行。
- 不开放 D1/W1/W2/W3 写动作，不接入飞书、企业微信、小程序、Matrix、AgentTeams、A2A 或外部 Agent。
- 不使用 MinIO，不复制 Hive/Sharp Cell 的产品代码或未审查 API；只复用其已验证的 S3 边界模式、配置方式和 VersityGW 部署经验。
- 不新建 `conversation_members`、`knowledge_*`、异常业务表或未来 Gate 的成功占位实现；未开放能力继续明确返回 `NOT_OPEN`。

### Supported upload profile

- 只接受 `multipart/form-data` 的单文件字段；扩展名只允许 `.txt`、`.md`，声明 MIME 只允许 `text/plain`、`text/markdown`，并同时进行内容检查。
- 单文件最大 `1 MiB`，必须非空、为严格有效 UTF-8；拒绝 NUL、二进制内容、目录穿越文件名、重复文件字段、额外未声明字段及内容/扩展名/MIME 冲突。
- 原始字节原样写入 S3；UI 只按转义纯文本预览，不执行 Markdown HTML、脚本、链接协议或内嵌资源。
- 对象 key 由服务端生成，形如 `tenants/{tenantId}/artifacts/{artifactId}/source.{txt|md}`；不得使用原始路径或把 tenant/principal 交给客户端决定。
- 浏览器不接收 S3 endpoint、access key、secret、直接上传 URL 或预签名下载 URL；上传和下载都必须经过 Control Plane 的授权、完整性和审计边界。

### User-visible behavior

用户在现有小纬三栏页面上传一份受支持材料。输入区显示上传状态，右侧上下文区显示文档名称、大小、类型、hash、模拟状态和不可变快照 ID。上传成功后，用户可选择 `auto`、一个专家或一个专家团，查看并确认与 Gate 0.1 相同的固定七节点 Workflow 图；审批对象必须绑定该 DocumentSnapshot、源 Artifact、content hash、resolved experts、WorkflowVersion `id + hash`、权限、预算、受众和模拟标记。

执行后，消息流继续只显示小纬，但允许展开专家步骤。结果区必须同时提供：

1. 明确的 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false` 标识；
2. 关键 Claim 的来源标记；
3. 可展开的 Evidence 抽屉，展示来源 Artifact、DocumentSnapshot、精确片段、hash、可访问范围和 Lineage；
4. Artifact 面板，可下载原始上传文件和系统生成的模拟 Markdown 报告；
5. 刷新、SSE 重连或 Worker 重启后从 Control Plane 恢复同一任务、步骤、Evidence 和 Artifact 状态。

Gate 0.2A 不声称具备通用文档分析能力。端到端正向验收使用仓库内版本固定的 `.txt` 演示材料，其 hash 注册为 `solution-analysis-demo/v2`，包含 Gate 0.1 的确定性 oracle。其他合法 `.txt`/`.md` 可以上传、形成快照和下载，但若不匹配已注册的模拟 profile，创建 `solution.analysis.v1` 任务必须返回结构化 `NOT_OPEN_FOR_SIMULATION_PROFILE`，不能凭空生成分析结论。

现有固定 Workflow 不变：

```text
document_ingest
→ requirement_extract
→ contradiction_check
→ solution_design
→ evidence_verify
→ result_quality_check
→ report_publish
```

## Prerequisite And Authority Inputs

- Gate 0.1 已在基线 commit `6be25df07527496d5e06d3caea0f0320ef2f2758` 前完成并通过 `pnpm verify:gate0.1`；Gate 0.2A 必须复用已有 Zod Workflow Schema、Compiler、canonical hash、Approval、fake Runtime、固定 Workflow、三栏小纬 UI 和安全基线，不得平行重写。
- 本文件是 Gate 0.2A 唯一可执行 scope；Gate 0.1 合同、v19 总方案、Gate 0.2 路线图、Hive/Sharp Cell 代码和历史 review 只提供背景或实现证据，冲突时不得扩大本合同。
- 技术参考优先采用 Sharp Cell 的 TypeScript S3 adapter/config/VersityGW compose 形态和 Hive 的 tenant-prefixed key/hash 行为；实现必须转写为 geneway 自有 contract，不能形成跨仓库源码依赖。
- 本合同的写入不自动授予产品代码实施、commit、push、PR、部署或发布权限；后续明确授权实施时才进入 First Code Slice。

## First Code Slice Guard

- first_code_slice: 交付最薄真实存储产品纵切：served 小纬页面上传受控演示 `.txt` → Control Plane 校验并创建 ingest intent → VersityGW 写入真实对象 → Postgres 冻结 Artifact/DocumentSnapshot/manifest → 页面显示 hash → 经授权下载并逐字节/hash 校验。
- first_code_slice_kind: product
- first_code_owner: `role:gate-0.2a-implementation-owner`；用户授权实施时必须解析为具名负责人。
- first_code_verification: `pnpm test:e2e -- --project=gate0.2a-storage-thin` 加浏览器外 API/Postgres/S3 三方 correlation；成功路径不得 mock/fulfill 上传、下载、Control Plane 或 S3 adapter。
- allowed_contract_gate_only_until: 本合同、SDD v2 authority slice 和 strict new-authoring lint 完成；获授权实施后，首个逻辑结果必须改变真实 served 产品/API/Postgres/VersityGW 行为，不能只提交 migration、adapter 单测、scanner 或文档。
- stop_if_no_code_by_phase: Gate 0.2A.1 storage vertical 首个逻辑提交
- gate_parallelization_or_deferral_plan: `0.2A.1 storage vertical → 0.2A.2 evidence/runtime vertical → 0.2A.3 delivery/recovery vertical` 串行收敛。每个内部 slice 只可声明自身 ready；只有统一 `pnpm verify:gate0.2a` 通过才可关闭产品 Gate。知识、异常、真实 Runtime、Hatchet、动态 Workflow、渠道和外部 Agent 全部后置。
- First-code rule: 允许先实现最小 S3 adapter、ingest intent 和 migration，但同一首个逻辑提交必须包含真实 served UI 上传/下载行为及其验证，不能先积累无用户价值的横向基础设施。
- Safety rule: 上传纵切必须与 tenant、principal、resource scope、大小/类型/hash、S3 凭证隔离和审计同门完成，不能先开放无保护上传再补安全。

### Internal slice map

| Slice | Base / head rule | Owned behavior | Required checks and exit oracle | Conclusion |
| --- | --- | --- | --- | --- |
| `0.2A.1 storage vertical` | base 为 authority brief 的 `base_sha`；head 为已通过独立 review 的首个产品逻辑结果 | served 上传/下载、受控 parser、S3 adapter、VersityGW compose、ingest intent、Artifact/DocumentSnapshot/manifest、审计和安全负向路径 | `pnpm test:storage && pnpm test:security && pnpm test:e2e -- --project=gate0.2a-storage-thin`；浏览器 task/input、API、DB 行和真实 S3 对象必须同 ID/hash | 只可声明 storage vertical ready |
| `0.2A.2 evidence/runtime vertical` | base 必须是已批准的 `0.2A.1` head | snapshot input union、ApprovalSubject、完整 Claim/Evidence/Lineage、fake Runtime 的 profile 限制、报告 Artifact、Evidence/Artifact UI | `pnpm test:contracts && pnpm test:integration && pnpm test:e2e -- --project=gate0.2a-evidence`；正向 oracle、无 Evidence 不发布和未注册 profile 拒绝均通过 | 只可声明 evidence vertical ready |
| `0.2A.3 delivery/recovery vertical` | base 必须是已批准的 `0.2A.2` head | 真实 Worker 投递、outbox/inbox、lease/fencing、取消、重启、孤儿对账、联合备份/恢复、最终 UI 恢复 | `pnpm test:recovery && pnpm test:e2e -- --project=gate0.2a`；故障注入不产生重复 Claim/Artifact，恢复后同 task/hash 可下载 | 只可声明 recovery vertical ready |
| `Gate 0.2A` | base 为已批准的 `0.2A.3` head；最终 head 为完整门禁通过的逻辑结果 | 不超出 authority brief owned paths 和本合同 | `pnpm verify:gate0.2a` 聚合全部真实检查，任一子项失败均非零 | 唯一允许的 Gate 通过结论 |

## Product/UI Acceptance Gate

- first_operable_user_flow: 在 `/conversations/new?capability=solution.analysis.v1` 上传版本固定演示 `.txt`，查看上传/快照状态，选择 auto/单专家/专家团，确认绑定 snapshot/hash 的固定 Workflow，批准、执行，查看模拟 Claim/Evidence/Lineage 和 Artifact，下载原文与 Markdown 报告，刷新后恢复。
- browser_entrypoint: http://localhost:3200/conversations/new?capability=solution.analysis.v1
- served_ui_validation_action: Playwright 调用 `page.goto("http://localhost:3200/conversations/new?capability=solution.analysis.v1")` 访问真实 HTTP 服务并执行上述用户流；主 HTML、JS/CSS、上传、任务、审批、SSE、Evidence 和下载 API 均由真实服务返回。浏览器生成的 task/artifact/snapshot id 必须在 API、Postgres 和 VersityGW 中核对同一对象 key、字节数和 SHA-256。
- ui_data_mode: 真实 Postgres、真实 Control Plane API、真实 VersityGW/S3、独立普通 Worker 进程、普通 Interpreter、服务端 fake Runtime、版本固定演示输入；全部分析结果清晰标记为模拟且不可用于业务决策。
- required_safety_gates: tenant/principal/resource scope、上传格式/大小/content sniff、S3 凭证隔离、对象 hash、ApprovalSubject/Version、Evidence 可访问性/publish guard、download reauthorization、outbox/inbox 幂等、worker fencing、取消、未开放 capability 拒绝、无真实 provider/connector 路由或开放出网。
- allowed_headless_only_until: `0.2A.1` 的 multipart/parser/storage contract tests 首次通过；随后同一逻辑结果必须进入 served UI 上传/下载纵切。
- stop_if_no_ui_by_phase: Gate 0.2A.1 storage vertical 首个逻辑提交
- Design continuity: 沿用 Gate 0.1 的 Codex 式三栏结构、assistant-ui + Base UI 组件语言、React Flow Workflow 图；本 Gate 只增加输入附件状态、文档卡、Evidence 抽屉和 Artifact 面板，不重做导航、任务中心或异常大盘。
- Served UI evidence: 成功路径不能使用 `page.setContent`、`route.fulfill`、Service Worker、fixture API 或等价替代；负向断网/403/409 测试可以单独拦截，但不得冒充成功路径。
- Reverse guard: UI 可见上传或下载不等于 Gate 通过；如果真实 S3、Postgres、Evidence、权限、worker/recovery 任一无法关联，必须失败。

## Data And Execution Contract

### Public input contract

任务输入从 Gate 0.1 的固定字符串演进为 Zod discriminated union；Zod 4 仍是唯一 wire schema 来源，类型由 `z.infer` 生成并导出 JSON Schema。不得增加 TypeBox/Ajv 第二套结构权威。

```ts
type TaskInputRef =
  | { kind: "fixture"; fixtureRef: "fixture:solution-analysis:v1" }
  | {
      kind: "document_snapshot";
      documentSnapshotId: string;
      artifactId: string;
      contentSha256: string;
      simulationProfile: "solution-analysis-demo/v2";
    };
```

Gate 0.1 历史 fixture 路径继续可回放；Gate 0.2A 新纵切只使用 `document_snapshot`。客户端不能声明或修改 `simulationProfile`，由服务端按已注册内容 hash 派生。

### Authoritative data changes

- 新建：`artifact_ingest_intents`、`artifacts`、`artifact_manifests`、`document_snapshots`、`claims`、`evidence_items`、`evidence_links`、`lineage_records`、`inbox_events`、`outbox_deliveries`、`audit_events`。
- Gate 0.1 的 `result_claims` 和 `minimal_evidence_refs` 通过单次 migration/backfill 转入 `claims`、`evidence_items` 和 `evidence_links`；保留原 ID、时间、task/tenant/scope、source hash 和 simulation 语义。切换后禁止双写，旧表只读兼容期结束后再由后续合同决定删除。
- `DocumentSnapshot` 只表示本 Gate 的精确内容快照，必须绑定 tenant、source Artifact/manifest、content hash、大小、media type、data class、audience、trust=`untrusted_text`、simulation profile 和创建者；不得命名或伪装为知识库快照。
- `ArtifactManifest` 至少保存 bucket、object key、version/etag（若实现可得）、size、SHA-256、media type、original display name、retention state 和 created-at；数据库不保存原始文件字节。
- `EvidenceLink` 支持 Claim↔Evidence 多对多；关键 Claim 至少有一条仍可访问且 hash 有效的 `supports` link。`LineageRecord` 必须覆盖输入 Artifact、DocumentSnapshot、WorkflowVersion、runtime output、EvidenceItem、Claim 和报告 Artifact。
- 所有新 public/wire schema 均从 Zod 导出 JSON Schema，并用正/负 fixtures 做 parity 测试；拓扑、引用、权限和跨实体语义由应用/compiler 校验，不用高级 TS 泛型冒充运行时验证。

### Upload and publish sequence

```text
authenticate + authorize + stream-validate + SHA-256
→ create immutable ingest intent/idempotency record
→ put object to server-generated S3 key
→ head/get and verify size + SHA-256
→ transactionally freeze Artifact + Manifest + DocumentSnapshot + audit + outbox
→ expose ready snapshot to UI
→ bind snapshot/hash into ApprovalSubject
→ enqueue workflow.execute.requested outbox event
→ independent Worker claims delivery and records inbox event
→ Interpreter/fake Runtime reads exact verified snapshot through Control Plane port
→ Control Plane validates Evidence/Claim/Lineage and publishes report Artifact
```

- S3 成功而 DB finalize 失败时，ingest intent 保持 `object_written/reconcile_required`；后台对账可安全完成同一 finalize 或删除确认无引用的孤儿，不得另建第二对象。
- DB intent 成功而 S3 失败时，状态为可重试失败，不能产生 ready DocumentSnapshot。相同 idempotency key+相同语义返回原状态；不同语义返回 409。
- 报告 Artifact 由平台按固定模板生成 Markdown，包含模拟标记、task/workflow/snapshot/hash、已发布 Claim 及 Evidence 引用；fake Runtime 不得自行上传文件或持有 S3 凭证。
- 下载时重新鉴权、重新解析 tenant/resource/audience 并验证对象 size/hash；缺失或不一致进入 `integrity_error`，不得返回部分或未校验字节。

### Worker delivery and cancellation

- `POST /execute` 不再在 Control Plane 进程内直接启动 Interpreter；它只在权威事务中验证 Approval/CAS 并写 `workflow.execute.requested` outbox。
- `apps/worker` 必须以独立进程运行，通过受限内部命令边界领取带 lease 的 delivery；先写稳定 `inbox_event_id` 再执行。完成/失败/进度命令均携带 task、attempt、lease/fencing token 和 idempotency key。
- Control Plane 只接受当前 attempt/token；旧 completion、重复 delivery、乱序进度和过期 lease 不推进状态。
- 取消命令是幂等 Control Plane 命令。Worker 在节点间和 publish 前检查取消；已取消任务不能发布新 Claim/Artifact。无法中断的当前 fake step 可结束，但其迟到结果必须被 fencing 拒绝。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | 真实 served 小纬页面完成“演示文档上传 → 快照 → 专家路由 → 固定 Workflow/审批 → 独立 Worker/fake Runtime → Claim/Evidence/Artifact → 双下载 → 刷新恢复”的首个可操作流程，客户作者只有 `{user, xiaowei}` | yes | Playwright served UI + API/DB/S3 correlation | goal:G0.2A-PRODUCT |
| AC-PRODUCT-02 | UI 沿用三栏结构，只新增附件/快照状态、Evidence 抽屉和 Artifact 面板；页面明确显示模拟、来源、完整性与不可用于业务决策，不出现真实模型、GearJob、知识库或真实专家误导 | yes | visual assertions + copy assertions + browser screenshot review | goal:G0.2A-PRODUCT |
| AC-AUTHORITY-01 | Postgres 是 Task、Snapshot、Artifact metadata、Claim/Evidence/Lineage、Inbox/Outbox、Approval 和恢复状态唯一权威；S3 仅保存字节，UI/Worker/Runtime 不建立第二权威 | yes | schema/ownership scan + transaction/integration tests | goal:G0.2A-AUTHORITY |
| AC-AUTHORITY-02 | `result_claims`/`minimal_evidence_refs` 一次性无损 backfill，切换后无双写；Gate 0.1 历史任务仍可读取和回放 | yes | migration up/down-policy/backfill/replay tests | goal:G0.2A-AUTHORITY |
| AC-AUTHORITY-03 | ApprovalSubject 精确绑定 DocumentSnapshot、Artifact/hash、WorkflowVersion、experts/harness、scope/audience/budget/simulation；任何字节、输入、权限或执行语义变化使旧审批失效 | yes | digest/CAS/tamper tests | goal:G0.2A-AUTHORITY |
| AC-EVIDENCE-01 | 关键 Claim 只有在至少一个可访问、hash 有效的 EvidenceItem 经 `supports` EvidenceLink 绑定后才发布；自由文本、Runtime 输出或未来 retrieval hit 不能直接发布 | yes | publish guard + negative fixtures + DB constraints | goal:G0.2A-EVIDENCE |
| AC-EVIDENCE-02 | 每个已发布 Claim 和 Markdown 报告 Artifact 都可回溯到准确的源对象、DocumentSnapshot、WorkflowVersion、runtime output、Evidence excerpt/hash 及转换版本 | yes | lineage traversal + report manifest test + UI drawer correlation | goal:G0.2A-EVIDENCE |
| AC-EVIDENCE-03 | Zod 4 是新 wire schema 单一代码来源，JSON Schema 正/负 fixtures parity 通过；production code 不增加 TypeBox/Ajv 或第二套 Workflow/Artifact validator | yes | contract parity + dependency/import scan | goal:G0.2A-EVIDENCE |
| AC-STORAGE-01 | 实际 VersityGW S3-compatible 服务完成 put/head/get/download；对象 key、size、bytes 和 SHA-256 与 Postgres manifest 一致，浏览器和 Runtime 均得不到 S3 凭证 | yes | real storage integration + secret/network scan + browser/API/DB/S3 correlation | goal:G0.2A-STORAGE |
| AC-STORAGE-02 | 上传重试、S3/DB 部分失败、孤儿对象、缺失对象和 hash 篡改均进入确定状态并可对账；不能产生两个 ready snapshot 或未校验下载 | yes | fault injection + reconciler/idempotency tests | goal:G0.2A-STORAGE |
| AC-STORAGE-03 | Postgres+S3 联合备份恢复在全新实例上重建同一 task/snapshot/claim/artifact 链并逐字节/hash 下载；缺失或错配备份必须 fail closed | yes | destructive disposable-environment backup/restore rehearsal | goal:G0.2A-STORAGE |
| AC-RELIABILITY-01 | 独立 Worker 通过 outbox/inbox、lease/fencing 和稳定 event ID 执行；重复、乱序、断线、Control Plane/Worker 重启及旧 attempt 不重复推进或生成第二份 Claim/Artifact | yes | multi-process recovery/fault-injection suite | goal:G0.2A-RELIABILITY |
| AC-RELIABILITY-02 | 用户取消是幂等权威命令；取消后迟到 progress/completion/publish 被拒绝，刷新与 SSE 重连显示同一 canceled 状态 | yes | cancel/race/reconnect Playwright + DB assertions | goal:G0.2A-RELIABILITY |
| AC-SAFETY-01 | 仅允许受控 UTF-8 `.txt`/`.md`，大小/扩展名/MIME/content sniff/文件名和输出转义全部 fail closed；Markdown/HTML 不执行 | yes | upload parser/security corpus + served UI XSS tests | goal:G0.2A-SAFETY |
| AC-SAFETY-02 | 上传、快照、Evidence、Artifact 和下载每次重新检查 tenant/principal/resource/data class/audience/授权有效期；跨租户、伪造身份、过期 capability、越权下载均不泄露元数据或字节 | yes | authorization/security negative tests | goal:G0.2A-SAFETY |
| AC-SAFETY-03 | 只有 hash 注册的演示 profile 可运行 fake `solution.analysis.v1`；其他合法文档可保存/下载但执行返回 `NOT_OPEN_FOR_SIMULATION_PROFILE`；无真实模型、GearJob、知识、Connector、Hatchet、MinIO 或外部网络执行路径 | yes | profile/registry/route/dependency/secret/network scans | goal:G0.2A-SAFETY |
| AC-GATE-01 | `pnpm verify:gate0.2a` 聚合质量、合同、storage、安全、integration、recovery、served UI 和备份恢复；任何检查失败时非零，未开放 Gate 不得假通过 | yes | aggregate script contract + exit-code tests | goal:G0.2A-AUTHORITY |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V-1 | SDD authority 与合同 | `codex-team-validate-json --type brief ...`；`codex-implementation-contract-lint --strict --new-authoring --authority-slice ...` | task id、Goal refs、semantics v2、owned paths 和 authority slice 一致 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-contract.txt` |
| V-2 | 基础质量 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | 全部退出 0，Gate 0.1 回归不退化 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-quality-summary.md` |
| V-3 | Schema、migration、authority | `pnpm test:contracts && pnpm test:integration` | Zod/JSON Schema parity、input union、backfill、ApprovalSubject、Claim/Evidence/Lineage 与单权威通过 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-authority-summary.md` |
| V-4 | 真实对象存储 | `pnpm test:storage`，连接本 Gate compose 启动的实际 VersityGW，禁止 S3 client mock | put/head/get、字节/hash、重复、部分失败、孤儿、缺失、篡改和下载全部符合合同 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-storage-summary.md` |
| V-5 | 安全 | `pnpm test:security` | 上传 corpus、XSS、跨租户、伪造 principal、过期授权、越权 Evidence/下载、secret/network/registry 负向路径通过 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-safety-summary.md` |
| V-6 | 投递与恢复 | `pnpm test:recovery`，在 disposable 环境对 Control Plane、Worker、Postgres 和 VersityGW 做阶段性 kill/restart、重复与乱序注入 | 同一 task 只形成一套 current states/claims/artifacts；取消与 stale completion 被拒绝；cursor 可续传 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-recovery-summary.md` |
| V-7 | Served UI | `pnpm test:e2e -- --project=gate0.2a` | 真实页面完成全纵切；成功路径无网络 fulfill；UI task/snapshot/artifact/hash 与 API/Postgres/S3 一致，刷新恢复 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-ui-summary.md` |
| V-8 | 联合备份恢复 | 在 disposable 源环境创建已完成任务与双 Artifact，导出 Postgres 和 S3 备份，销毁源服务，在全新目标环境恢复并执行一致性扫描与下载 | 恢复后 id/hash/bytes/lineage 一致；删改任一对象或 manifest 时 scanner 非零且下载 fail closed | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-backup-restore-summary.md` |
| V-9 | 总门禁 | `pnpm verify:gate0.2a` | V-2 至 V-8 任一失败均非零；全部通过且 Gate 0.1 回归通过才返回 0 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-phase-review.md` |

## Evidence Budget

- Git 只在 `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/` 保存最终 `gate-checklist.md`、`phase-review.md`、`evidence-index.md` 和 V-1 至 V-8 的小型摘要，目标不超过 12 个文件和 1.5 MB；不得创建平行 evidence 目录。
- Playwright trace/video/HAR、上传 corpus、完整日志、S3 对象副本、数据库 dump、联合备份、容器卷、故障注入输出写入 `/tmp/geneway-runs/<run-id>/`，不得提交 Git。
- 截图只能证明 UI 呈现；不能替代 API/Postgres/S3、权限、hash、worker、恢复或备份证据。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| 空文件、超 1 MiB、非法 UTF-8、NUL/二进制、扩展名/MIME/content 冲突、多个文件字段或目录穿越文件名 | 上传前/流式处理中拒绝，不创建 ready snapshot，不回显危险内容 | yes | goal:G0.2A-SAFETY |
| `.md` 含 HTML、script、javascript URL、远程图片或提示注入文本 | 只作为 `untrusted_text` 转义显示；不执行、不抓取、不提升权限，也不能单独决定 D1+ 参数 | yes | goal:G0.2A-SAFETY |
| 相同 idempotency key 重试 | 同语义返回原 intent/snapshot/artifact；不同 bytes/hash 或 metadata 返回 409，不覆盖原对象 | yes | goal:G0.2A-STORAGE |
| S3 put 后 DB finalize 前崩溃 | 对账同一 intent/key/hash 后原子 finalize 或安全删除无引用孤儿；不创建第二对象/快照 | yes | goal:G0.2A-STORAGE |
| DB intent 后 S3 不可用、对象丢失、size/hash/etag 不符 | 状态保持 failed/reconcile_required/integrity_error；不能批准、执行、发布或下载 | yes | goal:G0.2A-STORAGE |
| 合法文档未匹配注册的演示 profile | 可形成受控 Artifact/DocumentSnapshot 并下载；`solution.analysis.v1` 任务创建明确返回 `NOT_OPEN_FOR_SIMULATION_PROFILE`，不伪造结论 | yes | goal:G0.2A-SAFETY |
| 批准后源对象、snapshot/hash、Workflow、专家、权限、预算或受众变化 | 旧 ApprovalVersion 失效；不可在原版本上修改，必须创建新输入/审批版本 | yes | goal:G0.2A-AUTHORITY |
| Evidence excerpt 不属于被冻结 snapshot、hash 不符、已超 retention 或当前用户不可访问 | EvidenceLink 无效，关键 Claim 和报告 Artifact 不发布；UI 不泄露片段 | yes | goal:G0.2A-EVIDENCE |
| 重复/乱序 outbox、Worker 崩溃、lease 过期、旧 attempt completion | inbox 去重和 fencing 拒绝重复/迟到推进；恢复后只继续当前 attempt | yes | goal:G0.2A-RELIABILITY |
| 用户取消与 report publish 并发 | Control Plane CAS 决定唯一终态；cancel 获胜时迟到 Claim/Artifact 不发布，publish 已提交时取消返回明确不可撤销结果 | yes | goal:G0.2A-RELIABILITY |
| SSE 在快照与订阅交界断开或浏览器刷新 | 使用权威 watermark/cursor 续传并按稳定 event ID 去重；不丢、不重复显示进度或 Artifact | yes | goal:G0.2A-RELIABILITY |
| 跨租户猜测 artifact/snapshot ID、伪造 principal、过期 capability 或群体 audience 不满足 | 返回不泄露存在性的 404/403 策略结果，不返回 metadata、hash、excerpt 或对象字节 | yes | goal:G0.2A-SAFETY |
| Postgres 备份可恢复但 S3 对象缺失，或 S3 对象存在但 manifest/lineage 缺失 | 联合恢复验收失败；对象/业务链标记不可用，不能把部分恢复冒充成功 | yes | goal:G0.2A-STORAGE |

## Implementation Notes

- S3 contract 应保持小而可替换：`ensureBucket`、`putObject`、`headObject`、`getObject`/stream、`deleteObject`（仅对账和 retention 使用）及 URI/key 解析；应用层不依赖 AWS SDK 具体类型。
- 本地 compose 参考 Sharp Cell 的 VersityGW POSIX backend，使用独立 data/versioning/IAM 持久卷；服务端启用 path-style endpoint。生产部署参数只经配置注入，secret 不写日志、不进入浏览器、不进入 fake Runtime。
- 真实 S3 删除是受控补偿，不是用户业务能力；只有已证明无引用的孤儿或 retention 到期对象才能由对账器执行，且必须审计。
- 报告 Artifact 是本 Gate 固定模板的模拟交付物，不等于真实报告 Agent。文件名、MIME、hash、lineage 和下载权限必须与原始 Artifact 使用同一 contract。
- Gate 0.2A 不建立复杂 UI 表格。Evidence 适合抽屉/详情区，Artifact 使用轻量列表；后续任务中心如确有二维数据再按独立合同选择轻量 table。
- 可以复用 Gate 0.1 代码和经审查的 Sharp Cell/Hive 设计模式；不得为“统一架构”重写已通过的 Workflow、Approval、授权、UI shell 或 Runtime。

## Failure And Stop Conditions

- 如果实现需要 PDF/Office/OCR/压缩包解析、知识索引/检索、真实模型、共享 Codex、GearJob、异常中心、Hatchet、动态 Workflow、渠道、A2A、外部 Agent 或制造业写操作，停止并返回范围决策，不在 Gate 0.2A 内吸收。
- 如果必须使用 MinIO、让浏览器/Runtime持有 S3 凭证、绕过 Control Plane 下载，或让 S3 metadata 成为业务权威，停止实施。
- 如果只能以浏览器 fulfill、S3 mock、进程内 fake queue、静态截图或数据库 seed 冒充成功路径，Gate 0.2A 失败。
- 如果 S3 与 DB 部分失败没有确定恢复状态，Evidence/Lineage 无法回溯，或无 Evidence Claim 仍可发布，Gate 0.2A 失败。
- 如果独立 Worker 重启、重复 delivery、取消竞态或旧 attempt 能重复推进、生成第二份 Claim/Artifact，Gate 0.2A 失败。
- 如果 Postgres 与 S3 不能在全新环境联合恢复并逐字节/hash 验证，不能宣称 Gate 0.2A 完成。
- Required safe fallback: 当对象存储可用性或完整性无法证明时，保留 Control Plane 权威 metadata、错误和恢复状态；阻止批准、执行、发布和下载，UI 显示可恢复的“对象不可用/完整性异常”，不得退回本地磁盘、返回未校验字节或伪造成功。

## Provenance

- 权威 SDD slice：`/home/gewu/.codex/workflow/artifacts/20260722-003-geneway-gate-0-2a-artifact-evidence/team/sdd/slices/gate-0-2a-artifact-evidence/brief.md` 与 `brief.json`。
- Gate 0.1 已验证代码基线：commit `6be25df07527496d5e06d3caea0f0320ef2f2758`；Gate 0.1 最终合同：[`../20260720-010-geneway-gate-0-1/implementation-contract.final.md`](../20260720-010-geneway-gate-0-1/implementation-contract.final.md)。实际实施起点以 authority brief 的 `base_sha` 为准。
- 只读整理输入：`/home/gewu/.codex/workflow/artifacts/20260722-002-geneway/analysis.md`；只用于发现 Gate 0.2A 边界，不获得独立实施权限。
- 长期产品方向：[`../../../reference/制造业数字员工平台_内部能力内核细节终审与兼容实施方案_v19.md`](../../../reference/制造业数字员工平台_内部能力内核细节终审与兼容实施方案_v19.md)。
- Sharp Cell 参考：`/home/gewu/work/sharp-cell/apps/fms-api/src/modules/object-storage/`、`/home/gewu/work/sharp-cell/docker-compose.yml`、`/home/gewu/work/sharp-cell/docs/atlas-workflow/20260623-023-local-oss-versitygw.md`。
- Hive 参考：`/home/gewu/work/hive/backend/app/services/object_storage.py` 及其 tests；仅借鉴 tenant key/hash/S3 行为，不直接复制或假定其当前 API 完全一致。

## Finding Provenance

本合同的 Required 条目均绑定 `G0.2A-*` authority refs。历史会话、路线图、review 或参考仓库只能用于解释和验证，不得把后续能力、review 严重级别或实现偏好自动升级为本 Gate scope。实施 reviewer 可发现任意问题，但只自动修复阻断本 Gate、由本 Gate 引入的回归或安全/数据/权限问题；其他建议记录为后续项。

## Final Contract Cleanliness Gate

- [x] 本文件是 Gate 0.2A 唯一最终实施合同，不创建平行 README/spec/clarify/contract-index 来重复 scope。
- [x] 每个 Required acceptance criterion 与 edge case 均绑定 authority Goal ref。
- [x] 首个代码切片是可操作 served 存储纵切，不是横向基础设施或证据工程。
- [x] 真实验收必须关联 browser、API、Postgres、VersityGW 和独立 Worker，不以 mock、截图或组件存在代替。
- [x] Gate 0.1 固定 Workflow/fake Runtime/UI/授权可复用，真实模型、知识、异常、Hatchet、动态 Workflow、渠道和外部 Agent均未提前获得权限。
- [x] S3 明确使用 VersityGW-compatible boundary，不使用 MinIO；Hive/Sharp Cell 只作参考，不形成第二产品代码基地。
- [x] 原始 trace、视频、dump、备份和对象副本默认留在 Git 之外。
