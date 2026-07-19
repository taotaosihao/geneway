# geneway 制造业数字员工平台 v19 最终实施合同

task_id: 20260715-044-paperclip-agent-mvp
contract_semantics_version: 1
contract_revision: 7
work_type: implementation
first_code_guard: required
product_ui_gate: required
first_code_slice: 交付小纬 WebChat、BusinessTask API 和固定 Workflow 执行的首个产品纵切；用户可选择自动、单专家或专家团，并在真实 HTTP 页面完成任务提交、执行、结果和来源查看
first_code_slice_kind: product
first_code_owner: 用户授权的主实现负责人；人类产品/制造业负责人批准 Capability 范围并在 Gate A 登记具名业务验收人
first_code_verification: contract tests、Postgres integration、SSE cursor replay、idempotency negative test、Playwright served-UI end-to-end
allowed_contract_gate_only_until: 旧大写 GeneWay 归档已验证、新小写 geneway 仓库脚手架和首批数据库 migration 合入之前
stop_if_no_code_by_phase: Gate 0.1 结束
gate_parallelization_or_deferral_plan: Hatchet、动态 Workflow、真实 Connector、飞书和第二 Runtime 按 Gate 后置；Control Plane、fake Runtime、固定 Workflow/Approval、Authorization、事件账本和 served UI 不得后置
first_operable_user_flow: 用户在 WebChat 与小纬对话，选择自动、单专家或专家团，上传脱敏文档，查看并确认固定 Workflow 节点图，随后查看专家进度、结果和内联 Evidence；报告下载、Artifact 存储及异常中心在 Gate 0.2 补齐
browser_entrypoint: http://localhost:3200/conversations/new?capability=solution.analysis.v1
served_ui_validation_action: 使用 Playwright page.goto("http://localhost:3200/conversations/new?capability=solution.analysis.v1") 打开真实 HTTP 服务，完成三种专家路由、文档上传、Workflow 图确认、执行、结果和内联 Evidence；Gate 0.2 再验证报告下载、四个完整路由与两类异常 fixture；HTML 与 JS/CSS 必须由真实服务器提供
ui_data_mode: Gate 0 使用 Postgres、fake Runtime、脱敏文档和异常 fixture；Gate A 在相同 API 下使用共享 Codex 订阅的 OpenAI Agents dev Runtime 与 GearJob 单 Work Order；Gate D 再扩展真实异常和日报
required_safety_gates: tenant 隔离、C0/C1 或批准脱敏数据、R0/R1/A1 上限、服务端身份、无 provider/connector 直连、delegated capability、Evidence publish guard、事件和 Artifact 鉴权
allowed_headless_only_until: Gate 0.1 的真实 API 可调用之前
stop_if_no_ui_by_phase: Gate 0.1 结束

## Goal

安全归档当前大写 `GeneWay` Paperclip fork，在 `taotaosihao/geneway` 和 `/home/gewu/work/geneway` 建立干净历史的 TypeScript-first 制造业数字员工平台。客户只与“小纬”交流，但可让小纬自动安排或指定专家/专家团。MVP 复用旧分支共享 Codex 订阅开发车道完成 `solution.analysis.v1`，并通过 GearJob 一个真实 Work Order 只读查询完成 `production.work-order-status.v1`；随后按 Gate B–G 增加长任务、动态 Workflow、异常与日报、渠道、第二 Runtime 和内部毕业能力。

## Non-goals

- 不继续实现或合并旧 longtask implementation 分支，不把 Paperclip 领域对象带入新平台权威。
- 不执行 LLM 生成的代码，不使用 tagged template、双 Schema 体系或全图高级 TS 泛型表达 Workflow。
- 不允许 D1/W1/W2/W3 正式写动作，不直连或写回 GearJob，不让 LLM 单独判定制造业异常。
- 不提前引入 AgentTeams、A2A、DeerFlow、AgentScope 或 LangBot；Gate H/I 不属于当前完成条件。
- 不向客户暴露多个专家聊天身份，不把专家选择解释为提权。
- 不复制 Hive、Sharp Cell、GearJob UI，不使用 MinIO，不把 Codex 订阅车道包装成生产能力。
- 不允许 Runtime、Hatchet、渠道、浏览器或外部 Agent 保存第二份任务、Workflow 或审批权威。

