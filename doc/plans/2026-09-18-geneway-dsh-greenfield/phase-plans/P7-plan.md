# P7 全量集成与可运维交付详细计划

计划首次落盘：2026-10-16 16:14:01 UTC（2026-10-17 Asia/Shanghai），此前标称 16:10 为起草时间，不能作为实施顺序证据。状态：**双 Astra 规划、交换及两项独审通过；计划提交 `38a804e` 先于 T0。T0 原生检查及真实 GLM 工具调用通过；净安装构建策略已窄修并通过一次预验。T1/T3/T4 源码与局部检查独审通过并分别本地提交，T2 渠道协作与回执接线独审通过并本地提交；T5 验收脚本已独审并提交，所选20个回归入口实际通过。原生容量经采样范围及退出竞态修复后完整实测通过，原失败保留；Host 容量在§6.1最小修复后以原门完整通过，20身份空闲CPU为0.8403核、读取p95为337.5ms，原失败保留；两空目录冻结锁安装、原生探针及正式供应/登录/正常停止实际通过；旧应用、新版读取与空目录旧版回退完整演练通过，原始全量业务状态不存在的限制保留。最终同候选两路由、组合旅程及运维验收尚未完成。J10三轮在环境、共用select及继承库outbox前提处失败，旧证据保留；§8.1记录实施前的双Astra局部重规划，已通过独立过度设计审查及通知消费域口径复核；新准备包尚待实施。**

依据：合同 v4.4 全文、clarification-notes.md §10/11、P1–P6 计划顶部有效决定及实际验证记录。用户在 P6 完整材料交付后明确“开始p7”，进入门已解除；P7 技术交付后仍由用户最终验收。本文是唯一 P7 计划，不是正式发布认证，不另建执行许可、receipt 或验收平台。

基线：Geneway `/home/gewu/.devspace/worktrees/geneway-f4222c66`，`rebuild/dsh-greenfield@4bbf8e443a2f9e0e5d2bc00038bd1a77a190af24`（相对 `eb69798` 仅记录 P6→P7 指令，产品提交 `700b1ec`）；Kivo `/home/gewu/.devspace/worktrees/kivo-geneway-mcp`，`codex/geneway-kivo-mcp@ae27a4e97ddfa5248d4461bd563d9e907489b81c`。Geneway 原五组未跟踪 `ui-sketches*` 不读改、不暂存、不清理，Kivo 原工作目录和共享 refs 不动。

沿用 workflow `20260919-006-geneway-dsh-greenfield`。唯一外 Git 验证记录为该任务产物目录的 `p7-verification.md`，保留实际命令、退出码、失败/跳过、候选、实例、对象、结果及交付引用。本文记录方案、决定与阶段状态，不复制原始日志。

## 1. 目标、授权与完成边界

交付 G9 的完整产品配置、运行反馈和可运维能力，并保持 G1–G8。新增完整 J10、两条真实模型路由、实测容量与预算、可重复安装、完整备份恢复、DSH 升级回退、上游复用代码与 Kivo MCP 兼容维护。最终核对 J1–J12 和 AC-01–25 的全部适用结果，既有证据仅在相关代码、配置、身份、数据语义与方法仍适用时保留。

只在上述两个仓库本地提交；不 push、PR、合入、部署、发布，不改第三仓，不访问现场数据。安装与运行演练仅在本机 owned 隔离测试根，独立端口、数据库、Redis、synthetic 数据及秘密；不得据此变为共享环境部署。只监听 loopback。沿用本任务独立 Kivo/Hive 测试依赖，启动前重新核身份和有效 License，旧 PID/expiry 不是当前事实。

业务写权限保持本人核对并批准后，经机器 MCP 创建 synthetic 设备维修单；不增加自动批准、派工、报警处置、PLC/设备控制、业务删除或新写动作。测试用 Kivo 人类状态变更仅沿 P5/P6 已授权 synthetic HTTP 路径，用于真实 producer/outbox/worker 事件，不从数据库制造完成事实。旧已成功或未知动作不为验收重放。

渠道为模拟验收，必须经过实际 iLink 协议及飞书 SDK 事件入口，不发真实产品消息、不扫描联系人或群。阶段视频、离线说明按已授权 `geneway-product` 飞书路径交给用户并逐条 GET 回读。管理员仅看运维元数据，不能读取成员正文。

第一模型保持 ZenMux `deepseek/deepseek-v4.1-flash`。唯一已授权模型秘密来源仍是 `~/.paseo/config.json` 中精确 ZenMux 项及其服务端秘密引用，不扫描其他配置。第二模型由用户在本轮指定为 ZenMux GLM 5.3 Flash；官方模型目录已核实精确 ID 为 `z-ai/glm-5.3-flash`。沿同一 ZenMux 账号与秘密引用调用本任务 synthetic 数据，不扩其他模型或凭据；可用性仍须原生实测，无自动 fallback。

用户已将整体界面逻辑调整后置至功能实施完成；P7 仅补本阶段必需配置、反馈、导航、手机操作和安全/误操作缺陷，不自行全面重设计。

## 2. Team Astra 独立规划、取舍与审查

两名 `atlas-sdd-planner`，`gpt-6-astra/high`，`fork_turns=none` 收到同一目标、权威、决定、前序结果、权限与中性问题，先独立读文件和工具检查，首轮未互看：

