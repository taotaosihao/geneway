# P4 多渠道与移动工作入口详细计划

> **合同 v4.3 注记（2026-10-15）**：**本计划按合同 v4.3 重规划中，暂停新的实施任务。**下文“唯一有效计划 / ready frontier 可实施”的状态被本注记取代，直到 planner team 在本文件内完成原位重规划。已实现且仍适用的投递状态、发送前复核、关联码、群聊保守规则与飞书运行时保留；命令式渠道路由与“员工+技能”默认派发须改为渠道会话与默认 Agent；企业微信不再是必达项，微信改为 Geneway 内置并复用 dsh-im iLink 实现（合同 §5.4）。合同中的 DSH 升级任务编号为 P4-U0，与本计划已执行的 P4-T0 飞书真实接口探针不同。阶段末真人验收与“真实两个渠道主链”要求已由合同 §5.4 渠道模拟验收取代（本地 iLink 模拟服务器、飞书 SDK 事件注入，须经过实际渠道通道代码）。

> **合同 v4.4 注记（2026-10-15）**：业务系统由 GearJob 改为 Kivo TPM。新增切片 P4-K0：在 Kivo 建机器账号与 OAuth 授权，并在 `mes-api` 内按 MCP 2026-07-28 规范建 MCP 端点与 TPM 只读工具（不改既有 `agent-mcp`），Geneway 新建 Kivo 业务插件替换 GearJob，并重新验证 J1、J4、J6 的业务部分及 Kivo 路径上的 AC-06/07/09/10/11/12 与 J2；P4-U0 只回归与业务来源无关的部分；与 P4-S1、P4-U0 可并行，须纳入本计划的原位重规划（合同 §5.6、§9）。

状态：**Team Astra 规划已收敛；通用 ready frontier 可实施；真实渠道分支仍有用户决策与外部账号门。P4 尚未完成。**

基线：`20c4ea879a7d12a6035a8b913c696a2bb54e8415`（P3 产品候选 `5bc9bafbdf12d0edd44247161c17d320d6003a33`）。

本计划是 P4 唯一有效计划。它不授权创建或使用真实渠道应用、向真实人员发送产品消息、暴露网络入口、部署或发布；这些动作分别核对下文权限门。

## 1. 阶段目标、覆盖与非目标

P4 交付 G6、J7、J11 的渠道与移动部分，以及 AC-16、AC-17：Web、真实飞书和用户明确选择的真实微信通道进入同一套成员、工作和消息关联；两个真实渠道分别完成文字交办、反馈、补充、在 Web 继续同一 `workId`，并从 Web 向该工作的已验证渠道回复。重复、回声、乱序、失败、恢复和权限变化不能重复执行或越权发送，手机可完成关键操作。

`W-Feishu` 与 `W-WeChat` 可以是两个独立工作；合同不要求自动合并两个渠道发起的工作，也不要求跨平台转发。每个工作必须在自己的渠道和 Web 间保持同一 `workId`。

首版渠道消息范围限定为：

- 接收和发送纯文本；渠道中必须出现可读的业务反馈，不能只给链接；
- 可发送经过认证的 Web 工作/结果链接，承载来源、复杂配置和详细结果；
- 图片、文件、语音、视频、卡片中的任意外链均明确拒绝，不抓取、不自动入知识库、不触发业务；提示用户到 Web 导入 P3 已支持的 `.txt/.md`；
- 渠道自由文字“补充/追问”只映射现有 `followUp`，不猜测 `continueWork` 的结构化字段；活动执行期间明确提示“已收到但本轮未应用，待本轮结束后重新提交”，不新增输入队列。

P4 不实现通用消息总线、分布式队列、通用审批引擎、跨渠道自动合并、任意附件平台、远端消息撤回保证、已读保证、个人微信逆向协议、自写 AgentLoop、生产部署或发布认证。P4 切片本身不实现 P5 主动任务或 P6 业务写入；P5 的后续顺序按 §10 的用户更新决定执行。

## 2. Team Astra 规划与裁决

### 2.1 独立规划者

- 工程/安全 planner：`/root/p4_astra_engineering_plan`，`gpt-6-astra` / high，只读；检查 P3 代码、v5 store、auth/cookie、work/knowledge/runtime、恢复、渠道可靠性与真实验收边界。
- 产品/渠道 planner：`/root/p4_astra_product_plan`，`gpt-6-astra` / high，只读；检查合同、WorkBuddy 界面、J7、移动路径、身份关联、群聊、投递状态和失败恢复。

两者先独立返回，再交换并收敛以下实质问题：是否跨渠道合并同一 work、群聊最小安全输出、文本/链接范围、飞书长连接的证据边界、v6 与外发授权模型、微信未决时的 ready frontier。最终均返回 `CONSENSUS`，无阻止 ready frontier 的工程分歧。

### 2.2 主代理裁决

