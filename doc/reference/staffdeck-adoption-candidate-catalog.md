# StaffDeck 借鉴候选目录

catalog_status: `candidate_recorded`

decision_status: `NOT_AN_ACCEPTED_ADR`

implementation_status: `NOT_AUTHORIZED`

recorded_at: 2026-07-21

source_repository: StaffDeck

source_revision: `main@6e0ac47c283e`

evidence_mode: 源码、数据模型、测试和已跟踪界面的静态审查；未运行 StaffDeck 服务或测试

reuse_mode: 外部行为与测试参考，默认净室重实现

authority_effect: 本目录不授予产品代码实施、Gate 扩围、StaffDeck 代码/资产复制、依赖引入、部署或外部操作权限

## 文档角色

本目录保存 StaffDeck 深度分析中尚未提升为正式 ADR、但值得在未来 Gate 立项时重新评估的产品行为、可靠性测试题和运营模式。它是候选池，不是第二份路线图、实施合同或 backlog 权威。

状态含义必须严格区分：

| 状态 | 含义 |
| --- | --- |
| accepted ADR | 用户已经确认的长期架构不变量；仍不自动授予实施权限 |
| `candidate_recorded` | 值得保留和评估，但尚未逐项接受为产品决定 |
| implemented | 已在对应 authority slice 和合同内完成并通过验证；本目录没有任何一项因此自动达到该状态 |

任何候选进入实现前，必须由相应后续 Gate 新建 authority slice、可审计合同并取得用户明确授权。不得反向加入已完成 Gate 0.1 的范围或退出条件。

## 已提升为长期 ADR 的内容

以下 StaffDeck 议题已经从候选分析中提升为独立长期决定，本目录不再复制其权威语义：

| ADR | 已冻结内容 |
| --- | --- |
| [ADR-017](../adr/adr-017-controlled-ephemeral-orchestration-code.md) | 受控临时编码、Tool Broker、逐次授权与明确拒绝 General Skill runner |
| [ADR-018](../adr/adr-018-human-confirmation-for-external-side-effects.md) | 外部副作用的 immutable ActionVersion、可信确认、再授权、幂等和对账 |
| [ADR-019](../adr/adr-019-authoritative-three-layer-sop-state-machines.md) | 状态机 SOP、三层权威、固定 Interpreter、并行/等待/恢复与 StaffDeck 净室边界 |
| [ADR-020](../adr/adr-020-hybrid-knowledge-and-business-capability-matrix.md) | 权威知识源快照/索引/查询/Evidence 链、Business Capability Matrix 只读投影与知识/技能边界 |

## 候选总览与优先级

优先级只表示产品价值和依赖顺序，不授权对应 Gate，也不保证该候选最终会进入产品。

| ID | 候选行为 | 价值 | 建议 Gate | 当前状态 | 主要边界 |
| --- | --- | --- | --- | --- | --- |
| `SD-CAND-001` | Claim/Evidence 来源 chips 与详情抽屉 | 最高 | Gate 0.2 | `candidate_recorded` | 绑定 Claim–Evidence–Lineage；不能复用 StaffDeck `evidence_pack` 合同 |
| `SD-CAND-002` | 执行记录“摘要 + 展开详情” | 高 | Gate 0.2 | `candidate_recorded` | 只投影 Control Plane 正式事件；不显示 reasoning/code/secrets |
| `SD-CAND-003` | refresh/reconnect/cancel/乱序恢复 UX | 高 | Gate 0.2/B | `candidate_recorded` | 保留 snapshot watermark、stable sequence、CAS/fencing；不复用 StaffDeck cursor |
| `SD-CAND-004` | 文档结构导航与分层检索 | 高 | Gate 0.2/A | 权威/版本/证据边界已提升至 ADR-020；导航与检索 UX 仍为 `candidate_recorded` | immutable snapshot、trust/taint、query snapshot、Evidence/Lineage |
| `SD-CAND-005` | Draft → 编辑 → 新版本 → 确认卡 | 高 | Gate C | `candidate_recorded`，权威语义已受 ADR-018/019 约束 | 每次编辑重新 Compiler/hash/Approval；不原位修改 |
| `SD-CAND-006` | 版本分支、Diff、同步、promotion、rollback UX | 中高 | Gate C/G | 权威修改链已受 ADR-020 约束；具体 UX 仍为 `candidate_recorded` | immutable version + eval + approval + audit |
| `SD-CAND-007` | Model Gateway 输出预算与 provider 诊断 | 中高 | Gate A | `candidate_recorded` | 只能位于强制 Model Gateway 内，禁止业务模块直连 provider |
| `SD-CAND-008` | 人工接管待办与恢复体验 | 中 | Gate B/后续 | `candidate_recorded`，状态权威已受 ADR-019 约束 | 小纬仍是客户作者；actor audit + CAS/fencing/idempotency |
| `SD-CAND-009` | 定时任务草案、时区、misfire、concurrency | 中 | Gate D/独立后续 Gate | `candidate_recorded` | 每次唤醒进入 BusinessTask；定时不等于自动写授权 |
| `SD-CAND-010` | 按版本反馈、work record 与 Eval 运营 | 中 | Gate G | `candidate_recorded` | 反馈只是 Eval 输入，不能单独决定 Graduation |
| `SD-CAND-011` | Tool/Capability Registry 查找、绑定、启停和 probe UX | 低到中 | Gate A/C | `candidate_recorded`；执行与投影边界已受 ADR-017/020 约束 | Registry 只含受审版本和 policy metadata；所有执行经 Gateway |