| 规划者 | 视角与结果引用 | 实际限制 |
|---|---|---|
| `/root/p7_product_planner_astra` | 产品结果、J10、两路由、容量与交付；`team-result:/root/p7_product_planner_astra#initial` | 只读合同、代码、已有报告与 Git；无秘密、测试、探针、应用或外部调用。 |
| `/root/p7_engineering_planner_astra` | 工程接线、原生执行、资源、安装恢复与版本兼容；`team-result:/root/p7_engineering_planner_astra#initial` | 同上；明确区分已存源码与实际未测能力。 |

双方共同判断：使用现有单一 file-store、DSH 执行及渠道/协作/动作服务，不引入 Runtime、队列、数据库、审批或发布认证平台；第二路由必须贯穿全部执行入口；渠道缺协作创建/继续接线；动作保留在有真实关联结果的子工作；运维配置与认证供应需要可复现入口。

交换形成的关键裁决：

- 规模统一取 20 成员、5 Agent、200 会话；不采纳无额外义务依据的 8 Agent/500 会话。样本历史另为 1,000 工作、5,000 turn、100 份知识和 20 条规则。
- 本地读与受理 p95 ≤1 秒；不采用缺少用户 SLA 或测量依据的 500ms。自有产品进程树峰值 RSS ≤4 GiB，不采用尚无测量依据的 2 GiB；这些为实施前冻结的测试目标，不是已支持声明。
- 4 顶层执行是硬上限，服务端原子受理必需；第 5 个 BUSY。空闲 Harness 回收是 T0 条件分支，只有实测线性驻留或资源门失败且由它导致时才实施。
- 成员供应扩现有受限运维 CLI，支持显式名单和原身份校验；不新建邀请/IAM/邮件系统，不为容量另造后台成员创建页。
- 完整恢复使用既有 state-transfer 加固定外置配置配套恢复步骤，只有必要格式/秘密引用缺口才改脚本；不造任意文件归档器。
- DSH 回退采用成套 code/lock/data/DSH 快照，优先使用原 U0 真 Session 素材；缺真实素材时才用历史精确原生 API 在隔离根生成。不能只改版本字段，也不能回退覆盖升级后的外部效果。

交换结果：两名 planner 最终均返回 `CONSENSUS`，工程 planner 已逐项复核唯一计划。两项原保留为硬4受理不能条件实施、idle回收必须有稳定上界实测，均已采纳；同时落实幂等先于容量、取消关闭前不释放、渠道turn/work分别占位、CLI半成功可恢复。引用为两名同一 agent 的 `#exchange` 与工程 planner 的 `#final-consensus`。

未参与规划的 `/root/p7_overdesign_astra` 与 `/root/p7_plan_review_astra` 分别独立审查候选 `3bc8d5197b6f7947f26dae9056fb1b06b93d0566d8a3d6c94d411a37621cc020`，均返回 schema v2 PASS、issues为空；首轮不交换意见。过设计做两项静态消融：删除全局容量门不能由仅自动并发2替代；立即关闭所有成功Harness会改变same-session续接且无等价实证。因此保留原子硬4与条件idle回收，未增加独立服务。正式审查核对完整合同覆盖、就绪任务和代码接缝。两审当时保留第二模型授权、T0原生/资源事实、J10/运维实测与AC-22原始时序未证，不将计划PASS当运行PASS。计划门后的首个提交只更新本节与顶部状态；随后用户指定GLM，按已审的用户选择分支落实于§1/4.1及澄清§11.10，不扩大其他执行范围。

## 3. 已观察事实与未证假设

| 事实 | 工程影响 |
|---|---|
| DSH 直接依赖 `0.2.0-rc.2`；MCP client `2.3.1`；飞书 SDK `1.74.0`；Node ≥24；pnpm `11.8.0` | 当前锁定组合优先；P7 不默认再追 latest。必须实测冻结锁安装。 |
| store v12 已包含 work、conversation、knowledge、channel、automation、action，原子写入已有 | 扩现有事实与迁移，不另建运行数据库。 |
| runtime-config、work/conversation/automation service、collaboration-runner、execution grant 与 runtime patches 多处固定 Flash | 需要一个共享可信解析边界和一致请求复权，不能仅加 UI。 |
| 协作已有限制和 usage；普通 runner 多为 eventCount，通用 Web 用量/预算反馈不足 | 复用原生 request/usage 事件，补必要执行投影。 |
| dsh-runner 成功后保留 sessions Map 的 Harness | 连续完成工作可能累积 SDK 进程；这是源码推断，T0 实测才决定回收。 |
| 渠道工作工具只接普通 create/continue；已有 createCollaboration/continueCollaboration 支持根工作 conversationId | 窄接现有服务；不再造计划解释器。 |
| action-service 要求 correlation 结果，协作根是汇总 | 批准留在关联子工作；根提供可访问的导航与发送关联。 |
| state-transfer 包含 state、事件来源、关联 Session、配对秘密；恢复关闭渠道、暂停规则、unknown/rebind、批准失效 | 保持语义，补完整外置配置和认证供应说明，不重写引擎。 |
| init-p2-auth 默认两成员；底层 auth 支持显式 authRef；成员 API 已有更新 | 受限 CLI 提供更多合法成员；生产入口不能依赖验收脚本手写 state。 |
| vendor/dsh-im/weixin/SOURCES.md 已记 4.39.0/MIT/来源及本地差异 | 进行一次有界来源对比并完善同步步骤，不自动升级整包。 |
| P4/P5/P6 最终真实旅程已有，P6 final16 13/13、视频离线和飞书交付完成 | 可保留未失效的边界证据，不能拼接代替新 J10。 |
| Kivo check-boundaries 基线/候选同为 exit1、634 原始诊断；相关 MES 类型检查另有 exit0 | 保留原失败，不称全仓绿；初始派发的“634类型问题”笔误已纠正。 |

