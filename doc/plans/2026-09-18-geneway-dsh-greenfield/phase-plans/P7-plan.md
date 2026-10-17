# P7 全量集成与可运维交付详细计划

计划首次落盘：2026-10-16 16:14:01 UTC（2026-10-17 Asia/Shanghai），此前标称 16:10 为起草时间，不能作为实施顺序证据。状态：**双 Astra 规划、交换及两项独审通过；计划提交 `38a804e` 先于 T0。T0 原生检查及真实 GLM 工具调用通过；净安装构建策略已窄修并通过一次预验。T1/T3/T4 源码与局部检查独审通过并分别本地提交，T2 渠道协作与回执接线独审通过并本地提交；T5 验收脚本已独审并提交，所选20个回归入口实际通过。原生容量经采样范围及退出竞态修复后完整实测通过，原失败保留；Host 容量在§6.1最小修复后以原门完整通过，20身份空闲CPU为0.8403核、读取p95为337.5ms，原失败保留；两空目录冻结锁安装、原生探针及正式供应/登录/正常停止实际通过；旧应用、新版读取与空目录旧版回退完整演练通过，原始全量业务状态不存在的限制保留。最终同候选两路由、组合旅程及运维验收尚未完成。J10三轮在环境、共用select及继承库outbox前提处失败，旧证据保留；§8.1记录实施前的双Astra局部重规划，已通过独立过度设计审查及通知消费域口径复核；新准备包和初始化门已实际完成并独立回核。final04通过配置与渠道待补充，重启补充因reviewer缺接收Skill失败；§8.4最小修复经双Astra与独立过度设计审查进入SOURCE。Hive观察链的日期接口与实际消息反序分别由§8.3/§8.5规划处理，旧失败原件保留，完整J10仍未通过。**

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

### 8.2 T5 初始化校验的有界续行规划（2026-10-16 22:03 UTC）

本节先于续行包实施。两名独立Astra planner分别读取冻结源码及真实A/B快照，均建议保留run02资源，以新冻结准备包和新候选继续尚未开始的初始化消费；交换后双方明确CONSENSUS，无剩余方向差异；独立过度设计审查为PASS/issues[]，实际审查计划SHA为76f574d981f6904c8750a2bcbd36545d97f3cd578267b7deb640c2116f636bb4，审查先于新包实施。源码冻结、独审和root运行GO仍为不同门。

candidate12对应的新schema、两次首次License激活和A/B正式fixture均已成功；`setup-check.mjs`实际exit1。其第128行在只读snapshot后的`beforeSetup`抛错，第129行尚未保存A snapshot，第131行尚未写`consume-a-setup` once marker，第132行尚未调用worker。原gate SHA `84e0298d94131b20839a9da4a03e3fc31897dd692476a96ec70e65e4ed1c351e`，保持`phase: unknown`、`operations: {}`且没有A/B snapshot。实际只读回核两库各14条outbox，worker instance/execution均0，三条evaluate仍pending，维修reported/revision0，通知occurrence/recipient/delivery/attempt均0，旧两库指纹未变。这支持“尚未启动worker”，不把gate文件写入称为零副作用，也不把unknown改为完成；续行前必须实时复核，不能仅信旧快照。

根因是准备脚本`otherProducers`除维修事件外，把全部行都要求为configuration receipt。正式非消费域共11条：组织changed 1、device changed 1、device-organization-binding changed 1、device-ledger changed 1、Hive binding changed 3（create/validate/publish）、TPM repair changed 1、已处理notification configuration audit 3。本次一次核全这些真实producer及其API调用顺序，逐trace/actor/object/action/aggregate/payload/幂等键证明归属；拒绝缺失、重复、未知或错归属。14是此已冻结fixture的基线，不是产品通用数量限制。原三通知eventTypes与三条setup intent严格校验不变，全部11非消费域完整行在worker前后保持相同，不扩大worker allowlist。

采用新产物目录`p7-kivo-runtime-continuation/`及candidate13；仅唯一Sol准备包writer可写该新目录。原fresh包16文件、candidate12、run02的run/fixture/原unknown gate及诊断快照保持原字节。candidate12 SHA固定为`e4166136b0603432b01f73537797506492224ebfab13cc3b5b63ff004b662078`，fresh manifest SHA固定为`aab3e923d7f2730947892d2935c395a2b9482fe50eee62ce7096ec1b594ad896`；A/B诊断快照固定SHA分别为`30c01924b4430a6af584caf11dc173beb8780c14c0e36511e27b01144634ff97`、`ffbd39f7f3e6db1191122c86c87cc28863147275899a2f1656249db906a4e80f`。这些材料均在唯一验证记录中给出路径；另固定原run、两fixture和失败命令的精确摘要。manifest SHA与run.bundleSha256按各自原算法分别验证，不能混用。新包只支持这一组base→current关系，不做任意predecessor兼容、恢复平台或通用事件注册表；复用已冻结base io/schema/worker能力，必要的绑定和producer校验集中在最少现有职责边界。

新候选必须完整绑定新包所有实际消费源码、observer及其相对依赖，并绑定原base闭包。机器比较Geneway的142源码文件、Kivo源码/真实runtime/迁移/worker、精确Node、事件allowlist、资源和秘密引用与base一致；计划文档提交带来的HEAD变化单独如实记录，不能以HEAD不同放宽产品比较。原worker真实执行若使用base包，其receipt保留candidate12身份，续行gate明确绑定该真实worker闭包与当前candidate；不改写历史身份。worker launcher、observer、operator实际入口及收尾均核base/current适用闭包，不能只校验base而漏掉运行中的新源码。observer的完整Kivo/runtime/迁移及HEAD门由root在Host guard外包住整个正式生命周期：精确Node对同candidate路径/SHA运行冻结support.checkSources，主J10/Host启动前成功才准入，所有Host/observer退出后再次成功才允许判PASS。两次原始命令、exit、时间、runId、mainOutput、candidate与源码pins保存为同次绑定前后回执；失败不启动或将整旅程判失败。observer内部仅核其publicBindings，不能冒称内部完成全闭包。该外层路线经独立源码审查者明确接受，避免在guard内spawn git或复制完整checker。主验收入口默认保持原样，observer仍提供正式exact3消费接口。

新增一次性门固定为run02下`setup-notification-continuation-01.json`，不能覆盖、挪走或重试原unknown。新门在任何worker操作前重新确认原unknown字节/形状、原run/fixtures及base source pins、没有worker journal或已申请操作、没有相关owned launcher/worker进程、A/B没有instance/execution/领取痕迹；以实时只读snapshot逐行比较上述已保存14行及完整业务/configuration指纹，确认三条未领取与旧两库逻辑指纹仍相同。若有未解释差异，停止，不自动重建、删行或复位。只有这些条件成立，才持久化新once intent并首次启动普通A worker；新门排他创建，自身出现requested/unknown后禁止重入；没有force、通用resume或搜索任意已完成gate。

运行成功条件完整沿§8.1：A恰3条evaluate processed，执行ID精确相同且claim/lease/heartbeat及正常退出可证；维修与所有业务/configuration不变；occurrence/recipient/delivery/attempt与实际webhook HTTP新增0；11非消费域完整行不变；B全snapshot及旧两库指纹不变。允许变化仍仅A三条通知outbox和对应worker生命周期。新gate同时绑定base/current候选、两个manifest、run/fixtures、原unknown、诊断基线及实际worker journal/exit；满足全部后才可completed。

新operator只接受该新gate并核固定路径及内容SHA，不回退原gate；主旅程仍保留A无通知backlog、B三条未领取及每次release精确business/evaluate/derived-delivery集合。现有API journal必须等主候选，故root核当前owner身份后正常停止A/B，在同run02/runtime上使用窄适配launcher和新launch ID真实重启，写新的base12/current13 journal。停止前另存旧ready journal原始字节及摘要；旧journal仅由其原launcher正常写exited/diagnostics生命周期，不改其中candidate12、baseCandidate、launch和process身份，不伪造ready。首次schema/License/fixture均不重做。

先以已保存真实A/B快照直接运行新validator，取得原validator红、新validator绿对照；负例覆盖未知/缺失/重复producer、错trace/actor/object/payload、非消费域被变成通知事件、已有领取/worker/once marker、base/source pin变化。纯检查不能启动服务、访问DB/HTTP或读取真实秘密。冻结包由未实施者独审通过后，root才给实际续行GO；先完成真实初始化门和独立回核，再运行完整J10，不能用准备门替代J10或最终用户验收。

Hive window02仍按原61×30秒有限窗口自然结束，120秒freshness不变，不为赶窗口减少审查；此续行不授权自动延窗。若需新有限窗口，先据实际完成/退出证据单独冻结并审查同设备追加方案。无法证明run02无消费、出现未解释业务/外发变化或不能建立精确相容绑定时，停依赖动作并重新核查；run03只是后续重新评估的选择，不自动重建掩盖问题。无需改变产品目标、用户授权或Kivo公共claim接口。

### 8.3 T5 Hive 观察接口与有限追加窗规划（2026-10-16 22:23 UTC）

本节先于新窗口源码实施。工程、产品两名独立Astra planner分别读取冻结publish/probe及真实只读readback后，均选择固定NATS INFO五整数投影；交换后双方明确CONSENSUS，无剩余分歧，实际消费者核实后撤去不必要的新窗口目录接线变更。独立过度设计审查PASS/issues[]，实际审查计划SHA为65997196097bc2a2261994d140de3fe809675301e6a79993b9fc34823d50e592，审查先于新窗口实施。此工作与§8.2的Kivo初始化续行独立，不能改变其已冻结fixture或消费范围。

window02实际exit1，最后safe为sample98/transport876；sample99 request已落盘而safe缺失，原state仍running/last98，不能重发99或把原窗口改completed。原publish先落request并发两条MQTT，之后调用pipeline_snapshot；后者在同容器Python3.10的NATS SDK consumer_info时间转换上稳定抛ValueError。实际delivered.last_active为`2026-10-16T22:08:55.49708Z`，五位小数纯调用失败，等值六位通过。原失败日志未留原stack，诊断使用同函数复现和真实stream/latest回读，不冒称已有原异常栈。

只读readback04已精确比较seq877 heartbeat与878 DDATA的subject/完整bytes，按冻结publish及request99 timestamp重建完全一致；latest同tenant/device/code/时间、status及完整规范化data SHA一致，lastSequence=ackFloor=878、pending=ackPending=0。readback04 SHA `801b685290273f74020f358b81f75e1d732cc5e0e77d145e25aabd2eb88b4a97`，进程退出receipt SHA `5b34cff35a43a39877c9dd224d6bcf59ded004107b8e74475d714d7560c88134`确认host 441248/441332/441364及其PG、container PID72383均gone。这只确认99已发生效果；不授予旧样本freshness、不补写99safe或window02completed，不改旧request/state/log。

root在独立`hive-window02-resolved-effect01/receipt.json`排他创建效果判定：逐原件验证并绑定window02/frozen Hive/publish源码、host request、window-state、98safe、99request、失败命令与exit、readback03/04及诊断源码、进程退出证据、完整规范化data和消息匹配。明确原窗口失败未完成、sample99效果已观察、重发0、freshness资格false、下一边界100/878。无需重复已成功只读诊断；实际启动前边界仍须重新核。该判定不伪装原producer回执，也不自动授权发布。

新源码目录固定`p7-acceptance/hive-window03/`，运行输出固定`/tmp/p6-kivo-hive-20261016-jOp6FxI7/private/run/p7-j10-20261017-01-window03`；与旧目录分离、排他创建，唯一Sol writer负责源码/纯检查，root唯一runtime owner。只在新窗口独立加载的probe实例中显式装配新的pipeline_snapshot：沿同一`nats://nats:4222`、5秒连接/请求超时、allow_reconnect=False及finally close，调用固定`$JS.API.STREAM.INFO.telemetry_stream`和`$JS.API.CONSUMER.INFO.telemetry_stream.telemetry_processor`。拒绝error、缺字段、身份不符、bool/字符串/负数等非严格非负整数，投影原有五字段messages/lastSequence/ackFloor/pending/ackPending；不默认0、不做数值强转、不回退旧parser。没有门需要的日期转换被移除，未使用的日期只保原字符串（若记录），不改变ACK、transport或业务判断。不修改SDK、site-packages、第三仓、Hive服务或全局Base方法，不增加通用日期层/NATS客户端/重试平台。

新前驱仅接受上述固定效果判定及原件，不能放宽旧window02的completed条件。保持同tenant、device UUID `2e31def5-08f8-4975-b7b0-2815003db549`、code、container/image/mount和既有秘密引用，sample100–160共61次、周期30秒、最大1860秒、最多122次应用层MQTT publish，起始transport878、全部成功则1000。冻结原publish函数SHA `ad9e6f1a58f5fe4db70fb25d1b00999fef92451ef16424cf57cf9660da8591cc`字节不变，birth=False，不建新设备或发DBIRTH，不重发99，不自动补样/延窗。原request先落盘、两条精确字节读回、ACK、latest/online及真实120秒freshness门全部保留。

纯检查直接覆盖实际五位时间数据、正常响应新旧五字段等价及不同无关时间格式不影响投影；拒绝错误response/身份/类型/缺字段、错前驱SHA/设备/99时间或消息摘要/边界、原进程仍在；验证100起点、61上限、122publish、birthFalse、原publishSHA和中途失败不重试/不写completed。实际网络/容器/publish/秘密读取均0。冻结完整源码由未实施者独审通过后，root才可给runtime GO。

先完成§8.2源码独审、真实API和初始化gate、主J10输入；全部就绪后才启动采样时钟。启动前重新核旧host/PG/inside发布者均退出、没有该固定client的另一owned发布者、实际raw INFO为lastSequence=ackFloor=878且pending=ackPending=0，任一变化停止而非自动前移边界。sample100必须经过完整publish检查并有真实safe后，才允许依赖新鲜来源的J10继续。旧fixture保留window02 sample64/66创建时的真实历史来源；真实callsite已核：prepare-fixture:98–110仅创建时读取hiveWindowDirectory，accept-p7:276/377后续读取fixture原64/66 receipt核SHA作为历史完整性，未读取window03目录。新鲜业务走同设备Kivo实时接口，因此不改continuation资源、主候选或旧fixture；新窗口独立绑定source/receipt，不扩大受信目录。

这仍是本机隔离synthetic同设备采样观察链修正，不增加产品写动作、接收方或秘密来源。任何原件变化、消息/持久投影不匹配、未退出发布者、额外stream消息或新效果未知，均停止依赖动作保留证据；不把初始化门、单样本或有限窗口成功扩大为J10/P7/用户验收。

### 8.4 T5 交接接收权限配置与已完成初始化的候选续行（2026-10-16 22:56:50 UTC）

本节先于修复实施。工程、产品两名Astra planner分别阅读final04实际state与授权callsite后完成独立方案，正式交换均明确CONSENSUS。未参与规划的过度设计审查PASS/issues=[]，审查计划SHA为2e948091e1e1b79f0fbf95694a69fe2c25bb01da7aa256795855666592798488，审查先于harness或新准备包实施。用户目标、两条模型、产品权限、业务动作和现有隔离资源均不变。

candidate14的final04真实完成新配置、渠道交办及待补充工作保存；重启补充后correlate子工作已完成，review子工作在原生Agent和模型请求之前FORBIDDEN，root随后failed。原first-failure在accept-p7:665是后续断言，不是首因。harness给reviewer仅record-read Skill，而产品handoffProjection要求接收者拥有来源correlation Skill和同A连接。core使用原函数、全部真实helpers、失败state及实际catalog内存重放：原配置拒绝，仅追加correlation后同来源结果、连接、知识检查全部通过；源码/原state未变。保持产品授权门，不将failed改waiting_input、不替换GLM或跳过依赖。

Geneway既有142路径集合中只改`scripts/accept-p7.mjs`：reviewer增加同A的既有只读correlation Skill；仍属于成员a、使用GLM、review计划项仍record-read，产品按该child capability限制实际工具。正式Web保存后读回其准确skills/connection/member/route，不能直接修state。纯检查调用实际handoffProjection/dependencyProjection及真实连接/来源/知识函数，覆盖原配置拒绝、只补Skill通过、单独撤该Skill与单独撤A连接均再次拒绝；不用新产品导出、权限stub或新runner框架。已有真实失败state对照作为因果证据；常规harness纯检查不依赖秘密或实际服务，原模型/工具/动作范围不扩。

新主run固定`geneway-p7-20261017-02-j10-final05`，producer仍`geneway-p7-20261017-02`。主脚本与新包observer都严格推导`<setupOutput>/private/create-observer-<mainRunId>`，沿既有runId字符/长度约束，不接受任意路径；以新mainrun生成独立operator journal、新配置及新主output。旧`private/create-observer`的baseline和空attempts保留，不清空、迁移或重写。开始前核旧目录无prepared/arm/claim/consumed/dispatch，旧operator只完成switch-endpoints；存在未知写意图就停。新main可重新执行只读端点核验，不能重放业务写入。

新外置包固定`p7-kivo-runtime-continuation-r3/`，原r2及candidate12/13/14原件保留。新候选相对candidate14仅允许accept-p7的已审旧/新SHA差异，其余141项逐字一致，完整Kivo/source/runtime/worker/迁移/精确Node相同；必要observer和准备接线完整列入新manifest。历史源码以固定原归档/包与历史candidate核验，当前源码按新candidate核验；不得用新文件冒充历史字节，也不得删除142项比较或开放任意scripts差异。新HEAD与实际Git差异精确核定；计划文档变化单列。主脚本修复独审并本地提交后才冻结包含其实际SHA/HEAD的新包。依赖旧base io时使用明确、最小的当前源码校验入口，不隐式修改旧模块、文件或全局行为。完整当前闭包仍由launcher/operator入口及退出、root主Host前后双门核验；observer内部仅public bindings，不能冒称内部全闭包。

初始化已真实完成，不再执行setup：固定`setup-notification-continuation-01.json` SHA `88a8b1551d1856eb4fe95c24b892f63e845f8c7111d160c1565e66b5e17af5fa`，原candidate14 SHA `9a8dd099504b26459b43b34ead95589c2f876482742d3da2553e4da198699cb6`、r2 manifest SHA `bb8a6fb695b39feae92c0185ff4752931ededf89db65c36863c2994c9fb9d145`及base12 worker身份不改。按其原绑定验证gate/实际worker/日志，另验证当前candidate的精确相容关系。只接受这一固定gate，不搜索任意completed、不改gate身份、不新造已重跑setup回执、不再次领取三条evaluate。新前置只读门实际核A==原gate.after、B==原gate.before、旧两库完整指纹未变、没有活跃worker；允许的A初始化worker历史保留，不能再要求其从未存在。后续release仍只允许当前business event、精确evaluate sibling和对应derived delivery，原三条无重复消费资格。

旧API已在candidate14源码仍匹配时正常停止，ready原件保存于`p7-acceptance/continuation-api-ready02/`，A/B SHA分别`ac408bb15fcf9b361e84add45bd4f9d9b57294dec0089a4f851bbe6e123a67ea`、`19d98b14eb86d871b53e3eae3b64f6333b7eab910493b09aedada562177de193`；launcher退出0，四个owner/child PID及PG均gone。新launcher必须保留此前fresh01/continuation01/continuation02各自immutable identity和正常退出验证，使用新launch ID真实启动同runtime/DB；新journal仍base12并记录新current，不伪造旧ready/current。fixture、License、schema和秘密来源均不重做。