## 第一组：建议优先评估的产品投影

### SD-CAND-001：Claim/Evidence 来源 chips 与详情抽屉

#### 值得借鉴的行为

- 在已发布结论旁显示紧凑来源 chips，不要求用户先打开完整 trace；
- 点击 chip 后展示来源片段、章节路径、摘要、来源系统和置信说明；
- 只保留正文真正使用的引用，并按首次出现顺序稳定编号；
- 无证据候选以“未发布/待补证”单独呈现，不混入已核验结论。

StaffDeck 行为参考：

- `frontend-enterprise/src/pages/chat/components/MessageBubble.tsx`
- `frontend-enterprise/src/pages/chat/components/ChatDialogs.tsx`
- `backend/app/knowledge/citations.py`
- `backend/app/knowledge/service.py`

#### geneway 重构要求

- chip 绑定 `Claim.id → EvidenceItem.id`，不能只绑定 `chunk_id`；
- 详情展示 source system/record、query snapshot、content hash、schema、parser/transformation/desensitization version、data class、resource scope、retention、freshness 与 `Lineage`；
- 打开详情时重新经过 `AuthorizationService`，列表可见不代表原文仍可读；
- 引用编号算法按行为净室重写，并覆盖 Claim/Evidence 不一致、无权限、已撤权和来源 hash 失效的负向测试。

#### 明确不借

StaffDeck `evidence_pack` 只是检索上下文，不能直接映射为 geneway `EvidenceItem`，也不能把相关性/置信文本当作已证明的 Claim。

### SD-CAND-002：执行记录的信息分层

#### 值得借鉴的行为

- 默认显示单行摘要，按需展开正式细节；
- running、waiting、failed、reconciling 等状态在摘要层即可区分；
- 同一轮小纬消息可聚合任务进度、结果、附件/Artifact、来源、待确认 Draft 和反馈入口；
- 失败展示结构化错误和下一步，而不是迫使普通员工阅读原始日志。

StaffDeck 行为参考：

- `frontend-enterprise/src/pages/chat/components/ExecutionRecord.tsx`
- `frontend-enterprise/src/pages/chat/components/MessageBubble.tsx`

#### geneway 重构要求

- 摘要来自 `BusinessTask` 状态、已完成步骤、等待原因和下一步；
- 展开层只显示获得授权的输入/输出摘要、Runtime/Tool 状态、Evidence、retry、approval 和错误码；
- 唯一数据源是 Control Plane snapshot + `BusinessTaskEvent` projection；
- 用 stable event id + snapshot watermark 去重，UI 不拥有任务状态；
- 对普通员工隐藏原始 prompt、reasoning、生成代码、secret、未脱敏 `ToolResult` 和未授权 Evidence。

#### 当前边界

Gate 0.1 已有基础 TaskProgress、固定 Workflow 步骤和内联来源。这一候选是后续产品化增强，不是 Gate 0.1 缺口。

### SD-CAND-003：client turn correlation 与恢复 UX

#### 值得借鉴的行为与测试题