## Selected Direction

```text
clean-history geneway
→ 小纬唯一入口 + 可选 ExpertTarget
→ Capability-first Control Plane
→ WorkflowDraft JSON + Zod 4 + Compiler
→ immutable WorkflowVersion/ApprovalVersion + React Flow projection
→ ordinary Worker Interpreter；Gate B 后由 Hatchet 托管同一 Interpreter
→ Model/Tool/Connector Gateway + Claim–Evidence–Lineage
→ OpenAI Runtime first；GearJob 单 Work Order first；WebChat first
→ VersityGW/S3 ObjectStorage；Claude、飞书、异常/日报按 Gate 增加
```

详细组件、数据结构、UI 状态矩阵和错误处理以技术附录与 `ADR-UI-001` 为实现说明；本合同只保留范围、硬边界、门禁和验收权威。

## Decision Boundaries

1. Control Plane Postgres 是 Conversation、BusinessTask、BusinessTaskEvent、Workflow、Approval 和业务 Step 的唯一权威；跨服务使用 outbox/inbox，Hatchet 只调度命令。
2. CapabilityVersion、WorkflowVersion 和 ApprovalVersion 不可变；Agent、Runtime、UI 图和渠道只是可替换实现或投影。
3. 客户只看到小纬。ExpertTarget 仅能从 Capability allowlist 选择，写入任务/Workflow hash，不扩大数据、工具或动作权限；无授权 fallback 时不可静默替换。
4. TS 对象模板、Agent Draft 和管理端表单产生同一 WorkflowDraft JSON。Zod 4 是结构单一来源；Compiler 校验拓扑、引用、版本、能力、工具、权限、预算和 feature set，产出 canonical WorkflowVersion + hash。审批、React Flow、Interpreter 和 Diff 只读取该版本。
5. 每次执行必须解析一个不可变 HarnessVersion，固定 Agent/ExpertTarget、Tool、Model、Memory/Context、Verifier 和 Budget policy；实际选择进入 BusinessTask、WorkflowVersion hash 和审计，且不能扩大调用者权限。Gate 0/A 只使用已登记 HarnessVersion；Gate C 才允许 Agent 提交结构化 HarnessDraft/Patch。
6. Gate 0/A 运行固定 Interpreter；Gate B 只把同一 Interpreter 托管到 Hatchet；Gate C 才开放结构化 WorkflowDraft/Patch、条件、并行、等待和重新审批。Agent 永远不能生成或执行 TS。
7. 所有模型流量经 Model Gateway；所有工业系统访问经 Tool/Connector Gateway。每次调用重新检查 principal、delegated capability、resource、data/action 和 audience。
8. `codex_subscription_dev` 仅限可信本机、单账号、单 active run；只有本机 Model Gateway provider plugin 可读取 auth-file，Runtime、Control Plane、UI 和其他服务不得接触凭据或直连 provider。正式环境只使用 API/企业凭据。
9. ApprovalVersion 必须绑定 approval kind、subject type/id/version、WorkflowVersion hash、准确输入/工具参数、资源/受众范围、预算与有效期；任何执行相关变化都创建新版本并使旧批准 superseded。
10. Gate 0 建立服务端派生 principal、Postgres resource scope、Casbin domain RBAC、ApprovalVersion 和 append-only BusinessTaskEvent；非 loopback 且无 OIDC 时 fail closed。
11. 首个真实 Connector 只读一个 GearJob Work Order。Gate A 前必须锁定 endpoint、认证、DocType/object 权限、精确资源范围和字段白名单；需要修改 GearJob facade 时另行授权并在 GearJob 仓库独立提交。
12. `ADR-UI-001` 是 UI 技术和布局权威；浏览器只投影 Control Plane 状态，Workflow 图和表格不能形成第二份业务权威。
13. VersityGW POSIX backend 通过 S3 API 和内部 ObjectStorageService 使用；对象 key/prefix 不是权限边界，Artifact 下载必须重新授权。
14. A2A 只映射已经毕业的 Capability，Gate I 后置；旧仓库和分支只作为可恢复历史与文件级迁移来源。

## Required Implementation Order

