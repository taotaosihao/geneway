# geneway Gate A0 Fast Chat 无材料真实对话纵切实施合同

workflow_id: 20260723-002-geneway-fast-chat
task_id: 20260723-002-geneway-fast-chat
title: geneway Gate A0 Fast Chat 无材料真实对话纵切
contract_status: changes_required
current_authoritative_contract: doc/plans/atlas-workflow/20260723-002-geneway-fast-chat/implementation-contract.final.md
created: 2026-07-23
contract_semantics_version: 2
finding_scope_admission: controller_current_required_only
safe_fallback_authority: goal:A0-SAFETY
work_type: implementation
first_code_guard: required
first_code_not_applicable_reason:
product_ui_gate: required
product_ui_not_applicable_reason:

## Scope

### Goal

- `A0-PRODUCT`：在真实 served geneway Web 中，用户打开默认小纬新会话后，无需上传 `DocumentSnapshot` 即可发送普通文本，看到真实模型的流式回答、继续追问并停止生成。
- `A0-ROUTING`：新增 `xiaowei.chat.v1` 并把默认 Composer 路由到普通聊天；聊天只写 Conversation、Message、ModelInvocation 与审计，不创建 BusinessTask、WorkflowRun、Evidence 或 Artifact。用户只有显式选择“分析材料”时才进入 `solution.analysis.v1`，原材料、审批、Evidence、Artifact 和任务状态机保持不变。
- `A0-MODEL`：真实调用只通过 Model Gateway 的逻辑模型策略和 `codex_subscription_dev` provider plugin；Runtime、Worker、Control Plane 和 Web 不读取 auth-file 或 token，不直连 provider，也不静默切换 API key、账号、模型或 Codex CLI。
- `A0-AUTHORITY`：Control Plane Postgres 是 Conversation、Message、ModelInvocation、幂等、事件游标、取消与终态的唯一业务权威；UI、SSE、Runtime、Worker 与 Model Gateway 只消费命令或投影事件。
- `A0-CONTEXT`：Gate A0 固定使用服务端共享 `tenant_local/user_local`；每轮上下文只从当前 Conversation 的服务端消息构造并使用有界最近消息窗口，不混入该共享 principal 的其他 Conversation。客户端提交的 tenant/principal 覆盖值无效。
- `A0-FAILURE`：取消、鉴权失败、配额、超时、provider 错误、流中断与 Worker/Gateway 退出进入明确终态；未配置或未通过 conformance 的 live route 不得回退 FakeRuntime 冒充真实回答。
- `A0-DEV`：复用 `pnpm dev-up` 启动单用户、共享会话的 trusted-local 临时验收栈，自动发现本机现有 `192.168/16` 与 `10/8` Web 地址且默认进入 `/conversations/new`。所有能访问这些地址的设备都视为同一个 `tenant_local/user_local`，共享 Conversation、上下文与取消能力；本 Gate 不要求配对。只有 Web 暴露到局域网，真实模型凭据和内部服务继续留在 loopback/UDS 边界。
- `A0-SAFETY`：首版 `tool_choice=none`，不访问联网搜索、企业知识、GearJob、Connector 或生产写；所有 provider credential、请求 redaction、数据等级、预算、用量、取消和错误映射可审计且不泄密。

### Non-goals

- 不在本 Gate 交付企业知识库、检索增强、联网搜索、GearJob 查询、外部 Connector 或任何生产写操作。
- 不把 `solution.analysis.v1` 切换到真实 Runtime，不修改其 WorkflowVersion、Approval、Evidence、Artifact 或材料执行条件。
- 不引入 Hatchet、多 Agent、动态 Harness/Workflow、WorkflowDraft/Patch、条件、并行或等待。
- 不开放任意 Shell、主机文件系统、代码修改、通用 Runner、Codex CLI/app-server/ACP 或外部 Agent。
- 不承诺客户生产发布、生产 SLA、共享并发、多 provider、计费、客户 VPC 或 C2/C3 真实业务数据。
- 不提供注册、登录、长期 session、每浏览器独立 principal、LAN 设备之间的 Conversation 隔离或客户生产身份；正式身份与多用户隔离在后续独立身份切片处理。
- 不完成、不删除、不降级 Gate 0.2B.2–0.2B.3；它们保持延期且未关闭。