唯一writer：core Sol负责accept-p7；Kivo Sol只负责新r3外置包；root负责计划、候选及实际runtime，互不改对方文件。源码最小回归、语法、harness纯检查及新包负例（错gate/SHA、多一源码差异、旧observer路径、run/candidate混用、setup再次领取、状态漂移）完成后交未实施者独审。新冻结包及candidate通过后才实际重启API、执行上述只读接续门，最后新完整J10；历史安装/容量证据保留原候选归属，不能改签。

Hive window03继续原sample100–160有限窗口，不延长、不补样、不重发；实际120秒freshness门保留，不为赶窗口跳过检查。窗口不足时停止依赖实时来源的动作，另据真实完成/退出证据确定后续有限方案。若需要第二个Geneway源码路径、产品权限变化、连接/成员/知识范围扩大，或发现未知写意图、setup状态漂移、候选闭包不完整，停止对应动作重新确认边界。计划与纯green不代表GLM原生执行、完整J10、P7或用户验收通过。

### 8.5 T5 精确消息观察顺序与下一有限窗口（2026-10-16 23:03:32 UTC）

本节先于window04源码实施，独立于§8.4的harness/r3工作。工程、产品两Astra分别核原publish和实际readback，离线重建完整消息后交换均CONSENSUS；未参与规划的过度设计审查PASS/issues=[]，审查计划SHA为43e78fb29f873f53fdae8a38c193510b342db3b744583055eb215fecc9ef0267，先于本节源码实施；源码独审和runtime GO仍为独立后续门。产品验收要求本请求两条完整唯一消息、同设备/时间/业务数据和ACK，不要求下游stream保持两种消息的发布顺序；仅移除这个被实测否定的观察假设。

window03实际exit1，lastsafe108/transport896；request109 timestamp1792191077422已落盘而safe109/window-safe缺失，原日志只有固定码，无首次异常栈。只读readback01 receipt SHA `9336a92352d276fa26708a079f5f5656a7aa0a088d2d206ee56368f1ea62453e`、source SHA `f92e2dd1306b4273f382118d220973d9514fed2758ba094576b78dc06702337a`：seq897为DDATA334B，seq898为heartbeat{}2B，恰与发布顺序反转；原SDK两次get_msg和latest日期转换均成功。按冻结publish/request109完整重建subject/bytes，两条摘要精确匹配反序集合；latest完整normalizedData及timestamp相等，lastSequence=ackFloor898、pending=ackPending0。原publish按offset固定kind在这个响应必拒绝；这支持可复现原因，不伪称已有原故障栈。进程退出receipt SHA `07c4c53093eac9952859ba5b47c2a56fbff9bc9ca49c29a7e807e78d970b8842`证明host1298121 PID/PGgone、inside76357gone、同UID其他stdinPython为空。

root排他创建独立`hive-window03-resolved-effect01/receipt.json`：绑定window03/frozen Hive/旧publish源码、host-request、state、108safe、109request、原日志/实际命令和exit、readback source/receipt、进程退出证明及完整消息/规范化数据。保留原执行失败未完成；109仅effects observed、重发0、freshnessQualified false、下一110/898。原request、state、日志均不改，不补109safe或旧completed。启动时再核实时边界，历史效果判定不授予新鲜度。

新源码`p7-acceptance/hive-window04/`、输出`/tmp/p6-kivo-hive-20261016-jOp6FxI7/private/run/p7-j10-20261017-01-window04`由既有唯一Sol窗口writer/root runtime owner负责，排他新建。保留旧source及旧publish SHA `ad9e6f1a58f5fe4db70fb25d1b00999fef92451ef16424cf57cf9660da8591cc`；新窗口显式局部publish函数单独固定SHA，与原函数逐字差分只允许消息观察循环变化。这是§8.3字节不变要求的明确有界例外，不假称新函数仍旧SHA，不修改旧文件、SDK、全局方法或第三仓。MQTT内容/发送顺序/QoS/retain/次数、request先盘、ACK等待、latest/online/120秒freshness、失败不重试保持原逻辑。

每次只读本次边界后两个连续序号；每条按完整subject和完整bytes与两条预期消息一对一匹配、每项只允许消费一次、最后全部匹配。receipt记录实际sequence和实际到达顺序，不排序伪装。重复、缺失、额外、错tenant/device/kind、错完整bytes或timestamp、序号越界均拒绝；不能扩大扫描窗寻找两条、按kind覆盖字典隐藏重复，或放宽总transport/ACK约束。新函数只用于birth=False的固定窗口，不能推导额外业务支持。

新失败诊断最小保留静态allowlist code、异常class、栈的basename/function/line；未知异常用固定fallback，禁止异常message、源码行、locals、请求头或凭据。内层首因不能再被外层仅通用码覆盖；继续exit1、保留unknown、不写safe/不重发。纯检查用敏感标记异常确认诊断不泄内容。旧异常栈不可补造。

纯回归对实际109反序旧红/新绿，正常顺序亦绿；重复、缺失、额外、错subject、错完整bytes/时间、越界均红；覆盖失败无safe/二次发送、安全诊断和仅观察循环差分，保留零文件写/网络/进程/秘密。冻结源码由未实施者独审通过后，root才可给runtime GO。运行前必须§8.4新candidate/API/只读接续门/observer/J10 inputs全部准备好，重新核固定前驱SHA、旧进程与其他publisher无残留、同container/image/mount/tenant/device、实时898/898/0/0。仅此后启动计时；sample110完整safe后才继续依赖新鲜来源的J10。

固定sample110–170共61次、周期30秒、最长1860秒、最多122次应用层MQTT publish、birth=False、transport898→1020。设备/秘密引用不变，不重发109、不自动补样/延长。边界漂移、未知发送者、消息/业务不匹配、超时或任一pin变化就停止保留证据，不能调低门赶进度。若必须改发布、ACK、业务数据或freshness语义，回到规划；源修复、小检查、单样本或有限窗口成功均不代替J10/P7/用户验收。

### 8.6 T5 人类事件投影与新隔离完整旅程（2026-10-16T23:35:23.439088+00:00）

本节先于新包/窗口实施。工程、产品两名Astra分别独立核源码和保存证据，正式交换均为CONSENSUS；root汇总后，未参与规划的独立过度设计审查PASS/issues=[]，审查计划SHA为59a0514aad39a78828c098a7b155ff4eb8b21e5a6da3a085616feba08ec7419e，先于新包/窗口实施。源码冻结独审及runtime GO仍为后续独立门。用户目标、两条模型、业务写动作、产品schema和权限均不变。中间决策选择新隔离run03完整十步J10，不新增恢复框架，不把旧候选前四步与新候选尾段拼成完整通过。

candidate16 SHA `ebfa33a207ead61922f0861cc54fcf091936a1f88d1991556989458c04b27540` 的final05实际前四阶段通过：Web配置、模拟渠道交办、重启补充、真实DeepSeek/GLM协作；模型16请求、writesOffered0。observations SHA `fbd95e84eb93683f9ad23839f8b94983b87f72a80c6f40753a961c15b3f4e497`，第五阶段operator session68134 exit1，仅ERR_ASSERTION固定码，无原栈。原operator journal SHA `ab81e908f3e49c17d2bb0a57bfd3d169000fa05ccd09c71d394029270683dcc5` 中dispatch HTTP201已applied，整体source-human-update unknown，completed仅switch-endpoints。root停止main并正常cleanup，Host/SDK PID及PG全部gone，前后完整source门均exit0。旧失败原件不改。

root实际只读诊断保存在`p7-acceptance/human-dispatch-readback01/`：readback.mjs SHA `5e1efb65ec932a1ae747ff59a52f5a1cea42f5218c9a853e11ab0700d1318161`，receipt.json SHA `71fb28334de414d7a18167d7c745756aab037b30c31c55a54073c895a23e8a27`，精确Node净env exit0。A来源单080552a4-8153-4516-8e26-04325bde727e已dispatched/revision1；成功human audit056bcb35-d7e8-4e70-afad-8a14a21b9eb3，trace p7-setup-f7a7cd74-e453-44cb-b6d3-c7cedc1108dd；business outbox1ba9fa39-e42a-43f1-ba83-cf52b3a64a6b与evaluate c623b605-4598-4e41-8877-1521f57286f9仍pending/gen0。只有原setup stopped worker和三执行，无新worker journal/log/执行；原setup、B及旧双库指纹未变。作者与未实施者各自只读得同结论。

实际原projectBusinessEvent重放在fresh/observer/operator.mjs:37拒绝undefined!=human。Kivo正式`packages/platform-contracts/src/notifications.ts`规定actorKind?:'machine'；`packages/fms-db/src/notifications/business-events.ts`仅machineCreate写该字段，人类缺省。仅内存更换错误human假设并绑定实际human audit后，同一事件投影、boundEvaluateSibling和assertReleaseSelection均通过；这是可复现原因，不称恢复原始异常栈。新包修验收投影，不改产品producer、数据库事件或wire payload。原机器分支仍严格。

**旧效果和原件保护。** root排他保存dispatch效果判定，绑定原journal/请求/trace、成功审计及业务、精确两pending、只读诊断及主进程退出证据；明确dispatch已发生、release尚未执行、整体操作仍未完成。不得补旧completed、重发dispatch、重开旧worker或把unknown改成功。run01与run02所有现存数据均保留；新流程在任何新资源/fixture/worker效果之前记录这四个旧库的完整受保护业务/config/outbox/worker/delivery/attempt逻辑指纹，后续关键入口及收尾逐值比较，不能只数行或只保护最早run01。旧资源不停止、不删除、不复用。

API03已在candidate16/r3仍完整匹配时正常停止；ready原件在`p7-acceptance/continuation-api-ready03/`，A SHA `b8280d96af1194a7c641daa35f3ee1a79b279dd7a70022b7899b9d5d055db7b0`、B SHA `1181d310fcb932eed9bfda002f6a3fa322853a972daf3c5fc6123d129178a8db`。owner1817694/1819215、child1820465/1822026的PID与PG均gone，两个launcher exit0、本地journal exited/null-SIGTERM。新资源预检仍须核端口无占用与身份，不将历史退出记录当实时监听证明。

**唯一新包与资源。** 新producer固定`geneway-p7-20261017-03`，输出`/tmp/geneway-p7-kivo-runtime-03`，唯一外置包`p7-kivo-runtime-run03/`；新mainrun固定`geneway-p7-20261017-03-j10-final06`，独立operator与`private/create-observer-<mainrun>`目录、主output `p7-acceptance/j10-final06`。沿既有identities派生suffix `452afca431dc`，新库/角色/容器/volume/network按既有命名规则全部独立；API复用已释放34581/34582；PG55781/55782、Redis56781/56782、子网10.253.75.0/29与10.253.75.8/29、gateway分别.1与.9。root在本节形成前只读审44个Docker网络及356条route：上述网段无重叠、6端口无监听、新派生名称无占用；运行前现有preflight再核，冲突返回计划，不运行时换号。

复用已冻结Kivo编译runtime、迁移、镜像、精确Node及同Hive tenant/device，不重建产品、不pull、不改依赖。新数据库/schema、角色、独立JWT/通知/worker秘密、首次开发License、正式A/B fixture沿现有入口生成；只使用本任务允许的服务端秘密，不能搬用旧业务数据。新manifest/candidate/run/fixture/gate/API/worker/operator/observer/guard完整绑定run03，不能暗中返回run02路径或沿用其completed gate。产品142源码与Kivo源码/runtime逐字同candidate16，只有本计划文档HEAD变化单列；外置新包的全部实际消费文件和传递依赖完整列出。无需通用多代兼容层；历史candidate12–16及旧fresh/r1/r2/r3原件保留。

唯一Kivo Sol writer负责新run03包，在既有fresh职责内整合已验证修正：§8.2的三setup intent和11非消费producer精确核对、§8.4的mainRun observer隔离、r3正常API退出/进程身份及精确pending release、人类事件投影。不得机械复制已知旧缺陷。初始化A正式owned非superuser worker只处理新3条evaluate；B只读保持3pending；业务/config/非消费11原行不变、通知occurrence/delivery/attempt和HTTP均0。每次正式release全pending只准当前business及精确evaluate sibling；执行只准这两条及同event/rule/endpoint派生delivery，setup历史不得重新获得消费资格。所有当前闭包入口/收尾及root Host前后双门保留，observer内部仅public绑定不冒称全闭包。Geneway主脚本保持完整fresh入口，不为失败run增加resume/skip或放宽十步时序。

**人类与机器投影。** 新局部人类投影要求raw payload没有actorKind自有字段，并有唯一独立可信的human成功dispatch audit。严格核audit actor为本实例admin、action/result、audit ID/trace/object/device/organization、record及payload before/after/revision的一致性：reported/revision0→dispatched/revision1；audit、outbox和fixture相互绑定。在验收receipt中从可信审计派生human，绝不向原payload补字段。显式human、null、machine冒充human、缺/错audit、跨对象/实例/trace/actor/organization/revision均拒；不使用缺省值猜测人类。机器分支保留显式machine、机器账号/创建审计/action trace/revision0全部严格约束。安全首因诊断只输出固定allowlist code、异常类及basename/function/line，不输出message、actual/expected、源码、locals或秘密；原旧执行无栈事实不变。

**单次有限窗的显式准备排序。** 本节经双planner共识替代此前“所有动态fixture/input先就绪才开窗”的局部门：新fixture正式Hive绑定本身需120秒新样本，不能形成先有fixture才能采样的循环。下一窗开始前完成全部不依赖新sample的源码、纯检查、独审、候选、四旧库保护基线、新双库/schema/API、License及精确命令/输入模板；在同一有限窗内依次用新样本完成正式A/B fixture、A setup/B只读、动态输入冻结、Host前完整门、完整J10。这个顺序调整不放宽120秒freshness、单窗期限或未知不重试。

Hive04保持既定110–170、transport898→1020、61x30/最大1860/最多122发布，不延长、不补样、不改旧sample。只有它实际完整终态/末sample/transport ACK排空与owner/container publisher退出均核实后，才冻结下一有限window05的完整前驱pins；若04失败或效果不明，停止此依赖并重新规划，不自动按计划成功终点续跑。成功前提下window05固定171–231、transport1020→1142、61x30、最长1860、最多122发布、birth=False、同scope/UUID。由原窗口Sol writer在新`p7-acceptance/hive-window05/`与新独立output适配window04已审观察循环及安全诊断，旧函数/源码/日志均保留。新package资源和prepare-fixture显式绑定window05精确路径/范围/前驱receipt SHA与所选safe receipt，不保留旧window02/63..123硬编码，不放宽为任意后续sample。新窗口独审后由root单次启动；任何时间不足即停止依赖动作，不自动续窗。

**前置回归与最终门。** 使用保存真实human形状做原红/新绿，覆盖可信audit各错配及字段缺省、机器严格分支、实际producer分类、额外pending、跨run/候选/API混用、observer once和unknown不可重入。新包/窗口各冻结后由未实施者独立SOURCE审查，只有所需门全部通过才给对应runtime GO。新全十步仍实际验证同对象/root/child/action/receipt链、两真实模型、事件来源重读、本人手机拒绝/批准、真实唯一创建与machine echo、同渠道回执、正常重启、空目录恢复及恢复后只读执行。旧四步仅历史证据，容量/安装不改签为新候选重跑。任一旧数据变化、未知pending、错误审计、重复写入、候选变化、活worker/publisher或freshness失败即停止相应动作。阶段最终验收仍由用户执行，不部署、不发布。

### 8.7 T5 后续验收调用契约修正（2026-10-16T23:49 UTC）

本节先于实施。工程与产品两名Astra各自核正式源码和final05保存state后完成正式交换，三项方案均CONSENSUS；独立过度设计审查对计划SHA `7a9cc268abf22344e469a35c813debe51a34071cf87af8ec91fea38c5b299f65` 判PASS/issues=[]，先于实施；SOURCE独审与runtime GO仍为后续门。唯一实现范围为`scripts/accept-p7.mjs`的三个调用位置及同文件定向纯回归。产品、vendor、已通过B读取段、模型权限、十步旅程以及§8.6的run03资源/四旧库保护/单次有限窗口和准备排序均不变。

**事实与证明边界。** `src/domain/tpm.mjs:100–129`的正式单记录结果为`kind=kivo.tpm.observation`、`payload.records[]`，而主验收第791行检查`payload.tpm.id || payload.record.id`。final05保存state SHA `6a9149402eae81a3fa7dc7c12f02d8b9ada2ba89fd9c91ae25ebd8280d29a547`内A reviewer及B read均为records形状，旧predicate对各自正确UUID仍为false。这是事件前真实读取形状证据，不能称事件后follow-up已运行。第836行模拟HTTP503时，vendor/weixin-api先抛http-error而不读取body，正式插件将其归unknown；第858行等待failed与该fixture不符。第862行撤权retry使用仅接受2xx的api，但正式channel-service先保存blocked再抛DELIVERY_FORBIDDEN，server返回403。这两个后续行为尚未在final05执行，当前证据来自正式连接源码与已有协议回归。

1. 同对象follow-up改用本步骤专用小断言，runtime与同文件harness共用。选择最新实际observation，核work completed、owner/read capability/skill、当前A connection及input；kind必须正确，payload status=ok、mode=record、recordType=repair且records恰一条。记录UUID/reference/deviceId及linkedDevice.id匹配当前fixture；payload.source与result.source五项scope及sourceRecordId=repair:<reference>均匹配。不增加correlation/list/旧tpm或record兼容，不要求整个results数组只能一条，不抽通用validator，不改B段。
2. 可重试失败fixture改为明确HTTP200、body {ret:403}；非零协议码且不是stale-token -14，正式路径产生send-rejected及durable failed/WEIXIN_SEND_REJECTED。继续核同action/work的failed delivery。HTTP503仍归unknown，unknown禁止重试的产品语义和负例保留。
3. 仅撤权retry改用request，断言HTTP403及body.error.code=DELIVERY_FORBIDDEN；从状态读回同delivery ID的blocked及错误码，并核实际发送次数未增加。恢复原权限后仍用原api重试同delivery并要求delivered，保留work/action/recipient关联和唯一业务创建约束。

**最小回归。** 用正式normalizeTpmObservation生成最小合法形状，当前步骤断言直接接受A/B各自匹配并拒B对A；覆盖错kind/status/mode/type、零或多记录、错UUID/reference/device、内外source错配和仅旧tpm/record旁路，最新错误结果不得被旧正确结果掩盖。保存A/B样本仅作外置只读原红/新绿对照，不嵌私有state/旧UUID。实际adapter配内存响应证明503仍unknown且retry不新增发送，200/ret403进入failed；实际channel service配内存store证明先持久blocked后抛错、复权允许同delivery重试；实际caller断言拒绝错误HTTP/code/delivery或未持久blocked。运行语法和完整--harness-check，核无真实Host/模型/外部服务/秘密效果，源码冻结后由未实施者独审。纯检查不替代完整J10实际事件后读取、failed→blocked→delivered及唯一创建。

本节显式替代§8.6的142源码全部不变要求：集合仍142项，仅已审accept-p7.mjs允许旧SHA `dfd5ed144bb74ddef268173883b57ef69f2cbfe12da8d992d56e71235822d872`→实际新SHA，其他141项及Kivo源码/runtime保持原绑定。run03包可继续既有独立SOURCE工作，最终manifest/candidate冻结必须等待此修正的实际新HEAD、SHA、定向回归和独立SOURCE审查，不填预计值、不改签candidate16或历史证据。如需修改产品、扩大source范围或放宽unknown/权限门，停止对应分支返回规划。