1. **Gate R：归档与新基地。** 记录旧 refs/worktree/dirty/untracked，创建并验证 `git bundle --all`、bare mirror 和临时恢复 clone；外部改名、移动目录和新建 GitHub 仓库必须另获授权。
2. **Gate 0.1：安全的首个产品纵切。** 建立最小 monorepo、Postgres migration、服务端 trusted-local principal、tenant isolation、最小 Authorization/delegated capability、Zod/Compiler/canonical WorkflowVersion/hash、固定 HarnessVersion/ApprovalVersion、最小 EvidenceRef/来源 hash/可访问性与 publish guard、Conversation/BusinessTask/BusinessTaskEvent API、普通 Worker Interpreter和真实 served WebChat。结束仍无安全闭环的真实 API + UI 时停止。
3. **Gate 0.2：完整产品骨架。** 增加 JSON Schema parity/property tests、完整 Claim–Evidence–Lineage、Artifact/VersityGW、outbox/inbox 扩展、异常 fixture、状态矩阵，以及 Workflow、待办、任务/Evidence 四个完整路由。
4. **Gate A：真实 MVP。** 先完成 GearJob preflight，再迁移 OpenAI worker/provider/订阅测试机制；以固定 TS 对象模板完成 `solution.analysis.v1` 和 `production.work-order-status.v1`，并通过本合同的业务真实性验收。
5. **Gate B/C：长任务和动态 Harness/Workflow。** Gate B 把同一 Interpreter 托管到 Hatchet并验证 lease/fencing/恢复；Gate C 再开放结构化 HarnessDraft/Patch 与 WorkflowDraft/Patch、图 Diff 和重新审批。
6. **Gate D：制造业扩展。** 只依赖 Gate A，可与 B/C 并行；在 GearJob 只读 Connector 上增加确定性异常、`operations.exception-assist.v1` 和 `production.daily-report.v1`。
7. **Gate E/F：渠道和第二 Runtime。** 飞书与 WebChat 共享同一 Conversation；Claude 通过同一 Runtime contract 和 Capability/Evidence 格式。
8. **Gate G：内部毕业。** 完成至少一个受控动态 Harness + Workflow 场景，以及真实内部试点、回归、安全攻击、提示注入、成本、审计、运维与 Postgres/VersityGW 联合恢复；Gate C 是内部平台完成的必经门禁。
9. Gate H/I 只有出现真实需求和已毕业 Capability 后另行启动，不得由当前 review 自动扩入。

## Acceptance Criteria

`Required=yes` 表示该条目在所属门禁完成前不可跳过，不表示 Gate A/MVP 必须提前完成后续 Gate。

