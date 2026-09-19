# P1 详细计划：原生底座与第一项真实工作

版本：P1-plan v3（2026-09-19 Session 连续性 Team Sol 重规划）

形成日期：2026-09-19；先因用户明确 GearJob 模拟数据、ZenMux 凭据位置及界面视频交付要求形成 v2；随后真实 SDK 运行证明 `0.1.6-alpha.2` 的 sdk profile 不能在新进程 hydrate 已持久 Session，按合同触发两名 Sol planner 重规划并原位形成 v3。v3 是当前唯一有效 P1 计划，v1/v2 仅保留为本文件内的形成历史。

适用范围：`implementation-contract.md` v4.1 的 P1。该计划是 P1 实施前的唯一阶段计划；它不替代总合同，不把任何后续阶段提前算作完成。

## 1. 阶段目标、交付边界与当前结论

P1 只贯通一条可持久回读的普通工作路径：

> 已授权操作者明确选择员工和连接，输入明确工单号；服务端在当前授权下调用 DSH 原生外部插件，从本机完整 GearJob 开发测试实例读取团队新建且明确标注的模拟工单，生成唯一结构化观察和业务说明；操作者可以追问依据、查询最新、查看旧观察、停止当前执行，并在重启/恢复后重新读取同一工作。

P1 的可接受阶段结论限定为“GearJob 外部测试实例、团队生成模拟工单模式下的技术验收”。它证明完整 GearJob/Frappe 服务、数据库、权限、HTTP API、DSH 插件、模型和普通浏览器路径，不证明客户生产 GearJob、真实生产工单、生产容量、生产部署、正式发布或客户接受。若完整 GearJob 测试实例无法安全运行，不能静默退回进程内 fixture；需要重规划后才可采用明确标注的独立模拟服务，且该结论不得升级为生产接入。

本阶段覆盖：

- G1、J1；
- AC-01、AC-02、AC-10/11/12 的 P1 当前可达路径；
- 为 J2/J3/J4/J5/J11 留下稳定的工作、执行、员工、连接、操作者和 DSH 引用边界；
- P2–P7 所需外部条件的只读识别。

本阶段不交付：

- 完整企业身份与管理后台、两个账号、两个员工/连接的交错验收；
- 协作、知识、飞书、微信、定时/真实事件任务；
- 第二真实模型路由、第二业务来源、任何上游业务写入；
- 通用 AgentLoop、Workflow DSL、队列、消息总线、插件市场或独立移动应用；
- 生产部署、正式发布和客户接受。

P1 工程部分可以在真实来源或模型条件未具备时继续，但不能把受控测试、静态草图或合成响应记为 J1/AC-02 的真实完成。真实依赖缺失时，计划保留阻塞并交付已就绪的确定性工程部分。

## 2. 规划输入、当前事实与证据限制

### 2.1 当前工作树事实

- 工作树：`/home/gewu/.devspace/worktrees/geneway-f4222c66`。
- 分支：`rebuild/dsh-greenfield`。
- 形成计划前 HEAD：`2d4f6c7`。
- Git 跟踪内容只有合同和澄清记录；产品代码、`package.json`、锁文件、P1 计划、UI 草图和 workflow 材料目前均为未跟踪工作。它们属于当前工作成果，后续不得清理、覆盖或 blanket stage。
- 已存在锁定 DSH `0.1.6-alpha.2` 的根清单、CLI/插件/SDK 初始化探针、Node 标准库 loopback 服务、单 JSON 产品事实源、确定性工单规则、服务测试及同源桌面/窄屏 UI。
- 2026-09-19 本轮重规划前重新运行 `pnpm test:unit && pnpm test:service`，两项通过；这只证明纯规则和进程内服务边界，不证明 DSH、GearJob、ZenMux、浏览器、取消或恢复。
- 当前主路径仍未装配 GearJob 来源和 DSH runner；追问只保存文字，停止没有可达的运行中执行，刷新没有完整 execution，尚无原子 reservation、启动中断结算、备份恢复或真实浏览器证据。
- 主机：`gewu-CVN-Z890-ARK-FROZEN`；已观察 Node `v26.5.0`、npm `11.17.0`、系统可用 `google-chrome`；当前工作树没有 `dsh`、`deepseek-harness` 或 `geneway` 命令。
- 用户口述的 `~/.claude/setting.json` 不存在；实际 `~/.claude/settings.json` 权限为 `0600`，已确认 `ANTHROPIC_BASE_URL` 指向 `https://zenmux.ai` 且 `ANTHROPIC_AUTH_TOKEN` 已配置，未输出凭据值。ZenMux 官方文档与实时 `/api/v1/models` 已确认 OpenAI-compatible 基址 `https://zenmux.ai/api/v1`、模型 ID `deepseek/deepseek-v4-pro`；2026-09-19 最小工具探针返回 HTTP 200 和单次合法 tool call。产品仍须经 DSH route 实测，不能用直连探针替代。
- 本机 `/home/gewu/work/gearjob` 是完整 GearJob/Frappe 工作树，存在 `dev.localhost`、开发 bench、MariaDB/Redis Compose 定义和标准 Work Order 模型，但当前 8100 端口及 GearJob Compose 未运行。该仓库已有脏工作及旧 Gate A 专用接口/数据；P1 不修改或清理它，不使用 `WO-GATE-A3-*`、`X-Geneway-Connector-Token` 或旧 workflow/fence/effect 协议。
- `lark-cli 1.0.45` 已安装；bot identity ready，user token 已过期。视频录制不受影响，发送使用 bot 身份和明确目标；不得凭姓名猜收件人。