## Execution Order And Authority

1. Gate R、Gate 0.1、Gate 0.2A 与 Gate 0.2B.1 是已关闭基线。
2. 本合同仅授权 Gate A0；Gate 0.2B.2–0.2B.3 从当前关键路径延期，但仍受其原合同约束且不得宣称完成。
3. Gate A0 关闭后恢复 Gate 0.2B.2–0.2B.3；原 Gate A 继续负责真实材料分析与 GearJob 单工单只读查询。
4. 本合同与 Gate 0.2B 合同发生冲突时，只有 Gate A0 owned paths 和本合同 Goal 范围由本合同控制；异常、fixture、认领、异常分析绑定与 0.2B 恢复矩阵仍由原合同控制。
5. 文档支持材料不能扩大本合同；未列入 Goal 的发现只记录为 follow-up，除非由当前 controller 正式准入为 `current-required`。

## Product And API Contract

### Capability 与路由

- 新增 immutable CapabilityVersion `xiaowei.chat.v1` 与 PromptPolicyVersion `xiaowei.chat.system/1`，状态仅允许在可信本机由 `draft → shadow → internal` 推进；本 Gate 不进入 customer-production。系统提示只能由服务端版本解析，客户端不能提交或覆盖。
- 默认入口固定为 `/conversations/new`；`/conversations/new?capability=xiaowei.chat.v1` 是等价显式入口。
- `/conversations/new?capability=solution.analysis.v1` 继续作为材料分析入口；没有合格 `DocumentSnapshot` 时仍禁用或拒绝分析执行。
- `/conversations/:conversationId` 从服务端恢复同一 Conversation、消息和最新 ModelInvocation；不得用 localStorage 作为消息或运行权威。

### Public wire contract

所有新增 public wire schema 以 Zod 4 为单一来源并生成 JSON Schema artifact，不手写第二份 schema 或引入第二 validator。最小接口固定为：

```text
POST /api/conversations/:conversationId/chat-runs
  body: capabilityId=xiaowei.chat.v1, content, clientMessageId
  headers: Idempotency-Key
  response: conversationId, userMessageId, assistantMessageId,
            modelInvocationId, eventCursor, status

GET /api/conversations/:conversationId/chat-runs/:modelInvocationId/events?cursor=...
  event: run.started | message.delta | message.completed |
         run.canceled | run.failed

POST /api/conversations/:conversationId/chat-runs/:modelInvocationId/cancel
  response: modelInvocationId, status, eventCursor
```

- 服务端忽略客户端 tenant、principal、model/provider、data class、budget 和 audience 覆盖值；Gate A0 的 tenant/principal 固定由受控 `dev-up` Web → loopback Control Plane 路径解析为共享 `tenant_local/user_local`，其他字段由 Capability policy 和 Model Gateway policy 派生。
- `content` 首版仅允许非空纯文本，限制规范化后最大 16 KiB；拒绝 NUL、非法 UTF-8 和超限输入，不执行 HTML/script。
- 同一 principal、Conversation、`Idempotency-Key` 与规范化语义只能产生一个 user Message 和一个 ModelInvocation；相同 key 不同语义返回 409。
- 同一 Conversation 首版最多一个 active ModelInvocation；同一 `codex_subscription_dev` profile 全局最多一个 active provider 调用。超过上限返回明确 busy/retry 信息，不无限排队。

### Conversation、Message 与 ModelInvocation

