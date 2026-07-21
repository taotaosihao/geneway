# geneway Gate 0.2A Artifact / Evidence 纵切最终实施合同

workflow_id: 20260722-003-geneway-gate-0-2a-artifact-evidence
task_id: 20260722-003-geneway-gate-0-2a-artifact-evidence
title: geneway Gate 0.2A 真实 Artifact / Evidence 纵切
contract_status: final
current_authoritative_contract: ./implementation-contract.final.md
created: 2026-07-22
finalized: 2026-07-22
team_reviewed: 2026-07-22
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
- `G0.2A-EVIDENCE`：本 Gate 所有 `published` Claim 都必须关联可访问、hash 有效、来源可追溯的 EvidenceItem/EvidenceLink，并形成“上传对象 → DocumentSnapshot → Workflow/Runtime 输出 → Evidence → Claim → 报告 Artifact”的 Lineage；自由文本、模型断言或未来检索命中不能冒充 Evidence。
- `G0.2A-STORAGE`：使用与 Hive/Sharp Cell 同类的 S3-compatible 服务边界和 VersityGW 本地部署，不使用 MinIO；对象写入、读取、下载、重试、缺失、篡改、孤儿清理及 Postgres+S3 联合备份/恢复均有确定、fail-closed、可审计语义。
- `G0.2A-RELIABILITY`：任务执行从 Gate 0.1 的进程内 fire-and-forget 收敛为真实 Worker 投递；跨服务使用 outbox/inbox、稳定事件 ID、幂等键、lease/fencing、cursor/watermark 和 CAS。重复、乱序、断线、取消、重启及旧 attempt 不得重复推进任务或生成第二份 Claim/Artifact。
- `G0.2A-SAFETY`：上传、快照、对象读取、Evidence 和下载每次都检查 tenant、服务端 principal、resource scope、data class、audience、大小、类型、hash 和 retention；不受支持格式、内容篡改、跨租户、过期授权、审批语义漂移及未开放能力全部 fail closed。

### Non-goals

- 不支持 PDF、Word、Excel、PowerPoint、图片 OCR、压缩包、富文本 HTML 或任意格式解析；Gate 0.2A 只支持受控 UTF-8 `.txt`/`.md`。
- 产品运行与产品验收路径不调用共享 Codex 订阅、OpenAI Agents SDK、Claude、GearJob、真实模型或真实工业 Connector；继续使用 Gate 0.1 的服务端 fake Runtime 和模拟标记。开发阶段受控使用 Kimi Code CLI 的例外只受下文 `Kimi frontend implementation lane` 约束，不进入产品部署、产品数据流或 Gate 成功证据。
- 不实现知识库、KnowledgeDocumentSnapshot、切块、Embedding、向量检索、Business Capability Matrix 或检索 UI。
- 不实现真实设备异常、产能落后、生产日报、异常中心、任务中心、TanStack Table 或四类真实业务入口；这些属于后续 Gate 0.2B/A/F。
- 不引入 Hatchet，不开放动态 WorkflowDraft/WorkflowPatch、条件、并行、等待、运行中改图或 TS 动态代码执行。
- 不开放 D1/W1/W2/W3 写动作，不接入飞书、企业微信、小程序、Matrix、AgentTeams、A2A 或外部 Agent。
- 不使用 MinIO，不复制 Hive/Sharp Cell 的产品代码或未审查 API；只复用其已验证的 S3 边界模式、配置方式和 VersityGW 部署经验。
- 不新建 `conversation_members`、`knowledge_*`、异常业务表或未来 Gate 的成功占位实现；未开放能力继续明确返回 `NOT_OPEN`。

### Supported upload profile

- 上传前先由 Control Plane 创建 `private-conversation`；上传入口固定为 `POST /api/conversations/:conversationId/uploads`。multipart body 只允许字段名 `file`，`files=1`、`fields=0`、`parts=1`，不接受客户端 tenant、principal、scope、data class、audience、retention 或 profile 字段。
- 扩展名与声明 MIME 必须严格配对：`.txt ↔ text/plain`、`.md ↔ text/markdown`。内容检查只验证共同的安全文本 predicate，不声称从文本内容区分 txt/md。
- 原始文件字节上限为 `1_048_576`，包含该边界；整个请求 envelope 上限为 `1_114_112`。不信任 `Content-Length`，第 `1_048_577` 个文件字节到达时立即终止读取/写入并进入拒绝或对账状态。
- 文件必须非空、为无 BOM 的严格 UTF-8；增量 decoder 必须识别跨 chunk 非法序列。拒绝 NUL、除 TAB/LF/CR 外的控制字符、已知非文本 magic、重复文件、额外字段、超限 header、目录穿越、控制/Bidi 文件名及扩展名/MIME 冲突；安全 display name 最长 120 个 Unicode scalar。
- 原始字节原样写入 S3，不做换行或 Unicode 规范化；UI 对 display name、预览、Evidence、Claim、报告内容和错误文本一律按转义纯文本处理，不执行 Markdown HTML、脚本、链接协议或内嵌资源。
- 对象 key 由服务端生成，形如 `tenants/{tenantId}/artifacts/{artifactId}/source.{txt|md}`；不得使用原始路径或把 tenant/principal 交给客户端决定。
- 浏览器不接收 S3 endpoint、access key、secret、直接上传 URL 或预签名下载 URL；上传和下载都必须经过 Control Plane 的授权、完整性和审计边界。

### User-visible behavior

用户进入现有小纬三栏页面时，服务端先创建 private Conversation，再在该 Conversation 中上传一份受支持材料。输入区显示上传状态，右侧上下文区显示安全 display name、大小、类型、hash、模拟执行资格和不可变快照 ID。上传成功且匹配已注册 profile 后，用户可选择 `auto`、一个专家或一个专家团，查看并确认与 Gate 0.1 相同的固定七节点 Workflow 图；审批对象必须绑定服务端解析后的 DocumentSnapshot、源 Artifact、content hash、profile registry version、resolved experts、WorkflowVersion `id + hash`、权限、预算、受众和模拟标记。

执行后，消息流继续只显示小纬，但允许展开模拟 Workflow 步骤和所选路由元数据；三种路由共享同一固定 fake oracle，不表示真实专家被调用。queued/running 状态提供“取消模拟任务”按钮，终态禁用；取消和刷新后状态都从 Control Plane 恢复。结果区必须同时提供：