1. 渠道是同一产品工作空间的入口，不是第二套工作系统；复用现有 work service、DSH Session、结果和知识权限。
2. 不要求飞书和微信自动合并成一件工作；分别验证完整闭环。
3. 群聊允许已关联成员明确 `@` 机器人发起，但群内只回复不含标题、工单、结果、知识或成员私有信息的固定提示；私有正文只发该成员已验证且当前允许接收的私聊。私聊不可用时留在 Web 待处理，绝不回退为整群发送。
4. 内部 `delivered` 只表示平台发送 API 已接受并返回真实消息标识；UI 写“已发送至会话”，没有更强回执时不写“对方已收到/已读”。
5. 首选飞书官方 Node SDK `WSClient + EventDispatcher` 长连接，但只作为 T0 候选。必须用真实产品 app 验证事件、ACK、关闭/重连、发送回执和 SDK 版本后才能锁定；若失败，由双 Astra 复核 webhook 分支，不能静默换方案。
6. v5 缺少身份、消息和投递事实，升 v6；不建独立通用许可表。发送依据直接记录在已验证渠道绑定或明确发送请求中，并在每次网络发送前调用同一授权检查。
7. 微信未选定时只做渠道中立底座、Web/UI、恢复和已具备条件的飞书分支；不造占位微信适配器，不把待办链接当微信完成。两个真实渠道闭环前不得宣称 G6、AC-16/17 或 P4 PASS。

### 2.3 独立过度设计审查与有界消融

独立审查者：`/root/p4_overdesign_review`，`gpt-5.6-sol` / high，只读；未参与 P4 Astra 规划或 Team Sol 实现。首轮误把用户明确要求的 MP4/Lark 交付当成可删项，主代理依据当前用户目标纠正后，审查者重新完成收敛消融。

| 争议复杂度 | 最小变体与证据 | 裁决 |
|---|---|---|
| 单一 v6 store 与六组渠道事实 | 合并 identity/conversation 或 message/delivery 会丢失群聊、解绑、入站防重、未知发送效果或一次性关联的独立生命周期；拆库/队列增加第二事实源 | 保留单 store 与六组有限事实 |
| `reserved` 与七态 delivery | 删除 `reserved` 会使 work 已提交但 message 未落终态的崩溃间隙无法收敛；合并 `blocked/failed/unknown` 会允许越权或未知效果盲重试 | 全部保留 |
| `authorizeDelivery` + `validateSendClaim` | 单次授权不能覆盖实际发送前发生的撤权；T1 测试已证明最终 claim 或同一服务内的即时失效转换共同阻断失效知识/app/identity | 保留；T3 验证真实 I/O 紧前调用 |
| 手工 `bindMessageWork` | T2 `handleInbound` 已拥有唯一 message→work 映射并覆盖崩溃恢复，旧入口无生产调用 | 删除 |
| `deliverLinkCode` callback | 只有测试实现；认证 Web 本就需要一次看到明文码，直接返回 code 而 state 只存 digest 更短 | 删除 callback，T5a 负责防日志/响应缓存 |
| conversation/message/delivery 重复 provider | 历史 channelApp 被闭图强制保留且不可原地换 identity，provider 可由 channelAppId 派生 | 删除重复字段 |
| `channelGraphSha256` | 完整 state entry 已有 bytes/SHA-256，restore 再运行 v6 全闭图 normalizer；局部图 hash 没有新增保证 | 删除 |
| 验收材料 | 用户明确要求 MP4 + Lark；合同需要必要验证报告。offline HTML、完整帧目录、封面、独立 attestation 和 formal schema v2 只是重复包装 | 保留 MP4 + 一份去敏 verification report + 两类独立审查 + Lark 三项发送/回读；删除其余正式产物 |

消融后复杂度结论：**PASS**。不得因此删除真实双渠道、手机 HTTPS、群聊权限、撤权、防重、恢复、视频或 Lark 交付。

### 2.4 飞书 T0 长连接碰撞复核

用户于 2026-09-20 授权 app `cli_aaae8b6cbdb89cc0` 用于飞书 T0，并明确本轮先跳过企业微信真实验证；微信义务因此保持 deferred，不从合同删除，也不允许 P4、G6、J7 或 AC-16 宣称完成。

受控 probe 先证明 `im.message.receive_v1` 长连接可进入 `ready`；本机明确停止后，开放平台仍持续返回 `online_instance_cnt=1`，而本机 event bus 为 `not_running` 且无相关进程。新的 consumer 被拒绝，不能取得完整入站、ACK、重投或唯一消费证据。

依 §2.2 第 5 项启动两名新的独立 Astra：

- 工程视角：`/root/p4_feishu_t0_collision_engineering`；核对官方 cluster/transport 语义、连接归属与替代分支。
- 产品/安全视角：`/root/p4_feishu_t0_collision_product`；核对产品身份、数据隔离、既有 Multica 影响与最小用户决定。