Geneway 未声明 Control；Kivo 的 `agent-controlled-actions`、`control/agent-mcp-access.md` 等现有权威保持。P7 默认不改 Kivo 产品代码；若组合暴露本接入阻断，按既有 Control 与窄责任修复。改变用户承诺先取得相应决定。

## 4. 模型路由、预算与运行反馈

### 4.1 唯一事实与实际派发

`state.modelRoutes[]` 保持产品可编辑事实源，员工只引用 `modelRouteId`。在现有 `runtime-config.mjs` 中集中解析已批准 provider/model/API/endpoint/参数/秘密引用；仅在职责确需时提取一个窄模块。主机声明可用接入和秘密边界，不另存可编辑员工或权限副本。不接受模型/普通成员提交的 URL，不开放任意 provider 注册。

普通工作、即时会话、协作父子、渠道及自动工作共用该解析和当前授权。一次执行冻结实际路由和参数并保存非秘密身份，历史不因配置修改被改名；新执行用新配置。停用路由/员工、移出开放范围或撤销连接，在后续 I/O 前拒绝。协作子员工用自己的获准路由，禁止可变全局“当前模型”。

改变实际模型/接收方或影响上下文的参数时，用干净 successor 承接当前获准事实，保留原 owner、work/conversation 与历史谱系；不把旧 Session 全文自动送给新接收方。请求守卫同时核实际路由与目标。仅支持实测支持的 `maxOutputTokens`，范围 1–4096，其他推理/温度选项不先造。

第二路由分支已由用户选择：ZenMux `z-ai/glm-5.3-flash`，第一路由仍为 `deepseek/deepseek-v4.1-flash`。2026-10-16 16:23 UTC 实际读取 `https://zenmux.ai/api/v1/models` 返回 HTTP 200，精确名称与官方模型页面一致；这只证明目录存在，不是调用成功。先做无业务内容的原生工具调用探针，再 synthetic 业务；不同模型族的 tool-call、usage、重试和参数行为按实际返回验证，不能继承 DeepSeek 专属假设。用户此前允许另一款 DeepSeek 的答复已被最新 GLM 指定取代，禁止静默选回其他模型。两者显式选择，不自动 fallback；不可用只暂停对应分支并保留 AC-21 缺口。秘密来源与 ZenMux 接口保持原授权。

### 4.2 请求预算、硬容量与反馈

| 执行 | 冻结边界 |
|---|---|
| 普通工作单 execution | 最多 4 次实际模型请求；每次输出 ≤4096；120 秒 |
| 会话单 turn | 最多 6 次实际模型请求；每次输出 ≤4096；120 秒 |
| 协作 | 保留 12 次请求、深度 1、最多 4 子项、子并发 2、根360秒/子120秒 |
| 自动任务 | 保留累计1–10次、默认10、自动并发2、60秒对账和既定跳过语义 |
| 全产品 | 最多4个顶层活动 execution/turn/协作根，自动执行含在其中；协作子不重复计；waiting_input不占用 |

请求前消费本 execution 预算，内部重试计入，不能因重试清零；新显式继续产生新 execution并显示新预算，不暗中继续。预算耗尽保留已持久依据、明确失败/继续入口，不能伪报完成。普通 SDK child 不直接写产品 JSON；复用原生 guard 与事件投影。若 T0 证明合法主链本身超过这些值，先局部双规划，不事后降低标准或绕开保护。

4 顶层限制在既有 store 串行受理事务内按现有活动事实检查；幂等重放和活动执行重复继续先返回原执行，只有真正新增执行检查容量，在模型/工具派发前返回明确 BUSY。自动接受与occurrence/work关联必须同一原子判定，无单独计数事实源、队列或后台补跑。自动规则满额沿既有capacity终态跳过。渠道已持久入站不能丢失或误记业务完成；尚活动的渠道turn与它创建的独立work分别占位，满额明确工作未受理，不借协作child豁免或等待形成资源互等。停止中的执行在仍可能派发或资源关闭未完成时不提前释放；终态与关闭顺序沿现有责任最小调整，重启中断后释放且不重放。取消 W1 不关闭 W2。定向检查4入口竞争、auto占总量、child不重复计、满额幂等、关闭/新受理交错和恢复。

执行/turn 保存实际可得 request数、provider/model、开始/结束/耗时、原生 token usage、预算终止原因；同 request 的重复事件不重复累加。未知不写0，费用无可信来源显示未知。本人在详情查看；管理员现有管理入口只提供调用量、耗时、错误码、路由与渠道连接元数据，不含目标单号、标题、prompt、知识、正文、结果或 Session 内容。

## 5. J10 最小组合方案