### 8.8 T5 run03 License 准备续行（2026-10-17，实施前）

工程与产品两名Astra独立规划后正式交换，选择固定run03续行并形成CONSENSUS；本节汇总先于新包实施，独立过度设计审查、SOURCE与runtime门仍分别执行。不新建run04，不改Geneway/Kivo产品或License协议，不重试原activate，不扩大写动作及Hive05窗口。

**已发生事实。** C17 SHA `8a39411e8350e08b010554fea40dbab00a984f84be46e3edbc7a2b9fc4e1d9d4`下18项schema已完成，`run.json` SHA `83d9c0167f9322aa2f1be4472eb8ded0da5a0cc36393a83918a1f3ba796efb6f`。A/B各一次login/request成功、activate unknown；原journal SHA分别`8c146ba639a8fd4a0fbc750ee37c85d50036b32587f51d5a393b00b85a31dfab`、`cefb9ea2992ba714279c0132ce2e0da7165f403995bf540511ea166a77d21acd`。两名Sol分别用实际冻结signer和正式verifyLicenseFile复现九字段拒绝、仅去除excluded并重签后接受。原HTTP status/body未保存，不能声称实际400。只读proof `p7-acceptance/license-readback01/receipt.json` SHA `e82575f3a6b33fafbdd566a80bf70a6c3522a3097a74d2200c013bec462ab2ed`确认旧request各一条未消费/替换，license state与activate audit为零，业务fixture/worker相关表为零，旧四库不变。原API正常退出证明`run03-api-ready/exit.json` SHA `8dbe3a5f70477ce2c8137ce121b896ed2d3a6332df6fdb51549543c7c245af7b`；PG/Redis保留。原unknown和全部历史证据不改写。

**唯一新包和执行身份。** 新外置包为`p7-kivo-runtime-run03-continuation01/`，固定复用run03 producer/output/资源及main `geneway-p7-20261017-03-j10-final06`，主output仍为未使用的`p7-acceptance/j10-final06`。保留C17、原包、原run.json/schema journal和API历史原件；新包显式固定这些历史引用及上述proof，不在内存或磁盘将旧schema candidate替换为新值。Geneway 142项源码、Kivo 301项源码及编译runtime相对C17不变；新候选绑定实际计划HEAD与新包完整消费闭包。

候选冻结后排他创建`/tmp/geneway-p7-kivo-runtime-03/current-context-01.json`，分列`baseSchema`历史来源与`activeCandidate`当前执行；该运行输入的SHA由CLI/launcher/receipt绑定，不反向收入它引用的candidate manifest。API、License、fixture、gate/setup、worker、operator、observer、主验收及其子进程/清理/前后检查统一使用当前候选。API和observer的baseCandidate等于fixture.candidate；C17单列baseSchema。全部实际加载文件、正式parser与传递依赖纳入闭包，不暗调要求旧HEAD等于当前HEAD的旧checkSources。新API launch固定`run03-continuation01`，新ready为`api-a/b-run03-continuation01.json`，原ready只作已退出历史；必须重新核真实PID/PG、端口、数据库和来源。当前上下文缺失、混用或漂移在副作用前拒绝，不增加通用恢复框架。

**签名和纯门。** 只修外置签名payload为正式八字段及顺序：schemaVersion/licenseId/product/requestCode/issuedAt/notBefore/expiresAt/modules。发送前将原blob交给冻结runtime实际verifyLicenseFile，并另外核product=mes、本次requestCode、精确mes.monitor/mes.tpm、既定八小时有效期与当前生效；不把parser未承诺的业务约束算作已校验。HTTP失败仅保留允许的status/code，不落body、token、requestCode、签名或私钥。临时内存key回归实际旧九字段拒绝、新八字段接受，覆盖错key/signature/product/requestCode/modules/顺序/时间；上下文负例覆盖历史SHA错误、当前候选错配、消费闭包漂移、旧API冒充live和旧unknown重用。纯检查无真实秘密、API、DB和新进程效果；未实施者独立SOURCE通过后方可给运行GO。

**一次真实License支持门。** 先重新读回完整旧request行与旧成功request audit指纹、无license/activate效果及保护状态，核run03实际schema的User写入trigger/function与冻结源码一致。每实例最多一次新regular login、新session、新request、新license ID和新trace，排他新journal为`license-a/b-continuation01.json`。旧token/requestCode未保存且正式authority绑定session，故禁止借用旧request。顺序固定login→request→sign→实际parser及字段检查→单次activate→HTTP与DB读回；任一unknown立即停止，不自动第三个request或再次登录激活。

每次正式login的前后窗口内，User仅允许last_login_at、updated_at、updated_by变化：分别绑定新session.issued_at、正式事务时间和human/core-user/admin主体；created_at/created_by及其他身份、权限、凭据、role/org关系不变，regular分支只新增恰一条session，不新增terminal关联。此约束按每次操作窗口成立；后续原批准fixture/operator正式登录仍按各自journal核同一允许差异，不能把License历史receipt的lastLoginAt当作整个J10永不变化的当前值，也不能全局只准一条session。旧request完整行、旧audit和unknown持续不变。

A/B支持门均须证明required→valid、restricted=false、精确modules/ID/有效期，新request唯一consume、唯一预期state与activate audit绑定admin/session/trace；旧request/audit不变，业务fixture/machine/webhook/rule/delivery/worker此时仍零，旧四库不变，前后完整来源检查通过。后续fixture消费成功receipt和当前valid状态，不重复request/签名/activate；过期或漂移停止，不自动续期。License支持门通过后才按§8.6顺序单次启动冻结Hive05，在120秒新鲜度与既定有限窗内完成fixture/setup/动态输入和完整J10。纯parser或License局部成功均不能替代十步旅程、媒体交付、独立阶段审查和用户验收。

### 8.9 T5 停用模型路由的创建拒绝断言（2026-10-17，实施前）

两名Astra分别只读核实际调用链后正式交换CONSENSUS；本节在实现前汇总，仍先独立过设、再SOURCE实施和未实施者独审。当前HEAD `334cdfcfd3ec3528ea9c647ba9ca3ccf40095136`，accept-p7 SHA `70f6a81ce6a57bb13603b624f85581b69fd4436073c15cd34bd8ee9dffb0c05c`。后半旅程独立静态预查仅发现此确定caller冲突，其余路径的静态一致不称runtime通过。

**事实与最小修正。** accept-p7:977–981停用p7-deepseek后要求4xx及MODEL_NOT_CONFIGURED。正式modelRouteSnapshot会拒绝disabled路由，但work-service.authorizedBinding将该异常转为FORBIDDEN；createWork在生成work/execution/reservation前返回失败原state，server直接映射403。故只修同文件本步骤专用小断言为精确HTTP403/FORBIDDEN，runtime与harness共用；不改产品错误分类、模型路由或隐式回退行为。停用PATCH完成后再取得works/reservations基线，POST后深比较业务事实不变并保持模型审计请求零增；PATCH自身已有pending approval失效语义不得错误计入POST。保留原复权操作、事实记录、十步顺序和其他验收门。文件store可能同值重写，因此仅称无新work/execution/reservation/model效果，不称磁盘零写。

**最小纯回归。** 同文件harness使用ensureReady后的内存store与实际createWorkService；完整合法TPM请求先在仅route.enabled=true的副本上由实际authorizeWorkBinding证明成员/员工/skill/connection/input可用。再将所选DeepSeek设disabled、保持另一路GLM可用，以真实createWork验证403/FORBIDDEN、整个内存state不变和runner调用0；共享caller断言拒绝旧MODEL_NOT_CONFIGURED、503、200、其他4xx及新增业务事实。禁真实网络、模型、数据库、子进程与文件写入，执行语法/完整harness和独立SOURCE审查。该纯证据不能替代最终J10真实恢复后停用路由拒绝与无模型回退证据。

仅授权`scripts/accept-p7.mjs`此局部及同文件纯检查；§8.8包可继续已审外置SOURCE，最终资源/manifest/candidate须等待本修正实际提交HEAD及SHA，不能先按334cdfc冻结。Geneway142项集合不变，仅accept再更新，其余141项和Kivo源码/runtime仍相对C17不变；历史候选与失败证据不改签。如发现需要产品行为变化或新增范围，停止对应动作重新决策。

### 8.10 T5 正式 API 异步日志的精确保护（2026-10-17，实施前）

工程与产品两名Astra独立核查后正式交换CONSENSUS，本节先于新包SOURCE、探针和runtime。仅修已证实的外置保护门遗漏，不改Geneway/Kivo产品、业务写动作、License协议或十步旅程。新包仍须独立过设、未实施者SOURCE审查及单独runtime门。

**实际事实。** C18 SHA `0ef88db9811eb15ba4fa0099f7920079707994f945ab38e7b8d7dc2fcc0b991d`、ctx01 SHA `7c3ae439a8c2647e4aee35c1414b9d30e65cc20c3793e8357f18c0565d2edb68`下，仅A支持门调用一次login，HTTP201后在verifyLoginWindow失败。`license-a-continuation01.json` SHA `e320e89e1622b6d8b61d26daca2c4c5fdb20b63733059124748a028f55e9fecd`保留unknown，没有request/activate；B未开始。实际只读`license-readback02/receipt.json` SHA `9bd4e699775a5a9a2592dfd764cbf4e85c934b7b9b31c1e1382c813712b00ed9`证明metadata和旧request/audit不变，protectedTables唯一差异为api_log 3→4；排除精确trace `p7-setup-b9008e28-71c3-48c6-9108-d241ddfaa8c3`后完整旧行指纹相同。新行是POST /api/v1/auth/login/201、userId=null、system/service/mes-api-log。A当前2session、B1session；各旧request1、state0，没有新业务fixture。两个API已正常退出，`run03-continuation01-api-ready/exit.json` SHA `b50a3a06b4bbd9b6668e71163066ffc4ebfc931a05251c54826adb4ea81f03e5`记录launcher exit0及全部PID/PG消失；PG/Redis保留。

正式全局AuditLoggingInterceptor及冻结编译runtime均以`void record`异步写api_log，非GET/HEAD/OPTIONS成功请求和错误响应均可能记日志。HTTP或work完成不证明该日志已提交，日志失败也不阻止响应。旧loginSnapshot和License整体snapshot将api_log放入全表不变比较，故与正式行为冲突。不得删掉整个表保护、按p7前缀放行、拿sleep充当drain证明或将原unknown改成成功。

**固定续行身份。** 唯一新包`p7-kivo-runtime-run03-continuation02/`，新ctx为`/tmp/geneway-p7-kivo-runtime-03/current-context-02.json`，新candidate冻结后再生成ctx，避免哈希循环；新API launch `run03-continuation02`、ready `api-a/b-run03-continuation02.json`、License journal `license-a/b-continuation02.json`。沿用run03 schema和资源及尚未执行的main final06、Hive05。C17/C18、旧两个包、ctx01、所有unknown、只读回执和退出证据作为固定历史原件，新增A session和日志亦成为不可变旧基线；GO前只读冻结当前所有session完整行摘要及不可变User投影，不能把readback02选定字段回读扩称完整身份已验证；不得恢复旧token或借旧request。A/B各至多一次新的regular login/request/activate，预期session分别2→3和1→2；实际前置读回不符即停。Geneway142、Kivo301与冻结runtime保持当前C18字节，新HEAD仅计划变化；全链入口、子进程、observer及cleanup统一绑定新候选/ctx，历史baseSchema继续独立保留。

**最小实现与完整旧行保护。** 优先不新增实现文件：共享日志snapshot、精确delta和有限轮询放现有auth-protection，license-support复用，fixture/operator仅接固定前驱和当前HTTP元数据，selfcheck扩实际生产者回归。api_log从笼统tables相等移入同一snapshot内的专用完整行验证，不能不检查。以固定排序的完整行摘要保护全部旧api_log；新行只能由当前操作的精确trace集合解释，数量、唯一ID、method/path/status、userId、系统metadata actor、创建/更新时间窗及正式字段形状逐项校验；未变字段不得投影丢弃。只在已有metadata机制加入api_log trigger，核其身份、启用、事件、参数及既有冻结函数正文SHA（0519b203…），同时绑定正式挂载迁移20261009195150_api_log_record_metadata；与User/session沿用同一套检查。

每次login窗口恰一条本次POST /api/v1/auth/login/201日志、userId=null，原User三列和恰一regular session检查全部保留。License整体恰三条，另两条对应本次request/activate的固定正式method/path、精确200及实际journal HTTP状态和认证admin；登录日志不得重复计入允许增量。整个支持门保留旧License完整行、audit、业务零、旧四库及前后source门。日志receipt仅保存安全元数据、完整行摘要及来源绑定，不输出UA/IP原文、秘密、token、requestCode、License blob或正文。后续消费License receipt只核已记录三行仍完整存在及License不变，不将成功时整个api_log摘要冻结为未来业务永不新增的全局条件。

**异步与并发边界。** 一次HTTP只发送一次；响应返回后仅为尚缺的精确预期日志有限READ ONLY轮询，固定10秒/250毫秒/最多40轮，每轮新RepeatableRead事务读取专用完整日志及数据库clock，日志到齐后再取得全部保护项与clock的一致最终快照并重验，避免反复扫描无关全表；SQL/事务时间受剩余deadline约束。重复、错误或额外trace、旧行变化及其他保护差异立即失败，不能等到超时再忽略；只有尚缺预期日志可继续等。超时保留unknown并停止，不重发HTTP或登录。

进入后续login窗口前，仅对已绑定固定前驱journal中已applied、同实例且精确可识别的POST日志做同样有限到齐：fixture依赖对应成功License三trace；operator依赖对应固定fixture及自身已完成formal-http前驱。不扫描任意journal，不新增跨Host日志drain协议。建立baseline后，旧日志逐行受保护；窗口内未绑定的迟到MCP/业务/错误GET日志一律停止，不能追加白名单。前序work/HTTP完成不是日志到齐证明；未绑定异步日志可能使运行停止是保留的安全边界。原有业务写仍在其独立操作窗口内按既定计划执行。

**生产者回归与运行顺序。** selfcheck读取已冻结compiled AuditLoggingInterceptor原字节，用标准CJS wrapper和白名单真实Nest/rxjs加载，唯fms-db替为deferred内存事务sink；不加载实际Prisma、bootstrap或秘密。实际interceptor驱动login、request、activate形状，证明响应先完成而日志后提交；同一实际产物使旧全表不变门红、新精确delta绿。覆盖永不落库、错trace/path/method/status/user/actor/time、重复/额外行、旧行任一字段改变、迟到未绑定trace、后续消费历史日志不冻结全表、两个合法连续login，以及原八字段实际parser回归；禁真实网络/DB/进程/文件写入。所有实际消费文件及传递依赖进入新闭包，SOURCE独审不得只看自造日志对象。

方案独立审查通过后才实施新包；源码冻结、纯门和未实施者独审通过后由root创建新candidate/ctx并核完整闭包。新API就绪后先分别完成一次实际License支持门、HTTP与DB读回、原件保护和退出/cleanup可用性，两个门均成功才单次开启已冻结Hive05，按§8.6顺序fixture/setup/动态输入和完整J10。任一unknown保留并停止该分支；局部License成功、纯生产者回归及已有历史四步均不代表J10/P7完成。

### 8.11 T5 无时区日志时间的类型边界（2026-10-17，实施前）

两名Astra独立核查后正式交换CONSENSUS，本节先于新SOURCE/probe，仍须独立过设和未实施者源码审查。范围仅为外置日志时间读取、直接相关回归及固定续行身份；§8.10的精确1/3日志增量、完整旧行、User三列/session、前驱边界、10秒期限及unknown不重试规则不变。

**实证。** C19 SHA `f1eab9e6c31742869d6184e67332d2278a60ac2f5b638f09c7d49eeae7329931`、ctx02 SHA `55bca4e2d5fbdff55a53bcce19e32356153926359d1bf5ba2035eeeae7a9d8ee`下，仅A再次登录HTTP201后在checkLog:114时间窗断言失败。`license-a-continuation02.json` SHA `5c4e2e52870dd96beaaeaae17845dd212bc15dbb62667c4cf9896a97ed09d487`保留唯一login unknown，未request/activate，B未开始。实际`license-readback03/receipt.json` SHA `162100e3d8ba7aa12850216d932a28ca057b675e1000bd9583e629d8eb69942c`证明：同净环境Node为Asia/Shanghai，DB为Etc/UTC；api_log两时间列实际为timestamp without time zone、精度3。原SQL JSON两值为`2026-10-17T01:24:30.732`，旧newDate解析成`2026-10-16T17:24:30.732Z`，同一行Prisma typed投影均为`2026-10-17T01:24:30.732Z`，偏移八小时。A新增log ID `065e231a-2cd8-41dc-bbc4-680be1cecd72`，trace `p7-setup-42152d32-5d80-4330-bdd6-d340ef34999a`；全5行摘要 `17dd85062d5fae172dfd3b0388694aa4d38f645914e298d8115da974cd14490f`。扣本次trace后原4行完整摘要、旧2完整session、immutableUser、旧request/audit、metadata、余表及四旧库均不变。A当前3session，B1，双方原request各1/state0。API02均exit0且四PID/PG gone，退出proof `run03-continuation02-api-ready/exit.json` SHA `5201ebb26f7fdd4ec2119f1eab0029565b1e90445a732eca720f5eab545951ad`。

**最小类型修正。** 仅在既有apiLogSnapshot同一个SELECT中保留原`to_jsonb(t)::text`和原ORDER/COLLATE C，旁取同一t行id、trace及`created_at AT TIME ZONE 'UTC'`、`updated_at AT TIME ZONE 'UTC'`类型化时间。raw字符串、排序和完整行SHA一字不改；typed侧列与raw行双向一一对应，核ID/trace、唯一性、UTC日历值一致、有效绝对时间。checkLog仅用该typed时间比较，其他字段仍来自原完整raw行。A/B各自在实际snapshot门确认固定DB UTC语义和两列timestamp without time zone(3)，不凭A推断B；不盲加Z、不更改全局TZ/clock/数据库数据，不放宽既有1ms容差。snapshot及相关log检查、纯sink在原文件内调整，不新增通用时间库、适配层或产品依赖。所有实际消费依赖重新冻结。

**先纯检查，再对已有行做实际只读接缝门。** 同一个selfcheck由controller分别以TZ=UTC和TZ=Asia/Shanghai运行，不在测试内新增spawn。纯sink同时模拟PG无Z raw与同一行typed时间；冻结旧02时间解释在UTC绿、上海红，新路径两边均绿；缺失/重复/跨行typed绑定、raw与typed日历不符、无效时间及真实时间越界均拒绝，raw排序和SHA不变。保留真实compiled interceptor、1/3日志、deadline、HTTP零重试及其余既有回归。readback03仅公开选定字段，纯样本不可冒称完整历史raw重放。

新包SOURCE通过、新candidate/ctx03冻结并核完整来源后，**任何新login之前**执行一次app-role单RR READ ONLY实际接缝检查，复用正式apiLogSnapshot及新validator、冻结旧02 validator，禁止旧loadContext/checkSources。取得A实际完整5行raw和同行typed，核全SHA17dd…、固定未知journal.before.apiLogBaseline原4行、精确trace/ID和beforeClock；当前上海环境旧validator必须仅在原时间断言红，新validator绿，完整原件及旧四库保持。B同次只读核自己的DB UTC和列类型。记录安全时间/绑定/摘要及实际命令，不保存UA/IP或秘密。该门只证明已发生行的读取解释，不把原unknown改applied，不补称原login或License完整成功；失败停在新登录前，不以纯绿继续碰运气。