1. 明确的 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false` 标识；
2. 每个 `published` Claim 的来源标记；
3. 可展开的 Evidence 抽屉，展示来源 Artifact、DocumentSnapshot、精确片段、hash、可访问范围和 Lineage；
4. Artifact 面板，可下载原始上传文件和系统生成的模拟 Markdown 报告；
5. 刷新、SSE 重连或 Worker 重启后从 Control Plane 恢复同一任务、步骤、Evidence 和 Artifact 状态。

Gate 0.2A 不声称具备通用文档分析能力。端到端正向验收使用待实现于 `scripts/fixtures/gate0.2a/solution-analysis-demo-v2.txt` 的固定 180-byte UTF-8 文件，原始 SHA-256 为 `3b5ee113e79ab2afb504898cf962da10f7d31e62ddb89370e645c2d32f48ca06`，profile 为 `solution-analysis-demo/v2`，registry version 为 `gate0.2a-profile-registry/1`。文件原始内容必须逐字节等于：

```text
客户需要建设制造执行方案。
系统需支持生产工单全过程跟踪，并对质量检验批次提供可追溯记录。
本演示材料不要求直接控制设备。
```

正向 Claim 仍为“当前材料明确要求生产工单跟踪和质量追溯”；Evidence 定位原始 byte `[40,133)`，片段 SHA-256 为 `0230bc572ef7f3770a19727a8e9125cb30e9bdfd670c54c75ae6d4de8963b82f`。报告模板固定为 `scripts/fixtures/gate0.2a/report-template-v1.md`、`templateId=gate0.2a-report/v1`，模板源 326 bytes、SHA-256 `3253cfb9b6e8d85d0c47a12a510c66f49c4f80b953004877c1d9cce8af9e2044`，原文为：

```text
# 小纬方案分析（模拟）

- 任务：{{taskId}}
- Workflow：{{workflowVersionId}} / {{workflowHash}}
- 输入：{{documentSnapshotId}} / {{contentSha256}}
- 结论：{{claimText}}
- 来源：bytes {{startByte}}..{{endByteExclusive}} / {{excerptSha256}}