| ID | 所属门禁 | Criterion | Required | Verification |
| --- | --- | --- | --- | --- |
| AC-ARCH-01 | Gate R | 新 `geneway` 无 Paperclip 运行依赖/upstream；旧仓库 bundle/mirror、已知分支和 dirty/untracked 清单可恢复 | yes | bundle/mirror restore、dependency/remote/ref scan |
| AC-PRODUCT-01 | Gate 0 | Web 只显示 `{user, xiaowei}`；专家仅作为后台步骤、进度和结论；Goal B 使用同一真实 served-UI run 证明消息作者集合和 WorkflowVersion id/hash | yes | UI contract + Playwright + business evidence |
| AC-CHANNEL-01 | Gate E | 飞书与 WebChat 只显示 `{user, xiaowei}`，共享同一 Conversation/BusinessTask，并通过签名、去重、受众过滤、审批卡和投递恢复测试 | yes | fake/negative/controlled-live tests |
| AC-EXPERT-01 | Gate 0/A | auto/expert/team 均受 Capability allowlist、版本健康和权限交集约束；选择进入 hash，不静默 fallback | yes | resolver + authorization negative + Playwright |
| AC-CORE-01 | Gate 0 | Capability、BusinessTask、事件、Workflow 和 Approval 由 Control Plane 版本化持久化；浏览器、Runtime、Hatchet和渠道不能成为第二权威 | yes | DB/API/architecture tests |
| AC-AUTH-01 | Gate 0 | principal 由服务端派生；跨租户、过期 capability、伪造身份和未授权 Tool 均 fail closed；审批决策时重新授权 | yes | authorization/approval/replay negative tests |
| AC-APPROVAL-01 | Gate 0/C | ApprovalVersion 绑定 kind、subject version、WorkflowVersion hash、输入/工具参数、资源/受众、预算和有效期；任何执行相关变化都生成新版本并 supersede 旧批准 | yes | payload/hash/CAS/replay/role-revocation tests |
| AC-WF-01 | Gate 0 | Zod 4 为结构单一来源；Compiler 拒绝代码、URL、未知引用、无界循环和提权，并产出唯一 canonical WorkflowVersion/hash | yes | schema/compiler/hash tests |
| AC-WF-01B | Gate 0.2 | 导出的 JSON Schema 与 Zod fixture 保持 parity，拓扑/引用/版本/权限/预算 property tests 通过 | yes | export parity + compiler property tests |
| AC-WF-02 | Gate B | 普通 Worker 与 Hatchet 使用同一 Interpreter 核心；等待、恢复和重试不改变 Workflow/UI 合同且不重复业务效果 | yes | identity + integration/fault tests |
| AC-WF-03 | Gate C | Gate C 前动态 Draft/Patch fail closed；开放后 Harness/Workflow Patch Diff 可见、Compiler 可验证且变更重新审批；不得生成或执行 TS | yes | feature gate + compiler + graph diff + approval tests |
| AC-HARNESS-01 | Gate 0/A/C | Gate 0/A 从 Registry 解析不可变 HarnessVersion，固定 Expert/Agent、Tool、Model、Memory/Context、Verifier 和 Budget policy并写入 hash/审计；有效范围必须取任务 capability、调用者权限、目标 Agent ceiling、Harness scope 与 Tool policy 的交集；Gate C 才允许受控 Draft/Patch | yes | resolver/hash/replay/permission-intersection/dynamic tests |
| AC-RUNTIME-01 | Gate A | 首个 Runtime 支持幂等 task、cursor replay、暂停/恢复/取消、checkpoint、预算、deadline、ArtifactRef 和版本化事件 | yes | adapter conformance suite |
| AC-RUNTIME-02 | Gate F | Claude 与 OpenAI 通过同一 Runtime contract，替换后 Capability、权限和 Evidence 格式不变 | yes | cross-runtime conformance/eval |
| AC-MODEL-01 | Gate A | 共享订阅车道通过真实调用、quota、refresh/crash、secret redaction 和 egress 测试，且无法在生产/VPC启用或旁路 Model Gateway | yes | live conformance + policy/network negative tests |
| AC-EVID-00 | Gate 0.1 | UI 只发布带可访问 EvidenceRef、来源 hash 和 tenant scope 的关键 Claim；Evidence 缺失或越权时 publish guard 拒绝 | yes | evidence contract + publish/access negative tests |
| AC-EVID-01 | Gate 0.2 | fixture 关键 Claim 有完整 Evidence 和 Lineage；事实、推断、建议和未知项可区分 | yes | evidence/lineage contract + fixture eval |
| AC-EVID-02 | Gate A | 两个真实场景的关键 Claim 均可追溯到当前输入/查询、转换版本和可访问证据 | yes | business evidence map + real eval |
| AC-WO-01 | Gate A/MVP | GearJob 单 Work Order 经精确对象权限和字段白名单返回状态、计划/已产数量、确定性进度、更新时间与 Evidence；无数据库直连或写路径 | yes | connector/auth/deterministic/API/Playwright |
| AC-EXCEPTION-01 | Gate D | 设备停机、告警和产能落后由版本化确定性规则去重登记；小纬分析、日报、缺失提示和 Evidence 使用真实只读数据 | yes | rule + connector + data quality + Playwright |
| AC-DELIVERY-01 | Gate 0 | BusinessTask 状态、事件和最小 outbox 同事务写入；重复/乱序/重放保持幂等 | yes | transaction + delivery replay tests |
| AC-DELIVERY-02 | Gate B | step 使用 attempt/lease/fencing，双 Worker、崩溃恢复和旧 completion 不得重复完成或产生重复业务效果 | yes | dual-worker/fault tests |
| AC-UI-01 | Gate 0.2 | 真实 Vite HTTP 服务交付小纬、异常与待办、Workflow、任务与 Evidence 四个路由；完成首个 API-backed 可操作流程，不以静态原型替代 | yes | Playwright routes/e2e + served asset check |
| AC-UI-02 | Gate 0 | UI 遵循 `ADR-UI-001`，从 Control Plane 快照/cursor 恢复；Workflow 图、审批 payload、Diff 和执行版本 hash 一致 | yes | adapter/replay/theme/design review |
| AC-UI-03 | Gate 0.2 | 1440/1280/768 布局、键盘/焦点、loading/empty/403/404/409/offline/stale 状态通过；未开放导出保持禁用 | yes | responsive/state-matrix tests |
| AC-UI-04 | 首次开放导出的 Gate | 表格查询与导出均由服务端按同一 principal/resource scope 重新授权，不在浏览器先宽取后过滤 | yes | query/export authorization negative tests |
| AC-EVAL-01 | Gate G | Capability 按 draft/shadow/internal/graduated 晋级；真实业务、安全、故障和恢复证据齐全后才能毕业 | yes | eval/release policy + pilot verdict |
| AC-MIGRATION-01 | Gate 0/A | 迁移项记录来源、改写、许可证和新合同测试；无整包迁移或 Paperclip 领域泄漏 | yes | migration manifest/review |
| AC-SECURITY-01 | Gate 0 | trusted-local、tracing/telemetry、egress、secret、taint 和文档解析 fail closed | yes | security/adversarial tests |
| AC-SECURITY-02 | Gate G | 正式 sandbox、retention、依赖/镜像供应链和内部试点攻击测试通过 | yes | pilot security + supply-chain review |
| AC-STORAGE-01 | Gate 0.2 | VersityGW 通过 S3 conformance、Artifact 鉴权下载、tenant 隔离和重启持久化 | yes | storage conformance/restart tests |
| AC-RECOVERY-01 | Gate G | Postgres checkpoint/LSN 与 object manifest/hash 可形成、恢复并核对同一联合恢复点 | yes | backup/restore drill |

