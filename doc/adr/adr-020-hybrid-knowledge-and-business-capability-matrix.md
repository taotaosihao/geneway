# ADR-020：知识采用权威源快照链，业务能力矩阵仅作版本化投影

decision_status: `accepted`

implementation_status: `NOT_OPEN`

accepted_at: 2026-07-21

decision_scope: 后续 Knowledge、Registry、Capability 治理与内部管理 Gate 的长期不变量

knowledge_mode: `AUTHORITATIVE_SOURCE_PLUS_CONTROLLED_SNAPSHOT`

matrix_mode: `READ_ONLY_DERIVED_PROJECTION`

reuse_policy: StaffDeck 仅作外部行为和测试参考，默认净室重实现

authority_effect: 本 ADR 不授予产品代码实施、Gate 扩围、知识源接入、文档上传、索引构建、模型调用、部署或外部系统访问权限

## 决策摘要

geneway 的知识能力采用“**外部权威知识源 + geneway 受控快照、索引、查询快照与证据链**”的混合架构。正式维修 SOP、质量标准、设备手册、工艺文件和制度文档默认仍由客户现有 DMS、PLM、QMS、EAM 或其他受治理来源负责发布；geneway 保存完成受控检索、可重复运行和取证所需的不可变版本，不把模型生成内容、检索相关性或向量命中自动提升为正式知识。

geneway 的业务“技能矩阵”正式命名为 `Business Capability Matrix`。它不是新的执行权威、权限表或可变 Skill 对象，而是从精确版本的 Capability、Expert/Agent、Harness、Tool/Connector、Workflow、Knowledge、Model/Policy 和 Eval/Graduation 对象派生的只读管理投影。任何矩阵编辑都必须回到对应 Draft、新版本、Diff、校验、审批和 promotion 链路，不能原位覆盖已经批准或正在运行的绑定。

`Business Capability Matrix`、原 v19 已定义的 `ModelCapability Matrix` 和未来可能出现的人力资源员工技能矩阵是三个不同概念。当前决定只覆盖数字专家的业务能力治理；HR 员工技能、证书和熟练度管理不在 geneway 当前产品范围。

## 背景

原 v19 已经确定 Capability-first、`AgentDefinition.supportedCapabilities`、immutable `HarnessVersion`、`ModelCapability Matrix`、`ContextPacket`、Context Graph Lite、Claim–Evidence–Lineage 和 Object Storage，但没有定义完整原生知识库，也没有定义统一业务技能矩阵对象。

后续路线图允许 Tool/Connector Gateway 连接外部知识库，并规划受控文档摄取；StaffDeck 借鉴目录又补充了结构感知导航、分层检索、摄取状态、版本运营和 Registry UX 候选。若不先冻结权威边界，未来很容易出现以下问题：

- 把 Object Storage、Context Graph、Memory 或向量数据库误称为完整知识库；
- 把检索命中或模型摘要直接当作 Evidence 或正式事实；
- 索引、embedding 或权限变化后无法复现历史查询；
- 将 StaffDeck `SkillCard`、通用代码 runner 或可变绑定迁移为业务能力权威；
- 让一张管理员矩阵成为绕过 Capability、Workflow、审批和授权的第二执行面；
- 混淆模型技术能力、数字专家业务能力和真实员工技能。

本 ADR 补充原 v19 ADR-001（Capability 是产品合同）、ADR-009（工业访问只经 Connector Gateway）、ADR-010（Claim–Evidence–Lineage 是输出合同）、ADR-011（Context Graph Lite 是制造业对象解析基础）、ADR-012（自由文本默认不可信），并继续受 ADR-017～019 约束。

## 已决定的长期不变量

### 1. 正式知识默认保留在受治理权威源

维修 SOP、设备手册、报警码、质量标准、工艺文件和制度文档的发布、审核、生效、失效与责任人，默认由其现有受治理来源系统负责。geneway 通过受控 Connector 或经鉴权的摄取入口取得内容，不静默接管客户文控、PLM、QMS、EAM 或 DMS 的发布权威。