### 2.2 可用的外部只读依据

独立的 DSH 源码仓库 `/home/gewu/work/deepseek-harness` 的只读元数据显示：当前候选源码版本为 `0.1.6-alpha.2`，要求 Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`；其 CLI 包名为 `@deepseek-ai/dsh`，SDK 客户端包为 `@deepseek-ai/dsh-sdk-client`。官方教程展示了 Cordis 插件 `apply(ctx)`、`ctx.tools.register(defineTool(...))` 和原生 Profile/Bundle 装配。

这些是候选分发和 API 线索，不是本工作树已安装事实。实施只能使用官方/获准分发源生成当前工作树自己的清单与锁文件；不得复制旧 Geneway 的代码、锁文件、令牌、服务或验收数据。

### 2.3 UI 设计证据边界

`ui-sketches-workbuddy.html` 及其截图明确是设计预览和合成数据，检查脚本只覆盖静态导航、弹窗、响应式布局和无横向裁切。P1 复用其轻侧栏、中心交办、工作详情、手机单列和绿色状态层级；删除/隐藏合成设备报警、事件规则、协作步骤、动作草稿、提醒偏好及“4 名员工/3 个连接”等未交付事实。设计稿不构成真实 API、模型、事件或持久化证据。

### 2.4 未知与假设

仍未知：安全裁剪后的 DSH Profile、ZenMux 协议/模型/外发和真实调用；DSH 独占 execution runtime 的取消与同一 Session 重启恢复；GearJob `dev.localhost` 当前数据库/容器身份和标准 REST 的对象级只读能力；飞书明确收件目标；DSH 与产品事实的停机备份恢复方法。

用户已授权在隔离的 GearJob 开发测试实例创建本阶段专用模拟工单与最小只读服务身份，并授权用 ZenMux 对规范化模拟字段完成模型路径；这不授权修改 GearJob 源码、使用远程/生产站点、客户数据或旧 Geneway 协议。P1 仍以单操作者、单员工、单只读连接、单工单能力和 loopback 入口运行；每个活动 execution 独占 DSH runtime，P1 不做隐式自动重试，失败由用户明确重试。

## 3. 两名 planner 的独立输入与主代理裁决

两名 planner 先独立收到相同的合同摘要、P1 目标、当前工作树事实、UI 证据和权限边界，再分别返回意见；它们只依据自包含派发包，不声称独立读取本地源码或运行测试。

| planner | 路由/视角 | 独立意见摘要 | 采纳情况 |
|---|---|---|---|
| `/root/p1_product_planner` | `atlas-sdd-planner`，`gpt-5.6-sol`，`max`；产品结果、普通入口与验收 | P1 只做真实工单查询→依据追问→刷新最新→旧观察回读；保留显式员工/连接/工作/执行/观察 ID；UI 只实现真实 P1 状态；真实来源/模型缺失时不能宣布 J1。 | 全部采纳。 |
| `/root/p1_engineering_planner` | `atlas-sdd-planner`，`gpt-5.6-sol`，`max`；DSH 集成、存储与验证边界 | 先通过有限原生探针确定 DSH Host/嵌入式 Client/插件承载形态；优先 DSH 原生持久结果，确有缺口才增加一个产品事实库；禁止自建 Runtime、队列、恢复调度或第二份可变观察。 | 全部采纳；将“具体 Node 形态”保留为 T1/T2 探针结果，而不是先验决定。 |
| `/root/p1_product_replan` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high`；产品结果、GearJob 测试来源、普通入口与视频 | 完整 GearJob 测试实例加团队生成模拟工单可证明真实 HTTP/API/权限/映射，但结论必须持续标为 `external-test/synthetic`；补齐深链、桌面/手机旅程、视频和飞书回执。 | 采纳。完整 GearJob 优先于另造模拟服务。 |
| `/root/p1_engineering_replan` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high`；DSH、安全、状态机与恢复 | 使用安全裁剪的 DSH Profile；每个活动 execution 独占 runtime 以获得精确取消；原子 reservation 后再派发；复用 DSH Session/JSONL，不自建 AgentLoop；补停机备份、CDP 浏览器验收和录屏。 | 采纳核心方案；其“先自建轻量 GearJob simulator”未采纳，因为本机完整 GearJob 开发实例已存在。只有完整实例实测不可行并经重规划后才采用独立模拟服务。 |
| `/root/p1_session_replan_product` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high`；工作连续性与验收声明 | 合同要求同一 Geneway work 连续，不要求 SDK 跨进程恢复同一 Session；重启后用新干净 Session 承接当前获准 observation，旧 JSONL 只作不可变历史。 | 采纳；禁止把 successor Session 伪称原 Session 恢复。 |
| `/root/p1_session_replan_engineering` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high`；SDK 能力、插件主链与 lineage | sdk wire 无 inspect/resume/hydrate；新进程同名 Session 会 `already exists`。同时发现当前 create/refresh 直调 `source.read()`，未经过 DSH GearJob tool，违反 P1 插件主链。 | 全部采纳；修复限定在 runner/work-service/server 和既有测试，不引入恢复器或第二控制面。 |

两轮意见没有改变 P1 范围。v2 主代理裁决为：复用本机完整 GearJob 开发实例并创建全新的 `GENEWAY-P1-SIM-*` 数据，不修改 GearJob 源码、不消费旧 Gate A 接口；使用 SDK Client + 安全裁剪的 DSH Profile + 一个 GearJob 只读插件；产品只保留授权、归属、执行状态和必要观察投影；UI 继续使用同源单文件，不引入前端框架。

## 4. 产品对象、责任边界与最小数据

### 4.1 稳定关系

即使 P1 只有一名员工和一条连接，也必须保存显式：

`operatorId`、`employeeId`、`connectionId`、`workId`、`executionId`、`dshSessionRef`、`observationId`；发生 successor 时另保存 `continuedFromDshSessionRef` 与 `contextObservationId`。当前 SDK 没有原生 run id，不建立伪引用。

DSH 拥有 Profile、Bundle、插件、Agent/Session、模型调用、工具调用、原生事件和原生持久历史；Geneway 工作服务拥有操作者/员工/连接绑定、工作和执行归属、重复提交、停止产品语义、观察寻址与完成判定；工单插件拥有真实只读连接、字段规范化和确定性进度规则；模型只负责基于规范化事实生成说明，不决定 URL、凭据、连接、权限或数值。

### 4.2 最小观察语义

若 T2 证明 DSH 结果已能按稳定引用持久读取，产品只保存结果引用及必要关联。只有原生结果缺少历史含义或无法稳定寻址时，才保存一条不可变观察：

- 工单标识、来源系统/实例、稳定记录引用；
- 原始状态和仅在语义明确时的规范化状态；
- 计划量、完成量、单位；
- `sourceObservedAt`（只来自来源，可为空）与 `queriedAt`（服务端读取完成时间）；
- 可计算时的比例，否则保存 `no_plan`、`zero_plan`、`missing_completed`、`missing_unit`、`unit_mismatch` 或 `invalid_quantity` 等原因；
- 最小解释版本标识和 DSH Session/执行/结果引用。

计划量大于 0、完成量合法且单位/口径相容时才计算比例；零、缺失、负数、非法值或单位不一致均如实显示未知/异常；完成量超过计划量保留真实值，不截断；没有计划基线不判断提前/落后；源时间缺失不能用查询时间替代。模型和 UI 消费同一个结构化观察，不从自然语言反解析事实。

## 5. 实施任务、依赖和停止条件

### P1-T0：计划冻结（已就绪）

输出为本文件、两份 planner 输入、采纳/不采纳裁决、真实/受控边界及当前就绪/阻塞项。计划形成早于任何安装、代码探针、产品启动、模型调用或业务接口调用；因此 P1 实施门槛已经满足。

### P1-T1：运行时与 DSH 原生有限探针

T1A 先完成包锁定、CLI、插件装载和 SDK JSON-RPC `initialize`；T1B 随后完成实际 Session、GearJob 工具调用、ZenMux 模型返回、原生结果持久、执行级取消和重启后 successor 回读。最终仍采用“SDK Client + DSH 原生插件 patch + 薄 Geneway 服务”，实测证据见第 12 节。

**目的：**建立当前工作树自己的最小可重复依赖，不从旧项目搬运。

**动作：**

1. 复核 OS/架构/Node/pnpm 版本和脏工作树范围；从官方/获准来源解析候选 `@deepseek-ai/dsh`、SDK/插件包及相容版本。
2. 生成唯一根清单和锁文件；验证干净安装/重装，记录完整性和实际入口。
3. 先装配一个无业务含义的诊断插件，证明真实 DSH 原生加载、工具注册、Agent/Session/Client 调用、结构化结果和原生事件。
4. 关闭真实业务数据，验证同一 harness 生命周期内 Session 连续、持久历史寻址、事件标识和精确取消；另验证新 sdk 进程不能 hydrate 旧 Session，并按 v3 successor Session 规则承接同一 work。
5. 依据探针选择：单 DSH Host 插件、Geneway 进程嵌入 DSH、或官方 DSH Host + 薄 Web 服务三者之一；只保留一个产品事实源。
6. 核对模型日志、遥测、反馈和凭据加载路径，但在真实外发授权前不发送业务材料。

**成功证据：**包版本/锁文件、真实启动命令、插件调用记录、Agent/Session/执行/结果/事件/取消标识、重启回读结果、存储形态裁决。

**停止/重规划：**需要复制旧 Geneway；必须自建 AgentLoop/Session 恢复/通用重试；没有稳定结果引用；取消只能误伤全局且忙碌拒绝无法保护；结果只存在内存；包集不可锁定或安装需要未授权系统改动。

### P1-T2：第一模型与第一工单来源条件核实

T2A 与 T2B 在各自权限就绪后可并行，但都依赖 T1 的真实 DSH 形态。

**T2A 模型：**从用户明确指定且权限为 `0600` 的 `~/.claude/settings.json` 只读取固定键引用，不打印、复制或提交值。使用 ZenMux 官方 OpenAI-compatible `https://zenmux.ai/api/v1`、精确模型 `deepseek/deepseek-v4-pro` 和 `openai-completions`；凭据仅在受限 DSH 子进程内存中映射为 `ZENMUX_API_KEY`。先用不含业务数据的最小 DSH 请求核对真实路由、工具调用、失败、耗时与用量，再只发送最小规范化模拟工单字段。禁用 shell/fs/web/subagent、默认 DeepSeek adapter、独立 DeepSeek session-log 和 telemetry；不启用 ZenMux fallback 或自动路由。若 `sdk-minimal` 无法在禁用这些能力后装配该精确 route，暂停 T2A 重规划，不为调用成功放开秘密暴露面。

