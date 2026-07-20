# geneway Gate 0.1 最终实施合同

workflow_id: 20260720-010-geneway-gate-0-1
task_id: 20260720-010-geneway-gate-0-1
title: geneway Gate 0.1 安全产品纵切
contract_status: final
current_authoritative_contract: ./implementation-contract.final.md
created: 2026-07-20
finalized: 2026-07-20
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
safe_fallback_authority: none
work_type: implementation
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `G0.1-PRODUCT`：交付真实 HTTP 小纬 WebChat。用户从一个版本固定、预置、只读的脱敏方案分析 fixture 中选择材料，可选择 `auto`、一个专家或一个专家团，确认固定 Workflow 节点图后运行任务，并查看进度、结果和内联来源；客户消息作者只有 `{user, xiaowei}`。
- `G0.1-AUTHORITY`：Control Plane Postgres 是 Conversation、BusinessTask、BusinessTaskEvent、ExpertCatalogVersion、HarnessVersion、WorkflowVersion、ApprovalVersion、业务 Step、最小 Claim 和 EvidenceRef 的唯一权威；UI、Worker、Runtime 和事件流只读取或提交受控命令，不保存第二份权威。
- `G0.1-WORKFLOW`：`solution.analysis.v1` 的固定七节点 TS 对象模板只产生 `WorkflowDraft` JSON；Zod 4 是唯一结构 Schema；Compiler 产出不可变 RFC 8785/JCS canonical `WorkflowVersion` JSON、`canonicalizationVersion` 和 SHA-256 hash；审批、React Flow 和 Interpreter 使用同一个 `id + hash`。
- `G0.1-SAFETY`：真实产品纵切与 tenant 隔离、服务端派生的 loopback trusted-local principal、最小资源授权、delegated capability、完整 ApprovalSubject digest、事件幂等和 Evidence publish guard 同门完成；Gate 0.1 不存在真实 provider/connector 路由、凭证或开放出网执行面，所有未开放 kind 均 fail closed。
- `G0.1-SIMULATION`：Gate 0.1 只使用服务端 fake Runtime 和预置脱敏输入引用。BusinessTask、BusinessTaskEvent、业务 Step、最终结果/Claim、Evidence 及 UI/API 投影必须一致、可机器判定地得到 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`；允许从权威父实体无歧义派生，不要求每张表机械重复字段。任何缺失或冲突均不得发布结果或通过 Gate，且不得暗示已调用真实模型、GearJob 或真实专家。

### Non-goals

- 不实现任意文件上传、Artifact 下载、报告文件、VersityGW、完整 Claim–Evidence–Lineage 或完整 inbox；这些属于 Gate 0.2。
- 不调用共享 Codex 订阅、OpenAI Agents SDK、Claude、GearJob 或任何真实工业 Connector，也不实现 Model/Tool/Connector Gateway；这些属于 Gate A/F 或后续授权。
- 不引入 Hatchet、动态 Harness/Workflow Draft/Patch、条件、并行、等待、运行中改图或版本 Diff 编辑；这些属于 Gate B/C。
- 不实现异常中心、设备异常、产能落后、生产日报、TanStack Table、飞书或第二 Runtime；这些属于后续非执行路线图。
- 不开放 D1/W1/W2/W3 写动作，不使用 MinIO，不引入 Paperclip 运行依赖，不从保留的 dirty worktree 直接复制代码。
- 不为未来 Gate 创建返回成功的空验证脚本；未开放 Gate 如需占位，必须非零退出并输出 `NOT_OPEN`。

### Files or surfaces likely affected

- `apps/control-plane/`、`apps/web/`、`apps/worker/`
- `packages/contracts/`、`packages/authorization/`、`packages/workflow/`、`packages/runtime/`、`packages/evidence/`、`packages/ui/`
- `db/`、`migrations/`、`scripts/`、workspace manifests 与 Gate 0.1 验证配置
- `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/`，仅保存本 Gate 的小型验收摘要和索引

### User-visible behavior

用户打开小纬页面，选择一份标记为模拟的脱敏材料和专家路由，查看并确认固定 Workflow 图；任务经真实 API、Postgres、普通 Interpreter 和服务端 fake Runtime运行。页面显示模拟标识、步骤进度、结果、最小来源引用及不可变 WorkflowVersion `id + hash`，刷新后从 Control Plane 快照和事件 cursor 恢复。

Gate 0.1 的固定流程为：

```text
document_ingest
→ requirement_extract
→ contradiction_check
→ solution_design
→ evidence_verify
→ result_quality_check
→ report_publish
```

固定 fixture 至少产生一个可发布的正向 oracle：结论“当前材料明确要求生产工单跟踪和质量追溯”必须关联版本固定的来源片段及 hash；候选结论“当前材料要求直接控制设备”因无来源不得发布。文字可在保持语义的前提下调整，但测试必须验证同一 Claim–Evidence 关系与无证据拒绝路径。

## Prerequisite

Gate R 已于 2026-07-19 关闭；`taotaosihao/geneway` 与 `/home/gewu/work/geneway` 已确认为唯一产品代码基地。证据见 [`doc/migrations/gate-r-verification.md`](../../../migrations/gate-r-verification.md)。Gate R 不属于本合同待执行范围。

## First Code Slice Guard

- first_code_slice: 实现真实产品行为：Vite/Fastify 服务完成“选择预置脱敏输入 → 选择 auto/专家/专家团 → 创建 BusinessTask → 查看固定 Workflow 图和 hash → 批准 → 服务端 fake Runtime 执行 → 查看模拟结果与内联来源”的纵切。
- first_code_slice_kind: product
- first_code_owner: `role:gate-0.1-implementation-owner`；用户授权实施时必须解析为具名负责人。
- first_code_verification: `pnpm verify:gate0.1`，并关联同一 browser task id、API/DB BusinessTask、WorkflowVersion id/hash、ApprovalVersion 和 SSE cursor。
- allowed_contract_gate_only_until: 本合同、SDD v2 authority slice 和新 authoring lint 完成；Gate 0.1 实施获授权后，合同、scanner、fixture 或 headless 工作不得成为首个逻辑提交的唯一行为变化。
- stop_if_no_code_by_phase: Gate 0.1 vertical 首个逻辑提交
- gate_parallelization_or_deferral_plan: `0.1a foundation` 完成最小权威、Schema/Compiler、授权、Approval、Interpreter、Claim/Evidence 合同；`0.1b vertical` 完成真实 served UI 和端到端实体关联。两者是同一产品 Gate 的内部审查切片，各自拥有独立 base/head、owned paths、checks 和 reviewer verdict；Schema parity/property 扩展、Artifact、异常、真实 Runtime、Hatchet、渠道和后续 Gate 全部后置。
- Ordering rule: `0.1a foundation → 0.1b vertical` 是同一 Gate 内部顺序，不是两个可独立宣称通过的产品 Gate；只有两个内部 slice 与统一 `pnpm verify:gate0.1` 全部通过才能关闭 Gate 0.1。
- First-code rule: 首个切片可以使用 fixture 和 fake Runtime，但必须改变真实产品、API、数据库或工作流行为；文档、scanner fixture 和证据包本身不算产品代码。
- Safety rule: 纵切不得先以无授权、无 tenant、无审批或无 Evidence guard 的方式通过，再在后续补安全。

### Internal slice map

| Slice | Base / head rule | Owned paths | Required checks and exit oracle | Conclusion |
| --- | --- | --- | --- | --- |
| `0.1a foundation` | base 为 authority brief 的 `base_sha`；head 为通过独立 review 的 foundation 逻辑提交 | authority brief 中与 Control Plane、Worker、contracts/authorization/workflow/runtime/evidence、DB/migrations/scripts/manifests 相关的最小子集及 Gate evidence 摘要目录，不扩大总 owned paths | `pnpm test:contracts && pnpm test:integration && pnpm test:security` 加 schema/compiler/canonical suite；必须用真实 Postgres + Control Plane API + 普通 Interpreter/fake Runtime 探针证明 Approval、幂等、simulation、Claim/Evidence guard 可组合，不以组件存在代替集成 | 仅可声明 foundation ready，不能声明 Gate 0.1 通过 |
| `0.1b vertical` | base 必须是已批准的 `0.1a` head；head 为通过独立 review 的 served UI vertical 逻辑提交 | authority brief 中与 `apps/web`、Control Plane/Worker、`packages/ui` 及纵切依赖相关的最小子集及 Gate evidence 摘要目录，不扩大总 owned paths | `pnpm test:e2e -- --project=gate0.1` 加浏览器外 correlation；页面 task id 必须关联 API/Postgres、Workflow hash、Approval、SSE cursor 和一致 simulation 语义，并覆盖正向 Claim–Evidence 与无证据不发布 | 仅可声明 vertical ready，不能声明 Gate 0.1 通过 |
| `Gate 0.1` | base 为已批准的 `0.1b` head；最终 head 为完整门禁通过的逻辑提交 | 不超出 authority brief | `pnpm verify:gate0.1` 聚合 V-2 至 V-6，任何子项失败均非零 | 唯一允许的产品 Gate 通过结论 |

## Product/UI Acceptance Gate

- first_operable_user_flow: 在 `/conversations/new?capability=solution.analysis.v1` 完成预置材料选择、三种专家路由、固定 Workflow 图确认、批准、执行、结果与内联来源查看；不包含文件上传、报告下载或异常中心。
- browser_entrypoint: http://localhost:3200/conversations/new?capability=solution.analysis.v1
- served_ui_validation_action: Playwright 调用 page.goto("http://localhost:3200/conversations/new?capability=solution.analysis.v1") 访问真实 HTTP 服务并执行用户流。主 HTML、JS/CSS bundle 和 Control Plane API 必须由真实服务返回。UI 创建任务后必须以 task id 查询 API/Postgres，并核对 WorkflowVersion id/hash、ApprovalVersion 与 SSE cursor；服务端 fake Runtime 是唯一允许的成功路径模拟边界。
- ui_data_mode: 真实 Postgres、真实 Control Plane API、真实普通 Interpreter、服务端 fake Runtime、预置只读脱敏输入引用；全部结果标记为模拟且不可用于业务决策。
- required_safety_gates: tenant 隔离、loopback 服务端 principal、资源范围、delegated capability、R0/R1/A1 上限、ApprovalSubject/ApprovalVersion、事件幂等、Evidence 可访问性/publish guard、fake Runtime 隔离、未开放 kind 拒绝、无真实 provider/connector 路由/凭证/开放出网执行面、无跨租户缓存。
- allowed_headless_only_until: Gate 0.1 foundation 的最小 API/DB/Compiler/Authorization contract tests 通过；随后必须进入 served UI vertical，不能先扩展未来 Gate 证据。
- stop_if_no_ui_by_phase: Gate 0.1 vertical 首个逻辑提交
- Served UI evidence: HTML 和 JS/CSS 必须由真实服务器提供；网络拦截可用于单独标记的 403/409/offline 等负向测试，但不能替代成功路径 Control Plane API。
- Reverse guard: served UI 不能替代 required safety gates；headless 安全测试也不能替代 served UI。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | 真实 HTTP 页面只显示 `{user, xiaowei}`，支持 auto/单专家/专家团，完成固定 fixture、七节点图确认、批准、执行、带来源正向 Claim 与无来源不发布的首个可操作流程 | yes | Playwright served-UI e2e + author-set/Claim–Evidence assertions | goal:G0.1-PRODUCT |
| AC-PRODUCT-02 | 成功路径主文档、bundle 和 Control Plane API 未被浏览器 fulfill；browser task id 与 API/DB、Workflow id/hash、Approval 和 SSE cursor 指向同一实体链 | yes | browser network record + API/DB correlation test | goal:G0.1-PRODUCT |
| AC-AUTHORITY-01 | Conversation、BusinessTask、事件、ExpertCatalog/Harness/Workflow、Approval、Step、最小 Claim 和 EvidenceRef 仅由 Control Plane Postgres 权威持久化；同 operation/key 的同语义请求返回原结果，不同语义冲突失败；过期 attempt、重复、乱序和重放不重复推进 | yes | DB constraints + transaction/idempotency/fencing/replay tests | goal:G0.1-AUTHORITY |
| AC-WORKFLOW-01 | TS 模板只输出 plain `WorkflowDraft` JSON；Zod 4、Compiler、RFC 8785/JCS、`canonicalizationVersion` 和 golden vectors 产出唯一 WorkflowVersion/hash；拒绝代码、URL、未知引用、非有限数值和提权字段；production code 不引入 TypeBox、Ajv 或第二套 Workflow validator | yes | schema/compiler/canonical golden-vector tests + 复用既有 dependency/import check | goal:G0.1-WORKFLOW |
| AC-WORKFLOW-02 | React Flow、ApprovalVersion、Interpreter 和页面显示使用同一 WorkflowVersion `id + hash`；ApprovalSubject digest 还绑定任务、输入快照、resolved expert/harness、权限/受众/预算和模拟标记，任一执行语义变化使旧批准失效 | yes | projection/hash/approval-subject/CAS tests + Playwright | goal:G0.1-WORKFLOW |
| AC-SAFETY-01 | 服务仅允许 loopback 启动，代理头不能改变可信来源，principal/tenant 由服务端会话派生且客户端身份字段无效，浏览器写操作不能被跨站触发；跨租户、过期 capability、伪造身份、越权 Evidence 和未开放 Runtime/Tool/Connector kind 全部 fail closed | yes | authorization/session/cross-origin/security negative tests | goal:G0.1-SAFETY |
| AC-SAFETY-02 | 关键 Claim 仅由 Control Plane 权威记录，并只有在最小 EvidenceRef 可访问、来源 hash 和 tenant scope 有效时与事件原子发布；Runtime、SSE 和 UI 不能直接发布；Gate 0.1 不创建上传或下载接口 | yes | publish/access/transaction/API-route negative tests | goal:G0.1-SAFETY |
| AC-SAFETY-03 | fake Runtime 不持有真实 provider/connector 凭证或开放调用路由，不接受任意 URL/网络工具，未开放 kind 返回结构化 `NOT_OPEN`；真实 Gateway bypass conformance 不在 Gate 0.1 冒充完成 | yes | dependency/route/secret scan + controlled network/registry negative tests | goal:G0.1-SAFETY |
| AC-SIMULATION-01 | BusinessTask、BusinessTaskEvent、业务 Step、最终结果/Claim、Evidence 及 UI/API 投影必须一致、可无歧义派生并同时声明 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`；任一缺失或冲突时不得发布结果或通过 Gate，不得出现“已调用真实模型、GearJob 或真实专家”的误导性文本 | yes | contract tests + API/DB correlation + Playwright simulation assertions | goal:G0.1-SIMULATION |
| AC-MIGRATION-01 | 复用项只从已归档 commit/bundle 按文件迁移，记录 source SHA/path、许可证、去除的 Paperclip 耦合和新测试；无 `@paperclipai/*` 运行依赖或 Paperclip upstream | yes | migration manifest + dependency/remote scan | goal:G0.1-AUTHORITY |
| AC-GATE-01 | `pnpm verify:gate0.1` 聚合真实 Gate 0.1 检查；任何未来 Gate 占位命令均非零返回 `NOT_OPEN`，不得形成假通过证据 | yes | package script contract + exit-code tests | goal:G0.1-AUTHORITY |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V-1 | SDD authority 与合同 | `codex-team-validate-json --type brief ...`；`codex-implementation-contract-lint --strict --new-authoring --authority-slice ...` | task id、Goal refs、semantics v2 和 authority slice 一致 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-contract.txt` |
| V-2 | 基础质量 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | 全部退出 0 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-quality-summary.md` |
| V-3 | 权威与安全 | `pnpm test:contracts && pnpm test:integration && pnpm test:security` | DB 单权威、授权、ApprovalSubject、Claim/Evidence、fake Runtime 隔离和未开放 kind 负向测试通过；同一 task id 的 Task/Event/Step/Result/Claim/Evidence simulation 语义一致且缺失或冲突时失败 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-safety-summary.md` |
| V-4 | Workflow | 运行 schema/compiler/canonical golden-vector suite，并复用既有 dependency/import check | 同输入跨进程得到同 hash；非法 Draft fail closed；production code 无 TypeBox、Ajv 或第二套 Workflow validator | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-workflow-summary.md` |
| V-5 | Served UI | `pnpm test:e2e -- --project=gate0.1` | 真实页面完成首个流程，只有小纬，正向 Claim/Evidence 与无证据拒绝均符合固定 oracle；页面、任务、步骤、结果和来源的模拟语义明确一致 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-ui-summary.md` |
| V-6 | API-backed UI | 浏览器外探针用页面实际 task id 核对 API、Postgres、Workflow hash、ApprovalSubject/ApprovalVersion、SSE watermark/cursor 及 Task/Event/Step/Result/Claim/Evidence 的 simulation 语义；phase review 检查成功路径 spec、helper、global setup、config 与响应替代设施 | 成功路径主页面、bundle 和 Control Plane API 未被 `setContent`、`fulfill`、Service Worker 或等价代理替代；实体链和模拟语义一致，任一缺失或冲突时失败 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-api-ui-correlation.md` |
| V-7 | 总门禁 | `pnpm verify:gate0.1` | V-2 至 V-6 任一失败时非零；全部通过才返回 0 | `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/gate-0.1-phase-review.md` |