扩现有渠道会话工作创建/继续工具，显式协作类型调用已有 `createCollaboration/continueCollaboration`。复用既有计划项、员工/Skill/连接校验、调用标识幂等和 conversation 归属，不新增 DSL。缺明确业务对象时进入等待，不能默认选择最近工作；负责人就是当前获准会话 Agent。

一名子员工读取同设备 TPM+monitor 形成真实 correlation，另一名检索获准维护知识并复核；父工作显示原生子执行、计划、交接与汇总。维修动作保持在 correlation 子 work 的 `actions[]`，根详情只提供查看依据/预览的访问受控导航，不复制子结果或创造根动作。

渠道反馈沿当前有效 root/child/conversation/owner 关系派生目标，发送前仍校验成员、员工、identity与知识范围；不能因根可见就绕过子工作授权。主动规则按可信 resource/sourceInstance、TPM ID、device UUID 跟进同一对象；沿已有 rule/occurrence/work 引用核对，不新建旅程/案例实体。确有 UI 导航缺口时，只增经过 owner与目标核对的来源 work 引用。

### 5.1 一次完整真实操作

1. 新建本轮 synthetic TPM/设备对象与合法成员身份，记录A/B实际实例；禁止重放旧 final16 动作。管理员后台配置员工、连接、Skill、模型；A/B隔离与管理员正文拒绝保持。
2. A 从本地 iLink 实际通道交办协作任务，故意缺明确 TPM 单号，形成一个等待根；飞书同候选用官方 SDK 事件入口覆盖同类交接，不能直接调 service替代。
3. Web 找到同一会话和根；刷新/正常重启后仍存在；本人在渠道或 Web 补充同一根。重复消息和继续不新增重复执行。
4. 两名员工真实分工、工具调用、获准知识引用、交接汇总。两条实际模型路由参与本轮选定执行；模型不可用不得 fallback。
5. 本人从普通 Web 建同对象跟进规则。获准 Kivo 人类 HTTP 变更经事务/outbox/worker/签名 webhook、MCP回读及DSH产生后续观察和通知；旧观察不覆盖。丢事件补偿沿已有对账，不用模型轮询。
6. 在关联子工作核当前来源、预览维修；至少一次拒绝零写，再本人390px Web批准新预览；真实机器MCP创建新GW单号，从Kivo HTTP/独立持久结果与机器审计回读。
7. 真实回执经当前获准渠道反馈；微信需要本人近期上下文，平台拒发/unknown如实显示。发送前撤权负例零发送，重发通知不重新执行业务。
8. 正常重启后全部关联及历史可读。停机备份，空目录恢复，证明零自动模型/业务写/旧渠道重发、规则暂停、来源关闭、微信重绑、批准失效和未知状态保留。
9. 重新供应认证并核配置/当前权限，必要渠道重绑；执行一次新的获准只读操作，证明恢复后实际可用。旧cookie、解绑identity、旧批准不能复活。
10. 同候选完成W1/W2取消、B/管理员已知ID越权、路由停用/故障、预算/容量和桌面/390px关键操作。失败边界另列定向证据，不把旧阶段视频拼成J10。

必须记录同一成员、渠道identity/conversation、root/child、业务source/record/device、rule/occurrence、action/GW单号/receipt的真实关系。API可准备合法数据、独立回读和测拒绝，不能替代必需Web操作。最终冻结候选上的完整旅程才关闭J10。

## 6. 容量与资源验收

目标为20名由正式受限供应入口建立的成员、5名Agent、20个同时在线微信身份、1个飞书消费者、4顶层执行；测试存量1,000结束工作、200会话/5,000turn、100份知识（沿现有总量约3.2MiB上限）、20规则。历史量是synthetic验证样本，不是满额删除政策；超出实测范围不宣称无限支持。

- 微信用真正等待式本地协议 long poll，持续10个完整poll周期并覆盖一次断线重连；空闲模型调用0，每bot最多1个poll，同bot第二实例被拒。分别量2与20身份同条件资源；重投/乱序/非主人/一次持久失败证明游标只在受理后前进，解绑/停止释放锁。
- 执行先受控延迟验证原子4上限、第5个BUSY、取消与预算，再以真实获准路由验证至少W1/W2并行。受控吞吐不能称供应商吞吐。连续多批普通工作完成后量自有SDK进程数与RSS，判定空闲驻留是否有可重复稳定上界；同时检查历史继续、取消与正常关闭。
- 本地读与受理p95≤1秒；事件durable ACK p95≤1秒且每次成功ACK<10秒。模型耗时单独记录。所选负载下自有Geneway/DSH/SDK及微信锁辅助进程树峰值RSS≤4GiB、稳定空闲CPU≤1核；外部Kivo/Hive、模拟器、浏览器另报，不混入或漏计自有child。
- 在目标数据量停机备份与恢复到可登录只读状态分别≤10分钟。RPO为最后完整停机快照，外部重新授权/微信重绑不冒称已包括在现场RTO。
- T0 已实测普通工作完成2/4/8次时，idle SDK子进程为2/4/8、进程树RSS为432204/749332/1398164 KiB，线性驻留条件成立。因此实施固定4个idle上限，仅关闭最旧无活动Harness，保留原生历史及successor，并测关闭与同Session新请求竞争，禁止淘汰active；若原生合法行为不相容则局部重规划，不无限按测量调参，不造TTL服务、池或队列。shared Host八会话无SDK子进程，不扩大回收到该路径。此为受控loopback原生样本，不是完整容量PASS。