**T2B 工单来源：**启动前读回 `/home/gewu/work/gearjob` 的 `dev.localhost`、Compose/容器、数据库和 developer mode 身份；只在该隔离实例通过正常 GearJob/Frappe 数据层创建全新的 `GENEWAY-P1-SIM-READABLE` 与 `GENEWAY-P1-SIM-FORBIDDEN` 工单、专用只读 service user/role 和对象级授权，`GENEWAY-P1-SIM-NOT-FOUND` 保持不存在。使用标准 Frappe REST 精确读取状态、计划量、完成量、单位、`modified`/source revision 和源时间，比较读前读后证明无业务写副作用。凭据写入 GearJob site 私有 `0600` 文件，Geneway 只持路径引用。禁止修改 GearJob 源码，禁止使用远程站点、`WO-GATE-A3-*`、`gearjob.api.work_order.get_work_order_status`、`X-Geneway-Connector-Token` 或旧 workflow/fence/effect 协议。若标准 REST 不能满足最小字段或对象级只读权限，暂停 T2B 并请求跨仓库 API 建设授权，不回退旧接口。

**T2C 后续条件发现：**只记录 P2 身份/第二连接、P3 协作与知识来源、P4 飞书和用户明确选择的微信形态、P5 事件/时区/去重、P6 第二来源/获准写动作、P7 第二模型/部署/容量/备份的候选、条件提供者、下一步发现和最迟决定点；不调用、不取秘密、不实施后续阶段。