**固定第三续行。** 采用唯一新`p7-kivo-runtime-run03-continuation03/`、`current-context-03.json`、新candidate、API launch `run03-continuation03`、`api-a/b-run03-continuation03.json`及`license-a/b-continuation03.json`。baseSchema仍C17；保留C17/C18/C19、前两个续行包/context、所有unknown、readback03及exit proof原字节，A此次新增session/log纳入完整旧基线。当前142 Geneway、301 Kivo和冻结runtime字节保持，新HEAD仅计划变化；五字段context仍在candidate之后排他生成，API/fixture/setup/operator/worker/observer/cleanup统一新绑定。实际只读接缝门通过后，A/B各最多一次新regular login（本次分别3→4、1→2）及一次新request/activate；历史token不恢复，旧request不借用。成功License门之后仍按原排序单次Hive05、fixture/setup、动态输入、完整J10。无新业务动作、延窗、部署或发布授权。

### 8.12 T5 worker 初始化顺序诊断与既有准备材料续行（2026-10-17，实施前）

工程/产品两Astra分别独立核源后正式交换CONSENSUS，root确认范围为当前技术阻断：外置worker初始化与固定续行绑定，以及`accept-p6-kivo.mjs`共享worker验证器和`accept-p7.mjs`两个实际调用点。不增加业务动作、账号权限或产品源码改动。本节先于诊断SOURCE/probe和条件实施；独立过设通过前不得开工。

**当前证据。** HEAD `fac7aaea85aa39bfb7402fedcd1adbec1f3aa697`，C20 SHA `2fe6a318da9232b9e2ae42610d2f7bc6a4a1408b6cea933b59ce470cbb240ded`，ctx03 SHA `a25394534db5305437af05649f45b991d3e42bfa6841cc04a4766aec44affe17`。§8.11实际时间接缝已通过，A/B License03各一次初始化完成，回执SHA分别`4d348efb47b4df16c85e7d38a2b1ae8a9274aeff95f73793fd47ae08aab1cf68`、`e1ab117d9c4eaee1235fa70302c0650d85967b1250bf391f8e2e29c8b0d137f1`；fixture A/B成功原件SHA分别`c6d3a9269d835960fcea6e9fa08a906dc500e4150a83765713d86805dc0b08fd`、`70904b3d86e4d40f1f067f0c8e05881f2db844124c3e394ca577437b0e74ece9`。这些是已发生的C20准备材料，不重新签名或改候选。

随后setup实际session80458 exit1：`setup-notification-gate.json` SHA `dd7529c9fa5abf4d8cd0e91789fe43da3d54024b91dd76a3d77257e4cfdc908b`保留consume-a-setup unknown；`worker-a-p7-setup-evaluate-452afca431dc.json` SHA `09ab83062e01a4fc881b8d5fb4f5bfe9d32039c80a05db8d7114f78624f20a33`为operations空、runtime缺失、httpRequests0，worker4138218/start14945132 exit1/null。安全诊断只有PREPARATION_FAILED/Error/frames[]，不能反推原异常。实际app-role RR READ ONLY的`setup-readback01/receipt.json` SHA `1152b74d297c908cc3137ba0a55e3c4e16546453aed11f19b2b29157ffbbabd3`逐深比A/B gate.before完整snapshot相同：13业务/通知表指纹、维修reported/rev0、全部14outbox完整行、workerinstance/execution均0；各3通知evaluate仍pending/gen0。License及旧四库/unknown保持，worker PID/PG gone。API03各exit0且四PID/PG gone，退出proof SHA `5873f0bdde1f49924960708640c5773b6bdd3d7c15377f3358d461132d1464c5`。Hive05仍为固定171..231采样窗口，完整J10未开始。

**待证假设。** 当前run-worker在设置worker环境前，经old-fingerprint和LicenseReceipt require fms-db；platform-db导入创建并缓存默认Prisma，Prisma5.22异步instantiateLibrary/loadEngine随后以当时process.env创建engine。旧成功run02实际属于C12 `e416…`的fresh/run-worker SHA `f67cddd1421fbb27e0c729fe6f917717b584f5b0c358ac3f53f3295ed6d86d09`，首次Prisma require在workerENV后；不能拿后来03的SHA `147fcc28369510fb4c006df5a5bc5b2df16484c68adeab9df28081ea922effb0`冒充旧成功源。早导入是候选机制，不是已证实根因。

**先诊断，保持C20有效。** root先写本计划并按固定hash取得独立过设PASS，暂不commit、不改142个Geneway源，HEAD仍fac7；当前checkSources不读取计划正文。仅诊断SOURCE/PURE及独审通过后，才能在原C20/ctx03完整来源门下执行两个独立净进程。二者同Node/runtime/输入/原guard/真实imports；baseline保原顺序，variant唯一改变为loadContext完成后、assertOldUnchanged之前调用同apiEnvironment(worker)、清env赋值和chdir。apiEnvironment自身不导入fms-db。启动时仅在内存判原DATABASE_URL缺失或目标属于批准PG；未知目标即停、不连接、不输出值。

两进程均按真实顺序导入tsx/cjs、fms-db、runtime-identity、notification与outbox模块，止于READ ONLY身份SELECT；保database/workerRole/non-superuser精确断言。禁止registerMesWorkerRuntime、heartbeat、createMesNotificationWorker、runMesOutboxWorkerOnce、once/release、Redis/Hive/HTTP。SOURCE/PURE检查不调用真实模块产生外部效果；实际诊断允许这些固定导入必需的owned编译子进程及任务临时缓存，必须核进程退出，不扩到业务worker执行。失败输出只用固定stage、允许name/code/errorCode分类和安全结果，不输出message、stack、URL、ENV、凭据；如用message识别已知缺失DATABASE_URL错误，只输出固定布尔分类。新诊断原件不得覆盖旧journal。

两个进程前后都要独立app-role完整读回A/B setup/outbox/worker、License、完整用户/session/api_log等保护项和旧四库，证明零差，记录实际退出。只有baseline在对应初始化/identity阶段复现、earlyENV variant取得正确worker身份且全部零差，才支持修复。未复现、variant失败、错误落在别处、任何状态差异或越界访问均停止依赖步骤，返回有界分析，不通过业务release继续猜测。根因证据不足时不得开始下述条件实施。

**原因成立后的唯一首选修复。** 把既有worker环境构造/清env赋值/chdir移至loadContext后、首个可能runtime require前，继续既有默认Prisma及正式参数链，保所有原guard、角色检查和cleanup。不同时增加第二client、清模块缓存或修改产品；显式newClient只作为此方案被实证否定后的另案，需重新规划。

**固定续行04，分开历史准备与当前执行。** 新包`p7-kivo-runtime-run03-continuation04/`、新C21、五字段ctx04在候选之后排他创建；baseSchema仍C17。沿用已有continuation机制，resources以固定`sourcePreparation`路径/SHA绑定C20/ctx03/原03包、两成功License03和fixtures，以及失败setup/worker、实际零效果回执、API03退出proof。历史材料继续验证其C20/context/bundle，新API/setup/worker/operator/observer及主验收执行绑定C21/ctx04，不伪造历史context、不调用旧checkSources要求当前HEAD等于旧HEAD。新的API/observer baseCandidate=C20、candidate=C21；当前完整闭包仍严格验证C21。

需同时贯通support.validateFixtureContext、LicenseReceipt、start-api、setup gate/completion、两层operator、observer安装和worker返回校验中实际强制两候选相等的接缝。只允许固定历史原件，不泛化任意候选继承。使用固定新API launch/journals、新setup gate路径及新release ID，原setup/worker unknown一字不改；不重schema、不新License、不重fixture、不恢复或重用历史token。SOURCE自检须覆盖错历史pin/context/candidate、把unknown当成功、旧candidate充当前及旧journal路径复用负例。

**主验收真实consumer。** `validateP6Worker(receipt,fixture,eventId,expectedCandidate=fixture.candidate)`增加明确执行候选参数；P7两个调用点传来自已验证inputs的`binding.candidate`，不取proof自报值。原P6三参数严格语义保持。PURE调用真实consumer验证C20准备/C21worker通过，当前C21而worker报C20或第三候选拒绝，以及原P6默认正负例；不得内存改fixture或把新worker身份投影成C20。候选只允许`accept-p6-kivo.mjs`和`accept-p7.mjs`两个源SHA改变，其余140G、301K及runtime逐字保持，外置candidateIdentity与HEAD diff采用精确路径/摘要，不作任意来源豁免。

诊断支持后才实施、独立SOURCE/PURE审查并commit，再冻结新候选/context及完整来源。新setup前重新核全部原准备状态与三个pending；使用新release单次精确消费原3条，证明A各processed/gen1、一个已停止workerinstance/三executions、其余11outbox与业务表不变、HTTP0，B全快照不变且无worker。成功后接既定J10。Hive05不延长、不重启、不减freshness；若准备后窗口不足，停止依赖实时样本步骤，由controller处理新的外部条件。License过期或任一unknown/身份漂移仍停止对应分支，不能自动续签/重建或补签PASS。

### 8.13 T5 有限 Hive06 窗口与启动顺序（2026-10-17，实施前）

工程与产品两Astra独立核查、正式交换达成CONSENSUS。§8.12实际只读对照已完成：session15585 exit0，总回执`worker-initialization-diagnostic01/receipt.json` SHA `b05df6acd363e073ee84573b4ee27000c091b970ffb6ebf73214cebbce3916e8`，baseline在identity阶段缺DATABASE_URL/P1012、earlyENV正确worker身份；两变体完整保护前后同摘要`e7ba2138b7fb53f470c03707d989a2feb96f3cb3c4627eba723b127751860a51`，无业务调用，实际进程已退出。独立只读复核支持§8.12局部条件修复；不补写旧worker generic错误为已捕获P1012。§8.12原计划字节b8ac已由本地提交`15a4874d32f82271d3f5f24031c2e92f372aa8f7`保留；诊断旧manifest不再用于新当前来源校验。

**已完成前驱。** Hive05 actual session8277自然exit0，`hive-window05-completion01/receipt.json` SHA `285d1cb4fdeec34d73a1762da58973cc8af1563d37a3df45a3d8826e5a5bfdcb`，processes SHA `2fe890de0f7e044900c888611123f46a51e0226e35b1d811d7ceea76e78e6738`。window-safe SHA `2458489f18120a36ee80d4b1bbf3d9e6d4fa2959d6ff00d43f520458af2c1fc2`，末sample231 SHA `294989fc9388708fa1eec5ff8122ba73b27f94248efa579788da425457e3f8cf`，observedAt2026-10-17T02:16:42.858Z。61样本171..231、122发布、transport1020→1142/ACK1142/pending0/ackPending0；root实际核host4110776及PG、inside88925均gone且无同UID其他stdin Python。完整J10未开始，完成历史不提供未来freshness。

**固定新06，不扩为通用续窗。** 新`hive-window06/`源码和固定`p7-j10-20261017-01-window06/`输出沿用05机制，仅改前驱原件/进程/路径/名称/范围和对应PURE向量。固定232..292共61样本、30秒周期、最大1860秒、122条DHEARTBEAT+DDATA、birth=false；起点1142，首两条1143/1144，末两条1263/1264，结束ACK1264/0/0。仍为原tenant、device、externalDeviceId、容器/mount及秘密引用，不增凭据或业务绑定。冻结Hive source `64fc6d2a54ce38183449d2ff445c2c3054821598659459ce98f86c5a8d756bc3`、original publish `ad9e6f1a58f5fe4db70fb25d1b00999fef92451ef16424cf57cf9660da8591cc`、local publish `9345b8b8362898d3c6021fda0534fdf2e1b0cefea3577494fee155bccd889dbc`保持字节。

predecessor精确核05 completion和五个引用原件SHA、session8277自然exit0、完成范围、末sample231的1140→1142及1141/1142两消息、完整normalized data和进程退出证明，只导出下一边界232/1142。实际启动还要重新核host4110776/inside88925不存在、无其他publisher、固定容器和实际transport/ACK恰1142/0/0；历史proof不能代替这些实时检查。保fresh排他落盘、原消息/时间/ACK校验与无自动mutation retry。

**历史准备与当前发布分别绑定。** fixture A/B仍固定05 sample171/172原路径/SHA，原字节不改。`accept-p7`仅核其历史SHA，当前监控仍按既有published binding的externalDeviceId调用`mes.monitor.current`；不再调用prepareFixture或Hive binding validate/publish。catalog无Hive样本字段、observer无05路径，不增加activeHiveWindow字段、live-window receipt格式或新consumer。04复用现有resources.hiveWindow/hiveWindowDirectory/manifest绑定06 source、05前驱与固定范围；sourcePreparation严格保留C20/ctx03/05创建历史。root只在现有唯一验证记录和主验收输入归属中关联C21/ctx04、新setup及06现有host-request、首verified sample和最终window-safe。

**SOURCE先准备，publisher最后启动。** 本节独立过设PASS后才能制作06 SOURCE/PURE；其独审及04固定绑定在C21冻结前完成。实际顺序为：§8.12条件修复/全部SOURCE独审→C21/ctx04完整闭包→新API/原成功License与fixture验证→新setup单次精确消费原3pending并证明worker停止/B不启动→catalog/observer/主参数/输入摘要/输出/执行owner及所有非fresh前置全部就绪→单次启动06→首样本原有正式消息/ACK/最新值验证→立即既有fresh只读检查和J10。setup两rule为repair/business_event，原evaluate路径不读取实时Hive并保持HTTP0，故不用先开窗口。不得在窗口内继续计划或修改source。

publisher新样本不等于Kivo已返回新样本。首次正常monitor实读须对应06已验证样本并仍过120秒freshness/未来最多5秒；现有current cache默认5秒，允许现有有界读等待正常刷新，不清cache、不改TTL或样本时间。完整J10、publisher自然完成和P7最终验收分别报告，互不替代。

PURE保有效05前驱及错hash/状态/范围/序列/进程/tenant/device、重复request、DBIRTH、缺失/重复/额外消息、错时间、越界/超时拒绝；文件写入、网络、子进程、信号、秘密读取五计数0。独立SOURCE审查需核publish与关键机制原字节及真实consumer历史/当前关系。当前§8.12仍仅两个G验收脚本允许变化，其余140G/301K/runtime不改。实际窗口之后保原window-safe、末样本和host/inside/session退出证据。

边界不符、并发publisher、License失效、准备原件变更、发布unknown或freshness失败时停止对应依赖步骤，保原件先回读；不重建schema/License/fixture/setup、不换序号起点、不重放。窗口按上限结束，不延长06、不自动启动07、不降低J10门槛。此规划只恢复原验收所需有限新鲜样本，不增加业务目标、写动作、外部接收方或部署发布授权。

### 8.14 T5 API 启动器与子进程退出归属修正（2026-10-17，实施前）

工程 `c04_exit_engineering_astra` 与产品 `c04_exit_product_astra` 独立核实源码、固定真实退出原件及当前冻结身份后正式交换，达成CONSENSUS。本节只解决04新增退出断言与真实历史冲突，以及保留冻结失败候选的固定续行；不增加业务行为、权限、运行框架或证据平台。独立过设PASS前不得修改后继SOURCE或实际启动。

**真实失败与归属。** 04 SOURCE/PURE独审后，C21 SHA `0e351a80caa323e46553b1be98f22c980ef0e60cc4b170642f45f3e4bbb834b2`、ctx04 SHA `9b76aed0c4e3e7e3273601fbb5dce4e54bbc52486a83e4c3b709c488c4d88f59`排他创建，当前完整contextFor实际session24626 exit0。04 manifest `39279ea5892d20f800eca65aeb99e119b7986247770c458f97e2bf749f6d4865`、bundle `495194f16aa9cf0ef9f45b895dadcbd18c718d9bfb100622f27508f6fe048300`保持。随后A04 session73091 exit1停在start-api.previousApiLaunches:54：新增断言要求第三旧API child为0/null。固定03退出proof `5873f0bdde1f49924960708640c5773b6bdd3d7c15377f3358d461132d1464c5`准确记载两launcherExitCode=0，而两child都是`{code:null,signal:'SIGTERM'}`；A/B journal SHA分别`c2f538a6d6b794769bcc338db4f62d6790576b028f3f5a6ea4627d5b2331bf70`、`21eeec905c3cf87fd1c01e6f7767426b02ff2d74046a407109ce886f3db4163f`，均与proof相同。§8.12“API03各exit0”指启动器正常收尾，不是child自然退出；本节明确更正归属，不改历史原件。此前PURE把真实ready投影成child0/null掩盖冲突，其绿不能证明此接缝通过。

新A/B04 API journal均不存在；失败在databaseIdentity、journal创建和spawn前，assertOldUnchanged已执行只读。B04、setup、Hive06、主J10均未启动；现有唯一验证记录保73091命令、停止点及退出码，不另造failure receipt。04缺journal继续保持缺失，不编造exited，也不列入成功前驱API名单。

**最小修复。** 在现有previousApiLaunches内部读取已pin的sourcePreparation.apiExit，按固定实例核launcherExitCode=0、pidsAndGroupsGone=true、journal精确路径/原字节SHA、childPid及child exit与真实03 journal一致，删除强制thirdExit child0/null的两断言。保既有phase、immutable身份、完整历史journal名单、允许的0/null或null/SIGTERM退出组合，以及当前PID/startTicks不存在核查；EACCES或身份不明仍拒绝。不增加通用exit validator，不把正常SIGTERM改写成0，不接受任意signal。

**固定后继05。** 保04包、C21、ctx04及所有旧unknown原字节；排他新建`p7-kivo-runtime-run03-continuation05/`，只修上述接缝和PURE并完成必要05路径/身份替换。sourcePreparation仍固定成功准备的C20/ctx03/03包，baseSchema仍C17；04/C21不是成功准备。使用既有manifest.externalFiles精确固定04的19源码+manifest、C21及ctx04，SOURCE审查核它们内部对应关系；不增加history字段、祖先候选豁免或新状态机制，不对旧候选执行要求当前HEAD相等的checkSources。当前142G源、301K及runtime保持字节，HEAD仅因本计划提交更新；当前完整闭包按新HEAD及05来源执行。05独审冻结后root排他创建C22和五字段`current-context-05.json`，新API launch/gate/release成套使用05，拒绝04输入冒充current。mainRunId及尚未创建的final06主输出沿用现有名字。

**实际原件验证。** PURE直接读取A/B固定03退出journal原字节和真实proof，向实际previousApiLaunches只注入无进程的依赖；不覆写exit。保旧断言对真实样本拒绝、新consumer接受的最小前后对照。负例只克隆输入，覆盖错proof/hash/instance/journal/path/childPID/child exit、launcher非0、gone=false、SIGKILL/code1/unknown、同pid/startTicks仍活、EACCES与额外04journal。固定原件正例及纯效果计数0须由未实施者独立复跑，不能以摘要匹配代替语义消费。

**执行顺序与停止。** 计划独审/本地提交→05 SOURCE/PURE及独审→C22/ctx05完整来源门→新API A/B及原License/fixture验证→沿§8.12修复后的完整历史snapshot比较与单次新setup→全部非fresh输入就绪→原冻结Hive06最后启动→正常monitor与完整J10。当前不存在的04 journal若出现、旧原件或unknown改变、当前来源不符、License失效、旧进程仍活/读取错误、05/C22/ctx05碰撞，均停止依赖步骤；不覆盖、不重License/schema/fixture、不重放未知动作、不延长Hive06或降freshness。不修改产品、共享仓库、现场，不推送部署发布。