geneway 可以保存用于检索和取证的不可变内容快照、派生结构、索引和查询记录，但必须保留来源系统、外部对象 ID、来源版本、生效时间、抓取时间、content hash、访问范围和 lineage。来源系统内容更新、撤回或权限变化时，geneway 必须能够识别受影响的快照、索引和未来查询。

受鉴权上传可以作为未来 Knowledge source 的一种输入方式，但“上传成功”不等于“正式知识已发布”。如果未来要让 geneway 自身成为原生文控或正式知识发布系统，必须另建产品决定、责任模型、审核/生效/撤回合同和 authority slice；本 ADR 不隐式授予该角色。

### 2. 知识摄取、索引和查询必须全部版本化

未来知识合同至少包含以下目标对象。名称是后续 Zod 4/wire contract 的稳定输入；精确字段、存储实现和 API 由获得授权的后续 Gate 冻结。

| 目标对象 | 长期职责 |
| --- | --- |
| `KnowledgeSourceDefinition` | 定义来源类型、权威系统、owner、Connector、数据等级、资源范围、留存和生命周期 policy |
| `KnowledgeSourceVersion` | 冻结来源配置、外部版本/游标、访问策略和有效期；配置变化产生新版本 |
| `KnowledgeDocumentSnapshot` | 冻结文档/章节的来源版本、有效时间、content hash、数据等级、TrustLabel 与对象存储引用 |
| `KnowledgePipelineVersion` | 冻结 parser/OCR、chunker、index、embedding、reranker、routing、transformation 与 desensitization 版本 |
| `KnowledgeIndexVersion` | 绑定确定的文档快照集合、PipelineVersion、索引构建结果、状态和 hash |
| `RetrievalPolicyVersion` | 冻结查询范围、过滤、预算、选择、score/rerank、freshness 和 fallback 规则 |
| `KnowledgeQuerySnapshot` | 记录实际查询、输入/上下文快照、所用 Index/Policy 版本、候选与选中 ID、分数/理由、预算和调用者范围 |
| `KnowledgeContextBinding` | 把知识版本与 Capability、设备/产线/物料/工单、SOP 和 Context Graph 对象建立版本化关联 |

parser、OCR、chunker、embedding/model、index、reranker、routing、transformation、脱敏策略、文档集合、访问 policy 或检索语义任一变化，都必须产生相应新版本；不能用原位更新伪装成同一可复现知识环境。

向量数据库、全文索引或缓存只是 `KnowledgeIndexVersion` 的实现，可替换且不成为业务权威。数据库内部 collection 名、最新索引指针或相似度分数不能替代 Control Plane 中的版本、hash、权限与审计记录。

### 3. 知识查询必须可复现并保留 freshness 语义

每次被用于 Runtime、Verifier 或正式结论的知识查询，必须能够追溯到：

- 精确 `KnowledgeSourceVersion`、`KnowledgeDocumentSnapshot` 和 `KnowledgeIndexVersion`；
- 精确 `RetrievalPolicyVersion` 与实际 `KnowledgeQuerySnapshot`；
- 查询时的 tenant、principal、resource scope、audience、data class 和期限；
- 输入/业务对象/时间范围快照；
- 候选与最终选中片段、章节路径、score/rerank policy 和预算；
- 来源有效期、抓取时间、索引构建时间和 freshness 判断；
- parser、embedding、routing、transformation 与脱敏版本；
- 后续 Evidence/Claim 或仅作非权威上下文的使用方式。

`KnowledgeQuerySnapshot`、embedding/vector、派生 chunk、摘要、缓存和索引继承其来源内容及混合输入的最高数据等级、resource scope、audience、retention 和出域限制；派生后不能降级为“技术元数据”而绕过保护。QuerySnapshot 本身可能包含敏感查询意图和业务对象，也必须按同等策略访问和审计。

历史结果保留当时使用的 immutable snapshot 与 lineage；来源后续撤回不能篡改历史审计。未来查询必须遵守最新有效权限和撤回状态，不能继续从过期缓存、旧索引或历史授权泄露内容。具体删除、法律保留和历史 Evidence 展示策略由知识来源的数据治理 policy 决定。

### 4. 检索上下文不自动成为 Evidence 或正式知识

权威链路固定为：