### P1-T3：最小产品事实、绑定与服务端授权

**依赖：**T1 的存储/认证结论；真实执行前还需 T2A/T2B 合法引用。

建立单一维护的 `member`（单操作者受控模式）、`employee`、`connection`、能力绑定、`work`、执行关联和（必要时）不可变观察。一次性 bootstrap 只能在记录不存在时创建。所有 API 从服务端会话取得操作者；拒绝客户端/模型提供的 `operatorId`、任意 URL、任意凭据或未绑定目标。连接目标改变必须创建新连接 ID；每次实际派发和新重试重新检查启用、绑定、动作和对象范围。默认只监听 loopback；若验收要求跨主机而无可靠认证/TLS，则停止远程暴露并重规划。

### P1-T4：外部原生工单插件与确定性规则

**依赖：**T1 的原生插件格式、T2B 的来源字段语义。

插件只接受业务对象参数（例如明确工单号），连接/URL/凭据来自服务端执行上下文；调用真实只读 API，严格规范化状态、数量、单位、源时间、记录引用并映射 404/歧义/超时/限流/异常。自动重试无法重新检查当前授权时关闭。纯函数测试覆盖正数、零分母、缺失、单位不一致、超计划和非法数值。插件不得维护第二份可变结果库。

### P1-T5：工作受理、追问、最新、去重、取消与恢复

**依赖：**T1 的 Session/结果/取消；T3 授权；T4 观察。

提供窄产品操作：创建工作、读取工作/观察、同一工作追问依据、重新查询最新、取消当前执行。状态只使用 `accepted → running → completed|failed|cancel_requested → cancelled`，启动发现未结算执行则标 `interrupted`。同一 Geneway 进程内，一个 work 复用仍存活的 DSH harness/session；进程重启、恢复或 runtime 被关闭后，旧 `dshSessionRef` 只作历史，下一次用户显式操作创建 successor Session，只注入当前仍获准且明确选定的 observation、必要来源关联和本次问题。不得把旧 Session ID 再交给 SDK、重放 JSONL、注入完整旧对话或伪称同一 Session 恢复。execution 记录 `contextObservationId`、实际 `dshSessionRef`、可空的 `continuedFromDshSessionRef` 和 `continuity=new|same-session|successor`；不保存伪造的 DSH run id。

每个活动 execution 独占一个 DSH runtime，关闭该 runtime 是当前 SDK 下的精确取消边界。创建、刷新、追问先在 store 串行更新中以 `(operatorId, workId-or-create-scope, operation, clientRequestId)` 原子 reservation，再后台派发；重复请求返回同一 execution。每次实际派发重新检查当前员工、连接、只读动作、对象范围和 observation 当前访问权。create/refresh 必须由 DSH agent turn 调用且只调用一次 `geneway_gearjob_read_work_order`；服务端从唯一配对的 tool call/result 验证工具名、精确工单号、结果 schema 和非错误状态后形成 observation，不能直调来源后只让 DSH 解释。follow-up 禁止任何来源 tool call；刷新才新增 execution/observation。只有 DSH 结束、唯一合法工具结果已持久、观察与说明均可回读才标完成；迟到响应不得覆盖 cancelled/interrupted/更新后的状态；重启不自动重放。

### P1-T6：P1 Web 与手机响应式入口

**依赖：**T5 稳定产品操作；样式可复用现有 WorkBuddy 视觉语言，不复用合成业务数据。

实现同源的 `home`、`events`（仅真实工作状态）、`work`（J1 核心）和 `employee`（实际装配只读视图）；`mobile` 采用同一数据流响应式布局。首页展示真实操作者、员工、连接、工单号输入、查询、最近工作和缺失/忙碌/拒绝/执行中状态；工作详情展示结构化事实、来源/源时间/查询时间、说明、依据、历史、刷新和停止；员工页不显示假的保存/规则/动作/写入入口；无真实事件时事件页显示真实空状态。基础可访问性包括原生标签、键盘焦点、错误文字、`aria-live` 状态和窄屏无横向裁切。禁止 fallback mock、第三方 CDN、任意 Host 安装入口。

### P1-T7：停机备份与恢复