## Gate A Business Acceptance

Gate A 直接采用 Atlas Team SDD 现有 schema、helper 和 strict validator，不另造 Markdown 验收格式。仓库只保留一份简短摘要/索引；六个标准 JSON 及所有被 `source_type=local` EvidenceRef 直接引用的精选证据必须放在 `$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/` 或该任务 Artifact root 下的相对路径。`/tmp/geneway-runs/<run-id>/` 只保存未被 verdict 直接引用的批量原始日志：

```text
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/business-intent.json
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/scenarios/business-scenario-card.BA-A-01.json
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/scenarios/business-scenario-card.BA-A-02.json
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/business-evidence-map.json
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/business-acceptance-report.json
$CODEX_WORKFLOW_ROOT/artifacts/<task-id>/team/acceptance/business-verdict.json
```

`business-intent` 使用 `schema_version=2`、`closure_mode=dual_goal`；两项目标必须分别给出 EvidenceRef，但引用相同的 `integration_path_id` 和 `integration_mode=real`。Gate A 开始前必须在 Control Plane 任务元数据登记可解析的人类 `gate_a_solution_acceptance_owner_ref` 与 `gate_a_work_order_acceptance_owner_ref`，并由 `business-evidence-map` 引用对应审计证据；不向 Atlas schema 添加私有字段。验收人不能是 Agent，是否与操作人相同必须显式记录，Approval 职责分离仍按策略执行。缺 owner、真实集成证据或 UI 证据时 verdict 为 `blocked`。