```text
权威知识源 / 受鉴权输入
→ KnowledgeSourceVersion
→ KnowledgeDocumentSnapshot + content hash
→ KnowledgePipelineVersion
→ KnowledgeIndexVersion
→ RetrievalPolicyVersion
→ KnowledgeQuerySnapshot
→ retrieval hits + TrustLabel
→ 可访问性、来源与内容校验
→ EvidenceItem
→ EvidenceLink / Lineage
→ Claim publish guard
```

检索命中、相似度、rerank 分数、摘要、模型置信文本和 ContextPacket 中的引用都只是候选上下文。只有转换成当前用户和任务可访问的 `EvidenceItem`，并通过来源/hash/freshness/tenant/resource/data/audience 校验、绑定具体 Claim 后，才能支撑正式结论。

模型生成的摘要、建议、重写文本、合成 SOP 或用户反馈不能自动回写为正式知识。若未来允许知识草稿，模型最多生成结构化 Draft；正式发布必须经过单独的知识审核、版本化和责任人确认，不得借普通聊天、Workflow 审批或高评分隐式完成。

### 5. Trust、taint、授权与审计贯穿整条知识链

所有外部文本、上传内容、检索片段和模型生成内容默认按来源携带 `TrustLabel`；`untrusted_text` taint 必须贯穿解析、摘要、路由、生成和 Tool/Connector 参数。进入索引、命中检索或被多次引用都不能自动提升 trust。

每次摄取、索引读取和查询至少检查：

- tenant 与 principal；
- resource scope 与业务对象范围；
- data class、audience 和部署/出域策略；
- 来源与文档的当前访问状态；
- retention、expiry、撤回和 freshness；
- 查询、文档、chunk、token、成本和并发预算；

当操作属于 `BusinessTask` 或 `WorkflowStep` 时，还必须检查当前 Capability、Workflow、Harness、delegated capability ceiling、attempt 和 fencing 上下文。管理端摄取/索引任务即使不属于面向用户的业务 Capability，也必须绑定明确的管理权限、资源范围、版本化 policy、预算、owner 和不可变审计，不能因其是后台作业而跳过授权。

知识库不能成为绕过 Connector Gateway、AuthorizationService、Tool Broker、Model Gateway 或 Evidence publish guard 的快捷通道。提示注入、跨 tenant 索引污染、ACL 变更、旧缓存读取、恶意文档和混合数据等级必须纳入后续 conformance/security suite。

### 6. Business Capability Matrix 只是版本化权威对象的只读投影

`Business Capability Matrix` 至少展示下列精确版本与状态之间的关系：

| 矩阵维度 | 权威来源 |
| --- | --- |
| 面向用户的业务能力 | `CapabilityVersion` 及其 input/output、领域和 release policy |
| 执行专家 | immutable Expert/Team/`AgentVersion`、主责/备援角色与 health |
| 执行组合 | `HarnessVersion` |
| 工具和工业系统 | `ToolVersion`、Connector definition/version 与 action ceiling |
| 正式流程 | `WorkflowVersion id + hash` |
| 知识和业务上下文 | `KnowledgeSourceVersion`、`KnowledgeIndexVersion`、`KnowledgeContextBinding`、ContextPolicyVersion |
| 模型要求 | ModelPolicyVersion 与 `ModelCapability Matrix` |
| 权限边界 | tenant、resource、data/action class、audience、egress 与 delegated capability ceiling |
| 质量与生命周期 | EvalProfile/精确 Eval snapshot、health、Graduation、Evidence coverage、成本和延迟 |

矩阵不保存第二份可变绑定，不直接决定权限、审批、Workflow 迁移或 Tool/Connector 执行。每个单元格都必须能解析到权威对象及其精确版本；缺失、冲突、过期、未毕业或不可访问时显式显示 unavailable/invalid，而不是静默 fallback。

专家“熟练度”默认不采用无来源的人工自由评分。第一版优先使用 Capability allowlist、角色（主责/备援）、health、版本化 Eval、Graduation、Evidence coverage、成本和延迟等可审计信号。如果未来需要人工等级、资质或证书语义，必须定义来源、有效期、审核者和用途，不能让其自动扩大权限。

### 7. 矩阵修改必须回到 Draft、新版本和 promotion 链路