- Conversation audience 仍为 requester-private，但 Gate A0 的 requester 是共享 `tenant_local/user_local`：任一能访问本次 192/10 Web 入口的设备都具有读取、继续、恢复和取消该共享 principal 全部 Conversation 的同等能力。这是产品指定语义，不是跨 LAN 设备隐私边界。
- user Message 与 pending ModelInvocation 在同一 Control Plane transaction 中写入，同时记录 outbox/dispatch intent；assistant Message 使用预分配 ID，并在 delta 期间只保存受控 checkpoint，terminal transaction 冻结最终内容、状态、usage 和 model audit。
- Message 角色 public schema 仍只允许 `{user, xiaowei}`；provider、专家、系统提示和内部错误不得成为客户消息作者。
- ModelInvocation 至少记录 logicalModelPolicy、promptPolicyVersion、routeProfile、provider/model revision、dataClass、redactionPolicyVersion、budget/deadline、usage 或 `unpriced`、startedAt、terminalAt、terminalStatus、errorClass 和最后 event cursor；不得记录 token、auth-file 路径或未脱敏原始 provider payload。
- 上下文窗口固定为当前 Conversation 最近 24 条已完成 user/xiaowei Message，规范化总文本上限 64 KiB；超过时从最旧完整轮次开始截断并记录 `contextTruncated=true`，本 Gate 不生成长期记忆或隐藏摘要。
- incomplete、failed 或 canceled assistant Message 不进入后续模型上下文；UI 可显示其明确终态，不把部分输出伪装为完整答案。

## Runtime And Model Gateway Contract

- Control Plane 通过现有本机 Worker 命令边界派发 `execute_chat_turn`；Worker 使用 `packages/runtime` 的 ChatRuntimeAdapter 调用 Model Gateway facade/RPC。业务终态只能由 Control Plane transaction 提交。
- Model Gateway 是独立 loopback/UDS 服务，provider plugin 是唯一可读取仓库外 auth-file 的进程；Runtime、Worker 与 Control Plane 只传逻辑策略和短期 invocation token。
- Gate A0 只开放逻辑策略 `general.chat.standard`，固定 data class 为 C0/C1；C2/C3、文件正文、企业数据和工具结果不得进入该路由。
- `codex_subscription_dev` 固定为 trusted-local-only、单具名 owner、单 active invocation、`subscription_included/unpriced`。auth 目录必须为 `0700`、文件 `0600`、同一 OS owner、非 symlink；凭据检查失败时 live route 不启动。
- 迁移复现基线沿用技术附录固定版本；第三方 OAuth bridge 的来源、许可证、完整性或 live conformance 任一失败时 fail closed，不自研 OAuth/PKCE/token refresh，也不调用 Codex CLI。
- Model Gateway 必须支持并验证 stream、cancel、deadline、quota/retryNotBefore、usage/unpriced、provider error 映射和 secret redaction。A0 `tool_choice=none`；任何 tool call 输出均作为协议违规终止。
- 没有可用 live route 时 UI 显示“真实模型通道未配置或不可用”，不得调用 FakeRuntime、静态模板或浏览器 mock 生成成功回答。

## Security And Failure Contract

- Gate A0 不建立浏览器身份或配对 session。Control Plane 只接受受控 Web 代理的 loopback 请求，并为其使用服务端固定的共享 `tenant_local/user_local`；客户端 tenant/principal、Forwarded/X-Forwarded-* 或 Origin 不得改变该身份。Origin allowlist 和精确 192/10 监听用于约束暴露面，不承担用户认证。
- 该模式假设本次局域网内所有访问者都可信，允许共享 Conversation、上下文和取消；可以使用 HTTP，不要求 Gate A0 增加 TLS。它不得被描述为客户生产身份、多用户隔离或能抵御同网段窃听的安全通道。
- Model Gateway invocation token 绑定 tenant、principal、Conversation、ModelInvocation、logical policy、data class、预算、deadline 与 nonce，短时有效且单次消费；provider credential 不下发。
- 系统提示、内部 policy、provider 请求/响应、错误堆栈和模型路由详情只进入受控 redacted audit，不进入客户消息或浏览器网络响应。
- cancel 使用 CAS 将 ModelInvocation 置为 cancel-requested 并递增 execution fence；迟到 delta/completion 不能把 canceled/failed 反写为 completed。
- Worker 或 Gateway 中断后，本 Gate 不自动恢复未完成生成；Control Plane 将 invocation 收敛为 failed/interrupted，用户可显式重新发送，幂等重放不得产生第二条已完成回答。
- 所有错误使用稳定 error class：`MODEL_ROUTE_UNAVAILABLE`、`MODEL_AUTH_FAILED`、`MODEL_QUOTA`、`MODEL_TIMEOUT`、`MODEL_STREAM_INTERRUPTED`、`MODEL_PROTOCOL_VIOLATION`、`CHAT_BUSY`。UI 显示可理解中文，不暴露 secret 或内部路径。