**依赖：**T1/T3/T5 的实际数据目录和官方存储方法。

停止接受新工作，按真实状态结算/取消或标中断；分别备份产品事实 JSON 和 DSH home 下的 Session JSONL，生成含相对路径、字节数和 SHA-256 的无秘密 manifest。ZenMux/GearJob 凭据、Claude settings 和控制 token 不进入备份。恢复拒绝非空目标和路径逃逸，写入独立数据根后启动同一候选，从普通浏览器深链读取同一 work、两次 observation、execution lineage 和历史 Session 引用；旧 JSONL 的路径、字节数、SHA-256 不变且不会被 successor Session 覆盖。恢复后第一次显式操作创建新 Session，不自动调用模型或 GearJob。失效凭据只阻断新查询；未完成/未知执行不自动重放。

### P1-T8：阶段验证与交接

**依赖：**T1–T7 相关门槛，以及合法第一模型、真实只读来源、获准工单号和外发检查。

使用普通浏览器完成：选择员工/连接→首次 GearJob 测试实例模拟工单查询→核对结构化事实→同进程追问且不增加来源调用→更新模拟工单并查询最新→保留旧观察→刷新/重启/恢复深链回读→针对明确 observation 的重启后追问以 successor Session 完成；在 390px 视口重复关键动作。验证 create/refresh 的 GearJob 事实确实来自 DSH tool event，不接受 direct source + 模型说明替代。运行受控超时、404/权限拒绝、连接禁用、模型失败、零/多/错 ID/tool result、follow-up 意外 tool call、并发重复提交、精确取消和秘密 canary。保存候选提交/锁文件/运行命令、去敏对象 ID 链、GearJob 直接回读、DSH Session/Result 与 successor lineage、浏览器 DOM/网络/console 证据和未运行项。非录制旅程先通过，随后对同一候选录制 MP4、生成 PNG 封面和离线 HTML 操作手册；视频全程显示“GearJob 外部测试环境 / 团队生成模拟数据 / 非生产”，通过 bot 身份和明确飞书目标用 `lark-cli` 发送并保留 message id 与文件 SHA-256。该发送是交付动作，不计入 P4 产品飞书渠道。

## 6. 拟建入口、文件边界与验证命令

T1 决定语言和原生目录后，文件名以实际 DSH 规范为准；默认 Node/TypeScript 仅是当前 DSH 候选的工程假设。保持最少文件：根 manifest/锁文件、原生 DSH 配置、一个工单插件、一个工作服务/HTTP 入口、一个产品事实存储（仅在 T1 证明需要时）、`web/` 静态资源和少量确定性/工作服务测试。不要新增框架、ORM、队列、事件总线、Repository/Factory 层或第二 manifest。

稳定入口由 T1 以实际命令替换，职责至少包括：

```text
<PM> install --frozen-lockfile
<PM> run probe:dsh
<PM> run test:unit
<PM> run test:controlled
<PM> run start
<PM> run accept:j1 -- --work-order-id <AUTHORIZED_ID>
<PM> run backup -- --output <BACKUP_DIR>
<PM> run restore -- --input <BACKUP_DIR> --data-root <RESTORE_DIR>
```

`probe:dsh` 必须实际证明外部插件、Agent/Session/Client、结构化结果、重启读取和取消，不只看类型或注册表；`test:unit` 覆盖数量/单位/时间规则；`test:controlled` 覆盖去重、忙碌/取消/迟到响应、授权/任意 URL、模型失败和秘密泄露；`accept:j1` 必须走普通浏览器而非 API 调试入口。

## 7. P1 启动条件、阻塞与重规划

### 7.1 已满足

- 用户已明确授权开始完整合同的内部工程推进；
- 两名真实 Sol planner 已返回独立意见；
- 本唯一 P1 计划已在安装和代码探针前形成；
- UI 设计稿和合同边界已读取，合成数据与真实证据已分开。
- P1-T1 已完成官方版本锁定、DSH CLI/原生插件/SDK JSON-RPC 探针，实际证据见第 9 节。

### 7.2 当前阻塞（只阻塞相关真实验收）

- P1 当前路径没有遗留的阶段内阻塞；最终证据见第 12 节，仍须以独立阶段审查结论为门禁。
- DSH SDK 新进程不能 hydrate 旧 Session 的限制已按 11.5 落为同一 Geneway work 上的 successor Session，不再作为 P1 阻塞，也不误称旧 Session 恢复。
- 仍只允许 loopback 外部测试验收；跨主机入口、生产 GearJob、部署、发布和客户接受不属于 P1 技术验收结论。
- P2–P7 尚未实施；开始每个后续阶段前仍须重新组成至少两名 Sol planner 的详细规划团队。

### 7.3 必须暂停受影响工作并重新 planner team 复核

DSH 实际 API 否定插件/Session/结果/取消前提；必须自建 Runtime/Workflow/恢复调度；真实来源字段或数量口径无法确认；模型只能依赖未授权外发/旧 token；取消会误伤已接受工作；原生结果无法稳定寻址且最小观察不足；需要改其他仓库/生产 API；UI 和模型无法共享结构化事实；需要跨主机暴露却无可靠认证/TLS；实际查询有业务写副作用；或用户改变真实来源、微信形态、写动作、数据保留或外发边界。

### 7.4 P1 通过条件