两者独立收敛为 **CONSENSUS**：不能让 Geneway 与未知远端实例并行复用该 app；同 app 多长连接是集群分发而非广播，会随机分流事件，破坏完整性、ACK、重投和跨系统防重证据。webhook 是 app 级 transport/订阅配置，不是与未知长连接安全共存的旁路，也不能解决产品身份和数据隔离。

最简安全裁决按顺序为：

1. 定位现有在线实例的 owner/host/service；如果它将永久退出且 app 明确移交 Geneway 独占，由 owner 优雅停止并确认不会自动拉起，等待连接数归零后重跑 T0；当前任务不得强停未知实例。
2. 若现有实例必须继续、owner 不明或不能可靠移交，使用独立 Geneway 飞书企业自建 app；这是推荐路径。
3. 不为复用 app 临时新增跨服务消息总线；除非既有 runtime 已有经过认证、持久化并保留全部官方稳定 ID 与 ACK 语义的转发能力。
4. 只有独立 app 的长连接本身失败、app owner 明确批准切换且 HTTPS challenge/验签边界就绪时，才再次复核 webhook。

用户把 secret 直接提供到会话后，后续不得复述或写入仓库/state/log/report；正式测试或迁移完成后应轮换，并只从仓库外 `credentialRef` 使用。

### 2.5 Hermes 成熟实现复核与自主验收裁决

用户明确不再承担逐项 canary 发送，要求团队自行完成剩余测试，只在阶段候选冻结后参与一次最终验收；并建议优先复用成熟飞书方案，例如本机 Hermes。

两名只读分析者分别检查 Geneway 接入面与本机 Hermes 0.16.0 实际运行源码，收敛为：**继续使用已锁定并真实验证的飞书官方 Node SDK；复用 Hermes 已验证的局部设计规则，不直接调用或整体复制 Hermes runtime/adapter。**

关键证据与裁决：

1. 官方 Node SDK 会 `await EventDispatcher.invoke()` 后再写 ACK；Geneway handler 可以先 `await channelService.handleInbound()`，把 durable inbox/去重置于 handler 返回之前。
2. Hermes Python adapter 把 coroutine 提交到另一个 loop 后立即返回，Python SDK 随即 ACK；其独立 JSON 去重又发生在业务持久化前，不满足本合同的 durable-before-handler-return 边界。
3. Hermes 没有稳定的外部 adapter HTTP/IPC API；直接复用会引入 Python gateway、session/agent、独立去重文件、第二套权限/配置与第二事实源。
4. Hermes 对发送异常最多自动重试三次且每次生成新 UUID，不能复用于 `unknown` 不盲重发的 Geneway delivery 状态机。
5. 借鉴且重新实现为极薄 Node glue 的规则只有：app-scoped `open_id` 身份、bot `open_id` 精确 self-echo/群 @ gate、per-app 实时 availability、停用后关闭并禁止重连、每 attempt 固定 UUID、成功 message ID 回读；群结果仍只发已验证私聊。
6. 本机 Hermes gateway 使用另一个 app，继续保持独立运行，不停止、不接入 Geneway，也不读取/复制其 secret 或含临时 WS ticket 的历史日志。

后续实现与确定性测试不再要求用户逐项发消息：使用去标识真实形状 fixture、官方 `EventDispatcher.invoke()`、真实 channel store 和 fake official client 验证 durable-before-resolve、重复/冲突、发送前撤权、成功/failed/unknown、配置轮换和关闭重连。已经取得的真实私聊入站/出站/SDK fast/slow/lifecycle 作为 T0 bootstrap 证据；真实 DM 与群 @mention 正反例只在 P4 最终候选阶段请用户一次验收，bot 消息不得冒充真人路径。

## 3. 当前事实、已验证依赖与未知

### 3.1 已观察事实

- `src/store/file-store.mjs` 的 v5 单 JSON store 是产品唯一事实源，串行 update + 原子 rename；P3 已支持 work、execution、result、knowledge、handoff、backup/restore。
- `src/work-service.mjs` 保持 owner-only 工作权限；P4 必须通过渠道身份可靠映射到产品 member，不得用昵称或请求体 memberId 当权威。
- `src/server.mjs` 当前是 loopback HTTP，Cookie 为 `HttpOnly; SameSite=Strict`，没有 `Secure`；桌面本地验收成立，但不构成真实手机/渠道内 Web 安全入口。
- P3 已用 ZenMux 的 `deepseek/deepseek-v4-pro` 完成 root/child/recheck 真实调用。ZenMux 官方模型目录当前列出该精确 model id；P4 不更换 provider/model，不从 `~/.claude/setting.json` 复制或输出 API key。
- P3 `lark-cli` 仅证明工程验收资料能够送达既有飞书会话；它不是 P4 产品 app、产品身份映射或产品消息适配器。
- T0 真实探针证明需要官方 SDK 后，仓库已精确锁定 `@larksuiteoapi/node-sdk@1.74.0`；不为 adapter factory、队列、webhook 或 Hermes runtime 引入额外依赖。
- 用户提供的飞书 app `cli_aaae8b6cbdb89cc0` 机器人已激活，名称为 `IoT Deploy - Multica`；本机 credential 仅进入 `lark-cli` 加密存储。历史碰撞曾表现为本机停止后仍有一个未知在线实例；用户随后授权清理 Multica 绑定，精确 installation 被正式 API 标记为 revoked，远端连接数约 20 秒后从 1 降为 0，唯一事件 owner 冲突已经解除。
- Geneway 已独占完成真实私聊入站、幂等出站/回读、关闭重连和官方 SDK fast/slow probe。fast 通过；slow 的 4 秒 handler 在 20 秒内未观察到重投，因此重投语义保持 `not-observed`，不能当作丢失补偿保证。