记录主机、精确二进制、输入规模、样本数、原始延迟、进程树/CPU/FD及清理事实。目标失败先定位，不能事后改数字掩盖失败；需要架构或目标改变时局部双规划。

### 6.1 Host 空轮询容量阻断的局部修复决定（2026-10-16 20:15 UTC）

Hostfinal05 的 20 身份三秒空闲窗口实际为 1.119986 核，超过原 1 核门；采样器与 Host 分进程，不能归为采样成本。每次成功空轮询都将相同 connected 状态交给 setWeixinRuntime，原实现会反复持久化整库。CPU 归因比例尚未量化，修复收益必须按原负载和窗口重新实测；原失败保留。

在现有 T5 容量阻断范围内，root、Sol 只读分析及独立 Astra 最小方案复核选择仅优化 setWeixinRuntime：每次仍实际读取并校验当前 identity/bot/app/status；只有无状态、归一错误及派生变更义务时免写。需要变更时仍在原 update 事务内重新校验并使用当前状态，不提交预读快照。保持 unavailable/stopped 保留规则、失效凭据的 rebind/revision/端点/投递/关联码联动及存储失败传播；不改变插件每轮回调、入站/发送复权，不增加缓存或修改 store API。相同状态不刷新 updatedAt，实际状态或错误变化仍刷新；现有契约未将该字段定义为心跳时间。实施限渠道服务及相关回归，实施后独立审查。

必须以原缺陷的重复报告写入计数或同条件检查建立前后证据，覆盖同值复权、读后撤权与写事务复权、错误变化/清除、同值 invalid 联动及 read/persist 失败。1 秒轮询、3 秒空闲窗口、1 核、4 GiB、durable ACK 与读取延迟门均不变。若此局部修复不足，依据新实测再处理，不能改阈值或反复采样择优。

## 7. 安装、配置、完整恢复与版本维护

### 7.1 最小可交付形态

保留Node单产品进程和当前依赖；提供冻结源码/lock产物与一份中文 `doc/operations.md`，必要辅助只扩既有脚本。不安装系统服务、不Docker化Geneway、不做Kubernetes或公网部署。

在两个空owned测试目录从同一冻结产物执行 `pnpm install --frozen-lockfile`，记录实际Node/pnpm版本、安装闭包、正常启动/信号停止、独立根无旧/tmp路径依赖。package manager前置失败是安装失败，不把展开测试成功改称聚合命令通过。

入口复用 `node src/server.mjs`、`scripts/init-p2-auth.mjs`、普通后台配置。扩认证脚本为停机维护入口，支持受限显式成员名单，沿现有成员/role/authRef校验和唯一ID。首次初始化、增补新成员、既有authRef重新供应凭据语义分离；重复运行不覆盖既有角色/开放范围、不启用已停用成员、不删除未列成员、不复活旧cookie。state写入成功而auth写入失败时可安全重跑恢复，不要求手改state；新增成员权限须显式提供并由管理员现有入口调整。密钥/口令不放命令参数或日志。认证文件和签名材料在受限独立根，不进普通备份。

运维说明列state、DSH home、secret root、auth file、connection catalog、事件来源、model credential mapping、origin/port的唯一所有者；包含首次供应、后台配置、错误码、本人运行反馈、管理员元数据、Kivo trace定位与正常停止。识别残留按owned进程身份，不扫端口kill。

### 7.2 成套备份恢复

继续用 `scripts/state-transfer.mjs backup/restore` 和其配对 `--secret-output/--secret-input/--secret-root`。产品包负责state、所有关联Session和事件配置；秘密包只收集当前引用且保持0600/0700、配对摘要、空目标/无symlink、部分包失败处理。第二模型秘密引用必须被收集，不能因未在普通state保存真实引用而漏备份。

配套操作仅复制固定已知的非秘密启动配置与可信connection catalog到受限目录，校验并在新根显式重映射路径；不泛化读取任意文件、不另建可编辑配置权威。恢复认证时按原member/authRef重新供应并重置签名材料，保持role/enabled/employeeIds，旧cookie失效。须实际证明不依赖原运行目录。

恢复后活动执行中断、已完成历史保留原义；未用批准失效、在途动作unknown；规则暂停、pending suppressed、事件来源关闭；渠道关闭、sending unknown、已发不重发、微信rebind-required。无秘密或上游授权吊销时只读历史按当前权限可用，新派发明确不可用。恢复旧快照后先核对恢复点之后撤权/解绑，再开放入口，不能把旧快照当外部授权权威。

Kivo/Hive数据库由各自维护者负责，Geneway备份不回滚已创建维修单；未知效果按稳定业务身份核对，不自动重放。备份必须停机或遵循现脚本变化检测，不将并发修改下的部分集合称一致快照。

### 7.3 DSH、iLink 与 MCP

DSH先复用U0原始旧Session及已锁包集，验证旧格式在新候选可读或明确不可用、typed结果的判定/单位/时间不被重算。旧素材不足时，有限分支用历史精确原生API生成synthetic Session，再升级读取和回退原快照，禁止调用退休GearJob业务。当前P7最终候选仍为批准包集；无需默认再次升级。