只有当 AC-01、AC-02、AC-10/11/12 的 P1 当前路径均有有效证据，并且 ZenMux 真实模型、完整 GearJob 外部测试实例与模拟工单、普通桌面/手机浏览器、追问不重查、刷新追加观察、旧观察/重启/备份恢复回读、原子去重、精确取消、凭据保护、MP4/离线 HTML 操作资料及 `lark-cli` 回执全部成立，才可记录“P1 在 GearJob 外部测试实例、团队生成模拟工单模式下完成技术验收”。完成 P1 不推导生产 GearJob、真实生产数据、P2–P7、全量交付、部署、发布或客户接受。

## 8. 计划后的立即动作

按照本计划先完成 P1-T1 的官方 DSH 相容包安装与无业务含义探针，再只在 T1/T2 结果允许的范围内继续 T3–T8。不得在第一来源/模型条件缺失时用 mock、静态草图或模型编造结果闭合 J1。T1 的实际结果见下一节。

## 9. 已执行的 P1-T1 记录

本节只记录计划形成后的实际实施证据，不改变本计划的 P1 通过条件：

| 时间/命令 | 结果 |
|---|---|
| `pnpm install --ignore-scripts --registry=https://registry.npmmirror.com` | 成功；锁定 `@deepseek-ai/dsh@0.1.6-alpha.2`、`@deepseek-ai/dsh-sdk-client@0.1.6-alpha.2`、`@deepseek-ai/dsh-tools@0.1.6-alpha.2`，生成 `pnpm-lock.yaml`。镜像只改变下载入口，包版本与 integrity 仍由 lockfile 固定。 |
| `pnpm run probe:dsh` | 成功；`dsh -V` 返回 `0.1.6-alpha.2`；`--profile sdk --dump-default-config` 返回包含原生 SDK JSON-RPC、Session、JSONL persistence、tools 与 model adapter 的实际配置，未调用模型或业务来源。 |
| `pnpm run probe:dsh-plugin` | 成功；真实 DSH profile 加载本地插件并通过 `ctx.tools.execute` 返回结构化文本 `status=ok, source=geneway-p1-diagnostic-tool`。首次相对路径错误已修正为相对于 patch 的 `../plugins/...`，随后复跑通过。 |
| `pnpm run probe:dsh-sdk` | 成功；真实 TypeScript SDK 启动 `dsh --profile sdk`、完成 JSON-RPC `initialize`，返回 `deepseek-harness-sdk-runtime`，随后正常关闭；没有 prompt、模型或业务外发。 |

T1 结论：选用官方 Node/TS 包、DSH SDK Client + 原生 plugin patch 的薄集成形态。其后第一模型路由、第一只读工单来源和 J1 已按第 11、12 节落地并实测；本段保留为 T1 当时的阶段记录，不再代表当前阻塞状态。

## 10. 已执行的 P1 最小产品切片

- src/domain/work-order.mjs：规范化工单观察、保留源时间与查询时间、只在计划量/完成量/单位合法时计算完成比例。
- src/store/file-store.mjs：单一 JSON 产品事实源、临时文件写入后原子替换、进程内串行更新；运行时默认写入忽略的 var/state.json。
- src/work-service.mjs：服务端校验员工/连接绑定、固定本机操作者、工作/观察/追问/刷新/停止 API；无真实来源时返回 SOURCE_NOT_CONFIGURED，不创建合成工作；相同 clientRequestId 去重。
- src/server.mjs：Node 标准库 loopback HTTP 入口，默认 127.0.0.1:3471，未显式允许时拒绝远程监听；web/index.html 依据 WorkBuddy 视觉稿落成同源桌面/窄屏响应式首页、待办、工作详情和员工页，所有卡片来自 API，空状态不伪造。
- scripts/test-domain.mjs 与 scripts/test-service.mjs：确定性数量口径、缺失单位、持久观察、刷新追加、追问和受控去重检查。

早期切片检查：`pnpm run test:unit`、`pnpm run test:service`、四个 `node --check`、服务启动后 `curl /` 与 `/api/bootstrap` 均通过。该轮浏览器自动化尚未运行；后续真实 Chrome 验收结果见第 12 节。

这一段只记录 v1 最小切片当时的状态；第一真实工单插件、第一模型调用、员工/连接 bootstrap、DSH Session 与产品 work 关联、取消/恢复和备份回读随后均已实现并按第 12 节验证。

## 11. v2 实施切片、文件边界与验证顺序

### 11.1 唯一实施方案

1. **R1 GearJob 测试环境：**不改 `/home/gewu/work/gearjob` 源码；启动并核对 `dev.localhost`、容器/数据库/developer mode；用一次性受控脚本经 Frappe 正常数据层创建 `GENEWAY-P1-SIM-*` 工单、只读 service user/role、对象级授权和 `0600` 凭据文件；标准 REST 是唯一产品读取入口。若实例不可用或标准 REST 无法满足权限，暂停重规划，不消费旧 Gate A 资产。
2. **R2 DSH 安全运行：**新增 `config/p1-runtime.patch.yml`、`plugins/gearjob-work-order.mjs`、`src/runtime-config.mjs` 和 `src/dsh-runner.mjs`；优先复用 `sdk-minimal` 的 Agent/Session/JSONL/SDK server，禁用 shell/fs/web/subagent、默认 DeepSeek adapter、DeepSeek session-log 和 telemetry，装配一个 ZenMux route 与一个 GearJob 只读工具。需要直接使用 `@deepseek-ai/dsh-llm-pi-ai` 时把相同精确版本提升为根依赖，不依赖传递安装。
3. **R3 产品状态机：**在现有 `domain/store/work-service/server` 内就地补齐 bootstrap、work/execution/observation、原子 reservation、后台执行、当前授权重检、精确取消、迟到响应丢弃和启动时 `interrupted` 结算；不加数据库、队列、Repository/Factory 或通用重试平台。
4. **R4 Web：**保持 `web/index.html` 单文件；补真实状态轮询、幂等动作、`?work=<id>` 深链、模型说明、观察/执行历史、测试/模拟/非生产标识、真实待办筛选及 390px 操作路径。
5. **R5 停机迁移：**新增一个 `scripts/state-transfer.mjs` 同时实现 backup/restore 子命令；只复制产品事实与 DSH Session，生成 hash manifest，不复制秘密。
6. **R6 验收资料：**复用 Node 标准库、现有 Chrome/Xvfb/ffmpeg 和 CDP；自动检查与录屏共用同一旅程，生成 MP4、PNG 封面和可离线打开的 HTML 操作手册。发送只调用现有 `lark-cli`，不把飞书交付逻辑写进产品。