| ID | 业务场景与参与者 | 预期状态和结果 | 必须独立成立的真实证据 | Acceptance owner |
| --- | --- | --- | --- | --- |
| BA-A-01 | 内部实施顾问/产品人员在 WebChat 提交一组批准脱敏的真实需求材料，选择 auto、专家或专家团并确认固定 Workflow | BusinessTask `submitted → approval_required → running → review_required → completed`；需求、差距、建议、风险四段均非空；抽查 5 条重要事实（不足 5 条则全查）均指向正确来源位置；推断/未知显式标注；来源未修改；验收人确认可用于下一轮实施讨论 | A：真实请求/响应、共享订阅 Runtime、BusinessTaskEvent/WorkflowVersion 状态迁移、Artifact/Evidence/Lineage 与 Audit；B：同一 run 的真实 served UI 录屏/截图，消息作者仅 `{user,xiaowei}`，专家仅作流程归因，并显示 WorkflowVersion id/hash | `gate_a_solution_acceptance_owner_ref` |
| BA-A-02 | 具有目标 Work Order 读取权限的内部生产/实施人员在 WebChat 查询一个存在、可读、字段足够的真实 GearJob 工单 | BusinessTask `submitted → running → completed`；状态、计划/已产数量、确定性进度、更新时间与 GearJob 权威字段一致，且零写入；`not_found/forbidden/data_incomplete` 只作为负向测试，不能替代本场景通过 | A：真实 GearJob 请求/响应、对象授权、BusinessTaskEvent/WorkflowVersion 状态迁移、字段快照、确定性进度、Audit/Evidence 和零写入审计；B：同一 run 的真实 served UI 由操作人发起并理解结果、消息作者仅 `{user,xiaowei}`、显示 WorkflowVersion id/hash且至少打开一条 Evidence | `gate_a_work_order_acceptance_owner_ref` |

必须运行 Atlas 现有 `codex-team-artifact-lint`/业务验收 validators。技术目标与业务目标使用不同 Evidence identity；两个场景的 Goal A/Goal B 都必须为 `passed`，最终 `business-verdict.verdict` 必须为 `accepted` 才能完成 Gate A/MVP。`conditionally_accepted`、`rejected`、`blocked` 或 `not_run` 均不能关闭 Gate A；业务目标外发现只记 follow-up，不扩张当前合同。

## Completion Criteria

MVP 完成必须满足：Gate R、0、A 的所有 Required AC 通过；两个 Gate A 场景的技术/业务双目标均 `passed`，总 verdict 为 `accepted`；客户只看到小纬且专家选择不提权；真实共享订阅与 GearJob 单工单链路可审计，fake Runtime 仅作为故障/无凭据回退测试。

当前内部平台完成必须满足：Gate C 至少通过一个受控动态 Harness + Workflow 场景；至少一个 Capability graduated；真实只读异常助理与生产日报达到 internal；WebChat 与一个正式 IM 共享任务；OpenAI/Claude contract-compatible；长任务、审批、权限攻击、提示注入、Evidence、审计和 Postgres/VersityGW 联合恢复通过。Gate H/I 不在当前完成条件。

## Edge Cases

| Case | Expected behavior | Required |
| --- | --- | --- |
| 重复任务、事件、callback 或 outbox 投递 | 返回原对象/决定，按 cursor 续传，不重复业务效果 | yes |
| Workflow 含代码、URL、未知引用、未开放动态节点或图/hash 不一致 | Compiler 拒绝；不生成可审批/可执行版本 | yes |
| 专家不可用、未授权或能力高于用户权限 | 明确失败或请求用户确认 fallback；有效权限不扩大 | yes |
| 订阅配额、refresh、凭据或生产环境策略异常 | dev lane fail closed；仅 trusted-local Model Gateway provider plugin 可读 auth-file，不轮换账号、不回退其他凭据 | yes |
| 审批后输入、工具参数、Workflow/Harness、范围、受众、预算或有效期变化 | 创建新 ApprovalVersion 并 supersede 旧批准；旧回调不得推进任务 | yes |
| GearJob 工单不存在、无权限、qty=0、字段缺失或 API 迟到 | 返回结构化状态/数据质量提示，不补造数据，不除零，不写回 | yes |
| 客户端伪造身份、跨租户、审批重放/过期/角色撤销 | 决策和请求失败，不改变权威状态 | yes |
| 双 Worker、lease 过期或旧 completion 晚到 | 只有最新 fencing token 可提交；旧结果留审计后拒绝 | yes |
| untrusted 文本提权、模型路由不允许数据等级、Evidence 不可访问 | fail closed；相关 Claim 不发布或标记不可验证 | yes |
| 旧仓库/分支/dirty 内容无法恢复或迁移项依赖 Paperclip 领域 | 停止归档改名或拒绝迁移，不覆盖现有工作 | yes |
| VersityGW/对象缺失、下载越权或 DB/Artifact 恢复点不一致 | Artifact 不发布，Claim 标记不可验证，Gate/毕业失败 | yes |
| UI 403/404/409/offline/stale 或 Gate 0 触发未开放真实动作 | 显示安全可行动状态；真实分析/导出保持禁用，不泄露缓存或资源 | yes |
| Gate A 缺少可解析验收人、真实数据、独立 Goal A/Goal B 证据或标准 verdict | 业务验收 `blocked`；不得用 unit、fake、fixture 或单张截图替代 | yes |