回退顺序为停止候选→保留升级后数据→以升级前code/lock/data/DSH完整集合在新空根启动。不能让旧binary读新格式；若升级后已有新业务效果或不兼容事实，不覆盖新数据假称无损回退，停外发、保留当前事实，选择修复前进或经明确分析的恢复。操作演练实际起停/读历史，不只写说明。

iLink按 `vendor/dsh-im/weixin/SOURCES.md` 精确来源做一次有界比较；无当前相关修复则记录不升级依据。有修复只同步所需协议段，保留durable后游标、owner、秘密、分段/unknown、单消费者及禁止额外外发。协议与同Host生命周期检查仍必需，不引dsh-im Host/命令/Agent映射。

Kivo支持组合记录两仓commit、SDK2.3.1、协议2026-07-28和ext-auth `fb374c7db2b34f18ca9183882e0beecdf661892b`。未来分支更新先在获准独立clone比较协议、OAuth、输入/输出schema及权限；不fetch共享仓、不自动放宽白名单。升级规范或授权模式先重规划，写工具始终不进模型。当前测试全loopback；未来部署说明列TLS/私网、MCP/OAuth well-known路径、Origin/resource/issuer与反向代理一致性和禁止DB/Redis公网暴露，本次不实际公网部署。

## 8. 任务、依赖与单写者边界

| 任务 | 文件/责任与产出 | 依赖及就绪条件 |
|---|---|---|
| T0 有限事实核实 | 运行owner：净安装、现有model/Session probe、原生request/usage/route参数、idle驻留、恢复配置及旧格式素材核实 | 本计划双规划收敛与双独审通过后才准入。第二实际模型按用户已选GLM做有限原生探针；其余可并行。每探针一个问题、有限输入与成功/失败分支。 |
| T1 路由/预算/容量/元数据 | core唯一writer：runtime-config、dsh-runner/host、collaboration-runner、work/conversation/automation-service、grant、store、server、runtime patches及对应测试 | T0对应原生边界成立；先共享解析/复权与原子受理，再投影反馈；不与其他lane同文件并写。 |
| T2 J10接线 | 同core owner：现有渠道工作工具、collaboration/child/action/notification接缝与相关测试 | T1接口稳定；复用既有服务与refs，完成同对象主链和发送前权限。 |
| T3 安装/恢复/说明 | ops owner：init-p2-auth、state-transfer、对应测试、doc/operations.md及最少打包步骤 | 说明可并行；需T1确定schema/route秘密后集成。package/lock由core所有，必要修改串行交接。 |
| T4 必需Web | Web owner：web/index.html及对应UI测试 | T1/T2 DTO冻结；模型/参数、本人运行反馈、管理员metadata、根到子动作导航和手机操作。不改core服务。 |
| T5 容量/兼容与最终验收 | 验收单writer：拟建scripts/accept-p7.mjs及必要容量/安装检查；只读verifier | T1–T4稳定候选；真实两路由、完整J10、容量、安装恢复回退、受影响回归。不得并行修改被测候选。 |
| T6 交付/收口 | root唯一计划/报告writer；独立技术和媒体审查 | 真实检查通过、逻辑本地提交、实录/离线包、飞书readback、用户最终验收。 |

Kivo默认只读；只有当前接入真实阻断才派唯一Kivo writer，保留Control/HTTP边界和独立审查。实现沿用户指定Team Sol路由，不以默认saving模型替代。独立审查者不实现其被审对象。服务、数据库、有限Hive采样窗口由明确owner控制，旧进程先核实退出再换候选；不把耗时或固定轮数当完成依据。

### 8.1 T5 真实准备链局部重规划（2026-10-16 21:12 UTC）

本节在新的准备包实施前形成；工程与产品两名独立 Astra planner 均完成只读规划，root 汇总并交换。工程与产品planner交换结论均为CONSENSUS；独立过度设计审查及其通知消费域文字复核均为PASS，复核候选SHA为`d35517dcc7a699277fc5290ba83ce2f2e5523f2e30fa3f4989caf358c7366fd3`。该复核先于新包实施；root在本计划提交后可仅授予准备包SOURCE GO，新资源启动仍等待冻结包独审和实际运行条件。原三轮完整J10失败及operator `unknown` 原样保留。三处失败没有证据指向同一产品缺陷；共同风险是验收脚本对真实环境、DOM和正式fixture生产者的前提未由实际入口核实。现已完成Chrome/HOME与disabled select实测修复；candidate11的final03真实完成2模型路由、2连接与3员工配置/保存，相关源码、launcher及环境不变时复用该实际证据，不为新计划重复跑相同诊断。

已实测的当前阻断是operator把继承库所有pending都要求为本轮source-repair trace。A有旧P6 pending和本轮创建两规则产生的evaluate；B也有旧pending。删去断言不安全：既有worker只按事件类型循环领取，retained baseline允许所有历史ID；仅透传底层trace前缀也无法覆盖无来源trace的delivery。选择**新独立数据库与资源，复用普通真实worker**；不为此次验收扩Kivo公共claim接口，不清理、消费、删除或重放旧pending，不修改旧运行包/回执。新建库不复制旧业务；新资源不停止或复用旧PG/Redis容器。