### 8.15 T5 正常重启锁持有者对照与新隔离完整旅程（2026-10-17，实施前）

工程 `c04_exit_engineering_astra` 与产品 `c04_exit_product_astra` 独立读取真实失败、产品与验收调用链后正式交换，达成CONSENSUS。本节是诊断实施计划及有条件的验收修复/新fresh旅程计划；独立过设PASS前不写诊断SOURCE，诊断支持前不改仓库验收源码或启动新旅程。继续使用唯一验证记录，不建通用resume、候选等价豁免、退出框架或证据平台。

**当前实际结果。** 05/C22完整来源前后门均exit0，API A/B和setup真实通过；精确3条setup消费、A其余11outbox/13表不变、B完整不变、worker已停。final06 session82085 exit1，前四步通过，第五步same-object-event在accept-p7:830点击时全局selector匹配2而拒绝。observations SHA `8d6b63be4c57c5d8166d763857c4ace0bafed1ce35a2ad99ba3ef2f01f522de2`，录像258.45秒，SHA `ec054291fc7c932595f4e3dff79d132b1388550445a4291d957257fe01bb5fc6`；这是失败旅程。此前synthetic人类dispatch已成功，源单dispatched/rev1，事件 `da597804-b837-4c86-8992-0023d6406faf`，worker退出0、Kivo通知单次202/38ms、Geneway后续观察completed，不能重放。原C22/ctx05、包、状态、视频与效果保留。

API05已在原来源仍有效时由owner正常停：两launcher0、两child null/SIGTERM，四PID/PGgone，proof `run03-continuation05-api-ready/exit.json` SHA `5f6bf79cb6d3ca1ad65b5cf90c60525e58d1def10dec594132eb06481243a731`；主authRemoved且owned进程退出，root实际scratch进程扫描空。Hive06仍按原上限自然结束，不延窗、不重启。

**两个明确接缝。** UI有规则列表 `#automation-list` 与提醒 `#automation-attention` 的合法同规则入口；click helper先检查querySelectorAll数量再检查可见性，所以只证明2个DOM匹配，不证明2个可见控件。首选沿P5现有模式，把830限定为`#automation-list [data-open-automation="…"]`，保唯一性和真实点击，不隐藏产品提醒、不用first。

此外，微信身份在重启开始后13ms记录unavailable/WEIXIN_LOCK_LOST；自动通知后续blocked/attempts0，非same-channel-receipt的预期撤权负例。channel-service发送守卫要求connected；后续维修回执同样依赖它。源码链为P7 stopOwned→共享P4 stop向-HostPID组SIGTERM，微信holder普通spawn继承HostPG；Host异步shutdown等待automation.stop再channel.close，holder可能在release置releasing前被组信号终止，触发生产lost路径。旧日志有Host退出0但没有holder PID/exit signal，当前仅为支持假设，不补称旧actual已捕获因果，也不放宽产品failclosed。

**先做同条件真实对照。** 独立外置`p7-acceptance/weixin-host-stop-diagnostic01/`固定诊断源码及PURE独审后，使用当前精确Node与实际`scripts/accept-p4.mjs --host`入口（channelHost→正式start/server.shutdownServer），当前生产acquireWeixinBot/createWeixinRuntime，真实OS holder及本机iLink模拟器。两个独立净进程均在新owned临时根以synthetic身份/凭据启动至connected，Host detached PGleader、holder继承PG；唯一行为变量为baseline向-HostPID发SIGTERM、variant向HostPID发SIGTERM。不复用旧J10 auth/秘密，不调用模型、Kivo或业务，不访问外网，不人为sleep拉长竞态。

两组共用一个诊断专用透明`--import` preload：包装child_process.spawn并syncBuiltinESMExports，仅观察源码中固定/bin/sh锁holder调用，原函数、参数、返回及退出逻辑保持；通过安全FD/IPC记录PID/parent/startTicks/PGID和exit code/signal/时间，不记录完整args/env/凭据。父进程记录Host信号请求/退出和实际PID/PG消失；读取临时state的身份状态与simulator active/max poll，证明正常释放和同一临时身份重启connected/唯一owner/单poller。网络守卫只允许本机owned Host/模拟器，记录模型/业务调用为0；PURE不产生文件写、网络、进程、信号或秘密读取。

只有baseline实际复现holder提前退出→LOCK_LOST/unavailable，且variant正常产品close/release、无失锁、Host/PG退出并重启connected，才支持下面条件修复。保真实holder SIGKILL失锁负例，仍须停止poll、unavailable、禁止发送；复用现有test-p4-weixin与test-channel-state的真实断锁、sticky、撤权零发送语义。baseline未复现、variant失败、靠强杀兜底才退出或越界均停依赖实施，继续有界归因；旧实际holder证据缺口仍如实保留。

**条件修复仅限验收入口。** 原因支持后只改`scripts/accept-p7.mjs`：上述selector；stopOwned仅在`child.auditRole === 'host' && signal === 'SIGTERM'`先向正HostPID发送SIGTERM，先注册退出监听、等正式cleanup与Host退出，再核整个owned PG消失。超时/残留用原owned PG SIGKILL兜底并核退出，但必须将该次记失败，不能伪报graceful成功。其他children及显式SIGKILL沿原组语义，共享P4 stop及产品锁/发送守卫不改。可导出既有stopOwned供定向回归直接调用，不建wrapper。覆盖三处正常Host停止、最终runCleanup同回调及硬中断边界；用真实helper复验变体，不只测仿制函数。两入口同时存在时定向证明列表selector唯一打开该规则/已有occurrence，旧全局selector拒绝；不重放业务。执行现有harness-check、test-p4-weixin、test-channel-state和必要语法/独审；不把无poll的harness-check当真实重启证明。

**新run04是完整验收路径。** §8.6的fresh/no-resume继续有效。accept-p7属于候选闭包，一行变更也不能沿C22身份；旧run03已dispatch且临时认证清除，尾段接续仅能是局部证据，不能拼成完整J10。本节明确仅为新的同类本机synthetic旅程建立run04，不重建run03，不改变业务动作。固定runId `geneway-p7-20261017-04`、output `/tmp/geneway-p7-kivo-runtime-04`、包`p7-kivo-runtime-run04/`、新主runId `geneway-p7-20261017-04-j10-final07`及排他`j10-final07`输出。拟API34681/34682、PG55881/55882、Redis56881/56882，网段10.253.76.0/29(gateway .1)及10.253.76.8/29(gateway .9)，webhook34481保持。root只读预检六端口空、两路径不存在、46网络无重叠；实际入口必须重核，不运行时自动选号。新API端口需同步accept-p7五处严格端口/对应PURE，保精确绑定，不泛化任意目标。

新准备回到已有fresh单候选C23/run.json机制，不携带continuation ctx或sourcePreparation长继承。整合已证实的八字段License签名/正式parser、异步API日志和类型化时区保护、worker早ENV、API退出归属及现有通知精确消费；不得直接复制旧fresh包复活缺陷，也不把05历史License强行改为新库。新库首次独立License和fixture是新run必要准备；秘密只来自本任务新生成/获准模型项，旧业务原件不改。SOURCE逐项列已保留实现与必要fresh绑定差异。run01/02/03六旧库通过既有oldReadOnly机制以API停机后的当前逻辑指纹保护，包含run03已成功dispatch/outbox/delivery/attempt/worker，不沿用其变化前基准。142G中仅当前accept-p7必要变化，301K及compiled runtime保持；当前完整闭包必须以新HEAD/包/C23逐项校验，独审后才创建真实资源。

**固定Hive07与真实依赖。** Hive06自然完成后，先核window-safe/末sample292、transport与ACK1264、pending/ackPending0、host/inside进程退出及固定原件，才能制作并审查07 publisher SOURCE；不猜完成SHA。07复用现有机制，固定293..353共61样本、30秒、最大1860秒、122条、birth=false、1264→1386，原tenant/device/externalDeviceId及凭据不变。SOURCE/PURE含真实06前驱和原负例，publisher关键机制保持，不增加live receipt或放宽120秒freshness/5秒future/cache语义。

新fixture确需新鲜Hive样本，因此不能机械沿用旧fixture已完成的“publisher最后”次序：条件修复/定向实际证明→新准备与07 SOURCE独审/提交→C23完整闭包→新run04 schema/API/License及所有不依赖fresh准备就绪→单次07→首正式样本与最新值核验→A/B正式fixture→一次精确setup→动态catalog/observer/主参数及全来源门→立即完整十步J10。不在窗口内继续改源或规划；窗口不足、License失效、旧保护漂移、来源/身份碰撞、任何未知写入或真实断锁负例失效均停止依赖步骤，不重放、不延窗、不降标准。完整旅程、新窗完成、P7交付与用户最终验收仍分开报告；没有push/部署/发布或新业务权限。

### 8.16 T5 正常停机刺激校准与重启早门（2026-10-17，实施前）

工程与产品Astra先独立读取02实际原件及源码，后正式exchange形成CONSENSUS。本节显式替代§8.15中“baseline必须复现LOCK_LOST后才能修改P7/开始新旅程”的实施前提，改为独立的正常停机方法校准；其余权限、完整fresh旅程、旧原件保护、资源、来源闭包、Hive07前驱和发布顺序保持。独立过设PASS前不改源码；真实helper方法验收前不启动新旅程。

**失败结论不改写。** 诊断01在准备模拟器时被自身dns guard拒绝：固定Node对字面量127.0.0.1监听仍调用dns.lookup。02仅透传该精确字面量的原生处理，独立SOURCE/PURE209项及五效果0后actual session32151 exit1，总receipt SHA `86a246ede7a878d3c6bebd48da417bb15ae0fb2bcaebc5ef56b3740933a573d1`，supported=false。两scenario均exit0不等于对照通过。baseline微信stdin-finish早于exit回调，虽实际以SIGTERM退出，但state stopped/restart connected，未复现LOCK_LOST。variant两个holder均stdin-finish后0/null，stopped→connected且单poller；真正holderSIGKILL负例仍unavailable/LOCK_LOST、poll0、拒绝发送。原01/02源码及actual永久保留，历史final06原因仍未确认；stdin-finish/exit回调不等于捕获releasing赋值或OS死亡时刻。停止同条件自动复跑，不用sleep、延迟release或篡改产品制造竞态。

**独立修正理由及新验收目标。** 正常重启应通知Host并让正式shutdown释放自身owner，而不直接向holder发送终止信号。02已直接证明旧组SIGTERM同时终止automation与微信holder，automation还没有stdin-finish；单PID变体则让两个owner正式自然释放。因此允许修正P7的正常停止刺激，但不能宣称已经修好旧LOCK_LOST。新成功条件是实际导出的P7 stopOwned正常停止能完成正式释放、无信号杀holder、无兜底、Host/PG消失并同身份重启connected/单poll；不是把旧baseline改绿。若真实helper验收失败则停止依赖旅程，保原件继续有界分析。

**唯一源码责任。** 仍只改accept-p7：§8.15列表selector及五处新API固定端口；导出现有stopOwned，只有auditRole=host且SIGTERM走先注册exit监听、正HostPID通知、等待正式退出及PG消失。超时/残留仍清理owned PG并核退出，但该次必须失败；显式SIGKILL及其他children沿原组语义，共享P4 stop不改。P7 boot目前仅赋auditRole，而共享stop的host SIGKILL路径在发信号前读取auditFile/auditBinding；按P4已有模式把本轮已有auditFile与binding赋给child两字段，保硬停审计可达，不删除role或用假数据绕过。不改产品失锁、sticky、权限或发送守卫。

**复用现有访问增加两个早门。** 仅在restart-and-supplement和normal-restart的boot+login后，使用既有poll/state/simulator检查原refs.weixinIdentity.id的身份：id/memberId/channelAppId/weixin.botId与原refs及本轮weixinAccount.id精确一致、active、runtime connected，simulator.activePolls/maxActivePolls以已核botId为参数分别为1/≤1。正常connecting可用既有有界poll等候；一旦unavailable或WEIXIN_LOCK_LOST立即失败，不等其转绿、不手改状态/重绑/重放。前一门必须位于补充协作和来源dispatch之前。empty-restore继续预期appdisabled/rebind-required，不套connected条件。不新增通用poller或观测框架；两个相同检查可置于当前acceptance内部小函数，复用现有依赖。

**实施与真实方法验收。** 本节独审后Sol实现最小P7差异及定向测试，并在新外置weixin-host-stop-method01准备方法验收SOURCE/PURE；复用02的真实Host/生产锁/本机sim/透明观察与网络边界，调用真正导出的stopOwned，不复制其逻辑，不重跑baseline求红。使用新临时state/auth/身份，实际验证正常stop→同状态重启→最终runCleanup回调的正常停止，两个holder释放/0null、PID/PGgone/单poll且无强杀。保真正holderSIGKILL后的failclosed负例；独立owned Host显式SIGKILL及其他child组信号语义按既有审计回归。必要超时/残留分支采用最小受控owned fixture或纯依赖模拟验证失败和清理语义，不能让强杀变正常PASS；不引入产品mock或未知进程信号。列表与attention两个入口的定向测试保旧全局selector拒绝、新列表selector唯一打开已有规则/occurrence，不产生业务重放。早门覆盖错归属、多poll、unavailable立即失败与恢复预期不受影响。

运行既有harness-check、test-p4-weixin、test-channel-state与必要语法检查；未实施者独立审源码/PURE后root才执行一次有界真实方法验收。原02false、方法验收、全J10分别报告。源码/方法验收通过并本地提交后才按§8.15制作新fresh包和07来源、冻结C23、执行新完整十步旅程；新旅程仍须证明通知/维修回执真实渠道结果，不能用早门或方法验收替代。旧因果缺口保留至最终报告，不削弱完整验收或用户最终验收。

### 8.17 T5 重启早门的真实身份投影与新完整旅程（2026-10-17，实施前）

工程与产品Astra分别读取final07实际失败及producer/consumer源码，随后正式exchange形成CONSENSUS；本节独立过设PASS前不实施。全量合同、正常停机校准、fresh/no-resume、旧原件保护及用户最终验收边界不变。

**已证失败与替代文字。** C23/fresh04完整来源、schema、License、fixture/setup均通过；final07 session89705 exit1，仅前两步通过，第三步restart-and-supplement在accept-p7:500得到actual `a` / expected `undefined`。refs来自已认证a的GET /api/channels，经memberChannelState→identityDto→safeChannelState/safeIdentity；HTTP投影有意不含memberId，内部state则保留。真实producer→consumer纯复现失败，method01手造带memberId的refs通过，确认该测试缺口。此结论不是本次失锁证据；旧final06 LOCK_LOST原因未知仍保留。final07尚未source-human dispatch，但04已经有fixture/setup等真实准备效果，不能称无副作用。主auth已清除、owned进程及两API全部退出，原两步/录像不得拼成成功旅程。

本节明确纠正§8.16“memberId与原refs一致”的证据层混用：公开id/channelAppId与真实GET所得refs一致；内部memberId严格等于创建该refs的已认证操作者`a`；内部botId严格等于本轮weixinAccount.id。只在accept-p7既有waitWeixinRestart中分开这些断言，不给产品API增加字段、不伪造refs字段、不从被测identity自取expected，不删除归属约束。两处正常restart继续共用该门；active、unavailable/LOCK_LOST立即失败、同bot单poll、最终connected/activePolls=1等判据保持，empty-restore不套该门。

**最小但覆盖真实producer的回归。** 沿既有harness检查/必要外置定向检查，实际执行memberChannelState({ id: 'a' })过滤（使用真实认证actor对象；旧gate负例必须到达比较，不能把UNAUTHORIZED当前置失败证明）→identityDto→safeChannelState/safeIdentity生成refs，再执行实际waitWeixinRestart；明确断言公开refs不含memberId、私有weixin/bot材料。旧gate对同输入失败、新gate通过。owner漂移或缺失负例须先生成合法refs再改被测内部identity，以避免expected跟随错误变化；保错id/app/bot、inactive、unavailable/LOCK_LOST、并发poll>1、connecting/active0等待到connected以及有界超时。核两restart调用位置与失败阻断后续动作，不复制gate算法、不为测试新增产品export/API或通用映射层。运行实际accept-p7 --harness-check及必要语法/受影响检查，未实施者独立审查。method01真实正常释放、runCleanup、真实断锁和硬停证据，在stopOwned、boot审计及相关生产/Node依赖未改时按精确diff/pin沿用，不重跑整套诊断；其手造refs纯检查不再作为本接缝证据。

**fresh05选择及固定边界。** fresh/no-resume本身不逻辑强迫更换物理Kivo库，但04的run/fixture/setup/API/operator均精确绑定C23。复用04将要求新增跨候选历史准备消费机制，不是此次小修复的最低维护成本，因此选择已有fresh单候选机制的新run05，复用稳定compiled runtime、镜像和工具，不回滚04、不重放旧效果。固定runId `geneway-p7-20261017-05`，包`p7-kivo-runtime-run05/`，output `/tmp/geneway-p7-kivo-runtime-05`，候选`candidate-final24.json`，主runId `geneway-p7-20261017-05-j10-final08`及排他`j10-final08`。API34781/34782、PG55981/55982、Redis56981/56982、10.253.77.0/29(gateway .1)与10.253.77.8/29(gateway .9)，webhook34481不变。root预检六端口可用、三目标路径不存在、48网络无重叠；实际入口重核，禁止自动选号。accept-p7五处严格API绑定及对应检查同步窄改，不泛化目标。

新包只沿已审run04现有fresh机制更新固定身份、端口与旧库保护，保正式八字段License/parser、类型化时区、异步日志、worker早ENV、实际API退出和精确setup消费。run01..04八旧库在API停后取当前完整逻辑指纹保护，特别包含04已有准备及03已dispatch效果；不得复用其变化前基线。新首次License/机器秘密由本任务独立生成，获准模型项沿本任务server secret路径，不扫描旧项目。142G必要accept-p7差异、301K及56751compiled runtime和新包当前完整闭包实际逐项校验，独审后才能创建资源；C24与原C23各自不可覆写，不携带continuation/sourcePreparation继承。

**单个有限08及执行次序。** 07已自然完成session15860 exit0，61样本293..353、122发布、1264→1386、ACK1386/pending0/ackPending0；root实际host2188913 PID/PG及inside99057退出，独立61样本含完整DDATA摘要核验PASS。前驱`hive-window07-completion01/receipt.json` SHA `4f8d908924684d889a601469badb84ded9dc6ca808d37c1080c27c598d750895`，processes SHA `67573551ec809c79b0ed8fab97452aca617dfe84ed43993c949185b183f354b8`，原window-safe SHA `0a210fe4406c4bf1a70da58a874cd1ca5082e38ff8da636c4644483c167b26d1`。允许在本节独审及全部前置门后制作一个08，固定354..414共61样本、30秒、最大1860秒、122条、birth=false、1386→1508；tenant/device不变。SOURCE消费真实07原件，实际启动仍核ACK边界与旧publisher退出；完成不继承freshness，不新增live receipt或放宽120秒/5秒future规则。