- client operation/turn 与服务器 message/task 的显式关联；
- optimistic、stream、realtime、snapshot 和服务器最终消息的稳定合并；
- refresh/reconnect 后恢复任务而不复制消息或倒退状态；
- cancel、disconnect、interruption、排队草稿和已接受任务在 UI 中具有不同语义；
- duplicate、out-of-order、旧 attempt 事件不会覆盖新投影。

StaffDeck 行为参考：

- `frontend-enterprise/src/pages/chat/useChatSession.ts`
- `backend/app/api/chat.py`
- `backend/tests/test_chat_trace.py`

#### geneway 重构要求

- 保留 geneway 的 `snapshot watermark → 只读其后事件` 原则；
- optimistic UI 只创建 pending projection，不能创建 BusinessTask/Message 业务真值；
- cancel 是 Control Plane command + CAS/fencing，不是浏览器或 Worker 进程内 flag；
- disconnect 不等于 cancel；interruption 必须产生可恢复、可审计的正式状态；
- 浏览器 queue/localStorage 只能保存未提交草稿，不能表示任务已接受；
- 不采用 StaffDeck `(created_at,id)` relay、扫描式补偿或前端大 Hook 作为协议权威。

### SD-CAND-004：结构感知知识导航与分层检索

其中“外部权威源 + 受控快照/索引/查询版本”“retrieval hit 不自动等于 Evidence”“Business Capability Matrix 只读投影”等长期权威语义已经提升为 [ADR-020](../adr/adr-020-hybrid-knowledge-and-business-capability-matrix.md)。以下 concept 层级、导航交互、预算呈现、摄取 UI 和具体实现仍是待后续 Gate 评估的候选，不因 ADR accepted 而获得实施授权。

#### 值得借鉴的行为

- concept → document → bucket → section → chunk 的逐层缩小；
- 章节树、路径 breadcrumb、route trace 和 source drawer；
- 预算化选择文档、章节深度、chunk 数和 token；
- ingest 的 queued/running/canceled/failed/completed 进度；
- discovery 结果先确认，再成为 Runtime 可用知识范围。

StaffDeck 行为参考：

- `backend/app/knowledge/schema.py`
- `backend/app/knowledge/service.py`
- `backend/tests/test_knowledge_base.py`
- `frontend-enterprise/src/pages/KnowledgePage.tsx`

#### geneway 重构要求

- 冻结 input/document version 与 content hash；
- 记录 parser、chunker、index、embedding/model、routing、transformation 和 desensitization version；
- 保存 query snapshot、selected IDs、score policy 和 routing version；
- 贯穿 tenant/resource scope、data class、retention 与 `TrustLabel`；
- `untrusted_text` taint 贯穿摘要、路由、生成和 Tool/Connector 参数；
- retrieval context 只有转换成可访问的 `EvidenceItem` 并绑定 Claim 后才成为正式证据；
- 上传、Artifact 和 Object Storage 只有在 Gate 0.2 另获授权后进入。

## 第二组：中期执行与运营候选

### SD-CAND-005：Draft → 编辑 → 新版本 → 确认卡

可借用 StaffDeck 定时任务草案卡的交互语法，但目标对象改为 geneway `WorkflowDraft`、`HarnessDraft` 或 `ConnectorActionDraft`：

- 卡片展示目标、resolved experts、Capability/Harness/Workflow/Action version、数据范围、动作上限、预算、deadline、audience、风险、模拟/真实标记和 hash；
- “编辑”只修改 Draft，Compiler/validator 通过后产生新 immutable version；
- 任一执行语义变化使旧 Approval `superseded`；
- “确认”只提交 Approval 决策，Control Plane 仍是发令权威；
- 外部写卡完整遵守 ADR-018；Workflow 状态迁移遵守 ADR-019。

不得复用 StaffDeck ScheduledTask 数据模型或把 Gate 0.1 当前整体审批误报为该完整卡片已经实现。

### SD-CAND-006：版本分支、Diff、同步、promotion 与 rollback UX

ADR-020 已接受“矩阵修改必须回到 Draft、新版本、Diff、校验、审批/promotion，矩阵只重新投影”的权威语义。以下 StaffDeck 风格的分支、同步、版本详情和运营交互仍为候选，不代表对应管理能力已经开放。

可借 StaffDeck `synced/diverged`、本地版本、版本详情、从基线同步、发布和回滚的管理员心智模型。geneway 目标映射为：

- official `CapabilityVersion`/`ExpertCatalogVersion`/`HarnessVersion`；
- team/tenant-specific candidate version；
- explicit diff、eval、approval、promotion 和 rollback-to-new-version；
- Graduation 状态、证据、调用量、失败率、成本和人工复核。