### 3.2 外部事实与待验证假设

- 飞书官方 Node SDK 的真实 `WSClient`/`EventDispatcher` 已证明 ready、真实入站、真实发送回执、幂等出站、关闭后连接归零及重新连接。SDK 实现会等待 async handler 完成后再写 ACK；但 4 秒 handler 在本次 20 秒窗口内没有观测到重投，不能把平台重投当可靠补偿。仍待产品 adapter 和阶段末一次真人验收证明 durable inbox、私聊/群完整路径、发送前撤权、失败/unknown 和实际业务回读。
- 飞书长连接只解决产品 app 的事件通道，不解决手机打开 Web。真实手机/飞书内 Web 仍需要用户可达、可信 HTTPS origin 与相应网络暴露授权。安全拓扑固定为：Geneway 继续只监听 loopback，由明确获准的 TLS 终止器反向代理；服务只配置一个 canonical HTTPS origin，HTTPS 模式的 session Cookie 强制 `Secure; HttpOnly; SameSite=Strict`。只信任来自明确代理来源的转发上下文，不接受客户端任意 `Forwarded`/`X-Forwarded-*` 决定 origin 或身份；明文外网监听、origin 不匹配或代理来源不可信均拒绝。具体域名、TLS 终止器和网络暴露仍由用户授权。
- 微信具体形态、正式接口、账号资质、回调要求和消息限制未知。个人微信、企业微信内部应用/客户联系、微信客服等不可互换。

### 3.3 必须由用户决定或提供的外部门

1. 微信真实入口形态，以及可用账号/API/负责人；用户已决定本轮企业微信真实验证 deferred，该义务不删除；
2. 飞书真实测试用户、测试私聊与测试群的最终验收范围；app 唯一事件 owner 与私聊测试对象已经具备，群聊正反例留到阶段末一次真人验收；
3. 所选微信的真实测试对象与允许收发范围；
4. 两渠道允许外发的数据范围；默认只允许当前 work 的获准结构化事实与保守提示，不允许任意知识正文或模型 explanation；
5. 若要求群内直接显示业务详情，必须另行明确群接收范围和数据共享规则；默认保持 owner-only；
6. 真实手机所需 HTTPS origin 的网络暴露或部署动作。

以上缺口只阻塞依赖它的分支；不依赖的 ready frontier 继续实施。

## 4. 产品对象、v6 数据与唯一职责

### 4.1 最小新增事实

v6 在现有 state 增加五组有限事实；字段名可按实现局部调整，但职责不能拆成第二事实源：

- `channelApps[]`：provider、稳定 app/tenant identity、`credentialRef`、enabled、允许的事件/发送范围、revision 和状态；只保存引用，不保存 secret。由管理员配置/启停，是 T0、adapter lifecycle、发送前授权和恢复的唯一装配事实。
- `channelIdentities[]`：channelAppId、provider、外部稳定用户 ID、memberId、验证方式/依据、状态、revision、时间；不保存昵称作为身份依据。身份域是 `channelAppId + 官方用户 ID`，不同 app/tenant 永不合并。
- `channelConversations[]`：channelAppId、provider、稳定 conversation ID、类型（private/group）、绑定 memberId、允许接收范围、验证依据、状态、revision，以及本人在 Web 明确选择的单一默认派发绑定 `employeeId + skillId + capabilityId + optional connectionId`；群成员 ID 本身不自动建立私聊投递关系。
- `channelMessages[]`：channelAppId、provider、稳定 message/event ID、conversation、sender identity、方向、受支持文本、收到/持久化时间、workId、处理状态和错误；这是 inbox 与去重事实，不复制业务结果。
- `deliveries[]`：channelAppId、workId、result/message refs、provider、target conversation/identity、内容范围、授权依据 revision、状态、attempts、平台 message ID、错误与时间。

`pending → sending → delivered|failed|unknown|blocked|cancelled` 是投递状态，不是业务 work 状态。发送失败、取消或重试只改变 delivery，不重跑 work、不刷新 GearJob、不重新执行协作。