固定producer及新J10 run为 `geneway-p7-20261017-02`；新输出 `/tmp/geneway-p7-kivo-runtime-02`，新准备包为任务产物目录 `p7-kivo-runtime-fresh/`。沿现有identities函数派生suffix `407a7f46decc`：库 `geneway_p6_{a|b}_407a7f46decc`，角色 `kivo_p6_{a|b}_407a7f46decc_{owner|app|worker}`，容器/网络/volume前缀 `geneway-p6-407a7f46decc-{a|b}`，保留旧helper命名不混称旧实例。新运行包必须完整绑定实际目录与全部消费文件，不能让context、fixture、observer或workerChild暗中返回旧目录/旧run/旧数据库。

| 实例 | API（loopback） | 新PG / Redis（loopback） | 新子网 / gateway |
|---|---|---|---|
| A | 34581 | 55681 / 56681 | 10.253.74.0/29 / 10.253.74.1 |
| B | 34582 | 55682 / 56682 | 10.253.74.8/29 / 10.253.74.9 |

root于本节形成前只读核42个Docker网络与45条route：上述网段无重叠，6端口无监听，新派生container/network/volume名字未占用，/tmp可用473GiB。最初候选10.253.73网段因已有/28重叠而弃用；第一次审计因Docker空IPAM配置为null失败，未执行写入。启动前仍由既有preflight再核。使用已固定PG/Redis镜像、不pull、不开放公网、不改旧资源；旧两库业务/outbox/delivery/attempt的逻辑行指纹在新资源动作前后只读比较，不能仅比较数量。

唯一准备包writer只窄适配既有schema、bootstrap、API、fixture、worker及operator链：新资源配置、fresh schema来源（不伪造inherited handoff）、首次License申请/激活、新run派生的真实connection/sourceInstance、完整候选与秘密引用。沿冻结迁移、最小角色/权限收口和正式业务API；Kivo产品源码只读，不新增环境管理器或另一套worker。root维护唯一计划/验证记录，先独审冻结准备包，再给真实运行GO；Geneway主验收入口默认不改，确有消费形状阻断才由其原owner窄修并独审。

先完成新schema与API启动，再启动已独审的同设备有限Hive window02，避免慢准备耗尽新鲜度。设备始终为新P7 UUID `2e31def5-08f8-4975-b7b0-2815003db549`，不是样本序号61。原窗口自然exit0、末sample62/transport804；续窗绑定其实际completed回执与末样本SHA，确认原owner/docker/容器Python均退出，仅追加61个30秒间隔样本、最大1860秒，不重建设备、不改旧时间、不自动延长或未知重试。fixture用实际新样本通过正式Hive mapping；查询/预览/批准前的120秒门不变，过期即停。

本节所有“3条pending”“无backlog”及release前后的待处理/执行集合，均限定现有worker的固定三类通知消费域：`mes.notification.business-event.v1`、`mes.notification.deliver.v1`、`mes.notification.evaluate.v1`。其它正式producer产生的本轮outbox（例如`mes.tpm.repair.changed.v1`）按真实归属单独记录并保持未消费，不删除、不加入initial ID泛白名单、不扩大worker eventTypes；不能把全表pending数量当成上述门。

完整J10前必须完成正式producer支持的小检查：

- 两实例通过真实API创建本轮组织、设备、来源维修、机器账号、端点和两条business_event规则。逐ID/trace/actor/aggregate/payload/幂等键确认恰3条pending evaluate：维修revision0的subject intent，以及各自创建trace下的两条规则revision1 intent；没有business-event、delivery或其他未归属待处理项。不是只断言数量3或eventType相同。
- 仅A使用现有正式owned非superuser worker消费这3条，完整claim/lease/heartbeat/执行记录与正常停止；实际执行集合恰3ID且processed。源维修保持reported/revision0，设备/规则/端点及业务事实不变；新增occurrence、delivery、attempt与webhook HTTP请求均0。允许变化仅为A三条setup outbox正常状态迁移及对应worker instance/execution生命周期记录。B只读核3条并保持pending，逐status、claimGeneration、锁及retry字段证明未领取，不为对称性启动B worker；后续B只读旅程不能启动worker。旧两库指纹保持。
- 以上零通知预期来自真实evaluator的business_event规则直接返回、subject仅查询repair_*规则的现有语义，仍须实际验证。结果不符即保留并分析，不清理新增行、不扩白名单。
- 初始化完成回执与正式J10分开。`switch-endpoints`保留端点URL、签名、revision和scope/targets检查，A必须无backlog，B必须仍为已绑定3条setup pending。每次正式release前允许pending集合仅为当前真实business event及精确evaluate sibling；完成后execution集合只能是这两条和由同event/occurrence、当前规则及端点生成的delivery。已处理setup记录不能因列在initial中获得再次消费许可。

上述小检查、源码独审与新候选冻结通过后才重新运行完整十步J10，两真实模型、本人拒绝/批准、真实创建回读、同渠道反馈、重启及空目录恢复均保持原义。旅程中不修改候选；新输出/journal不覆盖旧unknown。出现旧库变化、未知pending、初始化通知/外发、身份混用、worker未退出、freshness失败或候选改变即停止依赖动作。容量/安装等已完成证据仍按实际消费变化评估，不冒称新候选已重跑。