必须保持：

- 不覆盖 official 当前行，每次变化产生 immutable content-addressed version；
- “回滚”创建引用旧内容的新版本或切换受控 binding，不删除历史；
- “发布”是权限、Eval、审批和审计控制的 promotion，不是复制内容后自增版本号；
- 调用量和 thumbs up/down 只是输入信号，不能单独决定 Graduation。

StaffDeck 行为参考：`backend/app/agents/branching.py`、`frontend-enterprise/src/pages/SkillsPage.tsx`、`backend/tests/test_agent_branching.py`。

### SD-CAND-007：Model Gateway 输出预算与 provider 诊断

可借鉴：

- operation-specific output budget；
- context fitting/compaction 指标；
- empty response 重试与可诊断错误；
- streaming TTFT、输出字符/chunk、reasoning 字符计数、finish reason、provider response id 和 usage；
- provider setup 与请求 correlation。

geneway 必须把这些能力封装在强制 Model Gateway 内，并同时具备 `ModelCapability Matrix`、tenant/budget/data-class/audience/region routing、provider allowlist/egress、prompt/response redaction、idempotency、audit、conformance suite 与 bypass scan。业务模块和 Agent Runtime 不得直接实例化 provider client。

StaffDeck 行为参考：`backend/app/llm/client.py`。该共享 client 的健壮性可转译，但其“业务代码直接 new client”的调用边界不可借。

### SD-CAND-008：人工接管待办与恢复体验

可借鉴的产品面：

- 上下文摘要、待处理问题、requester、assignee 和原任务入口；
- 明确的 pending/in_progress/resumed/failed/expired 状态；
- “回复并恢复”、失败原因和后续处理；
- pending 去重、assignee 权限、只恢复一次和恢复失败可审计等测试题。

geneway 中人工是审计 actor，客户侧作者仍然只有小纬。handoff/wait/resume 必须绑定 `BusinessTask`、`WorkflowStep` attempt、`ApprovalVersion` 或独立人工作业对象；resume 使用 CAS/fencing/idempotency，并检查版本、tenant、assignee、deadline 和权限。人工内容保留真实操作者、来源和 trust；如需面向客户表达，由小纬生成只读投影。

StaffDeck 行为参考：`frontend-enterprise/src/pages/chat/components/ChatDialogs.tsx`、`backend/app/db/models.py`、`backend/tests/test_human_handoff_policy.py`。

## 第三组：后置运营与治理候选

### SD-CAND-009：定时任务草案与唤醒策略

可借时区、schedule 类型、misfire policy、concurrency policy、唯一 scheduled occurrence、lease 争抢和“先草案后确认”的产品语法。

geneway 中每次唤醒必须创建或幂等复用 Control Plane `BusinessTask`，绑定 immutable `WorkflowVersion`、必要的 `ApprovalVersion`/`AutomationPolicyVersion`、`Delegated Capability`、稳定 occurrence/idempotency key、lease/fencing 和审计。长执行需要 lease renewal 或 durable scheduler。

定时运行不等于获得自动外部写权限；没有 ADR-018 所述人工确认或显式有效的 `AutomationPolicyVersion` 时，只能执行已授权只读/分析，或生成待确认 Draft。

StaffDeck 行为参考：`frontend-enterprise/src/pages/chat/components/ScheduledDraftCard.tsx`、`backend/app/scheduled_tasks/service.py`、`backend/app/db/models.py`。

### SD-CAND-010：按版本反馈、work record 与 Eval 运营

可借按精确版本聚合调用量、好/差评、失败、时延和 work record 的运营视图。geneway 应扩展为：

- unit、Capability 和 Workflow 三层 Eval；
- 安全/越权回归；
- Claim/Evidence 完整度和 freshness；
- 成本、时延、人工接管率与不确定结果率；
- 人工复核、发布门和 Graduation evidence。

用户反馈是可能受偏差和上下文影响的信号，不是业务事实、权限依据或自动 Graduation 判决。所有指标必须绑定精确版本和评测数据快照。

### SD-CAND-011：Tool/Capability Registry 管理 UX

Registry 的执行边界继续以 ADR-017 为准，`Business Capability Matrix` 的只读投影和修改链以 ADR-020 为准。以下查找、启停、probe 和版本详情属于未来管理 UX 候选；它们不能创建新的执行权威或隐式启用未授权对象。