其余实现级错误矩阵、字段级状态和恢复细节按技术附录执行；新增 review finding 只有在阻塞当前目标或造成安全/权限风险时才能进入本合同。

## Verification Plan

基础检查：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:contracts`、`pnpm test:integration`、`pnpm test:security`、`pnpm test:eval`、`pnpm test:e2e`、`pnpm build`。

新仓库必须提供 `pnpm verify:gate0.1`、`verify:gate0`、`verify:gate-a` 至 `verify:gate-g` 的稳定聚合命令。`verify:gate0.1` 必须在同一 run 同时验证 served assets/小纬可操作流程，以及 tenant isolation、服务端 principal、delegated capability、Approval/hash、事件幂等、Evidence publish guard 和无 provider/connector 旁路；任一失败都不能声称首个 UI slice 通过。每个命令以退出码表示结果；被 verdict 引用的精选证据写入 Workflow Artifact root，其他批量原始证据可写入 `/tmp/geneway-runs/<run-id>/`，Git 每阶段只保留精简 evidence index、gate checklist、business acceptance 摘要/索引和 phase review。`verify:gate-a` 必须执行 `codex-team-artifact-lint --task <task-id> --strict --business-acceptance` 并校验真实订阅、GearJob 和两项 dual-goal 业务验收；`verify:gate-e` 无受控真实租户时保持未完成。

服务入口、故障注入矩阵、UI 尺寸/状态、Connector 字段和完整 conformance 项目由技术附录定义；它们不得降低本合同 AC，也不得通过附录新增当前 Gate 的产品范围。

## Migration Rules

- 先建立新合同和测试，再按文件迁移已验证机制；每项记录 source ref/path、target、许可证、去除的 Paperclip 耦合和新测试。
- 优先迁移 OpenAI worker/provider conformance、structured output、取消/预算、tool IPC、故障测试、Evidence、渠道幂等和 SSE cursor；先按旧固定版本回放，再单独升级。
- 禁止迁移 Paperclip pipeline/issue/interaction 权威、Builder schema/roles、小红书闭环、插件 state outbox 和直接 issue/comment 映射；production code 禁止 `@paperclipai/*`。
- 共享订阅保留官方 `aisdk()` 接缝和经来源/锁文件/live conformance 验证的固定 provider；禁止改用 Codex CLI/app-server/ACP 或自研 OAuth。

## Failure And Stop Conditions

- 旧仓库归档/恢复失败，或 GitHub 改名、本地移动、GearJob facade 变更没有对应授权。
- 新 `geneway` 无法隔离 Paperclip 权威，或 Runtime/Hatchet/渠道/浏览器必须保存第二份任务、Workflow 或审批状态。
- Model/Tool/Connector Gateway、服务端身份、精确资源授权或 ApprovalVersion 必须被旁路。
- Hatchet/Agent 必须执行动态代码，首个 Runtime/Worker 必须持有长期员工或工业系统凭据。
- 共享订阅被要求用于生产、多租户、远程 sandbox、客户 VPC，或依赖/refresh/crash/quota/secret conformance 未通过仍要求启用。
- 真实数据缺少只读范围、数据字典、retention、audience、模型出域批准，或 GearJob 只能用 DB/通用 SQL/宽 service credential/先宽取后过滤接入。
- Workflow 图、审批 hash 和实际 DSL 不能严格一致；客户入口必须暴露多个专家身份或专家选择必须提权。
- Gate 0.1 无真实 API + served UI；Gate A 缺少两个业务场景的具名 owner、真实证据或 `passed` verdict。
- Capability 未通过回归、Evidence、安全、故障与恢复却要求毕业、外部开放或扩权。
- 对象存储被要求改用 MinIO，或 Postgres/Artifact 无法形成可验证的联合恢复点。