顺序为本节独审→Sol窄修/真实producer回归/独立代码审查/本地提交→新准备包与08 SOURCE/PURE独审→C24完整来源→新schema/API/首次License及所有非fresh命令模板就绪→单次08→最新正式样本及A/B正式fixture→精确setup→动态catalog/observer/主输入、全来源与两MCP最新样本门→立即完整十步J10。窗口内不改源或规划；窗口不足、漂移、未知写入或安全负例失败即停依赖步骤，不自动追加窗口、重放或拼接。成功完整J10、有限窗口完成、运维适用矩阵、实录/离线交付、独立总审与用户最终验收仍分别成立；无push/部署/发布或新增业务权限。

### 8.18 final08 环境准入、固定观察终态与单层承接（2026-10-17，独立过设通过，实施待验）

本节由独立工程、产品两名 Astra 先分别读证，再正式交换形成 CONSENSUS；controller 原位汇总，第三名未参与规划者独审通过后才可执行下述新诊断与实施。适用范围仅为首次 Chrome 启动失败、05/08 launcher 退出证据缺口及新完整 J10 的准备承接；不改变业务目标、写动作、权限、全量交付或用户最终验收。08 已实际结束后才开始此次规划，非窗口内补写。

**事实与历史保留。** C24 基线 `fa9e300463049b1ea00a8c94c282933d0cb405ae`、候选 SHA `9674d8b42108a9a4e6ea65f947a100e45bc5c0beb5f41f999e2a7ea611305ad0`。final08 主 session4638 exit1，首个 Chrome `owned Chrome failed`，steps/facts/eventAcks 均空；命令用了 `HOME=/nonexistent/p7-j10` 且缺 TMPDIR，P7 的 systemEnvironment 原样传递，Chrome stderr pipe 未消费。此前 owned HOME 成功及旧 headless 诊断支持环境假说，但本轮缺 stderr/exit metadata，根因仍未知。已存在本轮 synthetic Feishu ref、Host 状态和 observer baseline；attempts 为0字节、无 arm/claim/consumed、无 operator 业务请求，不能称没有副作用。原件、失败视频、秘密引用及准备记录均不覆盖。

05 API child `2883547/2884608` 的 PID/PG 已不在，journal 为 `null/SIGTERM`；launcher 实际退出码未知。观察原件 `run05-api-ready/observed-exit.json` SHA `60c2c99e1cf1cc38ce72d0b7cbd2ff16b74698a3d6a64f630efa8c63b89292c4`，恢复的 ready 表示从退出记录重建且摘要与当时观察相等，不伪称原始复制。08 host2912305 早已消失、launcher exit 同样未知；inside102402 持续到05:29:37UTC后退出。root及独立Sol实核61样本354..414、122消息、完整DDATA摘要、1386→1508、ACK1508/pending0/ackPending0及全部相关进程退出。窗口 SHA `ba09a3cdb77b353013a167975728590e10c6b2baec1ba64ac83eeff112cd06b9`，末样本 SHA `5e10c660dcf4221104146c639e2397c6941b9c2fad195128889656a2b3c38139`；`hive-window08-observation01/observed.json` SHA `92cdbabc1f76f8e68f30194e40331097ac63750d697b77edfd8c7d2fb6e43ade` 明确保留 launcherExitCode=null/naturalLauncherExitProven=false。观察命令exit0不是旧launcher exit0，窗口完成不继承freshness。C24全来源在P7源码改动前再取证：实际checkSources session13909 exit0、2026-10-17T05:36:56.152Z、5496ms；随后旧候选仅作为已执行准备的固定历史身份，不能要求改动后的当前文件仍等于C24，也不能声称源码等价。

**A：无业务 Chrome 准入，先做且有界。** 独立过设通过后，Sol 在排他 `p7-acceptance/j10-chrome-env-diagnostic02` 制作检查，使用实际Node/Chrome、P7的X11完整argv与Preferences、Xvfb、本机静态页面及既有CDP helper。不得用headless/dump-dom代替，不启动Geneway/Kivo、不读运行秘密、不调模型或真实渠道。基线badHOME且无TMPDIR；变体只换为本任务排他owned0700 HOME，TMPDIR仍缺失，其余环境/argv语义相同。每组独立profile，记录允许的环境项、argv、binary身份/版本、PID/startTicks/PG、实际exit/signal、私有stderr、CDP结果及cleanup；诊断就绪等待有界，不自动重试。正式环境另用owned HOME与TMPDIR=/tmp，验证三个独立profile同时存活、CDP正确DOM及读写、全部受控退出。若badHOME不复现，仅保留历史因果未知；正式环境可用、错误环境副作用前拒绝、失败诊断可取得、进程清理完整才是准入，不能把重现旧红变为永久阻断。正式环境或清理失败即停依赖动作。

源码只在 `scripts/accept-p7.mjs` 既有验收入口及harness-check窄改：在初始化Host/synthetic secret或其他运行副作用前检查显式HOME非symlink、本人拥有、0700且可写，TMPDIR有效；复用既有privateDirectory/access等边界。Chrome就地沿accept-p4-s1的stderrText取尾3000惯例消费pipe，安全spawn error分类、exitCode/signalCode及有限stderr只进入已有0600 first-failure私有诊断，公共report/manual不加入调试信息。不改共享systemEnvironment、产品API、正常停机、网络guard或成员隔离；不建日志框架、preload拦截或通用launcher。诊断与正式J10消费同一份已审固定命令/环境定义，明确owned HOME及TMPDIR=/tmp，不再手抄env。验证环境提前拒绝且无产品副作用、尾部界限、exit/signal区分、敏感环境不入诊断；实际 `node --check scripts/accept-p7.mjs` 与 `node scripts/accept-p7.mjs --harness-check`，未实施者独立审查真实Chrome证据及diff。正常stopOwned/boot方法未改时保留method01适用性，不重复整套失锁诊断。

**固定观察终态准入，替代方法而不回填历史。** 当前旧consumer要求launcherExitCode0，现状不满足；本节独审前不能启动新API/窗口。合同§2.6允许验收方法失效后的局部重规划，§2.5保留用户所有的业务与授权决定；§8.3已有旧失败保留、发布效果核清后固定新边界的先例。因此，本节通过后允许在新包中仅针对固定05/08引入明确的观察终态准入，旧代码和UNKNOWN原件不改，不静默删除原断言、不泛化接受任意失败。

新准入必须实核固定路径/SHA及旧ready/exited不变量、child退出形态、精确PID/startTicks/PG和关联进程已不在、当前源与准备效果；读取错误/权限错误/缺pin/漂移不得当gone。08另外逐份核61样本和122正式消息摘要、无birth/重号/缺口、完整末边界与ACK、全部publisher退出。任何未解释业务写入、发布、权限变化、来源漂移或活进程都阻断依赖动作；换库不能绕过。旧launcher退出仍UNKNOWN，新门只证明特定历史效果及归属已核清。对有持久身份的进程核原件实际具备的PID/startTicks/PG；原API launcher未保存OS PID，仅按固定executable/启动脚本、output、launch-id的当前进程参数核无匹配残留，不推定原parent身份或退出码，不把tool sessionId当OS PID。

不新增父wrapper、守护服务或重试平台：现有证据没有证明它能避开工具清理。root保持同一active turn直到本轮API/Hive/J10等owned长运行命令均终态；沿既有SIGTERM/stop流程，wait原launcher真实返回并立即保存，再核journal/PID/PG/完整来源。会话丢失与结束turn只有时间关联，不称已证根因。若再次失联，仍为UNKNOWN，不能用子journal、入口意向exitCode或观察命令exit0代替真实wait。

**B：固定单层继承05准备，承接门通过后才就绪。** 原C24/原包直接重启被排除：API launch固定run05、已有journal排他、operator/observer/main/window精确绑定。比较的新fresh方案虽然没有base/current接缝，但需新增两PG、两Redis、两网络及schema/License/fixture/setup写，修改P7固定端口，且同样不能解决旧退出缺口。双planner条件首选复用现有05物理资源；主验收verifyApiStates已区分baseCandidate=fixture.candidate与candidate=当前候选，历史fixture的Hive创建依据与实际MCP新鲜度也已分开。保留这一现有职责，不增加通用resume、多层继承或任意候选等价。

实际旧包只读门在进入数据库前失败：publicBindings 的555项 externalFiles 中仅当前 P7-plan.md 不匹配，旧pin为067b5c9c81760007d9df373fac7a08447c64b04692f5d1c7a0de09e28241bd69；新增本节即改变该文件，保持HEAD和产品源码不足以满足旧门。05:36的C24来源PASS仅保留为当时历史事实，原loadContext当前FAIL不得包装成PASS。两名Astra独立纠错并正式交换后，修正顺序为本节独审→A无业务环境准入及窄修→既已计划的单层新包SOURCE/PURE和C25当前完整闭包→新包第一次实际只读承接门；通过前禁止启动新API/worker、schema/License激活/fixture/setup写入、新窗口或业务。历史计划原字节从固定fa9e300463049b1ea00a8c94c282933d0cb405ae的精确路径读取，实核等于原067b摘要；当前批准计划另以当前闭包精确绑定。仅这一个历史计划路径按历史身份处理，其余外部输入及产品源码按base/current各自责任严格验证，不泛化忽略文档或来源漂移。不回写当前批准计划、不改旧包/原件、不建namespace/过渡loader；历史闭包不是当前工作区等价。新包在C25完整当前闭包下、启动API或业务前实核准备快照、当前License/权限及进程；门后到启动若发生相关状态变化必须复核，早先快照不是当前状态的替代证明。只读门须核A当前snapshot等于completed setup的after，B等于其原before/after；A三条setup已消费、其他生产者原样，B三条pending原样。snapshot实际覆盖13业务/配置/审计/通知表及outbox、worker instance、worker execution共16类，不能称05全227表。另核维修reported/revision0、无新增维修/dispatch/worker消费或未知delivery/attempt；当前License valid、精确模块、账号/密钥状态及权限；八旧库按既有全表指纹保护。原main无work/action/rule/业务消息、observer零attempt且无arm/claim/consumed、operator没有请求/一次性动作，须与实际原件一致。源身份、权限或效果不能核清时B不就绪，不能先写后查。

固定新包 `p7-kivo-runtime-run05-continuation01/`，当前排他输出 `/tmp/geneway-p7-kivo-runtime-05-continuation01`，候选 `candidate-final25.json`；承接的业务runId仍为 `geneway-p7-20261017-05`，保持fixture/sourceInstance及34781/34782等原资源身份。新的API launchId为 `run05-current01`，日志在当前输出内 `api-a-run05-current01.json` / `api-b-run05-current01.json`；baseCandidate固定C24，candidate/current context独立绑定C25。主runId `geneway-p7-20261017-05-continuation01-j10-final09`，排他 `j10-final09`、新Host/auth/会话/observer control/secret-root及HOME；新路径实际入口重核不存在，不自动选号。

仅允许一层“C24已执行准备→C25实际执行”：原schema run、两首次License、两fixture、completed setup、旧API journal保持字节不变；只验证承接，不再activate、POST fixture或consume setup。新包按既有职责窄处理resources/manifest、runtime-io/support、API当前launch、License历史消费、setup验证及operator/worker当前绑定，所有实际加载及传递来源进入当前完整闭包。不得复制更旧continuation链或用旧checker失败当源码豁免。旧fixture的sample354/355继续是历史创建依据，不改写为09、不继承freshness；当前实际MCP读取仍必须过120秒/5秒future与对象/cache门。旧准备记录只证明已发生效果，当前权限和执行来源另行核验。

SOURCE/PURE独审覆盖历史计划错revision/hash、当前计划漂移、非计划external漂移、C24冒充current、坏历史pin、current错配、旧API冒充live、setup重消费、未知操作重入、observer串目录、闭包遗漏、观察终态缺字段及活进程等负例。若具体实施需要第二层继承、改写旧原件或新恢复框架，停止B；fresh为已比较备选，但须controller明确选择、固定身份/源/端口及独审后才能实施，不自动切换。所有原件及用户UI sketches继续保护。

**一个有限09，非fresh门全部提前。** 工作区本节纠错独审→提交计划→A环境准入/窄修/独立代码审查及本地提交→新包与09 SOURCE/PURE独审→C25当前完整来源及新包首次实际只读承接状态/权限/进程门→新API及实际当前License核验→catalog/observer/operator/精确命令等所有非fresh输入就绪→单次09→两实例真实MCP最新样本门→立即完整十步J10。复用05不重fixture/setup、不从final08恢复、不拼旧步骤/录像。

09只允许415..475共61样本、30秒、最大1860秒、122消息、birth=false、1508→1630，同tenant/device，严格消费08真实完成/观察原件及全量边界；不得要求或伪造旧launcher自然exit0。窗口内不改源、不规划、不延长、不自动追加10；任何未知写入保持禁止重放。成功J10、当前业务配对恢复、安装/容量/升级回退对当前候选的适用矩阵、G/J/AC全部要求、MP4解码/1倍速离线播放/独立媒体审查/飞书交付回读及用户最终验收仍分别必达。历史AC-22时序限制不补签，不部署、不发布、不合入。

### 8.19 final09 输入通道准入与固定 current02 执行（2026-10-17，独立过设通过，实施待验）

本节在09发布实际自然退出、宿主和容器进程均已核清后才形成。工程与产品两名Astra先独立读证，再正式交换；controller只汇总共同决定，第三未参与规划者独审通过后才能开始新探针或实施。范围仅为真实stdin/operator生命周期、final09已发生效果及下一次固定执行准备；全量合同、业务动作、权限、模型、交付和用户最终验收不变。

**事实与原件。** 当前Geneway为`ac95149cec58f32847951cbaf736e96040a9bf4e`，Kivo为`ae27a4e97ddfa5248d4461bd563d9e907489b81c`，C25为`07e071ef95462b9f57beb455d1c2404a4f3452ef700d4c99211a9015827b3537`。§8.18的Chrome准入、C25实际只读承接、两API/current License、09两实例fresh门均已通过。final09主工具91276实际exit1；first-failure SHA`eaad1fd946330560b818f87523bd36fe962293b0a110ead0433a7f5edd8d45fe`证明`ReadStream.onend → Interface.close → operator ended`。root实际调用省略`tty:true`、使用默认pipes；原件没有fd/isTTY生命周期，不能把工具关闭stdin的具体机制写成已独立证实。现有operatorChannel把EOF缓存，到首次wait才reject，且发生在emit request之前；不是业务operator运行后失败。

final09已保存2条路由、2个Skill、2条测试ready的Kivo连接、3名员工和成员开放；Host work/knowledge/channel identities/messages/rules等仍空，facts/eventAcks空。已有本轮synthetic Feishu ref、Host state和observer baseline；observer attempt为0且无arm/claim/consumed，未运行operator/worker。网络12条fetch、2条connect包含两实例metadata/token/MCP discovery；没有ZenMux调用。OAuth及工具读取可能写认证/审计记录，不能称外部零效果。observations SHA`cb6eb5581208f6278f8670459a7cbf6598002640182411bd861b83f31c0a7ac8`、state SHA`4a05c44e192ef57a3b600e4cd901f2cbd03c8dadb3c161540a0e860f7e7c11fa`、network SHA`648dfc92f6ba9de8d61b044ca2df9546e2f711d7a5b9e50ac40e8cf1a5ea7c48`均保持。14.8秒录像只作失败原件，不拼入成功旅程。

两个current01 API经已保存launcher身份发SIGTERM，原工具69986/60897均真实wait exit0；child为null/SIGTERM，相关PID/PG均gone。`j10-inputs-run05-continuation01/api-exit.json` SHA`c40d8f20f3613eef2ad79166e35acca2fcb5bd4802cfa0eef3887a6765abaf24`保留launcher与child区别。主入口前后完整来源门分别实际14599/19490 exit0。09原工具26701、wait chunk e649b1实际exit0；`hive-window09-completion01/completion.json` SHA`2cd6146b48548b7c7876183445a8f8e23c5e227f132a53b14c0d2cda2328c6fd`立即保存，内pending字段是保存时状态，后续独审追加到验证记录，不改原件。独立审计61样本415..475、122条DHEARTBEAT/DDATA、1508→1630、完整DDATA和ACK/pending边界通过；06:59:37.315Z→07:29:37.347Z，1800.032秒。window SHA`c18960c255dc4eb66309d240c8e793e0cfc3a85af99b0ade392e5bc84697fdb1`，末样本SHA`581f31818b088b08c2afbf963bc7dc5ea2cc21eca25e3b30f51d33e1be99525c`，122份样本文件名→SHA规范JSON聚合`47b84d97340bd4b4743a97e796bc763e7f026b2514728a30f07778c10ea024af`。host551475/startTicks16811604/PG551475、inside110835均已退出，精确容器身份及无其他同UID stdin Python另行实核。旧05/08 launcher UNKNOWN仍UNKNOWN。

**A：复用真实operator通道，在产品副作用前验证本次读写。** 最小改动落在`scripts/accept-p7.mjs`已有operatorChannel、acceptance初始化和harness-check。保留JSONline、128KiB上限、runId/candidate/guard/step绑定、一次性step、noSecrets、300秒业务等待和全部既有业务operator门。主入口在既有try内、simulator/Host/Chrome/secret/auth/state初始化之前，用同一operator.wait发一条固定`stepId=transport-ready`、`operation=verify-transport`请求并严格校验`{ready:true}`应答。只允许排他诊断输出准备和既有只读来源/输入检查先发生；ready不调用Kivo operator、不构造业务receipt、不计入十步业务通过。唯一mainRunId及既有绑定已足够，删除随机challenge方案。

只靠固定启动options或独立smoke不能证明本次实际主进程stdin仍可读写，因此保留主入口ready；与新增父wrapper、自动driver或FIFO服务相比，仅增加原通道的一次等待。EOF/error第一次即向已有failure/abort传播，保留第一个错误；idle与pending都不能等到下一业务门才发现。具名close/error/abort监听及timer在dispose移除，正常finally已有的dispose→input.close顺序不得触发新失败；pending dispose仍拒绝并收束，不把已发送业务标成未发生、不重试未知写入、不改正常停机或guard。不得把`isTTY=true`变成产品必需条件，有效双向pipe仍合法。

新增外Git、固定`p7-acceptance/j10-operator-transport01`无业务小检查，直接消费导出的真实operatorChannel/readline，使用与正式入口相同的Node、已审environment模块、mapfile/exec以及明确的工具启动选项；不复制第二个parser或启动器。先yield再由root经真实write_stdin回固定应答，至少两次分时请求/应答并实际wait退出；额外验证接近128KiB的合法JSONline完整传输，不能把parser上限当PTY传输容量证明。默认pipes EOF负例须在任何产品副作用前失败；PURE覆盖ready前EOF、ready后idle/pending EOF、错绑定/重复或提前应答、超长行、abort/timeout及正常dispose/close，业务/模型stub调用为0或abort后不新增。秘密不进入诊断，fd/isTTY仅非秘密辅助元数据。

正式执行可固定工具`tty:true`，但准入依据是实际往返结果。若真实长行检查证明所选PTY会截断或改写，只允许就该owned PTY作必要的标准非canonical、无echo且保留信号字符的窄终端模式调整，并在finally恢复原模式，再用同一真实检查复核；不建通用stdio框架、不改全局终端/用户配置。若仍无法可靠保持通道，停依赖运行，不先开窗。source/PURE独审通过后才实际smoke；正式J10仍再次ready，smoke不替代本次主进程验证。A完成后本地提交，源码及真实效果独审通过才冻结下一候选。