管理员在未来界面执行“绑定、启停、替换、回滚、修改知识源、调整模型或专家”等操作时，不能原位修改矩阵投影或覆盖已经批准的对象。统一语义是：

```text
管理员意图
→ 对应 Capability/Harness/Binding/Knowledge/Policy Draft
→ Zod 4 + Registry + 权限 + 数据/动作等级 + Eval 校验
→ immutable version + canonical hash
→ 结构化 Diff
→ 必要的 Approval / promotion
→ Control Plane 更新受控 active binding
→ Business Capability Matrix 重新投影
```

“回滚”通过创建引用既有内容的新版本或受控切换 binding 完成，不删除历史；“probe 成功”、调用量、用户点赞或模型自评都不能单独决定启用、Graduation 或权限提升。运行中的 Task、Workflow 和 Approval 继续绑定其原精确版本，不能被矩阵最新值追溯修改。

### 8. 三类能力矩阵必须分离

| 名称 | 回答的问题 | 本决定 |
| --- | --- | --- |
| `Business Capability Matrix` | 哪项制造业业务能力由哪些专家、流程、工具、知识和策略实现，并处于什么质量/发布状态 | accepted，当前 `NOT_OPEN` |
| `ModelCapability Matrix` | 哪个模型支持哪些技术特性、部署方式和数据等级 | 延续原 v19；不能替代业务能力矩阵 |
| HR 员工技能矩阵 | 哪位真实员工拥有哪些工种、证书、资质和熟练度 | 当前非目标；如需要必须另立产品域和权限/责任合同 |

面向普通员工的产品仍以“小纬 + Capability”呈现，不暴露后台矩阵复杂度。`Business Capability Matrix` 首先是内部管理员的治理与诊断投影，不是 Skill 市场、Agent 广场或多客户作者界面。

### 9. 不引入通用 Skill runner 或第二执行面

本 ADR 不接受 StaffDeck `SkillCard` 自由 dict、General Skill 动态 Bash/Python runner、任意 URL/MCP transport、自动安装依赖或“从文档发现后直接启用工具”。知识目录和能力矩阵只能引用已登记、版本固定、通过 policy/Eval 的对象；实际模型、Tool、Connector 和 Workflow 执行继续经过既有 Gateway、逐次授权、固定 Interpreter、Approval 和 Evidence 边界。

如果未来引入 ADR-017 所述受控临时编码，它仍只是批准 Workflow Step 内调用固定 ToolVersion 的有界执行单元，不能从知识库或矩阵获得额外网络、凭据、权限或顶层任务权威。

## 推荐实施顺序

| 阶段 | 建议目标 | 明确不包含 |
| --- | --- | --- |
| 已完成 Gate 0.1 | 保留固定 `solution.analysis.v1`、固定 fixture、最小 Capability/Expert/Harness seed 与 EvidenceRef | 原生知识库、真实知识 Connector、索引、Business Capability Matrix |
| Gate 0.2 或独立基础 slice | 受鉴权摄取、Object Storage、DocumentSnapshot、完整 Claim–Evidence–Lineage 与安全解析基础 | 把上传自动发布为知识；开放动态 Registry 编辑 |
| Gate A 或独立只读 Knowledge slice | 一个真实只读知识源、Pipeline/Index/Query 版本链、逐次授权、taint、Evidence 转换；同时提供只读 Business Capability Matrix | 外部写动作、通用 Skill runner、矩阵直接编辑生产绑定 |
| 建议首个制造业纵切 | `设备报警 → Context Graph 解析设备 → 查询版本固定维修 SOP → 返回章节 Evidence → 设备专家建议` | 创建工单、外发通知、自动控制 |
| Gate C 或独立治理 slice | Draft、Diff、审批、binding/promotion/rollback 与矩阵重新投影 | 原位修改 immutable version；矩阵成为执行权威 |
| Gate G 或独立运营 slice | 精确版本的事实正确率、Evidence coverage、人工复核、知识 freshness、成本、延迟和 Graduation | 仅凭点赞、调用量或模型自评自动毕业 |

这里的 Gate 名称只表达建议依赖顺序。任何一行都必须新建 authority slice、可审计实施合同并获得用户明确授权；本 ADR 不修改现有 Gate 0.2/A/C/G 合同，也不意味着这些 Gate 当前已获实施授权。