可借“查找、绑定、启停、probe、结构化错误、copy-on-write、版本详情和使用状态”的管理体验。

geneway Registry 只能登记受审、版本固定的 Capability/Tool/Handler/Connector metadata 与 policy；所有执行仍经 Model/Tool/Connector Gateway 和逐次授权。明确禁止：

- 任意 HTTP URL 直接进入可执行 Registry；
- 任意 MCP stdio command/args/env/cwd；
- 从文档自动发现后直接启用工具；
- probe 成功即等于权限、数据等级和生产安全验收通过；
- mutable binding 覆盖已批准版本。

StaffDeck 行为参考：`backend/app/tools/tool_executor.py`、`backend/app/agents/branching.py` 及相关 Tool/MCP 测试。执行实现不复用。

## 可转译测试题库

这里只借测试问题，不复制 StaffDeck 测试源码、fixture 或断言实现。

| ID | 测试题 | geneway 目标 oracle | 建议 Gate |
| --- | --- | --- | --- |
| `SD-TEST-001` | client operation/turn 与 message/task ID 关联 | 重试得到同一权威对象；不同 payload 同 key 结构化冲突 | Gate 0.2 |
| `SD-TEST-002` | duplicate、乱序与旧 completion | stable sequence 去重；旧 attempt/fencing 不能覆盖新状态 | Gate 0.2/B |
| `SD-TEST-003` | cancel 早于 user event 可见、disconnect、interruption | cancel 是幂等命令；disconnect 不取消；interruption 形成正式可恢复状态并终结当前 trace segment | Gate 0.2/B |
| `SD-TEST-004` | 副作用调用前持久化 intent、重复 occurrence、同 key 不同 payload | ActionVersion/intent 先持久化；重复不产生第二次效果；语义冲突失败 | 首个写 Gate |
| `SD-TEST-005` | resource branch 的 tenant/owner/official/private 隔离 | candidate/official 版本跨 tenant 不可见；promotion/rollback 全审计 | Gate C/G |
| `SD-TEST-006` | ingest queued/running cancel 与部分数据清理 | 状态、对象、索引和 Artifact 一致；旧 ingest completion 被 fencing 拒绝 | Gate 0.2/A |
| `SD-TEST-007` | handoff pending 去重、assignee 权限、只恢复一次、恢复失败 | 同一 handoff 幂等；非 assignee 失败；CAS/fencing 只允许一次有效 resume | Gate B |
| `SD-TEST-008` | citation 只保留正文实际引用并稳定编号 | 编号可重复；无 Claim 绑定、无权限或 hash 失效的来源不能呈现为有效引用 | Gate 0.2 |
| `SD-TEST-009` | context compaction | 不丢近期对话、当前 Workflow/Step 与 Evidence refs；memory/summary 保持非权威和带 trust | Gate A/B |
| `SD-TEST-010` | Model 空响应、预算、TTFT/usage/finish reason | Gateway 给出结构化诊断、预算封顶和完整 correlation，不泄露 prompt/secret | Gate A |
| `SD-TEST-011` | scheduled occurrence、misfire、并发禁止与 lease 过期 | occurrence 唯一；misfire policy 确定；双 Worker 只产生一次有效唤醒 | Gate D/独立切片 |
| `SD-TEST-012` | optimistic/localStorage/浏览器 queue | 只能表示待提交草稿；刷新后以 Control Plane snapshot 为准，不创建第二份业务状态 | Gate 0.2 |

## 建议按 Gate 形成的候选包

| 候选包 | 包含 | 价值主线 | 前置与停止条件 |
| --- | --- | --- | --- |
| Gate 0.2 证据/执行投影包 | `001`、`002`、`003`、`004` 的候选 UX | 来源可发现、过程可理解、断线可恢复、文档结构可导航 | 必须新建 Gate 0.2 authority 并吸收 ADR-020；不能把 StaffDeck UI 复制进来或反向扩大 Gate 0.1 |
| Gate A Gateway 体验包 | `004` 的候选检索实现、`007`、`011` | 真实模型/只读工具的诊断、预算、Registry 管理 | 必须吸收 ADR-020；Model/Tool/Connector Gateway 与逐次授权先成为真实强制边界 |
| Gate B durable 协作包 | `003` 的 durable 部分、`008` | 恢复、人工接管、跨 Worker 可靠性 | Control Plane/WorkflowVersion 权威不变；必须具备 CAS/fencing/outbox/inbox |
| Gate C authoring/版本包 | `005`、`006`、`011` 的绑定 UX | Draft、Diff、审批、promotion、rollback | 动态 Draft/Patch、Compiler/Registry/SafeExpression 获独立授权 |
| Gate D 定时业务包 | `009` | 时区、misfire、occurrence、并发 | 不隐式开放写动作；日报/异常 Capability 与真实只读 Evidence 先验收 |
| Gate G 运营毕业包 | `006`、`010` | 版本运营、Eval、Graduation | 指标绑定精确版本；反馈不能单独驱动发布 |