超时且不能排除平台已接受时进入 `unknown`，不自动改 `failed`、不盲目重发；仅由平台回查/幂等证据或明确人工处理恢复。恢复时遗留 `sending` 转为 `unknown`，历史 `delivered` 不重发，未处理入站不在恢复过程中暗中启动业务。

### 4.2 服务与适配器职责

- `src/channel-service.mjs`：唯一维护 app 引用、身份关联、持久 inbox、message/work 映射、默认派发绑定、delivery 状态、去重和 `authorizeDelivery`；调用现有 work service，不执行模型循环。
- `src/channel-runtime.mjs`（仅当真实 lifecycle 需要）：装配启停、重连和 adapter 回调；如果 server 内几行即可完成则不建此文件。
- `plugins/feishu.mjs`：只做官方平台事件/发送传输和必要格式转换，不拥有 work、身份授权或 retry policy。
- `plugins/<selected-wechat>.mjs`：仅在用户选定形态及真实接口后建立一个实现，不预建多个占位插件。
- `src/server.mjs` / `web/index.html`：提供本人 Web 关联、投递状态与显式重试/取消；Host/plugin 安装仍不是普通成员能力。

渠道 app 凭据内容只位于仓库外既有 `GENEWAY_SECRET_ROOT`，`credentialRef` 继续使用现有安全文件解析边界；state、backup、API 和 UI 均不得包含 secret。管理员才可创建、修改、测试或启停 `channelApps`；普通成员只能在 enabled app 下关联本人身份、选择自己当前获准的员工/Skill/连接作为默认派发绑定。app revision 或启用状态变化立即参与入站和发送前授权，adapter 不读取另一份竞争配置。

不建通用 adapter interface/factory。两个插件若出现真实重复，再提取最小共用函数。

### 4.3 受理、去重与发送顺序

入站顺序：验证平台签名/连接来源 → 解析稳定 provider IDs → 在一个 store update 内持久化或命中现有 `channelMessages` → 关联当前有效身份/会话 → 创建 work 或 follow-up reservation → 返回平台回调。若 SDK 在持久化前已经自动 ACK，T0 必须如实记录并重规划可靠受理，不得声称“先持久化再 ACK”。

去重、身份、会话、平台 message ID 和投递查找键统一使用 `channelAppId + 官方稳定 ID`；不按 provider 单独建域，也不按文本、时间或“最新消息”去重。app 更换或停用不会让新 app 接管旧 app 的身份/消息；恢复保留原 channelAppId 域，只有原 app revision 当前有效时才允许新收发。回声、乱序或平台重投命中同一消息事实，不再创建 work/execution。工作 reservation 与 message/work 映射共同区分“已收件未受理”和“已受理未回执”。

首版不做自然语言意图路由。只有以下确定性文字格式进入 work service，其余文字回复简短帮助且不创建/继续/停止工作：

- 新建：`交办 工单 <workOrderId>`。使用该私聊在 Web 已确认的默认派发绑定，构造现有 `createWork` 的 `employeeId/skillId/capabilityId/connectionId/workOrderId`；首版默认绑定必须是 `gearjob-work-order-read`，否则入口不可用。
- 补充/追问：直接回复 Geneway 针对某工作发出的消息并写 `补充 <text>`，或发送 `补充 <workRef> <text>`。reply-to message ID / workRef 必须精确映射到当前成员拥有的一个 work。仅当没有活动 execution 且已有至少一个业务结果时，原样将 `<text>` 调用现有 `followUp`；这会在同一 work 创建 `follow-up` execution/result，不刷新 GearJob、不改结构化 input。活动 execution 时只回复“本轮未应用，请结束后重交”，不调用 service；`waiting_input` 且无业务结果时引导 Web 使用结构化补充；completed 或 failed/interrupted/cancelled 但已有业务结果时可按现有 `followUp` 当前授权执行。无映射、多个候选或其他状态均拒绝，绝不使用“最近工作”。首版渠道不把自由文字映射成 `continueWork`，也不提供通用参数 DSL。
- 停止：在上述精确 reply/workRef 上发送 `停止` 或 `停止 <workRef>`，复用现有 work-service cancel；只停止本人该工作，不取消 delivery、不影响其他 work。
- `状态 <workRef>` 只读取本人投影，不触发执行。附件、URL 和其他命令不执行。

provider event/message ID 经长度有界的 SHA-256 映射为现有 `clientRequestId = channel:<channelAppId>:<digest>`；同一入站在 create/follow-up/cancel 中稳定一致。每次真正调用 work service 前重新验证 member enabled、channel app/binding revision、employee、Skill、capability、connection 和 allowed object；Web 曾选择或消息已持久化都不替代当前授权。渠道不得直接调用 runner 或自行组装 execution。