首个只读 Knowledge slice 可以从用户提供或预先批准的设备/报警快照开始。若起点是平台主动采集真实设备报警、执行确定性异常检测并创建异常待办，则仍属于路线图 Gate D 或对应独立授权范围，不能借 ADR-020 提前并入 Gate A。

## 后续 Gate 必须证明的验收输入

首个申请实现本 ADR 的合同至少需要把以下内容转成可机器验证的验收条件：

1. 同一 Source/Document/Pipeline/Index/Policy 输入产生稳定版本/hash，任一执行或检索语义变化产生新版本；
2. QuerySnapshot 能复现实际使用的索引、策略、输入范围、候选/选中片段、分数/理由、预算、调用者和 freshness；
3. 跨 tenant、超 resource/data/audience scope、已撤权、已过期、已撤回和旧缓存查询全部 fail closed；
4. `untrusted_text`、恶意文档和提示注入不能借索引、摘要、路由或 Tool 参数提升 trust 或旁路授权；
5. retrieval hit、相似度和摘要不能直接发布 Claim；只有有效 `EvidenceItem` + `EvidenceLink` + Lineage 能通过 publish guard；
6. 来源更新/撤回后，未来查询不继续使用失效索引；历史结果仍可审计其当时快照且不会伪装为当前有效知识；
7. Business Capability Matrix 的每个单元都解析到精确权威版本，且矩阵缺失/过期/冲突不能扩大权限或启动执行；
8. 修改专家、Tool、Workflow、Knowledge、Model、Policy 或 binding 会产生 Draft、新版本和 Diff；运行中 Task/Approval 仍绑定旧版本；
9. probe、点赞、调用量或模型评分不能单独启用对象、提升权限或推进 Graduation；
10. 没有 StaffDeck General Skill、任意代码、任意 URL/MCP、动态依赖或矩阵旁路执行面；
11. 当前 UI/API 对未开放知识、矩阵、上传、真实 Connector/Runtime 继续返回或显示 `NOT_OPEN`，不把目标设计描述为已实现。

## 被拒绝的替代方案

- 把 S3/Object Storage、Context Graph、Memory、Evidence Store 或向量数据库单独称为完整知识库；
- 把向量命中、搜索相关性、模型摘要或置信度直接当作事实/Evidence；
- 只保存“当前索引”或 collection 名，不保存文档、Pipeline、Index、Policy 和 QuerySnapshot 版本；
- 把模型生成内容或检索反馈自动回写为正式 SOP/知识；
- 复制 StaffDeck Knowledge/Skills 数据模型或执行实现，并逐步补 tenant、trust、Evidence 和版本；
- 建立 mutable `Skill`/矩阵表作为 Capability、权限、Workflow 或 Tool 执行权威；
- 把 `ModelCapability Matrix`、业务能力矩阵和 HR 员工技能矩阵混为一体；
- 让矩阵编辑、probe 或“启用”按钮绕过 Draft、Eval、Approval、Gateway 和逐次授权；
- 迁移 StaffDeck General Skill runner、任意代码/URL/MCP 或自动依赖安装。

## 当前 Gate 0.1 事实

Gate 0.1 没有知识库、文档上传、Artifact 下载、真实知识 Connector、解析/分块/embedding/索引/检索链、`KnowledgeQuerySnapshot`、`Business Capability Matrix` 或真实 `ModelCapability Matrix`。

当前仅有：

- 固定 `solution.analysis.v1`；
- 一个固定方案专家与一个固定方案专家团；
- immutable `CapabilityVersion`、`ExpertCatalogVersion`、fake `HarnessVersion` 和七节点 `WorkflowVersion` 的最小 seed；
- 预置、版本固定、脱敏、只读 fixture；
- 最小 Claim/EvidenceRef publish guard；
- 服务端 fake Runtime，且 `simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`。

上传、Artifact 下载、异常中心和未开放 Runtime/Tool/Connector kind 继续结构化 `NOT_OPEN`。本 ADR 是 accepted long-term decision，不是相关能力已经实现、开放或获得实施授权的声明。