## Internal Slice Map

| Slice | Owned behavior | Required checks and exit oracle | Allowed conclusion |
| --- | --- | --- | --- |
| `A0.1 real first-turn chat` | Zod chat wire、Conversation/Message/ModelInvocation migration、`xiaowei.chat.v1`、最小 Model Gateway/Runtime/Worker 路径、默认 Composer 无材料首问与真实流式输出 | contract lint；contracts/integration/security；真实 served Web + live provider 首问；UI/API/Postgres/Gateway audit 同 invocation 关联 | 只能声明 real first-turn chat ready |
| `A0.2 context/cancel/failure` | 24 条/64 KiB 有界上下文、多轮、当前 Conversation 上下文边界、客户端身份覆盖拒绝、取消 fencing、quota/timeout/stream failure、SSE cursor 与幂等 | context isolation、client-override、fault injection、cancel race、cursor replay、secret scan、live 追问与停止生成 | 只能声明 context/cancel/failure ready |
| `A0.3 LAN/regression hardening` | `dev-up` 启动 Gateway/Worker/Control Plane/Web，192/10 网段共享 trusted-local 浏览器路径，材料分析材料门与 Gate 0.2B.1 回归，聚合门 | `pnpm verify:gate-a0`；两个 LAN 浏览器以同一 `tenant_local/user_local` 共享 Conversation/上下文/取消；默认 URL 首问/追问/停止；`solution.analysis.v1` 与 `verify:gate0.2b.1` 通过 | 只能声明 Gate A0 ready |

## First Code Slice Guard

- first_code_slice: `A0.1 real first-turn chat` 必须在同一首个逻辑实现结果中交付真实 served `/conversations/new`、无材料普通文本提交、真实 Model Gateway 流式回答，以及同一 ModelInvocation 的 UI、API、Postgres 与 Gateway redacted audit 关联。
- first_code_slice_kind: product
- first_code_owner: `role:gate-a0-fast-chat-implementation-owner`；获得产品代码实施授权后必须解析为具名负责人。
- first_code_verification: `pnpm test:e2e -- --project=gate-a0-live gate-a0-fast-chat.spec.ts`，并核对同一 conversation/message/modelInvocation ID 在 UI、API、Postgres、Worker 与 Model Gateway audit 中一致。
- allowed_contract_gate_only_until: authority brief、本最终合同与 strict new-authoring lint 完成；获得产品代码实施授权后不得继续只产出 contract、provider fixture、schema 或 mock-only 测试。
- stop_if_no_code_by_phase: `A0.1 real first-turn chat` 首个逻辑提交。
- gate_parallelization_or_deferral_plan: `A0.1 → A0.2 → A0.3` 串行关闭；0.2B.2–0.2B.3 延期到 Gate A0 后，不能与 Gate A0 在同一工作树并行写入或混合完成声明。
- First-code rule: 首个切片必须改变真实产品、API、数据库和模型执行行为；静态页面、headless model、migration-only、provider conformance-only 或模拟回答均不算。
- Safety rule: 服务端固定共享 tenant/principal、客户端身份覆盖无效、Model Gateway 唯一出口、secret 隔离、无 FakeRuntime fallback、普通聊天不创建 Task 必须与首个 UI 纵切同门完成。

## Product/UI Acceptance Gate