每次首次发送、显式重试及恢复后处理，均在实际网络 I/O 前重新检查：当前 member、渠道身份、应用/会话绑定、work owner、目标接收范围、结果和知识依赖有效性、该内容的外发依据 revision。生成时允许、当前 owner 可见、历史曾发送都不等于本次允许。失权转 `blocked` 并给出原因/恢复动作，不发送。

### 4.4 身份关联

成员在已登录 Web 生成一次性关联码；本人从待关联渠道的私聊发送该码；Web 显示 provider、已验证外部稳定 ID 的脱敏值、会话与过期时间，并要求最终确认。码使用 Node `crypto.randomBytes(32)` 的 256-bit 随机值，base64url 展示，TTL 10 分钟；每成员 × channelApp 至多一个活动码，新码原子作废旧码，最多 5 次失败尝试。state 只保存 SHA-256 摘要、成员/app、到期时间和失败计数；私聊匹配、Web 确认或到期均在同一 store update 内原子消费/失效。错误统一为“关联码无效或已过期”，不得暴露可枚举差异。码本身不授予工作或知识权限，不进入日志/视频/备份明文；猜测、重放、错 provider、群聊提交和过期均拒绝。

解绑增加 revision 并立即阻止新入站映射和未发送 delivery；历史事实留作审计，不自动删除远端消息。重新关联不接管旧身份的历史工作。

## 5. 群聊、附件、权限和恢复

- 群聊只接受当前已关联成员的明确 `@`；陌生人、其他成员、旧回复引用和猜测 work ID 均不能读取、继续、停止或获得 owner 私有结果。
- 群内固定响应不含工作标题、工单、结果、知识、连接和成员私有信息。群输入不授权后续派生内容共享给群。
- 私聊目标必须由本人明确关联且当前在允许发送范围内；没有私聊绑定时只在 Web 标为待处理。
- 发送结构化业务事实复用现有 result/source refs；只有确需发送 explanation 或知识派生文本时才验证完整 knowledge dependency 与外发范围。
- 渠道插件停用或未安装时 Web、权限维护、解绑、delivery 历史和现有 work 继续可用；该 provider 的新收发明确不可用。
- backup/restore 保存 v6 映射和状态但不保存 app secret、token、一次性码或 session secret；恢复默认不开启外部收发、不重放、不重发，待管理员重新提供凭据并明确启用。

## 6. 正式 Product Design 门与界面行为

实施用户可见界面前，在 `workflow/artifacts/20260919-006-geneway-dsh-greenfield/product-design-p4/` 形成 A/C/D/E。两 Astra 共识可批准已委托的中间产品决策；上文六项外部账号/共享/网络决定不能由设计文档越权代选。

关键场景至少包含：

1. Web 生成关联码 → 渠道私聊验证 → Web 确认；失效/错人/解绑可见；
2. 飞书与选定微信各自创建工作、接收业务反馈、补充、在 Web 继续同一 work，再从 Web 回复原绑定渠道；
3. 业务完成但投递 `failed/unknown/blocked` 时，工作结果与消息状态并列展示，显式处理不重跑业务；
4. 生成后撤销知识共享或解绑接收者，再重试时被当前授权门阻止；
5. 群聊保守提示与本人私聊投递，私聊不可用时安全降级到 Web；
6. 390×844 以及真实手机/渠道内浏览器，从认证深链打开工作、补充、查看来源、回复、停止当前本人工作与处理失败；停止复用既有 work cancel，而非取消 delivery。P4 没有需要批准的业务写动作，“必要批准”本阶段不适用，留到 P6。

UI 延续 WorkBuddy 层级，不另建“渠道运维平台”。工作详情在“需要关注”附近显示渠道来源、发送目标脱敏值、业务状态与投递状态；`unknown` 明示“发送结果待核对，请勿重复发送”；`blocked` 显示当前原因和恢复动作；成功只写“已发送至［会话］”。管理员配置 app/凭据引用与普通成员身份关联分离。

## 7. Team Sol 实施切片、依赖和门禁

