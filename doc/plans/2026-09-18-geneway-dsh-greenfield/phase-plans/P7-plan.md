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