- first_operable_user_flow: 运行 `pnpm dev-up`，打开 `/conversations/new`，不上传材料发送“你好，请介绍你能做什么”，看到至少两个流式增量和 completed 回答；追问“我刚才问了什么”验证同会话上下文；启动一条较长回答并停止生成；再进入 `?capability=solution.analysis.v1` 验证无合格材料时仍不能创建分析任务。
- browser_entrypoint: http://localhost:3200/conversations/new
- served_ui_validation_action: Playwright 使用 `page.goto("http://localhost:3200/conversations/new")` 访问真实 Vite HTTP 服务并完成首问、流式回答、追问、停止生成和材料分析回归；主 HTML、JS/CSS、Control Plane API、SSE 与模型回答必须全部来自真实服务和 live provider，禁止合成主文档、应用 bundle、API 响应或模型回答。
- ui_data_mode: 真实 Vite Web、Control Plane/Postgres、UDS Worker、loopback/UDS Model Gateway 与 `codex_subscription_dev` live provider；普通聊天无工具、无材料，材料分析回归继续使用既有受控 fixture/FakeRuntime 且醒目标记模拟。
- required_safety_gates: 服务端固定共享 `tenant_local/user_local`、客户端 tenant/principal 覆盖无效、当前 Conversation 上下文不串线、Zod wire、幂等、单 active invocation、Model Gateway 唯一出口、auth-file 权限与 secret redaction、C0/C1、tool_choice=none、budget/deadline/cancel fencing、无 FakeRuntime fallback、普通聊天零 BusinessTask/Workflow/Evidence/Artifact、材料分析门不退化。
- allowed_headless_only_until: `A0.1` 的 migration、contracts、Model Gateway conformance 与 API integration 首次通过；同一首个逻辑实现结果必须提供真实 served UI + live provider 首问。
- stop_if_no_ui_by_phase: `A0.1 real first-turn chat` 首个逻辑提交。
- Served UI evidence: 主文档、bundle、API 与 SSE 来自真实服务；live provider 回答的 invocation ID、终态和 redacted route audit 可在浏览器外重验。
- Reverse guard: 仅让 Composer 可输入、展示静态文本、使用 FakeRuntime、mock provider 或只有 Gateway conformance 均不算 Fast Chat 可用。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
| --- | --- | --- | --- | --- |
| AC-PRODUCT-01 | 无 `DocumentSnapshot` 的新 Conversation 可发送普通文本，真实模型至少产生两个可见流式增量并 completed；同会话追问可引用上一轮 | yes | live provider integration + served browser first-turn/follow-up | goal:A0-PRODUCT |
| AC-ROUTING-01 | 普通聊天只创建 Conversation/Message/ModelInvocation/audit，不创建 BusinessTask、WorkflowRun、Evidence 或 Artifact；显式材料分析仍要求合格材料 | yes | API/DB assertions + `solution.analysis.v1` regression E2E | goal:A0-ROUTING |
| AC-MODEL-01 | Runtime 只按逻辑策略调用 Model Gateway；`codex_subscription_dev` stream/cancel/quota/usage/error conformance 通过，Web/Control Plane/Worker 无 provider credential 或旁路 | yes | process/network/dependency scan + live conformance + secret canary | goal:A0-MODEL |
| AC-AUTHORITY-01 | Conversation、Message、ModelInvocation、event cursor、取消和终态从 Postgres 恢复；刷新和 SSE 重连不创建第二回答或第二 invocation | yes | integration restart/replay/idempotency tests + browser refresh | goal:A0-AUTHORITY |
| AC-CONTEXT-01 | 当前 Conversation 的最近 24 条/64 KiB 已完成消息构成上下文并记录截断，不混入共享 principal 的其他 Conversation；客户端 tenant/principal 覆盖值无效。不同 LAN 设备以同一 `tenant_local/user_local` 访问、继续和取消同一 Conversation 是预期行为 | yes | context boundary + shared-principal dual-browser tests + client-override negative tests | goal:A0-CONTEXT |
| AC-FAILURE-01 | cancel、auth、quota、timeout、stream interruption、protocol violation 和 busy 都进入稳定非伪造终态；迟到 completion 不能覆盖 canceled/failed | yes | fault injection + cancel race/fencing + UI error oracle | goal:A0-FAILURE |
| AC-DEV-01 | `pnpm dev-up` 无需 LAN host 环境变量，只有 Web 在本机实际 192/10 地址可访问且默认进入 `/conversations/new`；所有访问者共享 `tenant_local/user_local` 并完成 live 首问、追问、停止生成，内部服务和凭据不暴露 | yes | actual shared-principal LAN browser run + listener/origin/secret inspection | goal:A0-DEV |
| AC-SAFETY-01 | Gate A0 只处理 C0/C1 普通文本、`tool_choice=none`，无知识库、联网、GearJob、Connector 或写动作；凭据不进入 Git/DB/S3/log/trace/screenshot/browser | yes | policy negative tests + egress/tool scan + credential canary scan | goal:A0-SAFETY |
| AC-REGRESSION-01 | Gate 0.2B.1 和 Gate 0.2A 已关闭基线保持通过，0.2B.2–0.2B.3 继续未完成且未开放 | yes | `pnpm verify:gate0.2b.1` + capability/status/document scan | goal:A0-ROUTING |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
| --- | --- | --- | --- | --- |
| V1 | authority + contract | strict new-authoring contract lint with Gate A0 authority slice | task/goal refs、first-code/UI 字段和 scope attribution 全合法 | Git 外 run summary |
| V2 | quality + wire | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:contracts && pnpm build` | Zod runtime/JSON Schema、类型、构建与既有单测通过 | Git 外 run summary |
| V3 | API/DB authority | `pnpm test:integration` | message/invocation transaction、幂等、context boundary、cursor、cancel fencing 与恢复通过 | Git 外 run summary |
| V4 | security + provider | `pnpm test:security && pnpm test:model-gateway` | shared trusted-local principal、客户端身份覆盖拒绝、credential、route bypass、C0/C1、tool none、quota/cancel/error conformance 通过 | Git 外 run summary |
| V5 | served live product | `pnpm test:e2e -- --project=gate-a0-live` | 真实 HTTP + live provider 完成首问、追问、停止生成、材料门回归；无浏览器成功 mock | Git 外 browser trace/screenshots |
| V6 | LAN + regression | 实际 `pnpm dev-up` LAN 验收；`pnpm verify:gate0.2b.1` | 192/10 默认 Fast Chat 入口可用，两个 LAN 浏览器共享同一用户/Conversation/取消，内部端口不暴露，已关闭基线不退化 | Git 外 listener/browser summary |
| V7 | aggregate | `pnpm verify:gate-a0` | 聚合 V2–V6，任一 required 项失败则非零 | 简洁验收结论与 run id |

原始日志、Playwright JSON、trace、视频、HAR、截图集、provider payload、端口状态、API/DB dump 和调试输出写入 `/tmp/geneway-runs/<run-id>/gate-a0/`；不得把 provider secret、auth-file 内容或未脱敏请求写入任何证据。

## Edge Cases

| Case | Expected behavior | Required | Admission |
| --- | --- | --- | --- |
| 新 Conversation 无材料发送普通问题 | 创建 user Message 与 ModelInvocation，流式写入小纬回答；不触发任何材料错误或 Task 创建 | yes | goal:A0-PRODUCT |
| 相同幂等键重放 | 同 principal/Conversation/语义返回同一 invocation 当前投影；不同语义返回 409，不新增消息或调用 | yes | goal:A0-AUTHORITY |
| 共享用户存在多个 Conversation | 每轮只装配当前 Conversation 消息，不混入其他 Conversation；任一 LAN 浏览器可按共享用户语义打开、继续或取消这些 Conversation | yes | goal:A0-CONTEXT |
| 客户端提交 tenant/principal 或 forwarded identity 覆盖 | 服务端继续使用固定 `tenant_local/user_local`，覆盖值不能创建新身份或改变数据范围 | yes | goal:A0-CONTEXT |
| 上下文超过 24 条或 64 KiB | 从最旧完整轮次开始截断并审计 `contextTruncated=true`，不生成隐藏长期记忆 | yes | goal:A0-CONTEXT |
| 用户在 stream 中取消 | CAS/fence 使 invocation 收敛为 canceled；迟到 delta/completion 被拒绝，部分内容不进入后续上下文 | yes | goal:A0-FAILURE |
| auth-file 权限、owner、symlink 或 conformance 不合法 | Model Gateway live profile 不启动，UI 明确提示 route unavailable，零 provider 调用 | yes | goal:A0-MODEL |
| provider 返回 tool call | 作为 `MODEL_PROTOCOL_VIOLATION` 失败，不执行、不展示为成功、不调用 Tool Gateway | yes | goal:A0-SAFETY |
| quota、timeout、流中断或 Gateway/Worker 退出 | 映射稳定错误并结束当前 invocation；不自动切账号/API key/FakeRuntime，不产生第二 completed 回答 | yes | goal:A0-FAILURE |
| 用户显式进入材料分析但无合格材料 | 保持现有材料门与错误，不改走普通聊天绕过 Task/Approval/Evidence | yes | goal:A0-ROUTING |
| 从 192/10 地址访问 | 默认进入 `/conversations/new`；Web Origin 被本次 dev-up 精确允许，所有设备共享 `tenant_local/user_local`；Control Plane、Gateway、DB、S3 和 Worker 仍不可从局域网直连 | yes | goal:A0-DEV |

## Failure And Stop Conditions

- Stop and ask the user when：没有可用且获准的具名 `codex_subscription_dev` owner/auth-file；第三方 bridge 无法置于 Model Gateway 边界后；需要改用 API key、其他账号、Codex CLI、客户生产 route、C2/C3 数据、工具、知识库或跨仓系统；当前 0.2B 未提交工作与 Gate A0 owned path 无法隔离。
- Treat the Gate as failed when：普通聊天仍要求材料或创建 BusinessTask；真实回答来自 FakeRuntime/mock；Web/Control Plane/Worker 读取 provider credential；模型上下文混入其他 Conversation；客户端可以覆盖固定 tenant/principal；取消后仍 completed；材料分析门退化；成功路径依赖 `page.setContent`、主文档/bundle/API/SSE `route.fulfill` 或 HAR；`pnpm verify:gate-a0` 非零。
- Required safe fallback: 保持 Gate 0.2B.1 已关闭基线和现有 `solution.analysis.v1` 模拟材料分析可用；`xiaowei.chat.v1` 保持 `NOT_OPEN`，不显示或生成模拟的“真实聊天”答案，不开放 Model Gateway live profile。
- Optional fallback notes：provider conformance 可继续在隔离测试中修复，但不能用其通过替代真实 served UI；Gate 0.2B.2–0.2B.3 保持延期而不是删除。

## Finding Provenance

当前合同直接投影 `20260723-001-geneway` 已锁定的 Fast Chat 澄清和本 Gate A0 authority brief。`20260723-004-geneway-gate-a0-fast-chat-team-review` 已完成独立产品、架构与安全 review；用户随后明确裁决 Gate A0 采用单用户共享 trusted-local LAN 模式，因此原 `LAN_TRUSTED_SESSION_BOUNDARY` finding 已从当前范围撤销，不得继续引入配对、每浏览器 principal 或跨 LAN 设备隔离门槛。其余六个 controller `current-required` finding 仍为 open，本合同状态保持 `changes_required`，在聚焦修订与复审前不授权产品代码实施。

## Completion Check

- [ ] Scope stayed inside Gate A0 Goal and owned paths
- [ ] `A0.1 → A0.2 → A0.3` completed in order
- [ ] Required acceptance criteria and V1–V7 passed
- [ ] Live provider and served UI evidence are real and secret-free
- [ ] Ordinary chat creates no BusinessTask/Workflow/Evidence/Artifact
- [ ] `solution.analysis.v1` material and approval gates did not regress
- [ ] Gate 0.2B.2–0.2B.3 remain explicitly deferred and unclaimed
- [ ] `pnpm verify:gate-a0` passed from a clean test state