| 切片 | 输出与唯一写入边界 | 进入条件 | 必过门禁 |
|---|---|---|---|
| P4-T0 真实接口探针 | 飞书官方 SDK 有界 probe；选定微信后建立对应 probe；probe owner | 对应真实 app/账号/权限已授权 | 稳定 IDs、ACK、重投、发送 message ID、关闭/重连、群/私聊能力；失败只停该 adapter 并回 Astra |
| P4-T1 v6 与 channel service | store migration、`channel-service.mjs`、纯状态测试；store/security owner | 计划与 v6 语义已批准 | v5→v6、未来版拒绝、app 唯一装配、所有外部 ID 以 channelAppId 分域、app 更换/停用/恢复隔离、256-bit/10 分钟/5 次/摘要关联码、去重、delivery 状态、发送前复权 |
| P4-T2 工作接入 | channel service 调用现有 work service；integration owner | T1 | 明确命令语法、默认派发当前授权、provider ID→clientRequestId、创建/`followUp` 补充/状态/停止、active/waiting/completed/failed 分支、歧义拒绝、重复不执行；投递重试不重跑业务 |
| P4-T3 飞书 adapter | `plugins/feishu.mjs` 与最小 lifecycle；单一 adapter owner | 飞书 T0 通过 | 真实私聊、群聊保守路径、回声/乱序/重投、明确停用 |
| P4-T4 微信 adapter | 仅一个选定插件；单一 adapter owner | 用户选择与微信 T0 通过 | 真实私聊/适用会话、完整 J7；不以模拟代替 |
| P4-T5a 本地 HTTP/UI/移动 | server、`web/index.html`；单一 API/UI owner | A/C/D/E 可执行，T1/T2 | app 管理与本人关联/默认派发、状态、显式重试/取消 delivery、停止 work、服务端权限、桌面/390px；保持 loopback |
| P4-T5b 真实手机 HTTPS | canonical origin、Secure Cookie、可信 TLS proxy boundary 与渠道内浏览器；同一 API/UI owner | 用户批准域名/TLS/网络暴露 | 应用仍 loopback；只信任明确代理来源；明文外网/伪造 forwarded header/origin mismatch 拒绝；真实手机完成全路径 |
| P4-T6 恢复与组合门 | state-transfer、P4 tests/package scripts；integration owner | T1–T5 已集成 | secrets 不入备份、恢复不收发/不重放、插件缺失 Web 可用、P1–P3 回归 |
| P4-T7 实际验收与交付 | `scripts/accept-p4.mjs`、同候选 MP4 与一份去敏 verification report；acceptance owner | 全旅程通过并冻结候选 | 两真实渠道、Web/手机、权限变化、重复/失败/恢复全部同一候选；独立正确性和复杂度审查零阻断；Lark 说明/视频/report 回读后才可关闭 |

T1、设计发现和不依赖外部账号的受控测试可以并行；store schema、work integration、`web/index.html` 各保持单一 writer。未经 T0 不锁定具体 SDK 行为；微信未决时 T4 为空缺而不是假实现。

## 8. 验收数据、J7/AC-16/17 旅程

### 8.1 测试对象

- 真实 GearJob 测试源继续使用明确标记 `external-test / synthetic` 的对象，优先复用并在验收时回读 `WO-26-00096`；若状态不适用，通过正常 GearJob/Frappe 数据层创建新的非生产模拟工单并记录来源，不硬编码旧数量。
- 人类账号至少 admin、owner member、peer member；产品渠道身份分别绑定 owner，另准备未关联用户与无权群成员。
- 两渠道各使用唯一 message canary、重复 event ID 和乱序序列；知识使用当前有效与发送前已撤销的不同 canary。
- 所有真实消息只发到用户明确批准的测试私聊/群；不扫描旧项目或联系人寻找目标。

### 8.2 完整旅程

1. admin 通过凭据引用启用真实飞书；owner 在 Web 生成一次性码并从真实飞书私聊完成关联。错码、群聊码、重放和 peer 冒用均拒绝。
2. owner 在 Web 为该私聊选择当前获准的 GearJob 员工/Skill/连接，再从飞书发送 `交办 工单 <id>`；系统持久入站并只创建一次 `W-Feishu`，provider message ID 映射为稳定 clientRequestId；真实读取 GearJob，渠道收到可读业务反馈与认证 Web 链接。缺少/失效默认绑定、歧义和其他文本不创建 work；相同 event 重投、回声和乱序不新增 work/execution。
3. owner 在飞书回复该工作的机器人消息发送 `补充 请解释完成量来源`；若当前 execution 活动，明确告知本轮未应用且不创建 execution；结束后原样重交，系统调用现有 `followUp`，在同一 work 创建 follow-up execution/result，不刷新 GearJob。另测 waiting_input 无业务结果时引导 Web、completed 与 failed/interrupted/cancelled 且有业务结果时按当前授权执行、歧义 workRef 拒绝。Web 打开同一 `workId`，补充/查看来源后回复飞书，平台返回真实 message ID。
4. 对用户选定微信形态重复关联、交办、反馈、补充、Web 继续与 Web 回信，形成独立 `W-WeChat`；不复用飞书身份推导微信身份。
5. 在两个渠道分别验证不支持附件的明确反馈，不抓取 URL、不执行、不入知识。
6. 群中 owner 明确 `@` 发起，群内只见固定无敏感提示，私有正文发已验证 owner 私聊；陌生人、peer、旧引用和猜 work ID 均得不到私有内容。移除私聊绑定后不回退群发，Web 显示待处理。
7. 结果生成后但发送前，撤销相关知识共享或解绑/失权接收者；首次发送/重试转 `blocked` 且零平台发送。恢复权限后显式重试只发 delivery，不重跑业务。
8. 制造一次明确 `failed` 与一次效果不明 `unknown`；failed 可显式重试，unknown 不盲重发。业务结果保持完成，UI 不把消息失败写成业务失败。
9. 正常重启与 backup/restore 到隔离根：work/message/delivery/identity revision 回读一致，`sending→unknown`，无入站自动处理、无历史重发；未配置渠道 secrets 时 Web 与维护能力仍可用。
10. 真实手机及渠道内浏览器从认证 HTTPS 深链打开指定工作，完成补充、来源查看、回复、停止当前本人工作并回读停止范围/最终状态与失败处理；验证停止不影响独立工作且不同于取消 delivery。390×844 回归无横向溢出、焦点和错误提示可用。本阶段没有业务写动作，必要批准不适用。