simulation=true
runtimeMode=fake
businessDecisionAllowed=false
```

变量使用固定 UTF-8 文本替换、LF 换行和末尾单个 LF。报告确定性以完整且不可变的 `ReportRenderInput` 为输入，至少绑定 `templateId/templateSha256`、`taskId`、`workflowVersionId/workflowHash`、`documentSnapshotId/contentSha256`、`claimText`、`startByte/endByteExclusive/excerptSha256`；同一 `ReportRenderInput` 必须产生逐字节相同的报告。测试中的期望 literal 不能从生产 registry/runtime import。

其他合法 `.txt`/`.md` 可以上传、形成快照和授权下载，但 `simulationProfile=null`，页面显示“仅存储，当前模拟分析不可运行”并禁用创建任务；绕过 UI 调用时返回结构化 `NOT_OPEN_FOR_SIMULATION_PROFILE`，且不写 execute outbox、不启动 Worker、不产生业务结果。

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
- frontend_implementation_executor_preference: `Kimi Code CLI`；在 `role:gate-0.2a-implementation-owner` 负责的 First Code Slice 内优先承担受控前端实现 lane。Kimi 不是 slice owner，不能独立提交、合并或宣布 ready；主控制器负责冻结交接契约、整合前后端、独立验证并形成唯一逻辑提交。
- frontend_implementation_executor_fallback: 每次 Kimi-eligible frontend dispatch 都必须真实尝试并记录 Kimi lane；成功结果只有依次完成预检、隔离执行、candidate patch、patch admission、真实工作树应用和独立验证后才可接受。任一失败只需先写入 receipt 即可由主控制器接管，不要求不存在的后续阶段；不得用口头“不可用/无可用 diff”静默替换执行器，也不得把 Codex 修复后的结果记成纯 Kimi 产出。
- allowed_contract_gate_only_until: 本合同、SDD v2 authority slice 和 strict new-authoring lint 完成；获授权实施后，首个逻辑结果必须改变真实 served 产品/API/Postgres/VersityGW 行为，不能只提交 migration、adapter 单测、scanner 或文档。
- stop_if_no_code_by_phase: Gate 0.2A.1 storage vertical 首个逻辑提交
- gate_parallelization_or_deferral_plan: `0.2A.1 storage vertical → 0.2A.2 delivery/evidence vertical → 0.2A.3 recovery hardening` 串行收敛。每个内部 slice 只可声明自身 ready；只有统一 `pnpm verify:gate0.2a` 通过才可关闭产品 Gate。知识、异常、真实 Runtime、Hatchet、动态 Workflow、渠道和外部 Agent 全部后置。
- First-code rule: 允许先实现最小 S3 adapter、ingest intent 和 migration，但同一首个逻辑提交必须包含真实 served UI 上传/下载行为及其验证，不能先积累无用户价值的横向基础设施。
- Safety rule: 上传纵切必须与 tenant、principal、resource scope、大小/类型/hash、S3 凭证隔离和审计同门完成，不能先开放无保护上传再补安全。

### Kimi frontend implementation lane

- **交接先于编码**：主控制器在 dispatch 中固定前端交接包，引用已落地的 Zod public wire schema、endpoint、状态/错误矩阵及稳定 UI selector。Kimi 只能消费这些权威输入，不得在 Web 层平行定义 schema、伪造 API 或自行放宽错误语义；发现缺口时返回 `dependency_request`，由对应所有者修订后重新派发。
- **逐任务最小写权限**：每次 dispatch 生成精确的 tracked-file allowlist；默认只允许 `apps/web/src/**`、`packages/ui/src/**` 及同目录非权威 unit/component/interaction tests。package manifest、lockfile、构建配置、CI、根脚本、API/contracts/DB/storage/authorization/Worker/Runtime、合同、Evidence、固定 fixture/hash/profile oracle、Playwright project/config、`gate0.2a-success`/`gate0.2a-negative`、真实性扫描和 `verify:gate0.2a` 均不归 Kimi；所需修改只能提案给主控制器或独立 validation owner。
- **隔离运行**：Kimi 只在从已批准 base SHA 生成的干净、可丢弃、去密 workspace 中运行；workspace 不含 untracked/ignored 文件、客户材料、运行产物或其他仓库，`.git` 不可写，不挂载 Docker socket、SSH agent、Kube config、S3/DB 数据卷或 `/tmp/geneway-runs`。环境变量使用 allowlist，只保留 Kimi provider 所需项；网络只允许已批准 provider endpoint 和必要 loopback。无法机械满足文件、进程或出网边界时，本 lane 预检失败并由主控制器接管，不能把提示词或 hook 冒充隔离。
- **调用模式**：dispatch 前冻结 expected CLI version/digest 及批准的 provider/model alias；每次运行记录并 exact-match `command -v kimi`、`kimi --version`、可执行文件/package digest 和 `kimi doctor`，版本或 digest 漂移为 `unreviewed_version`，provider/model 不匹配为 `preflight_failed`。`doctor` 只证明配置可解析，不证明 provider/model 可用。始终只允许 fresh interactive manual-permission session，由主控制器逐项批准写文件和 Shell；无论是否存在 sandbox，都禁止 `-p/--prompt`、`--auto`、`-y/--yolo` 及别名、`--session`、`--continue`、`--add-dir`、server/web/acp/export、provider/login、upgrade/update，以及 stage/commit/branch/push/reset/clean、安装依赖和任何外部系统变更。sandbox 是第二层强制边界，不得扩大权限；自动发现的 skill/hook 也不得充当权限边界，只能使用本次明确审查的隔离配置。
- **开发数据出域**：运行记录固定 provider、model alias、endpoint/region、base SHA、read/write scope、egress policy 和调用模式，但不记录 secret。只允许向 Kimi 提供 allowlist 内已跟踪源码、权威交接包的必要摘录及合同明确的合成 fixture；禁止客户/tenant 数据、实际上传物、Artifact/Evidence 内容、`.env*`、日志、trace、HAR、dump、备份、截图、用户目录或其他仓库内容。session/log 放在 Git 外隔离目录，禁止 export、分享或作为产品 Gate Evidence。
- **patch admission 与独立验收**：Kimi 结束后主控制器确认 base/HEAD 未变、index 未暂存、全部 tracked/untracked/ignored 变化均在 allowlist，且无新依赖、lockfile/postinstall、CDN/远程资源、telemetry、生产外部 URL、symlink、binary、executable bit 或禁止的 Git/外部动作；随后生成 patch SHA。任何越界都使整个 lane 失败，不能只丢弃越界部分后接受其余改动。只有通过 admission 的 patch 才可由主控制器应用到真实工作树，并在干净依赖环境独立运行 diff/secret/dependency/remote-URL scan、UI typecheck/build/tests 和合同既定 served UI 真实性验收；Kimi 不拥有 Gate oracle。
- **可判定结果与接管**：Git 外小型 `frontend-executor.json` receipt 至少记录 requested/actual/repair executor、base SHA、expected/actual CLI version/digest、provider/model alias、调用模式、allowlist、changed paths、patch SHA、验证结果、outcome 和 fallback reason，不保存 prompt、session 或 secret。执行成功产生 candidate patch 时直接进入 admission，不提前赋予最终 outcome；最终 outcome 仅为 `accepted | preflight_failed | unreviewed_version | execution_failed | timeout | interrupted | dependency_blocked | scope_violation | no_effective_diff | validation_failed`。`preflight_failed | unreviewed_version | execution_failed | timeout | interrupted | dependency_blocked` 在 receipt 落盘后即可接管，其中 `dependency_blocked` 必须先补齐交接包再重新 dispatch；`scope_violation | no_effective_diff | validation_failed` 是候选结果拒绝/修复而非执行后端不可用，只有 admission 与独立验证均通过才记为 `accepted`。实际版本和 doctor 结果属于当次 receipt，不固化为合同事实。

### Internal slice map

| Slice | Base / head rule | Owned behavior | Required checks and exit oracle | Conclusion |
| --- | --- | --- | --- | --- |
| `0.2A.1 storage vertical` | base 为 authority brief 的 `base_sha`；head 为已通过独立 review 的首个产品逻辑结果 | private Conversation、served 上传/下载、受控 parser、S3 adapter、VersityGW compose、ingest intent、Artifact/DocumentSnapshot/manifest、审计和安全负向路径；本 slice 不创建 BusinessTask | `pnpm test:storage && pnpm test:security && pnpm test:e2e -- --project=gate0.2a-storage-thin`；浏览器 Artifact/DocumentSnapshot、API、DB 行和真实 S3 对象必须同 ID/hash | 只可声明 storage vertical ready |
| `0.2A.2 delivery/evidence vertical` | base 必须是已批准的 `0.2A.1` head | public/resolved snapshot input、ApprovalSubject、最小 execute outbox→独立 Worker→inbox 投递、attempt candidate、完整 Claim/Evidence/Lineage、profile 限制、报告 Artifact、Evidence/Artifact UI；本 slice 必须删除 Control Plane fire-and-forget | `pnpm test:contracts && pnpm test:integration && pnpm test:e2e -- --project=gate0.2a-evidence`；同一 UI task 关联真实 Worker，正向 oracle、无 Evidence 不发布和未注册 profile 拒绝均通过 | 只可声明 delivery/evidence vertical ready |
| `0.2A.3 recovery hardening` | base 必须是已批准的 `0.2A.2` head | delivery/step lease、fencing/reclaim、取消竞态、重复/乱序/断线、进程重启、孤儿双向对账、联合备份/恢复和最终 UI 恢复 | `pnpm test:recovery && pnpm test:backup-restore && pnpm test:e2e -- --project=gate0.2a`；故障注入不产生重复 Claim/Artifact，恢复后同 task/hash 可下载 | 只可声明 recovery hardening ready |
| `Gate 0.2A` | base 为已批准的 `0.2A.3` head；最终 head 为完整门禁通过的逻辑结果 | 不超出 authority brief owned paths 和本合同 | `pnpm verify:gate0.2a` 聚合全部真实检查，任一子项失败均非零 | 唯一允许的 Gate 通过结论 |

## Product/UI Acceptance Gate

- first_operable_user_flow: 在 `/conversations/new?capability=solution.analysis.v1` 创建 private Conversation，上传版本固定演示 `.txt`，查看上传/快照/执行资格，选择 auto/单专家/专家团，确认绑定 snapshot/hash 的固定 Workflow，批准并执行。happy-path task 必须完成模拟 Workflow 步骤、Claim/Evidence/Lineage、原文与 Markdown 报告双下载及刷新恢复；同一 served UI project 另创建 cancellation task，在 queued/running 取消并验证刷新后仍为 canceled、无 published Claim/报告 Artifact。
- browser_entrypoint: http://localhost:3200/conversations/new?capability=solution.analysis.v1
- served_ui_validation_action: Playwright 调用 `page.goto("http://localhost:3200/conversations/new?capability=solution.analysis.v1")` 访问真实 HTTP 服务并执行上述用户流；主 HTML、JS/CSS、上传、任务、审批、SSE、Evidence 和下载 API 均由真实服务返回。浏览器生成的同一 task/artifact/snapshot id 必须在 API、Postgres、VersityGW、outbox/inbox、execution attempt/fence 和独立 worker instance 中核对同一对象、字节数和 SHA-256。
- ui_data_mode: 真实 Postgres、真实 Control Plane API、真实 VersityGW/S3、独立普通 Worker 进程、普通 Interpreter、服务端 fake Runtime、版本固定演示输入；全部分析结果清晰标记为模拟且不可用于业务决策。
- required_safety_gates: tenant/principal/resource scope、上传格式/大小/content sniff、S3 凭证隔离、对象 hash、ApprovalSubject/Version、Evidence 可访问性/publish guard、download reauthorization、outbox/inbox 幂等、worker fencing、取消、未开放 capability 拒绝、无真实 provider/connector 路由或开放出网。
- allowed_headless_only_until: `0.2A.1` 的 multipart/parser/storage contract tests 首次通过；随后同一逻辑结果必须进入 served UI 上传/下载纵切。
- stop_if_no_ui_by_phase: Gate 0.2A.1 storage vertical 首个逻辑提交
- Design continuity: 沿用 Gate 0.1 的 Codex 式三栏结构、assistant-ui + Base UI 组件语言、React Flow Workflow 图；本 Gate 只增加输入附件状态、文档卡、Evidence 抽屉和 Artifact 面板，不重做导航、任务中心或异常大盘。
- Served UI evidence: `gate0.2a-success` project 及其本地 import closure 禁止 `page.setContent`、`route.fulfill`、`page.route`、Service Worker、fixture API 或等价替代；负向断网/403/409 只放入独立 `gate0.2a-negative` project 的显式白名单 spec，不能贡献成功路径结论。`pnpm verify:gate0.2a` 必须同时运行两者并验证项目边界。
- Reverse guard: UI 可见上传或下载不等于 Gate 通过；如果真实 S3、Postgres、Evidence、权限、worker/recovery 任一无法关联，必须失败。

## Data And Execution Contract

### Public input contract

客户端命令与服务端 resolved input 必须分离；Zod 4 仍是唯一 wire schema 来源，类型由 `z.infer` 生成并导出 JSON Schema。不得增加 TypeBox/Ajv 第二套结构权威。

```ts
type CreateTaskInputRef =
  | { kind: "fixture"; fixtureRef: "fixture:solution-analysis:v1" }
  | { kind: "document_snapshot"; documentSnapshotId: string };

type ResolvedTaskInputRef =
  | { kind: "fixture"; fixtureRef: "fixture:solution-analysis:v1"; fixtureVersion: 1 }
  | {
      kind: "document_snapshot";
      documentSnapshotId: string;
      artifactId: string;
      manifestId: string;
      contentSha256: string;
      simulationProfile: "solution-analysis-demo/v2";
      profileRegistryVersion: "gate0.2a-profile-registry/1";
      resourceScope: string;
      dataClass: "C1";
      audience: string;
    };
```

Gate 0.1 历史 fixture 路径继续可回放；Gate 0.2A 新纵切只使用 `document_snapshot`。strict public schema 拒绝客户端额外提交 `artifactId`、`manifestId`、hash、profile、scope、data class 或 audience。Control Plane 必须在创建任务事务中按 `tenant + principal + ready DocumentSnapshot` 重新授权并解析 `ResolvedTaskInputRef`；只有服务端按原始字节 hash 得到非空 profile 才能持久化 BusinessTask 和 ApprovalSubject。`DocumentSnapshot.simulationProfile` 的权威类型为 `"solution-analysis-demo/v2" | null`。

### Gate 0.2A authorization context

- 本 Gate 只开放 `private-conversation`，group audience 一律 `NOT_OPEN`；不提前创建 `conversation_members`。
- Control Plane 在 ingest finalize 时从服务端 session 和 Conversation 派生 `tenantId`、`principalId/creatorId`、`dataClass=C1`、`audience=conversation:<conversationId>`、`resourceScope=artifact:<sourceArtifactId>` 和 `retentionPolicy=gate0.2a-internal/v1`。客户端不能声明这些值。
- DocumentSnapshot、ApprovalSubject、delegated capability、Worker snapshot fetch、Evidence/Claim/Lineage 和报告 Artifact 都继承并核验同一个 root `resourceScope`；audience 只约束受众，不能代替 resource scope。派生数据的 data class 只能保持或升高，不能降级。
- 上传、snapshot read、task create、Worker fetch、publish、Evidence/Claim read、原文/报告下载和 idempotency replay 都调用同一个 policy evaluator，其输入至少为 action、tenant、当前 principal、resource scope、data class、audience、capability/approval expiry、retention/availability state 和当前时间；任何 metadata/body 返回前都重新授权。
- 安全测试必须用至少两个由服务端会话派生的 principal 和两个 tenant 穿越真实 HTTP 边界；不得把直接调用 repository 的伪 principal 测试冒充 HTTP 授权证据。

### Authoritative data changes

- 新建：`artifact_ingest_intents`、`artifacts`、`artifact_manifests`、`artifact_states`、`document_snapshots`、`attempt_output_candidates`、`claims`、`evidence_items`、`evidence_links`、`lineage_records`、`inbox_events`、`outbox_deliveries`、`audit_events`。
- Gate 0.1 的 `result_claims` 和 `minimal_evidence_refs` 通过一次 roll-forward migration/backfill 转入 `claims`、`evidence_items` 和 `evidence_links`；保留原 ID、时间、task/tenant/scope、source hash 和 simulation 语义。切换顺序固定为 backfill/constraint validation → 新读路径 → 数据库阻止旧表写入；开始产生新表数据后不承诺破坏性 down migration，也不双写。
- Evidence source 使用受控 union：历史数据为 `legacy_fixture {fixtureRef, fixtureVersion, sourceId, excerptSha256}`，不伪造 S3 Artifact；Gate 0.2A 新任务为 `document_snapshot {documentSnapshotId, artifactId, startByte, endByteExclusive, excerptSha256}`。完整 Artifact→Snapshot→Report lineage 只要求 `document_snapshot` 输入任务，历史任务保持真实 legacy lineage 和可回放性。
- `ArtifactManifest`、`DocumentSnapshot`、已发布 Claim/Evidence/EvidenceLink/Lineage 是不可变核心，使用 DB trigger/权限禁止 UPDATE/DELETE。Manifest 只保存 bucket、object key、size、原始字节 SHA-256、media type、安全 display name、初始 retention policy 和 created-at；数据库不保存原始文件字节，不把 VersionId/ETag 当业务身份。
- `artifact_states` 单独保存 availability、integrity、retention lifecycle、reconcile status、state version、last checked/error 和不透明 `etagObserved`；对象删除后保留 tombstone、manifest、lineage 与审计。
- `DocumentSnapshot` 只表示本 Gate 的精确内容快照，必须绑定 tenant、source Artifact/manifest、content hash、大小、media type、data class、audience、root resource scope、trust=`untrusted_text`、nullable simulation profile 和创建者；不得命名或伪装为知识库快照。
- 所有 `published` Claim 都至少有一条当前有效的 `supports` EvidenceLink；不引入可绕过的 criticality。非事实性展示文字不得作为 Claim 或报告事实条目。
- Document Evidence locator 固定为原始对象的 UTF-8 byte `startByte`（inclusive）与 `endByteExclusive`、snapshot content SHA-256、excerpt SHA-256 和 extraction version；禁止隐式换行/Unicode 规范化。Control Plane 通过受权 storage port 重读已验证原始字节、按 range 重新提取并逐字节比较，不能信任 Runtime 提交的 excerpt/hash；UI 只显示该重取结果。
- 所有新 public/wire schema 均从 Zod 导出 JSON Schema，并用正/负 fixtures 做 parity 测试；拓扑、引用、权限和跨实体语义由应用/compiler 校验，不用高级 TS 泛型冒充运行时验证。

### Upload and publish sequence

```text
authenticate + authorize + stream-validate + SHA-256
→ create immutable ingest intent/idempotency record
→ put object to server-generated S3 key
→ head/get and verify size + SHA-256
→ transactionally freeze Artifact + Manifest + DocumentSnapshot + audit
→ expose ready snapshot to UI
→ bind snapshot/hash into ApprovalSubject
→ enqueue workflow.execute.requested outbox event
→ independent Worker claims delivery and records inbox event
→ Interpreter/fake Runtime reads exact verified snapshot through Control Plane port
→ Control Plane validates Evidence/Claim/Lineage and publishes report Artifact
```

- Ingest 状态只允许以行版本/CAS 在 `intent_created → put_inflight → object_verified → ready` 主路径及 `put_failed_confirmed | reconcile_required | integrity_error | delete_pending → deleted` 恢复路径间迁移；finalize 与 delete 前态互斥。超时、连接丢失等 PUT 结果不确定情况一律进入 `reconcile_required`，不能当成“确定未写入”盲目重试。
- `putObject` 必须 create-only：锁定的 VersityGW 版本须通过 conformance test 证明支持 `If-None-Match: *` 或等价不覆盖语义；对象已存在时只做 head/get+SHA 对账。若无法证明 create-only，按 safe fallback 停止，不降级为覆盖写。`SHA-256(raw bytes)` 是唯一内容完整性值，ETag 仅为不透明观察值；本 Gate 不依赖 VersionId 作为业务身份。数据库唯一约束保证 `(tenant_id,bucket,object_key)` 和一个 idempotency semantic tuple 只对应一个 intent/artifact/snapshot。
- S3 成功而 DB finalize 失败、PUT 响应丢失或报告对象写入后 cancel 获胜时，均保留可对账 intent；对账器可安全完成同一 finalize，或先 CAS 到 `delete_pending` 后删除已证明无引用的孤儿，不得另建第二对象。
- Upload idempotency identity 至少包含 `tenant + principal + operation + key`，semantic digest 还绑定 Conversation、display metadata 和 raw-byte hash；重放返回当前 Postgres intent 投影而不是冻结的 pending response，并在返回任何 metadata 前重新授权。相同 key 不同语义返回 409。
- 报告 Artifact 由 Control Plane 按固定模板生成，最大 1 MiB，包含模拟标记、task/workflow/snapshot/hash、已发布 Claim 及 Evidence 引用；fake Runtime/Worker 不得自行上传文件或持有 S3 凭证。
- 在线下载只支持本 Gate 有界对象：Control Plane 先读取到有界内存或安全临时 spool，完成当前授权、retention/availability、size 和全量 SHA-256 校验后，才提交 HTTP status/header/body。tenant/principal/scope/data class/audience/expiry 拒绝只返回不泄露存在性的 404/403 并写拒绝审计，不修改 Artifact 状态；retention/availability 非 active 按已有 lifecycle 失败，不写 `integrity_error`；只有对象缺失、截断、size/SHA-256 不符或校验 spool/read 失败才以 CAS 进入 `integrity_error`。所有失败都必须在写首字节前完成并返回零对象字节。响应固定 `Content-Disposition: attachment`、安全编码文件名、受控 MIME 和 `X-Content-Type-Options: nosniff`。
- 业务 S3 port 保持单 key API；恢复/对账另有只限服务自有 bucket/prefix 的分页 inventory port，返回 key、size 和不透明 ETag。scanner 必须双向比较 PG→S3 与 S3→PG，并校验对象存在性与 intent/manifest/state 兼容：只有允许 live object 的 active intent 或有效 manifest/state 才能匹配 S3 key；`deleted`/tombstone 必须对应 S3 对象不存在，tombstone 本身不能为 live object 背书。不兼容时 scanner 非零，只能由 reconciler 经 CAS 收敛。

### Worker delivery and cancellation

- `POST /execute` 不再在 Control Plane 进程内直接启动 Interpreter；它只在权威事务中验证 Approval/CAS 并写 `workflow.execute.requested` outbox。
- `outbox_events` 继续是 append-only 权威业务 envelope；`outbox_deliveries` 是按 `(consumer,event_id)` 唯一的 mutable lease/delivery state；`inbox_events` 是按 `(consumer,event_id)` 唯一的 `received|processing|completed|failed` receipt state，而不是“插入即完成”。同一 execution version 的 attempt/event 数据库唯一。
- `apps/worker` 必须以独立 OS 进程运行，通过受限内部命令边界领取 delivery；expired delivery/step 以 CAS reclaim 并递增 fencing token。Worker 调用 Control Plane 时必须先使用服务端管理、与 S3 凭证分离的 Worker service identity 认证，并绑定 consumer/deployment；完成、失败和进度命令再校验 task、attempt、lease/fencing token、worker instance ID 和 idempotency key，这些相关性字段不能代替身份认证。Control Plane production route 禁止 import/构造 `WorkflowInterpreter` 或 fake Runtime。
- Worker/Runtime 只能提交 attempt-scoped candidate output。Control Plane 的单一 terminal publish 事务必须锁定当前 task/attempt/fence，重新验证 Approval、非 canceled、Evidence locator 和报告对象 hash，然后原子写 published Claim/EvidenceLink/Lineage/报告 Manifest、terminal Task/Event/Outbox；旧 completion、重复 delivery、乱序进度和过期 lease 不推进状态。
- 取消命令以 CAS 进入 `canceled` 并撤销/递增 execution fence。Worker 在节点间和提交 candidate 前检查取消；当前 fake step 可结束，但其迟到输出被拒绝。若报告对象已写而 cancel 获胜，只保留 reconcile intent，不建立 published Artifact 引用。
- Crash/reclaim 至少覆盖：inbox receipt 后执行前、执行中、side effect 后 completion 前、completion 已提交但 ack 丢失。每种恢复都必须收敛到同一 current attempt、Claim 和 Artifact。

### Backup and restore protocol

1. Control Plane 创建 `backup_set_id` 和 backup barrier，拒绝或排队新的 source/report ingest intent 及所有新 S3 PUT，暂停 ingest finalize、terminal publish、retention/orphan delete，并等待已在途 `put_inflight` 收敛到 `object_verified|ready|put_failed_confirmed|reconcile_required|integrity_error` 等确定状态。只读访问和不改变对象引用的任务进度可继续。
2. 记录 Postgres checkpoint/LSN、BusinessTask event watermark 和包含 key/size/SHA-256/ETag observation 的对象 inventory；随后导出 Postgres 与对象原始 bytes。本 Gate 采用逻辑对象恢复，恢复后的 ETag 可变化且不改变业务身份。
3. Runner 销毁 source containers 及其 volumes/data dirs；使用唯一 run ID 启动隔离、恢复前为空的 target Postgres 与 VersityGW data/versioning/IAM 目录。
4. target 先保持 `restoring/verifying`，Worker、批准、执行、发布和下载全部 fail closed；完成 PG→S3、S3→PG 双向扫描和逐字节/hash 验证后，才以权威 CAS 打开服务。
5. `pnpm test:backup-restore` 必须直接执行上述协议并向 `pnpm verify:gate0.2a` 透传非零退出；summary 只是输出，不是通过输入。

### Process credential and network boundary

| Process | Allowed S3 authority | Forbidden |
| --- | --- | --- |
| Control Plane online storage adapter | 指定 tenant prefix 的 create-only put/head/get | list-all、delete、IAM/admin |
| Reconciler | 服务自有 prefix 的 inventory/head，以及经 CAS 授权的 delete | IAM/admin、业务发布 |
| Backup/restore runner | 隔离窗口内的 export/import 和 inventory | 在线请求、业务审批 |
| VersityGW provisioner | 启动时 IAM/bucket 配置 | 在线业务调用 |
| Worker | 无 S3 secret/env/mount/网络通路；仅持有 Worker command service credential 并访问私有 Control Plane command endpoint | S3、公开用户 API、用户 session 凭证 |
| Browser/Web/Interpreter/fake Runtime | 无 S3 secret/env/mount，且无 S3/Worker-command 网络通路与凭证 | 所有直接 S3 调用或 Worker 命令 |

admin、online app、reconciler/delete、backup/restore 和 Worker command 必须使用分离凭证。Worker command endpoint 只暴露在私有进程/网络边界，不得被 Browser origin 或公开 Web 路由到达。门禁检查渲染后的 compose/service secret 分配，并动态证明 Control Plane 可以完成允许操作、Worker 对同一 key 的直接 S3 访问失败，且日志/错误响应不出现 canary secret。匿名、Browser origin、错误 Worker credential 或只伪造 worker instance/fence 的 claim/progress/candidate/completion 命令必须拒绝且不推进 DB，只有真实独立 Worker 可成功。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | 真实 served 小纬页面完成同一 private Conversation 下的两条分支：happy-path task 从演示文档上传/快照、专家路由、固定 Workflow/审批、独立 Worker/fake Runtime 走到 Claim/Evidence/Artifact、双下载和刷新恢复；cancellation task 在 queued/running 取消后恢复为 canceled 且无 published Claim/报告 Artifact。客户作者只有 `{user, xiaowei}`，happy-path browser task 关联真实 outbox/inbox/attempt/fence/worker instance | yes | Playwright served UI + API/DB/S3/worker correlation | goal:G0.2A-PRODUCT |
| AC-PRODUCT-02 | UI 沿用三栏结构，只新增附件/快照/执行资格、模拟 Workflow 步骤与路由元数据、取消、Evidence 抽屉和 Artifact 面板；未注册 profile 只可存储/下载且任务禁用，不出现真实模型、GearJob、知识库或真实专家误导 | yes | visual/copy/interaction assertions + browser screenshot review | goal:G0.2A-PRODUCT |
| AC-AUTHORITY-01 | Postgres 是 Task、Snapshot、Artifact metadata、Claim/Evidence/Lineage、Inbox/Outbox、Approval 和恢复状态唯一权威；S3 仅保存字节，UI/Worker/Runtime 不建立第二权威 | yes | schema/ownership scan + transaction/integration tests | goal:G0.2A-AUTHORITY |
| AC-AUTHORITY-02 | `result_claims`/`minimal_evidence_refs` roll-forward backfill 后禁止旧表写和双写；Gate 0.1 历史任务保留真实 `legacy_fixture` lineage 并可读取/回放，不伪造历史 S3 Artifact | yes | migration/backfill/constraint/read-path/replay tests | goal:G0.2A-AUTHORITY |
| AC-AUTHORITY-03 | public schema 只接受 snapshot ID，Control Plane 解析权威 resolved input；ApprovalSubject 精确绑定 resolved Snapshot、Artifact/Manifest/hash/profile registry、Workflow、experts/harness、scope/audience/data class/budget/simulation，任何语义变化使旧审批失效 | yes | strict-schema/resolution/digest/CAS/tamper tests | goal:G0.2A-AUTHORITY |
| AC-EVIDENCE-01 | 所有 `published` Claim 都至少有一条当前可访问、按原始 snapshot byte locator 重验 hash 的 `supports` EvidenceLink；自由文本、Runtime output 或未来 retrieval hit 不能直接发布 | yes | publish guard + byte-range negative fixtures + DB constraints | goal:G0.2A-EVIDENCE |
| AC-EVIDENCE-02 | 每个 Gate 0.2A document-snapshot Claim 和 Markdown 报告 Artifact 都可回溯到准确源对象、Snapshot byte range、WorkflowVersion、attempt candidate、Evidence/hash 和模板/转换版本；历史 fixture 只要求 legacy lineage | yes | lineage traversal + deterministic report manifest + UI drawer correlation | goal:G0.2A-EVIDENCE |
| AC-EVIDENCE-03 | Zod 4 是新 wire schema 单一代码来源，JSON Schema 正/负 fixtures parity 通过；production code 不增加 TypeBox/Ajv 或第二套 Workflow/Artifact validator | yes | contract parity + dependency/import scan | goal:G0.2A-EVIDENCE |
| AC-STORAGE-01 | 锁定的真实 VersityGW 完成 conformance-tested create-only put/head/get；对象 key、size、raw bytes 和 SHA-256 与不可变 Manifest 一致，ETag 仅为观察值，Browser/Worker/Runtime 均无 S3 凭证和网络通路 | yes | real storage conformance + rendered-secret/network test + API/DB/S3 correlation | goal:G0.2A-STORAGE |
| AC-STORAGE-02 | 明确 ingest/Artifact state 与 CAS 处理重试、结果不确定、S3/DB 部分失败、双向孤儿、缺失和篡改；不能覆盖对象、产生两个 ready snapshot 或在 preverify 前返回下载字节 | yes | fault injection + state-transition/reconciler/idempotency tests | goal:G0.2A-STORAGE |
| AC-STORAGE-03 | `pnpm test:backup-restore` 用 backup barrier/set/checkpoint 和双向 inventory，在销毁源卷后的全新隔离实例重建同一 task/snapshot/claim/artifact 链并逐字节/hash 下载；缺失/错配必须非零且 fail closed | yes | executable destructive disposable-environment rehearsal | goal:G0.2A-STORAGE |
| AC-RELIABILITY-01 | 同一 UI task 由已认证的独立 Worker 通过 outbox envelope、delivery/inbox states、lease/fencing/reclaim 和稳定 event ID 执行；匿名/伪造 Worker 不能领取或提交命令，重复、乱序、断线、进程重启及旧 attempt 不重复推进或生成第二份 Claim/Artifact | yes | authenticated same-task multi-process correlation + required fault matrix | goal:G0.2A-RELIABILITY |
| AC-RELIABILITY-02 | Worker 只提交 attempt candidate；Control Plane terminal publish 与 cancel 使用互斥 CAS。取消后迟到 progress/candidate/completion/publish 被拒绝，刷新与 SSE 重连显示同一 canceled 状态 | yes | cancel-vs-publish/reconnect Playwright + DB assertions | goal:G0.2A-RELIABILITY |
| AC-SAFETY-01 | multipart parts/fields、request/raw-byte 上限、扩展名/MIME、安全文本 predicate、增量 UTF-8、文件名和全部 UI/header sinks 都 fail closed；Markdown/HTML 不执行，非法流不留下 ready/泄漏对象 | yes | fixed upload corpus + served UI XSS/network tests | goal:G0.2A-SAFETY |
| AC-SAFETY-02 | 所有路径使用同一 policy evaluator 逐次检查 server-derived tenant/principal/root resource scope/C1/private audience/expiry/retention/current time；跨 principal/tenant、过期或越权访问均不泄露 metadata/hash/body并留下拒绝审计 | yes | real-HTTP dual-principal/tenant authorization tests | goal:G0.2A-SAFETY |
| AC-SAFETY-03 | 只有 authority-pinned raw hash/profile 可创建 fake 任务；其他合法文档仅存储/下载且无 outbox/Worker/业务结果；产品运行与验收路径无真实模型、GearJob、知识、Connector、Hatchet、MinIO 或外部网络执行路径；开发用 Kimi 例外不得进入产品进程、数据或 Gate oracle | yes | independent oracle/profile/registry/route/dependency/secret/network scans | goal:G0.2A-SAFETY |
| AC-GATE-01 | `pnpm verify:gate0.2a` 直接聚合质量、合同、storage、安全、integration、required fault cases、success/negative served UI 和可执行备份恢复；禁止 skip/手工 summary 作为通过输入，任一失败时非零 | yes | aggregate script contract + exit-code/required-case tests | goal:G0.2A-AUTHORITY |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V-1 | SDD authority 与合同 | `codex-team-validate-json --type brief ...`；`codex-implementation-contract-lint --strict --new-authoring --authority-slice ...` | task id、Goal refs、semantics v2、owned paths 和 authority slice 一致 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-contract.txt` |
| V-2 | 基础质量 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | 全部退出 0，Gate 0.1 回归不退化 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-quality-summary.md` |
| V-3 | Schema、migration、authority | `pnpm test:contracts && pnpm test:integration` | public/resolved Zod/JSON Schema parity、legacy roll-forward backfill、immutable triggers、ApprovalSubject、byte-locator Claim/Evidence/Lineage 和单权威通过 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-authority-summary.md` |
| V-4 | 真实对象存储 | `pnpm test:storage`，连接本 Gate compose 锁定版本的实际 VersityGW，禁止 S3 client mock | create-only conformance、状态/CAS、put/head/get/preverified download、幂等、双向 inventory、部分失败、孤儿、缺失和篡改符合合同 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-storage-summary.md` |
| V-5 | 安全 | `pnpm test:security` | 固定 multipart corpus、全部 XSS sinks、真实 HTTP 双 principal/tenant、expiry/retention、越权 Evidence/下载、拒绝不污染 integrity state、渲染后 secret 分配、Worker 直连 S3 拒绝、匿名/伪造 Worker command 拒绝和 profile/network 负向路径通过 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-safety-summary.md` |
| V-6 | 投递与恢复 | `pnpm test:recovery` 在 disposable 多进程环境执行下列全部 required fault case IDs；每例 runner 记录 `fault_triggered=true` | 同一 task 只有一个 ready snapshot/current attempt/每个 published Claim/报告 Artifact，stale/cancel 被拒绝，cursor 续传；任何 case skip 或未触发均非零 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-recovery-summary.md` |
| V-7 | Served UI | `pnpm test:e2e -- --project=gate0.2a-success && pnpm test:e2e -- --project=gate0.2a-negative` | success 无 interception：happy-path task 完成全纵切并关联 API/DB/S3/outbox/inbox/attempt/fence/独立 Worker PID，同一任务运行中 kill Worker 后恢复；独立 cancellation task 取消后无 published Claim/报告 Artifact。negative 只验证白名单故障，不贡献成功结论 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-ui-summary.md` |
| V-8 | 联合备份恢复 | `pnpm test:backup-restore` | 唯一 run ID 的 source/target、backup barrier/set/checkpoint/inventory、源容器与卷销毁、target 恢复前为空、restore gate 和双向 scanner 全部被真实执行；删改对象或 manifest 时命令非零 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-backup-restore-summary.md` |
| V-9 | 总门禁 | `pnpm verify:gate0.2a` | 直接运行 V-2 至 V-8 和 Gate 0.1 回归；任一失败、skip、缺 case 或手工 summary 代替命令均非零 | `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/gate-0.2a-phase-review.md` |

V-6 的 required fault case IDs 固定为：`after_intent_commit_before_s3_put`、`after_s3_put_before_db_finalize`、`put_response_lost`、`after_outbox_commit_before_worker_claim`、`after_inbox_insert_before_step_execution`、`after_step_side_effect_before_completion`、`after_report_put_before_db_publish`、`stale_attempt_completion`、`cancel_vs_publish`、`sse_snapshot_subscribe_gap`、`control_plane_restart`、`worker_restart`。测试结果必须逐项列出触发点和最终实体计数，summary 只能由 runner 生成。

## Evidence Budget

- Git 只在 `doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/evidence/` 保存最终 `gate-checklist.md`、`phase-review.md`、`evidence-index.md` 和 V-1 至 V-8 的小型摘要，目标不超过 12 个文件和 1.5 MB；不得创建平行 evidence 目录。
- Playwright trace/video/HAR、上传 corpus、完整日志、S3 对象副本、数据库 dump、联合备份、容器卷、故障注入输出写入 `/tmp/geneway-runs/<run-id>/`，不得提交 Git。
- 截图只能证明 UI 呈现；不能替代 API/Postgres/S3、权限、hash、worker、恢复或备份证据。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| 空文件、恰好 1 MiB、1 MiB+1、chunked/no-length、跨 chunk 非法 UTF-8、BOM、NUL/二进制 magic、超长 header、扩展名/MIME 冲突、重复 file、额外 field 或危险文件名 | 恰好上限可进入后续校验；其余非法输入在首次可判定时中止，不创建 ready snapshot，不留下无 intent/tombstone 的对象，不回显危险内容 | yes | goal:G0.2A-SAFETY |
| `.md` 含 HTML、script、javascript URL、远程图片或提示注入文本 | 只作为 `untrusted_text` 转义显示；不执行、不抓取、不提升权限，也不能单独决定 D1+ 参数 | yes | goal:G0.2A-SAFETY |
| 相同 idempotency key 重试或 same-tenant 其他 principal 碰撞 | 同 principal/同语义重新授权后返回当前 intent/snapshot/artifact 投影；不同 principal 或不同 bytes/hash/metadata 不泄露原状态并返回冲突/拒绝，不覆盖对象 | yes | goal:G0.2A-STORAGE |
| S3 put 后 DB finalize 前崩溃，或 PUT 提交后响应丢失 | 进入 `reconcile_required`，以 create-only key 和 raw SHA 对账后原子 finalize，或经 `delete_pending` 安全清理；不盲重试、不创建第二对象/快照 | yes | goal:G0.2A-STORAGE |
| DB intent 后 S3 不可用、对象丢失、size/raw-byte SHA-256 不符，或 HEAD/GET 间 ETag 变化/替换/截断 | 缺失、size 或 SHA-256 不符时状态保持 `put_failed_confirmed|reconcile_required|integrity_error`并禁止批准/执行/发布/下载；ETag 变化只触发完整 GET、size/SHA-256 重验和审计，若字节一致则更新 mutable `etagObserved` 且不进入 `integrity_error`。所有失败在写首字节前完成且 body 为空 | yes | goal:G0.2A-STORAGE |
| 合法文档未匹配注册的演示 profile，包括含提示注入/HTML/远程 URL 的 `.md` | 可形成受控 Artifact/DocumentSnapshot 并授权下载；UI 显示仅存储且禁用任务，API 返回 `NOT_OPEN_FOR_SIMULATION_PROFILE`，无 execute outbox/Worker claim/外部 DNS/TCP/业务推进 | yes | goal:G0.2A-SAFETY |
| 批准后源对象、snapshot/hash、Workflow、专家、权限、预算或受众变化 | 旧 ApprovalVersion 失效；不可在原版本上修改，必须创建新输入/审批版本 | yes | goal:G0.2A-AUTHORITY |
| Evidence byte range 越界、片段不属于被冻结 snapshot、snapshot/excerpt hash 不符、已超 retention 或当前用户不可访问 | EvidenceLink 无效，所有相关 Claim 和报告 Artifact 不发布；UI 不泄露片段，历史 fixture 只走 legacy locator | yes | goal:G0.2A-EVIDENCE |
| 重复/乱序 outbox、inbox receipt 后崩溃、执行中崩溃、completion ack 丢失、lease 过期或旧 attempt completion | delivery/inbox state、CAS reclaim 和 fencing 拒绝重复/迟到推进；恢复后只继续一个 current attempt | yes | goal:G0.2A-RELIABILITY |
| 用户取消与 report publish 并发 | Control Plane CAS 决定唯一终态；cancel 获胜时迟到 Claim/Artifact 不发布，publish 已提交时取消返回明确不可撤销结果 | yes | goal:G0.2A-RELIABILITY |
| SSE 在快照与订阅交界断开、切换 task 或浏览器刷新 | 使用 tenant+task scoped 的权威 watermark/cursor 和稳定 event ID；客户端缓存仅作提示且同样按 tenant+task 分区，不丢、不串任务、不重复显示 | yes | goal:G0.2A-RELIABILITY |
| 跨 tenant/principal 猜测 artifact/snapshot ID、scope 不同、过期 capability/approval、C1 clearance 不足、retention 非 active 或 group audience | 同一 policy evaluator 返回不泄露存在性的 404/403，不返回 metadata/hash/excerpt/body，并记录拒绝审计 | yes | goal:G0.2A-SAFETY |
| Postgres 备份可恢复但 S3 对象缺失、S3-only 对象无兼容 active intent/manifest/state、仅 tombstone 对应的 live object、对象存在性与 state 不符，或 target 恢复前非空 | restore gate 和双向 scanner 非零；对象/业务链保持不可用，不能把部分恢复、删除失败或旧卷冒充成功 | yes | goal:G0.2A-STORAGE |

## Implementation Notes

- S3 contract 应保持小而可替换：`ensureBucket`、`putObject`、`headObject`、`getObject`、`deleteObject`（仅对账和 retention 使用）及 URI/key 解析；`getObject` 内部可流式写入有界校验 spool，但不得在全量验证前直接转发 HTTP body。应用层不依赖 AWS SDK 具体类型。
- 本地 compose 参考 Sharp Cell 的 VersityGW POSIX backend，使用独立 data/versioning/IAM 持久卷；服务端启用 path-style endpoint。生产部署参数只经配置注入，secret 不写日志、不进入浏览器、不进入 fake Runtime。
- 真实 S3 删除是受控补偿，不是用户业务能力；只有已证明无引用的孤儿或 retention 到期对象才能由对账器执行，且必须审计。
- 报告 Artifact 是本 Gate 固定模板的模拟交付物，不等于真实报告 Agent。文件名、MIME、hash、lineage 和下载权限必须与原始 Artifact 使用同一 contract。
- Gate 0.2A 不建立复杂 UI 表格。Evidence 适合抽屉/详情区，Artifact 使用轻量列表；后续任务中心如确有二维数据再按独立合同选择轻量 table。
- 可以复用 Gate 0.1 代码和经审查的 Sharp Cell/Hive 设计模式；不得为“统一架构”重写已通过的 Workflow、Approval、授权、UI shell 或 Runtime。
- Kimi Code CLI 只是开发时编码执行器，不是 geneway 产品 Runtime、仓库依赖或 Gate 成功证据；其完整边界以 `Kimi frontend implementation lane` 为准。最终结论仍由主控制器根据真实 served UI、独立 Playwright oracle、API/DB/S3/Worker correlation 和 `pnpm verify:gate0.2a` 给出。

## Failure And Stop Conditions

- 如果产品实现或运行路径需要 PDF/Office/OCR/压缩包解析、知识索引/检索、真实模型、共享 Codex、GearJob、异常中心、Hatchet、动态 Workflow、渠道、A2A、外部 Agent 或制造业写操作，停止并返回范围决策，不在 Gate 0.2A 内吸收；受控开发执行器不改变这条产品边界。
- 如果必须使用 MinIO、让浏览器/Runtime持有 S3 凭证、绕过 Control Plane 下载，或让 S3 metadata 成为业务权威，停止实施。
- 如果只能以浏览器 fulfill、S3 mock、进程内 fake queue、静态截图或数据库 seed 冒充成功路径，Gate 0.2A 失败。
- 如果对象存储无法证明 create-only，S3 与 DB 部分失败没有确定恢复状态，Evidence/Lineage 无法回溯，或无 Evidence Claim 仍可发布，Gate 0.2A 失败。
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

本合同的 Required 条目均绑定 `G0.2A-*` authority refs。Team Review 只准入了阻断当前 Gate 或会造成安全、数据、权限、恢复假通过的澄清，没有新增产品能力。历史会话、路线图、review 或参考仓库只能用于解释和验证，不得把后续能力、review 严重级别或实现偏好自动升级为本 Gate scope。实施 reviewer 可发现任意问题，但只自动修复阻断本 Gate、由本 Gate 引入的回归或安全/数据/权限问题；其他建议记录为后续项。

## Final Contract Cleanliness Gate

- [x] 本文件是 Gate 0.2A 唯一最终实施合同，不创建平行 README/spec/clarify/contract-index 来重复 scope。
- [x] 每个 Required acceptance criterion 与 edge case 均绑定 authority Goal ref。
- [x] 首个代码切片是可操作 served 存储纵切，不是横向基础设施或证据工程。
- [x] 真实验收必须关联 browser、API、Postgres、VersityGW 和独立 Worker，不以 mock、截图或组件存在代替。
- [x] Gate 0.1 固定 Workflow/fake Runtime/UI/授权可复用，真实模型、知识、异常、Hatchet、动态 Workflow、渠道和外部 Agent均未提前获得权限。
- [x] S3 明确使用 VersityGW-compatible boundary，不使用 MinIO；Hive/Sharp Cell 只作参考，不形成第二产品代码基地。
- [x] 原始 trace、视频、dump、备份和对象副本默认留在 Git 之外。