**B：直接承接原05准备，精确核对本轮认证效果。** 现包固定mainRunId/launchId/output且current01 journal已存在，不原地重启、改写C25或复用final09已配置state。新包固定`p7-kivo-runtime-run05-current02/`，输出`/tmp/geneway-p7-kivo-runtime-05-current02`，候选`candidate-final26.json`；业务runId仍`geneway-p7-20261017-05`，base直接是原C24的schema/License/fixture/completed setup，不以C25为第二层准备父级，不回调旧loadContext链。C25仅是最近失败尝试、真实API退出、认证和已审代码来源的固定历史证据；所有旧包/原件保持字节。当前计划与当前源码单独固定，历史计划仍按原精确Git对象核，不恢复旧工作区计划。

新API launchId=`run05-current02`，journal为新输出的`api-a-run05-current02.json`和`api-b-run05-current02.json`。主runId=`geneway-p7-20261017-05-current02-j10-final10`，主输出`p7-acceptance/j10-final10`，输入`p7-acceptance/j10-inputs-run05-current02`（catalog、observer26及来源/退出记录），secret-root=`/tmp/geneway-p7-j10-secrets-10`。observer control沿实际consumer放在原setup05的`private/create-observer-{mainRunId}`。HOME继续使用已实际通过的`j10-chrome-env-diagnostic02/environment.mjs`（SHA`180d2bf5ab0ca4996421c1ce0b1c133d25da321f8e804ccb6dada96964c593c2`）；Chrome profile、DSH、auth、state、日志全部在新输出内独立。原物理PG/Redis/端口不变，不自动新建库绕过未知效果。

新SOURCE/PURE和完整当前闭包独审后，首次实际READ ONLY承接仍核原16类准备快照（A=setup after、B=before）、四授权表、正式License签名/到期/模块、机器主体/密钥/管理员权限、8旧库全表指纹及全部相关进程。另加`user`、`fms_auth_session`、`api_log`、`audit_log`、`machine_client_assertion`五类专项，不把业务只读等同认证无写。Kivo正式producer的consumeAssertion会删除已过期断言并插入digest，写`machine_account/oauth.token.issue`；recordAccess写`mcp.http.read`，API interceptor记录非GET/失败。现有verifyPredecessorLogs只证明expected存在，不足以拒绝额外日志，不能单独据此称增量全部解释。

用户和Session在首次承接、该实例尚无本轮受保护login proof时，以C25 `license-status.json`（SHA`14bf61144a024ed8ac7743c55e249d55dbd33a18bffadd39c734c683b67cf562`）每实例loginProofs的usersAfterSha256/sessionsAfterSha256核当前集合；该初始期望不能永久用于新登录后的检查。verifyPreparedState显式消费本轮受保护journal/proof，只有既有loginGuard已证明真实before/after、唯一新增session及合法admin lastLoginAt变化，且该实例login operation=applied、proof绑定及保护检查全部有效，才能选用该proof的after摘要。逐实例选择，A已登录不改变B尚未登录的期望；未验证或错实例proof不能成为authority。license-status后门运行时整个journal仍可能requested，不能以全journal completed作为必要前提，也不能删除后门、从当前DB自取expected或泛化为新状态机。

推进proof前还须保护真实before：current02为loginGuard增加窄的显式expected/before-validator，在原settlePredecessors取得before后、invoke之前，将before.users/sessions及完整日志集合与该实例已接受的历史或此前受保护期望匹配。保留原operation.httpStatus/instance检查与settledSnapshot异步日志等待，不用现测试snapshot注入替代（该分支会跳过上述真实保护）。仅before→after合法不足以证明起点可信，初次gate后、login前偷增session等漂移必须拒绝，不能被新proof洗成expected。

C25的apiLogs.after是已有全日志基线。插件同一次连接会让多个metadata/token/MCP请求共享trace；旧verifyApiLogDelta按单请求登录要求trace唯一、每trace至多一行，因此不能直接用于MCP增量，也不修改其原登录语义。只在current02承接入口按真实trace组核增量：先逐ID/raw SHA保护基线，再按已知producer的method/path/status/userId/metadata/writer多重集及条数严格匹配同组多POST，拒绝额外、缺失或歧义；不退化为只验证expected存在。专项必须同时覆盖fresh-monitor的`p7-c25-fresh-a/b`、主final09真实metadata/token/discovery与全部既有准备journal；检查完整当前集合的正式producer形状、账号/凭据、产品资源、path/status/trace/时序和写入身份，拒绝额外未知业务/权限写入或不匹配行。无历史audit/assertion完整raw基线本身不是永久阻断：可以据既有原件和正式producer证明当前剩余集合与已知效果一致，但不得捏造历史没有已删除行、全表不变或从当前取expected。断言过期删除按正式producer解释，不假设旧行永存，不补发token取证。实际无法解释的行/数量/身份/时间或权限漂移才阻断B；精确报告缺口，不泛化忽略auth/log，也不换新库掩盖。

专项归属精度固定如下：api_log保护基线完整ID/raw SHA，新增仅正式consumer可达的MCP POST初次401 challenge、OAuth POST200与后续MCP POST200，逐行核userId、类型化时间、metadata trigger和`mes-api-log` writer；成功GET metadata/status不产生新增。audit_log本轮oauth.token.issue要求module=`machine_account`、entity=`MachineAccount`、entityId=fixture.clientId，after精确machine actorId/credentialId、writer=`machine-oauth`；fresh-monitor的三个mcp.http.read additionally固定productNamespace=`mes`、原resource、repair/ledger/monitor三个正式源path、status200、writer=`machine-http-access`。原machine_account.create等准备行仍须固定journal/actor/trace对应，不能只列动作白名单。断言集合只含唯一合法SHA256 digest、精确machineAccountId/credentialId和expiresAt；expiry按正式issueToken.validTimes约束（请求服务器时刻最多+330秒，有已有SDK精确证据则用更窄值），不捏造未保存的jti原像。

fresh-monitor trace精确在原件。main09 guard没有保存trace/method/status，允许的仅是唯一、无歧义的多源归属：数据库内部一致trace组，与两实例精确client/credential、已知connection-test时间窗、每实例原六次fetch路径序列（三MCP/一token）、testKivoTpmConnection正式connect/listTools行为及api_log/oauth audit同trace交叉匹配。不能把该匹配称原wire trace证据，不能只靠时间/数量；多个同样可匹配组、额外成功issue、其他account/credential、额外read/write路径、状态或expiry不符均阻断。这个范围允许解释已知认证 effects，不扩大业务写入许可。

最小新增负例还须证明正常MCP同trace多POST可通过而多余/缺失行拒绝，A已有合法login proof而B未登录时仍分别使用正确期望，伪造/错绑定proof拒绝；整个journal未completed但该login操作及保护已完成的真实后门顺序可通过。

新包对当前API退出/日志、final09非业务状态及零attempt、原准备直接base、当前计划/候选、10窗口前驱做SOURCE/PURE负例；历史原件不能冒充新API ready。operator/worker延用既有一次性动作和当前HTTP License消费，不重activate、fixture、setup或已发生动作。observer在Host guard内仍只调用无spawn的publicBindings；完整Git/base/runtime/checkSources仍由root在主入口前、全部Host退出后调用，并绑定同一候选/main/output/实际退出。承接后新API各自产生可归属launcher身份，当前License HTTP valid后才准入；实际当前认证窗口也按保护门记录。

**顺序与单次10。** 本节形成并通过第三独审→提交计划→A源码/PURE独审→实际双向stdio小检查及最窄必要调整/复核→A本地提交→新包和10 SOURCE/PURE独审→C26完整来源及首次实际只读承接→新API/current HTTP License→全部非fresh输入、精确主命令及逐步operator请求处理方式就绪→单次10→两实例真实MCP最新样本门→立即完整十步J10。10固定476..536共61样本、30秒、最大1860秒、122消息、birth=false、1630→1752，同tenant/device；严格消费09真实wait0、完成原件、61样本完整消息/ACK和进程终态。旧fixture sample354/355仍只作历史创建依据，当前样本120秒/5秒future及唯一对应门不变。

root执行每条长运行命令时保存真实工具session及OS PID/startTicks/PG，维持同一active turn直到所有owned长进程真实wait终态；operator业务请求只能交既有固定CLI实际执行，再把真实结果回stdin，不补造receipt。主运行前先备好完整operator命令和stdin发送方式，不等窗口开始后拼接。窗口内不改源、不规划、不延长、不自动追加11；新未知写入禁止重放。失败仍按实际原件记录，不能因首步UI成功或窗口成功降低完整旅程门。成功J10、当前业务配对恢复、G/J/AC适用矩阵、独立总审、中文MP4/离线HTML及飞书回读、用户最终验收继续分别必达；旧AC-22时序限制不补签。

### 8.20 final10 单请求工具转交校准与平级承接（2026-10-17，实施前）

本节在 window10 原工具自然结束后，由工程、产品两名 Astra 独立读证，再正式 exchange 形成 CONSENSUS。第三名未参与规划的过设审查通过、计划提交后才能开始新诊断、包修改或窗口。只解决已观察到的 operator 结果未在等待期限内被主入口接受及下一次完整旅程的安全准备；不改变业务目标、写动作、权限、全量交付或用户最终验收。

**事实与因果边界。** Geneway HEAD `92f9669521b7416b25cae364df7e1f35600cae5f`、Kivo `ae27a4e97ddfa5248d4461bd563d9e907489b81c`，C26 `f03d3c80b3d4ab75c739f62dd1cbecc49a25a232bbdd2038836a39650c43c9a3`。current02 实际只读准入、当前 HTTP License、来源及两实例 fresh 门通过。final10 原主工具3154/chunk8df95f真实exit1，首步08:51:37.815Z→08:56:50.043Z，首错为既有300秒timer的 `operator timed out`；TTY握手、恢复通过，非前轮EOF。request保存mtime08:52:40.847716Z，operator journal08:52:48.133715Z，root结果原件08:59:43.695683Z。固定CLI35276/f768d4真实exit0、三项端点核验true、只有switch-endpoints applied/completed，但operator先保存completed，随后执行数据库、License、旧库及来源finally检查，最后才stdout。因此文件mtime不等于stdout可读、工具返回或stdin接收时刻，不能把延迟精确归因于某一环。first-failure SHA`0294cf55b5f0c2e006ce0a6d23a39567d982bd272391f72c9d427935d1c16583`、observations SHA`fa7ec455daba83f5d72f7e6a7fa40394f3f298292341a59bf92f2004487f056a`及请求、结果、journal、失败录像保持。

final10已有2route、2skill、2ready连接、3员工及A/B开放范围，业务works/knowledge/conversations/channel/rules等为空，facts/eventAcks空；12fetch/2connect包括认证和发现，无ZenMux或SDK spawn。observer baseline `e3bf975d85ce64bc497cbbccc3585aace3255ffdb93444356c62e1ea3b87fa57`、attempts0、无arm/claim/consumed。switch-endpoints只读核验，没有登录、dispatch或worker；不抹去已发生的读取和认证效果。synthetic Feishu ref已保存，不声称秘密被删除。两API原88075/d1386c、1491/7f55f2真实wait0，child null/SIGTERM，PID/PGgone，退出原件SHA`0b71bf3914f34c121d7d977dcf63f976e5860fc5b1b019bc0c7484794fccc4ab`；主/Host已退出，sourceafter39456/fea398真实exit0。当前数据库认证增量仍须实际核对，不能以无维修创建替代。

**A：先证明单请求转交，不改产品或accept源码。** 保持现有operatorChannel、300秒、绑定、一次性步骤、秘密检查及operator所有尾部复核。root仍人工观察每条实际请求、选择现有固定步骤；将这一条请求的固定CLI执行、同session等待真实终态、结果校验、立即stdin转交收在一次 `functions.exec` 的顺序await链内，再把结果返回模型。仅exit0、输出完整且唯一 `p7-operator-result`、runId/candidate/guard/step精确匹配时转发真实结果；不从journal拼receipt，不在结果就绪与转交之间插入模型往返、总结或另一次源检查。主已退出、CLI非零、缺失/多条/错绑定/截断时不发送成功应答、不重跑CLI，保留实际效果并收束。等待循环只持有已启动的这一CLI；全部Promise被await，外层yield后继续原cell，不建立第二条执行链。不得自动读取并决定下一业务动作，不建父wrapper、FIFO、后台driver、通用路由器或重试服务。固定单请求片段及参数随本轮执行材料保存、pin，PURE与actual使用同一局部逻辑，不复制第二套算法。

第三独审后，Sol在新外置 `p7-acceptance/j10-operator-orchestration01` 准备上述片段、最小PURE及执行材料，复用未改的 `j10-operator-transport01/diagnostic.mjs`（SHA`3807de7ba52ee2f9fe26c3291ccd3aaa008f745684b1b6634798fd8c39e1f288`）真实operatorChannel/readline、--run/--reply、原diagnostic runId及既有Node/environment/mapfile/exec/tty:true。旧诊断原件不覆盖。只启动一个真实无业务receiver，顺序覆盖直接完成的reply CLI、至少一次明确跨初始yield后同链wait终态的reply CLI、近128KiB合法JSONline完整收集/校验/转发；可用固定短延迟的无业务producer使yield可观察，不能以模拟session代替。接收端须记录各轮accepted，最终真实wait0、listener移除、终端恢复、PID/PGgone。长payload不打印给用户。记录请求观察、CLI启动/终态观察、stdin调用/接收时刻、长度和摘要，明确是观测时刻。非零、缺失、多条、错绑定、截断的拒绝分支以同片段PURE证明stdin调用0即可；只有真实工具形状或截断信号存在未覆盖缺口才补一个对应实际负例。不重造已有EOF/parser等未变测试，不启动Host、API、worker、模型、渠道、窗口或读取秘密。独立SOURCE/PURE审查后root执行实际诊断，独立核其工具时序及终态后才准入后续。这个检查不证明业务CLI自身耗时，也不替代正式入口transport-ready；若CLI实际超过300秒，保存分段证据后停止依赖，不先延长超时。

**B：新包直接C24，平铺解释C26效果。** 固定新包 `p7-kivo-runtime-run05-current03/`、输出 `/tmp/geneway-p7-kivo-runtime-05-current03`、候选 `candidate-final27.json`、API launchId `run05-current03`，主runId `geneway-p7-20261017-05-current03-j10-final11`、输入 `j10-inputs-run05-current03`、输出 `j10-final11`、`observer27.json`及排他observer control、secret-root `/tmp/geneway-p7-j10-secrets-11`。创建前核无占用，不自动选号。原业务runId、PG/Redis/端口、fixture、schema、License及completed setup保持直接C24为事实源；C25/C26只作平铺历史证据和代码来源，不调用其loader形成准备继承链。旧包、原件、Host state、operator journal/profile/observer均不覆盖或带入新旅程。已准入environment继续共用，其他运行文件独立。

保留原16类准备状态、四授权表、正式License/机器主体/credential/管理员、8旧库全表及进程保护；不新增物理库绕过未知效果。users/sessions初始期望推进到固定C26 `license-status.json`（SHA`0ee45173befe9171fdc307b26a1d6e3ee03b06d7bfadaf64105e0b486a4de92e`）protected after proof，精确核历史candidate/operation/beforeIdentity/摘要绑定；历史proof不冒充当前WeakSet。新登录继续逐实例initial→真实before-validator→受保护登录→持久化proof→后门；before-validator仍只在原限定入口显式使用，不扩大operator权限。

api_log以C26 proof的完整after集合逐ID/raw SHA保护，新增精确解释 `p7-c26-fresh-a/b`（fresh receipt SHA`81e78529470207c818f24ee3939fca323453e41c0ddc1a69069d49e1da23dcea`）和final10 connect/listTools正式producer、多POST trace组、路径/状态/身份/时间/metadata/writer。沿已证明的请求发生窗与API全部退出持久化上界，不用queriedAt或journal mtime冒充异步写入完成。audit_log与machine_client_assertion仍平铺解释C24、C25、C26全部已知producer，不能因api_log基线推进就丢旧组；C26 admission摘要/count只支持历史保护、不代替完整归属。断言按正式expiry删除语义，不强求旧摘要恒等、不补发token取证。旧登录单trace语义不改。核final10仅端点读取的request/result/operator journal、零attempt和实际退出；C26退出原件字段与C25不同，checker适配真实形状，不改历史文件迎合schema。发现额外、缺失、歧义、错身份/权限或未知业务写入即阻断，不以当前DB自取expected、不放宽白名单。新增PURE覆盖C26合法增量、保留旧组、历史proof绑定、额外/缺失组及现有登录保护；旧当前02已实际冻结，不原地修改。

**前驱及单次11。** window10原2280/chunk3dc807真实exit0，完成原件 `hive-window10-completion01/completion.json` SHA`7743632918d8f3cdc7e1ff06e387399b4cd578ec09178ddd9e623ac7f0aaa5e6`保留创建时pending字段；后续独审7f7b58 exit0已核61对476..536、122条1631..1752、完整DDATA、ACK/pending、唯一record/event及host2230381/inside118599退出。window-safe SHA`bdeed108ff0997cabdca9cd859e708ab7043ebd9ad15d550e76a093498b3a47b`、末sample SHA`750671b9524da8a4fd5d8539b19b0641c417f7644f7e4f0b7fc864e253eb8cfc`、host-request SHA`0746a9cc412854b501071b0fd54cc3ba429b01d2b233493d156ffe28491210ab`、122文件聚合`ffd154f90164feda29a386aef684be9f5e1b8048ce9a118bf6f39bac370bbb3f`。08:50:37.218→09:20:37.249Z=1800.031s。独审首个额外库存messages单调断言527f3e exit1保留，该条件不是批准不变量；库存变化原因未核，不新增retention探针或把它当序号丢失。

仅允许制作一个window11，固定537..597共61样本、30秒、容器内最大1860秒、122条、birth=false、1752→1874，同tenant/device。沿既有host执行上界及启动前实际进程/ACK核验，消费10真实wait及全部原件，不继承freshness。A通过后，新包与11 SOURCE/PURE独审→C27完整来源及实际只读承接→新API/current HTTP License→全部非fresh输入、主命令、每步固定转交片段就绪→单次11→两实例真实MCP最新样本门→立即全新完整十步J10。120秒freshness/5秒future保持。窗口内不改源/规划/延长，不自动追加12；每条长工具保存session/PID/startTicks/PG并持有到真实终态，失败不重放未知效果。没有产品源码变化不等于可沿用C26身份，当前计划/包/运行身份均纳新闭包。

成功完整J10、同候选当前业务配对恢复、G/J/AC适用矩阵、独立技术/媒体审查、中文MP4完整解码与1倍速离线播放、离线HTML“渠道为模拟验收”、飞书发送/GET回读及用户最终验收仍分别完成。失败片段不得拼成成功旅程，旧AC-22时序限制不补签。无新用户业务决定；若必须改变既定业务/写入/权限/第三仓/真实消息/部署范围，则停对应依赖并请求用户决定。

### 8.21 final11 子工作导航与全新隔离旅程（2026-10-17，实施前）

本节在 window11 原工具自然结束及完整独审后，由工程、产品两名 Astra 分别独立读证，再正式双向 exchange 形成 CONSENSUS。第三名未参与规划的过设审查通过并提交本计划后，才开始本节修复、浏览器回归、新资源准备或窗口。目标仅为排除完整 J10 的导航阻断并安全准备下一次完整运行；业务目标、批准写动作、权限及最终交付不变。