方案参照[PostgreSQL CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html)的独立新库边界，以及[AWS transactional outbox说明](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)中事务内持久事件与消费者重放/幂等职责；这些资料不替代本地生产者与真实worker证据，也不授权清理旧outbox。

## 9. 验证矩阵与证据复用

| 覆盖 | 本阶段结果与检查选择 |
|---|---|
| AC-01/13/21 | 两次空安装、正式供应/配置、两真实路由、启停与完整运维演练 |
| AC-02/03/05/07/14/19 | 新J10的TPM/monitor/知识/协作、等待重启继续、双实例相关回归、旧结果不重算 |
| AC-04/06/10/11/15/23/24 | route/请求guard/容量变更后的撤销、取消、会话/知识隔离、管理员metadata、秘密/外发检查 |
| AC-08/09 | 原生节拍及同Host lifecycle保留适用证据；模型/装配变化影响时重跑；可选插件缺失不拖垮无关入口 |
| AC-12/21 | 全量state/Session/秘密/配置恢复、旧cookie与批准失效、无未知效果重放、DSH成套升级回退 |
| AC-16/17/18 | 新渠道协作交办/补充/回馈，真实事件主动跟进、定时回归、发送前撤权、手机 |
| AC-20/25 | 新J10真实批准创建回读、模型无写工具；未改Kivo事务/幂等细项可引用原有效证据，接缝变化另回归 |
| AC-22 | P1–P7真实planner输入、汇总、独审与实施时序核对；保留历史流程变更/未知，不补签 |

优先扩现有 `test-runtime-config`、`test-model-credential-boundary`、`test-run-result`、`test-conversation-service/runtime`、`test-dsh-host`、`test-shutdown`、`test-p3-runtime`、`test-channel-work-tools`、`test-p4-channel-conversations`、`test-p2/p3-state-transfer`、`test-channel-state`、`test-kivo-state-transfer`、`test-kivo-repair-actions`、`test-kivo-events/automation`、`test-p5-notification`及微信协议/真实生命周期脚本。每个实际命令及必要fixture路径在唯一验证记录核定，不把脚本存在当PASS。

沿用 `accept-p4-s1` 浏览器/起停、`accept-p4` 通道、`accept-p5`规则、`accept-p6-kivo`批准与读回能力，拟建 `accept-p7` 只负责当前组合，不复制四套launcher。容量与安装回退有实际重复需要才独立脚本。不要执行会启动退休GearJob的旧acceptance来凑全量。显式提供合法旧state与去敏Kivo wire fixture，禁止暗读旧秘密。

Kivo目标包类型/Vitest、实际HTTP/PG与边界检查只按变更选择。原634边界诊断保留；新候选不得新增当前范围问题。先前PASS可引用但须记录适用理由；权限、路由、持久化、执行或方法变化则重新验证相关结论。最终J10及新运维义务用同一交付候选，不混拼局部成功。

AC-22已独立核对真实双planner结果与实施顺序；P1原Sol及P2用户更新后Astra重规划按当时有效决定描述，不伪写从第一天全是Astra。现行P4 v4.4、P5-K1、P6 Kivo与P7规划门先于实施。旧P6 T0则存在历史流程限制：2026-09-21 07:43:23 UTC已尝试启动隔离Hive、随后运行synthetic来源和映射准备，而唯一计划至08:00:13/08:01:30才更新状态和授权边界。因此该段“计划先于实施”不能写为PASS，不能事后补签。写动作是否由当时用户委托覆盖、窄实施者首次改代码时间仍不可独立确认，不扩成未经证实的越权结论。原始时序与独立核查引用保留于p7-verification.md；历史限制由用户在最终合同结论中处置，不阻止当前安全的其余工作。

## 10. 交付、失败分支与最终门

采用操作手册式验收：真实操作MP4及离线HTML共用同一成功旅程的步骤和timecode，每步可见截图/操作/反馈；中文标注“渠道为模拟验收”、synthetic/external-test、实际模型/版本。自然速度显示关键输入/批准，不能剪掉失败假装成功。完整解码、1倍速离线播放至结束、截图/链接可迁移、独立视觉检查及范围如实记录；完整技术结果与材料质量分开。

必要产物保存用户可访问的工作流目录，不只留/tmp；Git只去敏方案、产品、必要测试和操作说明。按已授权飞书收件路径发送并GET逐项回读。独立阶段审查不得代签用户验收，也不得把本地测试称发布/现场接受。

出现新模型接收方/秘密、新写动作、第三仓修改、真实产品消息、公网监听或部署等未授权动作，暂停对应分支；其余就绪工作继续。越权正文、secret泄露、旧批准/解绑复活、恢复自动重放、重复维修、未知schema暴露是当前交付阻断。

实际接口否定关键前提，容量需要数据库/队列或改变已冻结行为，采用局部双Astra重规划和独审后再实施。完整旅程连续三轮失败或同错误无新信息重现时停止全程重跑，先找共同原因并做生产者支持的小检查；不以重试次数当结束条件。每项失败/跳过保留原命令和原因。

最终仅在G1–G9、J1–J12、AC-01–25全部适用要求有有效结果、P7真实交付及用户验收完成后关闭全量合同。第二路由、安装/恢复/回退、容量、流程时序或真实业务仍未知时，只报告已完成部分，不降低为MVP后宣布完成。