## Evidence Budget

- Git 只在 `doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/evidence/` 保存 Gate 0.1 的 `gate-checklist.md`、`phase-review.md`、`evidence-index.md` 与必要的最终摘要，目标不超过 10 个文件和 1 MB；其他位置不得创建平行 evidence 目录。
- Playwright JSON、trace、video、HAR、完整日志、API dump、数据库 dump、端口状态和失败重试输出写入 `/tmp/geneway-runs/<run-id>/`。
- 浏览器截图只能补充说明，不能单独证明 API、数据库、权限、审批或业务状态。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| 专家不存在、未授权、不健康或不在 Capability allowlist | 明确失败或请求用户重新选择；不静默 fallback，不扩大权限 | yes | goal:G0.1-PRODUCT |
| Workflow 含代码、URL、未知引用、`undefined`、`NaN`、`Infinity` 或 hash 不一致 | Compiler 拒绝，不产生可批准或可执行版本 | yes | goal:G0.1-WORKFLOW |
| 批准后输入、专家目标、Workflow/Harness、预算、范围或受众变化 | 旧 ApprovalVersion 失效；必须生成新版本并重新确认 | yes | goal:G0.1-WORKFLOW |
| 同一 operation/key 重放 | 同一请求语义返回原结果；不同请求语义结构化冲突失败；业务状态、权威事件与必要 outbox 原子提交 | yes | goal:G0.1-AUTHORITY |
| 快照与 SSE 订阅交界、重连、乱序事件或旧 completion | 快照返回一致 watermark，续传只读取其后的事件；稳定 event id 去重且 tenant/task 鉴权；过期 attempt 不推进 Step | yes | goal:G0.1-AUTHORITY |
| 跨租户、伪造 principal、过期 delegated capability 或 Evidence 不可访问 | 请求失败，不泄露缓存、消息、Workflow 或来源 | yes | goal:G0.1-SAFETY |
| 用户尝试上传文件、下载报告、访问异常中心或调用真实 Runtime/GearJob | 返回 `NOT_OPEN` 或禁用态，不创建隐式临时文件，不自动扩大 Gate | yes | goal:G0.1-SIMULATION |
| fake Runtime 失败、超时或返回无 Evidence 结果 | 任务进入结构化失败/需人工状态，候选 Claim 不进入 Control Plane 已发布状态，不伪造成功 | yes | goal:G0.1-SIMULATION |