**已知事实。** G HEAD `8f9fba1c7cab639e81bb6081647f85207a2eff22`、K HEAD `ae27a4e97ddfa5248d4461bd563d9e907489b81c`。C27 SHA `02bd33dcad421fe790c68bf5c9e545251a3be49b49d46211d756fbb4b8f31811`，final11 原 main8138/chunk52946f真实exit1。前五步passed；第六步10:08:36.937Z→38.567Z报 `expected one visible control: 0`，栈为openWork621→preview675→967。第963–965行已经从根的真实按钮进入目标child，preview随后再次调用只从全部列表取卡片的openWork；web263统一排除collaboration-child。这不是移动端特有过滤；保存state中的child存在且owner=a/completed，截图支持停在全部列表，但没有完整DOM dump。first-failure SHA `77c0e5caf0a409ebfdb6c0b01ba5afe4efe2f5a7f9a850e3ad033320e2b2bafd`，observations SHA `f09633712c2fd3d970c1d81942b39b366ba530419cf7a0b2dc6f54a3faecfe64`。

两次单请求transfer真实CLI exit0后立即stdin，主旅程实际推进；本轮无需重写已审转交算法。source-human-update已将原synthetic维修单reported→dispatched并指定executor，worker evaluate/business-event/deliver三个作业processed、失败/死信0、exit0，Host202 ACK36ms并产生后续工作。六个work actions均0、observer未arm/attempt0，尚未进入维修preview/reject/approve；这不抵消此前真实派单效果。主/两个Host/三个SDK已退出，TTY恢复，两个API原A16394/d673ec及B44062/f587f3真实wait0，child null/SIGTERM且PID/PGgone；API退出原件SHA `dad69e777a0f4f15d9fd875ef3aadd54df298e493e49ee5f808eaceb2353cb97`。sourceafter18434/9a82e9真实0。旧业务状态不回滚，失败录像不冒充完整成功录像。

**A：同一导航helper的最小修复与真实前置回归。** 仅修accept-p7的导航及必要窄测试。通过当前actor正式可读工作DTO识别普通工作、协作根或child；普通/root仍点全部列表的精确卡片，child先经可见root卡进入根，再点与root/planItem/child对应的精确按钮。等待active详情及currentWork.id正确才返回。关联不符、root不可读、控件缺失/多匹配或目标错误即失败；不读全局状态绕过owner，不猜最近项、不模糊选择、不直接调用网页内部导航函数或改URL替代真实点击。产品child不入全部列表、root→child/返回root以及服务端权限保持。

逐一核openWork/preview和手动root→child调用：至少覆盖preview675及967/974两次调用、1008回执步骤直接开child、844/963/1021附近已有根子跳转、其他root及B普通工作、重启/恢复后入口；不只删除首次preview重开。必要时导出一个窄helper供同源测试使用，不建通用导航框架，不扩改P6无关普通工作路径。

开新业务资源前，在独立临时fixture上复用正式HTTP/server/auth/store/web、现有Chrome/CDP及受控协作树，执行同一修正helper。1440×900与390×844验证ordinary/root/child，child仍不在全部列表；根进child后再次进入覆盖preview调用形态，reload/其他详情后直接进入child覆盖回执调用形态，返回root及重新登录后目标正确。维修表单打开→取消→再开，actions/执行数不增加；不新增receipt fixture，不重复维修保存/拒绝/批准业务。peer/admin不能获得A的正文入口，root/child错误关联拒绝；无页面错误/横向溢出，模型/Kivo/Hive/worker/渠道外呼0，owned server/Chrome真实退出。用同一fixture确认旧selector匹配0与新helper成功，旧final11保留实际失败证据，无须再跑旧完整J10取红色。执行`node scripts/accept-p7.mjs --harness-check`及窄`node scripts/test-p7-work-navigation.mjs`，独立复核修复/全部调用与真实回归后提交。此回归仅证明导航，不替代完整业务链。

**B：新的直接fresh准备，保留旧资源。** 旧05已不满足reported/revision0初始语义；有限复用会额外引入旧事件、outbox、规则及绑定的混合消费例外，故采用run06独立A/B，producer runId `geneway-p7-20261017-06`。固定包`p7-kivo-runtime-run06`、输出`/tmp/geneway-p7-kivo-runtime-06`、候选`candidate-final28.json`、API launchId `run06`、mainRunId `geneway-p7-20261017-06-j10-final12`、inputs `j10-inputs-run06`、main output `j10-final12`、`observer28.json`及独立observer control、secretRoot `/tmp/geneway-p7-j10-secrets-12`。PG56081/56082、Redis57081/57082，网络10.253.78.0/29及10.253.78.8/29、gateway .1/.9；API34781/34782、sourceId kivo-p7-a/b、webhook34481及原Hive tenant/device保持。新容器/volume/network/角色/库/fixture身份均由run06明确绑定；审后按已有方式实查占用，冲突即停、不自动选号、不清理或接管。

复用已审Kivo runtime/镜像/迁移/schema/bootstrap、首次License、fixture/setup worker/operator及env实现，必要修改仅新身份、来源绑定和本节保护。run05模板仍有旧window08/C23/final08字段，新包须完整直接绑定C28/window12/final12的资源、producer、observer、operator、worker、catalog及secret refs，不能仅copy后换runId，也不调用current03 loader形成新继承层。旧代码及原件可作为固定来源，但新的准备是直接事实源。

新资源前先有界只读对齐旧05已知终态：源单及dispatch audit/trace、三个processed worker/outbox/delivery与事件、B三条setup仍pending且无worker、final11 actions/observer零create及owned进程终态。发现额外/缺失/未知业务或权限效果即阻断依赖，不靠新库抹去。对齐后将旧05 A/B加入既有run01–04八库保护，形成十旧库完整只读指纹；新基线只证明从当前观察起未受新运行改变，不倒推旧05历史全表未变。只扩已有明确列表/计数，不新建认证框架或继承解析器。保留旧PG/Redis、pending、会话、秘密引用与失败原件，不reset、删除、回滚、消费旧pending或续改旧环境。新认证沿已审正式License、机器主体/credential、四授权表及受保护登录流程；不得从当前DB任取expected绕过准入。新凭据按既有准备来源与server-only存储处理，不扫描旧项目秘密。

**C：一次性转交记录隔离。** 原transfer.js SHA `ae6007193ff06a75c765772195507f4f120465ce3f1eb656c3650efbf6c7c296`不改。仅本轮调用处把其固定逻辑key映射为mainRunId/candidate/guard/step完整绑定的物理key，核逻辑key属于当前step。CLI启动前拒绝已有的新物理key；同一次执行只更新自己的记录，旧`p7-operator-orchestration01:*`原件/键不覆盖。requested/failed/unknown/completed都不清除或再次启动，恢复时无法确认已启动状态按unknown处理。新磁盘request/result/launcher排他创建，store不替代journal。以同一调用片段PURE验证新旧run隔离、完整binding同step二次启动前拒绝、旧记录不变及失败不重启；复用原真实三轮转交和final11两个成功业务转交，不另建driver或重复无关实际诊断。仍人工逐请求决定、同cell固定CLI→同session终态→完整唯一绑定结果→立即stdin，300秒/所有尾部保护不变。

**前驱、唯一window12及执行顺序。** window11原37570/chunk3e7566真实exit0；completion `hive-window11-completion01/completion.json` SHA `f3894dbe9c77cd1bc70c77fd0b0e2495df8311f62b349272509553c424e4903a`保持创建时pending。随后独审3a17ff exit0/failures[]核61对537..597、122条1753..1874、完整DDATA/ACK/唯一值/state、1800.030s及host3325041/inside123700退出。window-safe SHA `cc7352563d80f1d50ec03f05fe410feeea8457a12bccb13e8c162eb3ec990107`、sample597 SHA `e01892ae57d002bf8fd8a173cfd6a13bd909a85e65b4ede87df60bf5a9a6b919`、host-request SHA `2a4caad52a2fc7eebb0daab3db710e1495aca9702e196a221900e263e7fd6df7`、122样本聚合 `152a8b27852d6a486dcdc5e15c3b50883ede5a15211761342be9ec8a7f174b27`。新窗口只一个，固定598..658/61×30秒/122条/1874→1996/birth=false，同tenant/device，inside最大1860秒及原host执行上界；启动前复核精确进程和ACK，不继承freshness、不新增库存单调/retention调查。

新fresh fixture在开始和publish前均要求样本≤120秒、future≤5秒，所以不能照搬current03的fixture全备好再开窗次序。严格依赖如下：A修复和真实回归独审→旧05对齐/十旧库保护定义→新包、window12、scoped调用片段SOURCE/PURE独审及完整C28来源冻结→实际占用/身份与旧库保护检查→新PG/Redis/schema/bootstrap/API/首次合法License→全部不依赖新样本的材料、精确命令和收尾手段就绪→单次window12→A/B各自在执行前选取最新实际样本，经正式mapping/validate/publish创建新fixture→正式setup核A精确消费三初始化evaluate且零webhook/occurrence/delivery、B三条pending且未跑worker及其他域保护→在已审结构中填实际fixture/sample/证据路径形成catalog/observer等最终输入→当前License、完整来源和双实例最新MCP门→立即从第一步执行完整J10。运行期只填已审数据结构，源码变更必须停止依赖、重新冻结及审查。所有长工具保存session/PID/startTicks/PG并持有至真实终态，原件600；失败不重放未知效果。窗口内不改源/重规划/延长，不自动追加13，时效不足保留失败并收束。

完整J10、同候选当前业务配对恢复、G/J/AC适用矩阵、独立技术/媒体审查、中文MP4完整解码与1倍速离线播放、离线HTML“渠道为模拟验收”、飞书发送/GET回读及用户最终验收仍分别完成。旧前五步不可拼接为新旅程成功；AC-22历史时序限制不补签。本方案没有新用户业务决定，不授权部署/发布/第三仓/真实成员消息；触及既定目标、写动作或授权变更时停依赖并请求用户决定。

### 8.22 final12 CLI 接缝与 run06 直接复用（2026-10-17，实施前）

本节在 window12 原工具自然结束并完成独立全样本审计后形成。工程、产品两名 Astra 分别独立读源码及原件，再正式双向 exchange，均回签 CONSENSUS、无未决设计分歧。第三名未参与本节规划的审查者通过本计划后，才实施新包、执行只读准入探针或启动资源。目标仍为完整 J10 及既定交付；本节不将复用假设写为 runtime PASS，不改变业务写动作、权限或用户最终验收权。

**事实与失败边界。** G HEAD `a85f01ab5d6e7488ac6ab3d15251faff935bb04f`、K HEAD `ae27a4e97ddfa5248d4461bd563d9e907489b81c`，C28 SHA `07e2bf498c6802124d5eb81d39e54f9fac17ec2bf0dc0799470e714cc55c5883`。final12 原 main95952/chunk2a5954 exit1，首步 fresh-configuration failed。固定 commands.md 的 operator 带 `--output`，而 operator.mjs:264 自建 parseArgs 未定义它；原 CLI244174 exit1，在 run() 之前抛 ERR_PARSE_ARGS_UNKNOWN_OPTION。scoped transfer 保留 CLI_NONZERO/transferred=false，未发送成功回执、未重放。main 保存了模型、员工、连接等 Web 配置，不能称完全无效果；works/conversations/channelMessages/automation/deliveries 为零，12 次保存 fetch 仅 loopback MCP/OAuth、模型请求0。无 operator journal，observer 仅 baseline 与0字节 attempts、无 arm。

原 run06 schema、A/B fixture、首次 License 和 setup 均完成；A 精确三条初始化 evaluate 已消费，B 三条 pending 且未跑 worker。两 API 原10612/bb0b48、95094/7b704b真实 exit0，child null/SIGTERM；main/operator/API/Host/Chrome/ffmpeg 已独立核 PID/PGgone。post-main-exit.json SHA `fe9c882d93cb0b0d23003df4b2ee6bf4f21f35e9aff3f50f69d898318216fa18`保存 SOURCE3f69a6与十旧库c8bc02真实 exit0。原件位于 p7-acceptance/j10-inputs-run06 与 j10-final12，均保留。没有当前06数据库完整终态准入，不能从参数解析失败推出全库未变。

**A：新入口的最小 CLI 修复及同源接缝。** 比较过删除文档多余参数与复用既有 argumentsFor 两案，二者都能用实际 parser 测试。选择仅在新 current01 的 operator 复用现有 argumentsFor，立即断言 output 等于固定 resources.output、拒绝无意义的 instance，再进入 context/数据库/网络。旧06/C28不改，故不破坏旧无output调用；不新增任意目标选择器、不关闭严格未知参数拒绝，不为形式统一修改其他无关入口。必要窄解析函数由实际CLI与现有selfcheck共用，不复制第二份参数名单。

用原文档完整 argv 复现旧 parser 对 --output 的拒绝，新文档实际 argv 经同一新入口解析通过；错误 output、instance、未知参数、缺失或错配 binding 必须拒绝。开窗前逐项核本轮实际使用的准入/SOURCE、A/B API、当前License GET、秘密准备、final inputs、fresh-monitor、main、operator、两类业务worker、window及收尾接口；shell作语法/固定引用检查，实际进程身份仍由actual证明。不能仅regex扫描文档或绕过parser直接调用run。

原 selfcheck:221–225只有switch成功、source未知失败及拒绝重放，故补一条现有内存adapter的七步完整成功链，经过validateRequest/createOperator、operation/order/expected、结果结构及既有channel接收契约；保留必要错序/错目标/错候选负例。workerChild实际生成argv交真实worker parser，receipt当前候选正例和历史候选拒绝负例同测。复用现有selfcheck/harness，不建通用CLI框架、runtime dry-run、自动driver或重试服务，不重复真实stdio诊断。原transfer字节、300秒及全部finally保护不改；仅新main/candidate/guard/step scope，首次CLI前拒任何已有状态，同调用才更新，原键/请求/launcher不覆盖。

**B：有条件复用06，直接准备来源与当前执行分离。** 优先复用原 schema、PG/Redis、端口、网络、角色、组织/设备/机器账号、fixture、endpoint/rules/Hive绑定、首次License及setup。不是自动run07；不得reset、删除、重跑schema/bootstrap、首次activation、fixture publish或再次消费setup来制造初始状态。当前读回若有未知业务、权限、outbox或无法归属效果，停止复用依赖，不以新库掩盖。

新固定执行包 `p7-kivo-runtime-run06-current01`，输出 `/tmp/geneway-p7-kivo-runtime-06-current01`，候选 `candidate-final29.json`，API launchId `run06-current01`，新输出下 `api-a-run06-current01.json` / `api-b-run06-current01.json`。producer仍为 `geneway-p7-20261017-06`；新main为 `geneway-p7-20261017-06-current01-j10-final13`，inputs `j10-inputs-run06-current01`、main output `j10-final13`、`observer29.json`。observer setupOutput保持原06目录，controlDirectory按现有accept合同为原目录下 `private/create-observer-geneway-p7-20261017-06-current01-j10-final13`，不覆盖旧control。路径有占用或身份不符即停，不自动选号/清理。

新包直接pin原06/C28的包、run/fixture/License/setup/failedmain/API退出原件与当前C29闭包；可移植既有窄baseState+current实现，不调用05-current03或其他current loader，不形成递归准备链，不伪造重新准备的run.json，不改旧candidateSha。原fixture、首次License、setup及已消费setup worker继续归C28；新API journal、observer和两个业务worker的journal/receipt/parent readback/release proof归C29，明确baseCandidate。run-worker/workerChild现取producer candidate，而accept-p7:943/1001要求当前binding，必须在新包同一责任边界修齐并测，不把缺口留到完整J10。全部实际代码/observer/命令及旧来源列入C29闭包，不能只换配置。

secretRoot固定 `/tmp/geneway-p7-j10-secrets-13`，按既有owner/mode/nofollow/排他及字节相等规则，仅复制已获准secret12中的五个明确ref：ZENMUX_API_KEY、MCP_PRIVATE_A/B、WEBHOOK_A/B，不输出值、不扫描、不复制旧合成渠道ref。新目录有实际必要：accept-p7:481–482会写入本轮合成飞书ref，复用secret12会追加修改失败材料。

**C：先证实复用，再实际启动。** 在新包SOURCE/PURE及独审后执行窄只读准入，保留原命令、原工具终态与600回执。核原run/C28/manifest、A/B fixture、首次License、setup gate与worker原件固定摘要，全部操作settled；不得用当前DB任取expected。用已有snapshot逐项要求A严格等于原gate.a.after、B严格等于原gate.b.before，覆盖源单reported/revision0、原配置/业务表、全部outbox和worker instance/execution；A仅原setup三evaluate及对应停止worker/三execution，B三pending/no worker，无派单/create/delivery或未知执行。

License、四授权表、机器主体/credential及认证session/API日志，按原License、fixture、current-status、fresh-monitor与main配置访问的已知生产者证据逐项归属；API已真实退出后核异步落盘，不能整表无条件豁免或把当前值改成期望。十旧库沿原actual02固定保护，不重取基线消化差异。未解释的额外、缺失、权限变化、未结操作或原件缺失均阻断依赖。此门当前尚未执行。

实际API启动和当前License GET valid在开窗前完成；不因候选编号变化重做activation。原到期A 19:50:15.580Z/B19:51:04.114Z只作历史，执行前核当前有效与执行余量。全部静态fixture/catalog/observer/五ref、每步固定命令、单请求转交与收尾手段提前备齐；启动API不代表CLI接缝或业务已通过。

**唯一window13及顺序。** window12原29658/a67814自然exit0，completion SHA `0a8baaad97069b1f8bff5fab13191fb0607217bbc726a2a79d9f4eb1de86d302`；独立f9ca54完整61对598..658/122消息/ACK/完整DDATA/唯一/1800.030s核验和f4a5f4 host827480/inside131491退出通过。window-safe `fb81f1b8d7989da1db65caf289dc5e4c0cbbe49df8ee7033d3a6d89b545e5ffa`、sample658 `6a95e264c7d3da0f74c4b69f5916f025535d3a65f5cbd4fa77d29900853e1db2`、host-request `e0cb56691a4b43af99045f6efc9ff9bf5a0200bd98e3c500890f2687d12c0eae`、122文件聚合 `e830acbc25aa1c8b7411de808f084f4668eee26b666b1f569023a6a31c451d40`。completion历史pending字段不改，以独立真实审计补充，不伪装在线重读NATS。

仅制作一个hive-window13，现有Hive run根下输出 `p7-j10-20261017-01-window13`，固定659..719共61×30秒、122条、1996→2118、birth=false、同tenant/device，inside最大1860秒/host1920秒。沿原启动前进程/容器/ACK检查，前驱原件和源pins不变，不能继承freshness。原fixture sample598/599只证明创建来源，不因它们过期重发绑定；当前fresh-monitor必须读取window13实际新样本，经双实例完整MCP关联证明≤120秒/future≤5秒。

严格顺序：本计划第三审→新current01/窗口/scoped片段SOURCE/PURE及文档CLI接缝独审→C29完整冻结→当前06只读复用准入和十旧库保护→新API/当前License/所有非fresh材料就绪→单window13→双实例最新MCP门→从第一步完整J10。所有长工具保存session/PID/startTicks/PG并持有到真实终态；窗口内不改源/重规划/延长，不自动追加14，失败/unknown不重放。完整J10、当前业务配对恢复、G/J/AC适用矩阵、独立技术/媒体总审、中文MP4解码及1倍速离线播放、HTML“渠道为模拟验收”、飞书发送/GET和用户最终验收仍分别完成。旧片段不拼通过，AC22历史时序限制不补签；新业务目标/写动作/权限或授权变化仍请求用户决定。

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