### 8.3 确定性与真实证据矩阵

- AC-16：飞书与明确选定微信的真实稳定 IDs、真实收发 message IDs、各自 workId、精确 `followUp` 补充、Web readback 和后续回信；mock 只用于异常补充，不替代主链。
- AC-17：同 provider event 去重、乱序、回声、群聊正反例、发送前撤权、failed/unknown、恢复无重放、可信 HTTPS 和真实手机停止工作。
- J11：两个产品成员的渠道身份/工作/知识服务端正反例；管理员配置 app 与普通成员关联/默认派发权限分离；真实手机完成补充、来源、回复和停止。
- 回归：P1 真实读取与来源、P2 waiting/continue/cancel/confirmation/多连接、P3 collaboration/knowledge/revoke/backup 均通过。

拟建命令不是当前证据：

```text
pnpm test:p4
pnpm probe:p4-feishu
pnpm probe:p4-wechat
pnpm accept:p4
```

保留回归：

```text
pnpm test:unit
pnpm test:service
pnpm test:controlled
pnpm test:p2
pnpm test:p3
GENEWAY_P1_PROBE_MODEL=true pnpm probe:p1-runtime
git diff --check
```

## 9. 视频、验证报告与 Lark 工程交付

P4 有可验收界面，必须在功能、真实渠道、回归和 Design Review 全通过后冻结一个产品候选，再用同一候选录制正常速度 MP4。视频至少展示：两个真实渠道关联与各自 J7、Web 同 work、群聊边界、重复不重跑、发送前撤权、failed/unknown、390px 与真实手机补充/来源/回复/停止、恢复无重发。不得用静态动画、mock 消息或剪掉失败替代真实主链。

一份去敏 verification report 保存 candidate、MP4 SHA-256、真实 provider/app 脱敏标识、外部 message/event ID 脱敏值、work/execution/result/delivery refs、权限正反例、回归、浏览器、恢复、秘密扫描、独立正确性审查和独立过度设计审查结论。材料不得包含 app secret、access token、Cookie、关联码、grant 或 Session secret。

独立正确性 reviewer 完整查看视频、report、hash 和秘密扫描；独立过度设计 reviewer 确认最终候选没有重新引入已否定复杂度。随后使用新的 P4 幂等 key 通过 `lark-cli` 发送说明、视频和 verification report，并回读类型、消息 ID 与 `deleted=false`。视频制作临时帧可在确认 MP4 后删除，不作为正式交付物。该发送仍是工程验收材料交付，不等于 P4 产品飞书渠道本身。

## 10. 风险、恢复、停止和完成判定

- SDK 无法证明持久化/ACK/重投边界：停止该 adapter，保留 inbox 设计，由双 Astra 复核 webhook 或官方替代；不削弱可靠性声明。
- 微信选型或账号不可得：继续 ready frontier，但 T4、微信 J7、AC-16/17、G6 和 P4 PASS 保持未完成。用户于 2026-09-20 后续明确批准 P5 并允许在这些 P4 缺口 deferred 时先实施 P5；该决定只取代“不提前进入 P5 实施”的顺序限制，不改写 P4 完成条件。
- 手机 HTTPS 入口无授权：只实施保持 loopback 的 T5a；不得直接对外监听或信任任意 forwarded header，本地 390px 只能作为支持证据，T5b 与真实手机门保持未过。
- 外部发送效果未知：保留 `unknown`，不盲发；需要真实平台回查或人工决定。
- 身份/群/外发范围发生产品语义变化，或需要通用队列/新存储/跨进程 worker：暂停受影响工作，由两名 Astra 原位复核本计划。
- 任何 credential、关联码或私有正文进入日志、视频、备份或错误响应：停止验收，修复并重新冻结候选。

P4 只有在两个真实渠道主链、Web/真实手机、权限/群聊/重复/失败/恢复、P1–P3 回归、Design Review、MP4/verification report、独立正确性与过度设计审查和 Lark 回读全部通过后，才能标记 PASS。局部代码完成、一个渠道可用、受控 webhook、HTTP 200 或材料发送成功均不构成阶段完成。