## Implementation Notes

- Gate 0.1 内部顺序为 `foundation → vertical`；它们不是独立产品 Gate。
- 最小数据库清单按技术附录 Gate 0.1 表执行；不得提前建立 Gate 0.2/A/D 专属表来制造“基础设施完成度”。
- 首次引入依赖只限 Gate 0.1 所需：Fastify、Drizzle/Postgres、Zod 4、React/Vite、assistant-ui、Base UI、React Flow，以及实现最小授权所需的 Casbin。TanStack Table、VersityGW、OpenAI Agents SDK 和 Hatchet 后置。
- 复用旧代码时只能读取归档 commit/bundle；保留的 dirty worktree 不是可信迁移源。

## Failure And Stop Conditions

- 如果实现要求任意文件上传、Artifact 下载、真实模型、GearJob、Hatchet、动态 Workflow、异常中心、飞书或第二 Runtime，停止并返回范围决策，不在 Gate 0.1 内吸收。
- 如果必须让浏览器、Worker 或 fake Runtime保存第二份 BusinessTask、Workflow 或 Approval 权威，停止实施。
- 如果真实 served UI 只能通过 fulfill Control Plane API 才能通过，或者 safety gates 需要后补，Gate 0.1 失败。
- 如果出现真实 provider/connector 路由、凭证或开放出网执行面，未开放 kind 未拒绝，跨租户访问、过期 ApprovalSubject 或无 Evidence Claim 无法 fail closed，Gate 0.1 失败。
- Required safe fallback: not_applicable
- 未开放能力只允许明确失败或禁用，不允许静默降级、提权或伪造业务成功。