## 明确不复制或迁移的实现

即使候选行为未来被接受，下列 StaffDeck 实现仍默认拒绝：

1. 数字员工广场、多客户作者和 Agent-first 产品对象；
2. 超大 `agent_loop.py` turn orchestration；
3. `SkillCard` 自由字符串/dict 作为可执行 Workflow schema；
4. Distiller 静默自动修补为“最低可运行”流程；
5. General Skill 动态 Bash/Python runner、远程 package import 与自动 `pip install`；
6. 任意 HTTP/MCP/stdio ToolExecutor；
7. SQLite + runtime DDL + mutable Session JSON 业务权威；
8. 扫描最近事件的幂等算法与 `(created_at,id)` cursor 协议；
9. 无 hash/query snapshot/scope/retention/Claim/Lineage 的 `evidence_pack`；
10. 业务模块直接实例化 `LLMClient`；
11. runner code、原始 prompt、模型 reasoning 或未脱敏 raw output 面向普通员工；
12. 把浏览器 queue/localStorage/optimistic state 当业务权威；
13. 复制 3k～6k 行页面/Hook 的组织方式；
14. 在许可证路径未澄清前复制任何 StaffDeck 源码、测试、SVG/PNG、CSS recipe 或其他视觉资产。

与 SOP、临时编码、外部写动作、知识权威链和业务能力矩阵有关的更强约束，以 ADR-017～020 为准。

## 净室转译流程

候选未来获准实施时，按以下顺序处理：

1. 从 geneway 当前 authority 和对应 Gate 目标编写行为合同、非目标和拒绝列表；
2. 只记录 StaffDeck revision、相对文件、观察到的行为和限制，不复制实现代码或资产；
3. 使用 geneway 对象重新表达：`Capability`、`BusinessTask`、`WorkflowVersion`、`ApprovalVersion`、`Claim`、`Evidence`、`Lineage`；
4. 先写正向、越权、乱序、重放、过期、无证据、trust-taint、幂等和 fencing 测试；
5. UI 只消费 Control Plane projection，任何 optimistic/localStorage 状态显式标记为非权威；
6. 使用 geneway 技术栈和现有组件系统净室实现；
7. 若确需文件级复制，停止实现，先取得完整许可证/版权/例外说明和法律判断，再使用类似 [`legacy-migration-manifest.md`](../migrations/legacy-migration-manifest.md) 的来源 SHA/path、修改、耦合清理与新测试记录，并单独获得用户授权。

## 来源限制与未知项

- StaffDeck README/官方页面声明 AGPL-3.0，但所审 `main@6e0ac47c283e` 根目录未发现完整 `LICENSE`、`COPYING` 或 `NOTICE`；不能据此认定可直接复制。
- 本地没有 StaffDeck Python venv、frontend `node_modules` 或 pytest；约 500 个测试函数仅作静态题库来源，不能宣称该 revision 的测试通过。
- StaffDeck 前端未发现常规 `test/spec` 测试文件，现有 CI 也不包含完整 lint/typecheck/unit/browser 流水线；不能把已跟踪截图或源码交互当作已验证的前端质量证据。
- 没有启动 StaffDeck 浏览器产品；stream、恢复、权限和可访问性行为来自源码与已跟踪界面材料，实施前需要重新验证。
- 所审默认形态是 SQLite/单进程/桌面打包；未知是否存在未公开的 Postgres、Gateway、OIDC、KMS、sandbox 或企业分支。
- 候选基于固定 source revision；未来使用前应重新核对上游变化、许可证和行为，不把本目录当作永不变化的 StaffDeck 事实库。
- 当前所有候选都没有后续 Gate 实施授权，也不是 Gate 0.1 的缺口。