R1 与 R2 的无业务模型预检可并行；R3 依赖 R1/R2 的稳定契约；R4 在 R3 API 稳定后实施；R5 在产品与 DSH 数据根确定后实施；非录制验收通过后才能录屏，录屏资料校验通过后才能发送飞书。 tightly coupled 的产品代码保持一个写入者；只读复核和验证可独立并行。

### 11.2 最小观察、执行与来源字段

观察除既有业务字段外仅新增：`observationId`、`sourceSystem=GearJob`、`sourceInstance`、`sourceEnvironment=external-test`、`dataMode=synthetic`、`sourceRecordId`、`sourceRevision`、`sourceObservedAt`、`queriedAt`、`dshSessionRef`、可空的 `continuedFromDshSessionRef`、可空的 `contextObservationId` 和 `continuity`。这些值由服务端连接配置、GearJob 响应和实际 DSH Session 形成，浏览器和模型不能提交；没有原生 run id 时不保存伪造的 `dshRunRef`。`completion.reason` 使用稳定原因码，中文由 UI 映射。

执行保存：`executionId`、operation、`clientRequestId`、状态、开始/结束时间、错误/中断原因、DSH 事件范围与结果引用。产品不双写模型 token、完整循环检查点或 GearJob 镜像。

### 11.3 验证命令与通过证据

拟建稳定入口：

```text
pnpm install --frozen-lockfile
pnpm run test:unit
pnpm run test:service
pnpm run probe:p1-runtime
pnpm run test:controlled
pnpm run backup -- --output <EMPTY_DIR>
pnpm run restore -- --input <BACKUP_DIR> --data-root <EMPTY_DIR>
pnpm run accept:p1
pnpm run accept:p1 -- --record <RETAINED_OUTPUT_DIR>
```

`probe:p1-runtime` 必须证明安全 Profile、真实 ZenMux 非业务探针、GearJob 插件加载和无秘密输出；同时记录 sdk profile 不支持新进程 hydrate 旧 Session 的版本事实，不再把同 Session 跨进程恢复列为通过条件。`test:controlled` 必须证明 create/refresh 只通过唯一合法 DSH GearJob tool result 完成，零/多/错 ID/错误 tool result 均拒绝；允许/拒绝/不存在工单、原子重复 reservation、同进程同 Session 追问不查源、重启后 successor Session 承接同 work/observation、刷新新增观察、连接撤销、模型失败、W1 精确取消不影响 W2、迟到响应丢弃、启动中断和停机恢复。秘密 canary 只输出零/非零命中数，不输出秘密或命中行。

`accept:p1` 使用同一候选、同一 GearJob 模拟工单和同一对象链，覆盖 1440×900 与 390×844；DOM、API、GearJob 直接回读、DSH 结果和历史必须一致，无阻断 pageerror/console/resource failure。录制材料需完整解码、封面可读、HTML 离线打开且每步有对应截图和时间段；发送前在线检查 Lark 目标并使用幂等 key，保存去敏 message id、发送时间与视频 SHA-256。

### 11.4 停止与重规划条件

出现以下任一事实时暂停受影响切片：GearJob 目标不是隔离开发实例；标准 REST 需要改 GearJob 源码；实现依赖旧 Gate A 端点/令牌/数据；安全 DSH Profile 无法在关闭 shell/fs/web/额外外发后调用 ZenMux；唯一合法 GearJob tool result 不能稳定定位或模型不能可靠执行恰好一次受控调用；successor Session 必须复制完整历史才能工作；旧 JSONL 被覆盖或无法与 execution 关联；取消仍会误伤别的 work；需要自建 AgentLoop、Session hydrator、JSONL replay、队列或通用恢复框架；备份不能覆盖关联历史；需要跨主机暴露、生产部署或客户数据；飞书目标不明确。最后一项只暂停发送，不回滚本地成果。

### 11.5 v3 Session 连续性裁决

`@deepseek-ai/dsh-sdk-client@0.1.6-alpha.2` 的 sdk wire 只提供 initialize、prompt 和 shutdown；sdk server 对不在当前进程 Map 中的 sessionId 调用 create，若持久层已有同名 Session 就返回 `already exists`。因此 JSONL 可持久、备份和审计，不等于 sdk profile 可 hydrate。当前 P1 不切换到另一套 Web/API SessionController，也不自建恢复器。