## Provenance

- 产品与长期路线来源：[`doc/reference/制造业数字员工平台_内部能力内核细节终审与兼容实施方案_v19.md`](../../../reference/制造业数字员工平台_内部能力内核细节终审与兼容实施方案_v19.md)
- Gate R 证据：[`doc/migrations/gate-r-verification.md`](../../../migrations/gate-r-verification.md)
- 技术实现参考：[`doc/plans/2026-07-18-geneway-v19-technical-appendix.md`](../../2026-07-18-geneway-v19-technical-appendix.md)
- UI ADR：[`ui-design.md`](ui-design.md)
- 历史合同：旧任务 `20260715-044-paperclip-agent-mvp` revision 7，已被本合同替代，仅作审计来源。
- 2026-07-20 只读 Team Review：`/home/gewu/.codex/workflow/artifacts/20260715-044-paperclip-agent-mvp/team/decision.md`。

## Finding Provenance

本合同的可执行要求全部来自新任务 authority brief 的稳定 Goal refs；历史 reviewer 严重级别和修复建议不直接授予范围。Gate 0.2–G 保留在非执行路线图，待用户授权后另建 authority slice。

## Final Contract Cleanliness Gate

- [x] 本文件是最终要求的 clean rewrite。
- [x] Gate R 和旧 Paperclip 要求不再作为待执行指令。
- [x] `clarify.md`、`spec.md`、主计划和 UI 文档不再是第二份可执行 scope。
- [x] Required acceptance 和 edge case 均绑定 authority Goal ref。
- [x] Gate 0.2–G 仅作 non-executable roadmap，不获得当前实施权限。
- [x] 原始日志、trace、视频和批量证据默认留在 Git 之外。