P1 的连续性权威对象是 Geneway work：同一进程内可复用当前 DSH Session；重启/恢复/取消关闭后，下一次用户显式操作创建新的原生 Session，只携带当前获准且明确选择的 observation、必要来源关联和问题。execution/follow-up 以 `dshSessionRef`、`continuedFromDshSessionRef`、`contextObservationId` 和 `continuity` 记录 lineage。旧 Session JSONL 保持不变且可由历史 execution 定位。合格声明必须说“同一 work、successor Session 承接”，不得说“旧 DSH Session 已恢复”。

## 12. P1 最终实施与验收记录

### 12.1 实际运行候选

- DSH 包集锁定为 `0.1.6-alpha.2`；产品只启用 SDK runtime、一个 GearJob 只读工具和 ZenMux `openai-completions` 模型路由，模型为 `deepseek/deepseek-v4-pro`，Base URL 为 `https://zenmux.ai/api/v1`。shell、filesystem、web、MCP、subagent、telemetry、额外 session log 和默认 DeepSeek adapter 均在 `config/p1-runtime.patch.yml` 禁用。
- `~/.claude/settings.json` 中既有 token 只在父进程内映射为子 DSH 所需的 `ZENMUX_API_KEY`；没有把 `ANTHROPIC_*`、GearJob 凭据或 token 写入产品状态、浏览器、备份或验收资料。
- GearJob 使用 `/home/gewu/work/gearjob` 的 `dev.localhost` 外部测试实例；团队创建 `GENEWAY-P1-SIM-READABLE` 和拒绝对象，专用只读用户只有可读对象权限。标准 REST 实测允许对象 `200`、拒绝对象 `403`、不存在对象 `404`，未修改 GearJob 产品源码。
- 产品保持一个 JSON 事实源、一个 loopback HTTP 进程、一个 DSH runner、一个静态 Web 文件；没有新增框架、数据库、队列、事件总线或恢复器。

### 12.2 自动与真实链路证据

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，依赖与 lockfile 一致。 |
| `pnpm test:unit && pnpm test:service && pnpm test:controlled` | 通过；覆盖数量规则、持久观察、原子重复受理、同进程追问、successor lineage、直接来源旁路拒绝、零/多/错工具结果、follow-up 工具调用拒绝、连接非 ready 拒绝、取消与启动中断。 |
| `GENEWAY_P1_PROBE_MODEL=true pnpm run probe:p1-runtime` | 通过；实际 `zenmux / deepseek/deepseek-v4-pro / openai-completions`，DSH 事件 14 条，非业务模型响应成功。 |
| 真实 J1 浏览器旅程 | Chrome CDP 实际页面完成：首次 `Draft / 10 / 0 / Nos / 0%`；同 Session 追问且观察数不增加；GearJob 模拟数据更新为 4 后刷新得到 40%，旧 0% 观察保留；深链重载可读。 |
| 重启连续性 | 同一 work 保留；旧 Session `session-4a6e…` 只作历史，新 Session `session-4f2e…` 记录 `continuedFromDshSessionRef`、当前 `contextObservationId` 和 `continuity=successor`，没有 hydrate 或重放旧 JSONL。 |
| 390×844 | `innerWidth=390`、`scrollWidth=390`、桌面侧栏隐藏；当前 40%、来源、观察历史和操作仍可见。 |
| GearJob 权限边界 | 同一专用 credential 对允许/拒绝/不存在对象分别返回 `200/403/404`。 |
| 秘密 canary | 扫描工作区、产品状态、DSH home、备份和恢复根共 149 个文件，实际 ZenMux token、GearJob API key/secret 命中数为 0。 |
| 停机备份/恢复 | 备份 9 项、150592 字节；manifest 中每项 SHA-256 在独立恢复根全部复核通过；恢复服务回读同一 work、2 条 observation、2 条当时 follow-up 和最新 0.4。 |

内置 Browser 通道因当前 Node kernel 与 browser-client 的 `Cannot redefine property: process` 冲突不可用；这不是产品失败。验收改用本机 Google Chrome DevTools Protocol，实际浏览器 console warning/error 与 Runtime exception 均为 0。此工具切换不改变页面、来源或模型候选。

### 12.3 界面材料与飞书回执

- 完整实录：`artifacts/p1-acceptance/p1-final-acceptance.mp4`，时长 121.08 秒，SHA-256 `94c5d9765d0cf7c095c84c5d0249ebbf4f6f002eb15ba5d1438637b27a27bfcc`。
- 服务端连接状态门禁修复后的同候选补充复验：`p1-final-acceptance-v2.mp4`，时长 33.76 秒，SHA-256 `95c3eda9bf6f5c2d4a156f7bd3a158a521c27362482bc27dc3c77727fcaa154c`。
- 离线操作手册：`artifacts/p1-acceptance/index.html`，以相对路径引用视频和截图，不包含凭据。
- `lark-cli` bot 发送均返回 `ok=true`：完整实录 message id `om_x100b65d439fbd8a0b4b5c0697c5763b`（2026-09-19 11:54:27）；补充说明与复验视频 message id 分别为 `om_x100b65d4cb8fdcb0b32a735fbaf4178`、`om_x100b65d4cbbf30a4b277f591395518e`（11:58:12、11:58:15）。幂等 key 固定，重复命令未产生重复消息。

### 12.4 P1 结论边界

在独立阶段审查没有发现 P1 阻塞项的前提下，可记录“P1 在 GearJob 外部测试实例、团队生成模拟工单模式下完成技术验收”。这只覆盖 AC-01、AC-02、AC-10/11/12 的 P1 当前路径和 J1；不表示生产 GearJob、远程部署、正式发布、客户接受、P2–P7 或整份合同已经完成。
