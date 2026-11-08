# 多地点协作实施状态（2026-11-05，首批文本链与附件接缝）

本批依据附件 v4.2 与控制器采纳的首批合同实施。基线为 Geneway `0698659a62cef36b0cdc940242516a4133ba5496`。本批是单机隔离、允许模拟的产品增量，不是多机交付、真实识图验收或发布认证。用户已有 `doc/plans/geneway-implementation-plan-2026-10-28.md` 未修改。

## 已实现的行为

- 登录成员经真实 `POST /api/works` 提交 `workType=multisite`、`employeeId`、`goal`、可选 `targets`（员工 ID 数组）及稳定 `clientRequestId`。workspace 和 issuer 由服务端实例及已认证成员决定，正文不接受自报身份。
- 以 `(workspaceId, authenticatedIssuerId, commandId)` 去重。规范化摘要涵盖操作、目标和业务参数；相同内容返回原受理，异内容返回 `IDEMPOTENCY_CONFLICT`。重放仍复核当前可读权限。
- 同一 FileStore 草稿同步转换并提交 Work、Delegation、Attempt、Input、命令记录与 outbox。提交失败不成功 ACK、不 kick、不启动 Session。rename 后目录同步失败仍阻断后续存储操作。
- v12 显式迁移至 v13，新增 `multisite` 事务域，保留旧业务记录；新域校验关联、版本、摘要及不可改写事实。旧 runner 的 recover/close 不把 multisite Work 误标为中断；旧执行路径继续使用其原授权。
- `employeeConfig.placement` 保存 `nodeId`、`mode=agent_host` 和 `resourceRefs`，沿用员工 revision 和成员 `employeeIds` 授权。协调员工与目标员工的当前授权都在派发及生产原生请求边界复核。撤权项保留阻断原因，其他工作、取消和回执继续校准。
- 产品 `start()` 为 `nodeId=local` 接好本地 Host 和周期扫描。创建仅持久受理；后台扫描已提交 outbox。没有匹配 Host 的节点保持待派发，不冒充已执行。当前尚无跨机器网络 Bridge。
- Host 在返回 accepted 前持久 inbox 的完整命令、摘要与绑定。消息 ID 按 Input、Attempt、Session 稳定生成；历史和 inbox 同时去重。实际 user/message 正证先取快照，再完成 flush，才能产生 ingested 回执。
- 报告与普通派发共用 Host 同步合并：在一次 journal 提交中单调推进 delivery、delivered/ingested outbox 与报告。报告路径不启动 Loop、不补投输入、不等待自身 idle；旧派发结果不会回退已消费状态，停止先提交则拒绝迟到报告。
- 未确认事件保留固定 event_id 与 sealed 内容，只有 node、event_id、digest 和完整绑定一致的 ACK 才清除对应待确认标记。没有用最大序号或 Last-Event-ID 确认业务交付。
- 活动执行独立于旧输入校准相同 Session；加载 Session 不等于恢复活动推理。全输入已消费但没有对应版本的 settled report 时，明确记录 unknown/interrupted 和 `RECOVERY_EXECUTION_UNCONFIRMED`，不重投旧内容；缺失已消费执行的历史也不创建替代会话。人工取消先持久 stopping，优先执行；未启动由 Host 给出 `never_started`，已启动须 cancel 后实际 idle 与 flush，才持久 cancelled。普通补充不能自行恢复人工停止的工作。
- Work 持久保存总计 12 次模型请求预留，跨全部 Attempt 共享；每次真实 DSH request 在同一 FileStore 事务中复核绑定、根/目标授权、停止状态与模型路由后原子预留，再调用 provider resolver。并发争额不超限；失败/取消不退款，补充/恢复不重置。第 13 次只落盘 `BUDGET_EXHAUSTED` 并拒绝 provider 请求；报告与停止不扣额，迟到报告不能清掉耗尽原因。预留不是账单 usage。
- Host journal 与云端一样在新实例读取前确认已有文件和父目录的同步；失败实例和确认失败的新实例均不成功派发或回报。
- 现有备份工具仍支持旧 v12 恢复及空 multisite 域的旧业务备份；包含多地点协作事实时明确拒绝 backup/restore，避免丢失 Host 日志与 Session 后输出不完整成功。尚未实现跨 Host 完整备份。
- `POST /api/works/:id/multisite/inputs` 支持补充；`POST /api/works/:id/multisite/cancel` 支持停止。DSH 当前只安装 `geneway_multisite_report`，不开放 shell、GitHub、push、飞书或配置写工具，不设置 `danger-full-access`。ready 是报告候选，不将其变成业务成果完成。

## 上游来源与受控移植

完整固定源码位于 `third_party/dsh-superagent-prototype/`，来自 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)，固定 SHA `6337fc823ce20251c8de8085948165c81aaa701e`。通过 Git 精确 fetch 并 archive 导入；保留原 LICENSE、全部源码、65 个原测试文件、锁文件、构建和部署资料。该目录不修改、不直接作为生产运行包安装。

| 上游源文件 / 采用部分 | 生产落点 | 本批必要差异与实际覆盖 |
|---|---|---|
| `src/core/ids.ts`，JSON 编码参数后 SHA-256 稳定 key | `packages/agent-contracts/index.mjs` | 保留生成算法；增加 workspace、认证 issuer、Input、Attempt、Session 命名空间。重投、摘要冲突和跨目标隔离回归覆盖。 |
| `src/core/intake.ts::receive`，时间归一化、稳定 Input 去重、按接收对象 Map 去重的 fan-out | `packages/agent-orchestration/intake.mjs::receiveInput` | 只移植明确归属 Work 的输入切片；将 Thread/Ticket 订阅映射到已授权 Attempt，去掉未使用的 SourceScope/Eval/自动接单，不伪装 human，不创建平行 Ticket 状态。真实 HTTP 创建、补充和双目标消费进入此函数。 |
| `src/core/assignments.ts::started/delivered/read/report`，区分启动、送达和消费、结构化追问 | `packages/agent-orchestration/assignments.mjs::assignmentEvent` | 将 Ticket assignment 映射到 Delegation/Attempt；加完整 epoch/launch/session 和当前 revision 校验。输入消费按接收者保存；迟到执行只留历史；ready 不直接完成 Work。原 `interrupted` 自动重启算法未采用。 |
| `src/app/delivery.ts::AgentDelivery.history/holds/send`，历史分页、WeakMap 实时 user/message、inbox 去重、失败后重试及 flush | `packages/agent-host/delivery.mjs::AgentDelivery` | 核心历史＋inbox 算法直接移植并适配当前 DSH；消息 source 改为 Geneway，稳定 ID 绑定 Input/Attempt/Session，正证在最后 flush 前取快照；不把上游 flush 前 accepted callback 作为 durable ACK。历史不可读、flush 失败、重启重投和并发工具报告均覆盖。 |
| `src/app/sessions.ts` / `src/executor/dsh.ts` 的 Session 和消息消费接缝 | `packages/agent-host/dsh-runtime.mjs` | 采用当前 DSH 官方 `ctx.agents` 和 sessionPersistence API；不复制上游权限 preset、coding 环境、GitHub/飞书依赖或旧取消即结束领域状态的行为。新 Host 自有 transport journal 不持有云端 Work 权威。 |

上游完整 SQLite Store、Engine、Tickets、运行时和可覆盖 payload 的 Effects 未直接接入生产。Geneway 的不可变命令/outbox 在唯一 FileStore 事务域中实现；本批不声称已完成完整 Eval、Thread 订阅、后台槽位或原 Effects 队列移植。上游原测试已保留，尚未安装其独立 DSH 0.2.1-alpha.2 profile 并运行完整上游 suite；实际移植行为由 Geneway producer-backed 回归覆盖。

## 实际验证

以下命令均在 `/home/gewu/work/geneway` 执行；现有依赖按原锁恢复，无新增 dependency 或锁变更。

| 命令 | 结果与边界 |
|---|---|
| `node scripts/test-service.mjs` | 通过；旧业务服务回归，injected runner。 |
| `node scripts/test-p6-state-store.mjs` | 通过；v13、v12 迁移、旧 Action 不可变事实和 write/fsync/rename/dirSync 边界。 |
| `node scripts/test-dsh-host.mjs` | 通过；原官方启动/关闭组合的纯提取检查。 |
| `node scripts/test-model-credential-boundary.mjs` | 通过；原凭据引用边界，injected runtime。 |
| `node scripts/test-runtime-isolation.mjs` | 通过；原隔离目录和子进程清理断言，不启动模型。 |
| `node scripts/test-multisite.mjs` | 通过；真实 FileStore、Host journal 和 AgentDelivery；本地模拟 Session producer。覆盖事务故障、丢 kick、重投、摘要冲突、双目标、追问/补充/停止、旧 launch、回执精确 ACK。 |
| `node scripts/test-multisite-http.mjs` | 通过；真实 loopback HTTP 登录/CSRF/API/周期扫描/持久回读，模拟 runtime。 |
| `node scripts/test-multisite-recovery.mjs` | 通过；启动前取消、待消费输入取消、已消费未报告执行重启明确 unknown、根/目标撤权与队列逐项隔离。 |
| `node scripts/test-multisite-journal.mjs` | 通过；真实 producer 报告在 rename 后目录同步失败；新实例确认失败前无 send，确认成功后才回报原 sealed 事件。 |
| `node scripts/test-multisite-budget.mjs` | 通过；生产 Local Host、真实 DSH request hook、FileStore，两 Attempt 20 并发仅 12 预留；含最后额度争用、重开、四提交故障、持久后取消、错误绑定/撤权、报告/停止。 |
| `node scripts/test-p2-state-transfer.mjs`、`node scripts/test-p3-state-transfer.mjs` | 通过；原转移回归、v12 恢复、空域旧备份可用、有协作事实拒绝不完整备份/恢复。 |
| `node scripts/test-multisite-dsh.mjs` | 通过；实际 DSH defineTool schema 编译、官方缺 Session 异常和已有历史拒绝时不创建替代会话。 |
| `node scripts/test-multisite-report-order.mjs` | 通过；已形成 user/message 与下一次 dispatcher 扫描之间的报告竞态。 |
| `node scripts/test-multisite-report-concurrency.mjs` | 通过；实际 createDshRuntime、defineTool、AgentDelivery 与 Host，受控 persistence producer；覆盖 flush 阻塞/失败、旧 delivery 后到、稳定事件、新输入尚未消费、停止夹在 inspect/commit 和无 report→idle 等待。 |
| `node scripts/probe-multisite-budget.mjs` | 通过；生产 Local Host 授权、真实 DSH、连续 loopback 模型替身工具调用，provider capture 恰为 12；持久耗尽后实际停止成功，原因保留；不是实际计费用量。 |
| `node scripts/probe-multisite-dsh.mjs` | 通过；真实 DSH 0.2.0-rc.2 Agent/Session/persistence、1 Session、2 user/message、4 次 loopback 模型替身请求；结构化追问→补充 revision2→ready 候选→实际取消/idle/flush。没有真实模型推理或图片理解。 |

原生探针先后暴露官方缺 Session 异常类型、实际 defineTool output schema 和消费记账/报告时序三类缺口。先增加最近回归，再按 Astra 和独立审查采纳的共享校准方案修复；没有提高超时来掩盖失败。以下为首批历史验证记录；环境重置后这些 `/tmp` 目录与日志已不可读，不能作为本轮可复查的证据。首批当时的候选原生成功证据位于 `/tmp/geneway-multisite-native-hRWrfZ`，日志 `/tmp/geneway-multisite-native-final.log`；目录含同一运行的 cloud state、Host journal、原生 Session 和 capture 请求。最终受影响检查全部 exit 0，原始 pass markers 与实际退出码保存在 `/tmp/geneway-multisite-final-results.log`。预算原生证据另存 `/tmp/geneway-budget-native-oW5GXS`，日志 `/tmp/geneway-multisite-budget-native.log`。测试为隔离模拟数据，模型替身不是识图结果来源。

## T00/T02/XLSX 与下一批接缝

T00 本批选用“模拟现场异常资料整理与整改表”作为本地样本。协调、执行两角色均在一台开发机运行；`targets` 独立绑定不同员工，单机原生探针只运行一个真实 DSH Session。本批未声称真实多机、真实两种网络出口或实体现场采集。

实测环境为 Node 26.5.0、pnpm 11.8.0、Geneway DSH/SDK/tools 0.2.0-rc.2；上游固定源码声明的 DSH 0.2.1-alpha.2 没有混装进产品依赖。Desktop、Gateway 硬件、Node 24 实测与平台 Office 能力尚未验证。

T02 本批仅证明文本的真实 DSH→本地模型替身请求/工具/持久 Session 管线。图片上传、runtime image block、provider image_url、真实模型识图质量与现场图像新鲜度均未验证。生产凭据仍按现有服务端秘密引用读取；探针只使用临时合成凭据，未调用外部真实模型。

首份 XLSX 尚未生成或核验。本样本后续优先选择确定性业务计算写值，并对异常条目、日期、责任人和行数做独立业务断言；若必须保留公式或要求重算，再明确选择和实测计算引擎。当前不假定 ExcelJS 会重算公式，也没有安装 Office 引擎。

下一批从单端图片上传/授权引用→DSH 模型路径→headless XLSX→云端独立核验/下载开始；再扩大角色和实际节点。跨机器 Bridge、节点注册撤权、二进制文件服务、真实识图、Office 产物与全业务 UI 均仍在该接缝之后。本批没有提交、push、PR、部署、生产写入或外部消息。


## 附件产品接缝（本轮 F 候选）

本轮新增附件 API、独立字节目录和引用事务；尚未接通 DSH 图片输入、模型代理或 XLSX 业务成果。附件 `ready` 仅表示原文件经过字节与类型校验、完成持久提交，不等于业务 `Artifact.ready` 或 Work 完成。

- `POST /api/attachments/init`、`PUT /api/attachments/:id/content`、`GET /api/attachments/:id`、`GET /api/attachments/:id/content` 接入真实 session、当前成员和写操作 Origin/CSRF 校验。上传使用 `application/octet-stream`，下载每次重新鉴权与核对字节摘要，固定 `Content-Disposition: attachment`，不暴露服务器路径。
- init 按 `(workspace, authenticated owner, clientRequestId)` 幂等；摘要覆盖文件名、类型、大小、SHA-256 及请求 ID。相同声明返回同对象，冲突返回 409。稳定引用为 `{attachmentId, version, sha256}`；服务器生成存储 ID，用户文件名不参与路径构造。
- 文件最多 10 MiB，历史 JSON 最多 64 KiB，单输入最多 8 个引用；原 JSON API 仍为 64 KiB。PNG/JPEG 使用固定 `sharp@0.35.4` 真正解码并限制 2000 万像素、边长 8192 和单帧。历史 JSON 仅接受 `geneway.incident-history/1` 的日期、异常描述、责任人列表，并实际解析 UTF-8/JSON、校验条目和日期。XLSX 在接入受限解析器前明确不支持，不把 ZIP magic 当作类型验证。
- 上传设 30 秒总时限。流程为独占临时文件写入、大小/摘要/类型核验、文件 fsync、hard-link 不可覆盖发布、已发布对象复验与文件/目录 fsync、FileStore 元数据提交后返回 ready。采用 hard-link 而非可覆盖 rename，避免并发重试替换已发布对象；失败保留 pending 或存储不可用，重试同 ID、同 hash 校准已有对象。
- 字节、base64 和绝对路径不进入 state、Input、outbox 或元数据 API。Work 创建与补充接收 `attachmentRefs`；在同一 FileStore 草稿中重新检查 owner/workspace、当前协调与目标员工权限、ready/version/hash，再绑定单一 Work 并写 Input/outbox。FileStore 的 `beforeCommit` 重新读取磁盘字节，校验失败不提交绑定或输入、不返回成功、不 kick。
- 新 schema 为 v14，显式保留 v13 协作事实迁移并增加空附件域；v14 缺域或附件不可变事实被改写时拒绝。旧版本携带非空新附件域时拒绝降级丢失。既有附件 ready 与 Work 绑定均不可回退或改写。
- Host 将原 stable refs 交给 runtime；runtime 未声明附件支持时，Host inbox 记录 `ATTACHMENT_RUNTIME_UNAVAILABLE` 并保留待投递，不启动 Session/Loop，不向纯文本 runtime 投图。能力恢复后重试原消息，不产生替代引用。现有生产 DSH runtime 尚未声明图片支持，因此本批图片工作只完成受理与受控持久化。
- 文件和元数据是两个资源：文件已发布、元数据未提交时可能留下不可引用对象，重试校准后再提交。元数据 rename 后目录同步失败时，当前 FileStore 明确不可用；重开实例先完成持久确认，再允许重放原受理。没有把无 ACK 的不确定窗口报告成失败回滚或成功交付。
- `state-transfer` 在附件域非空时明确拒绝 backup/restore，避免遗漏字节后输出成功；空域旧业务备份及 v12 恢复仍保留。跨资源完整备份尚未实现。

本轮 focused 验证使用真实 sharp PNG/JPEG producer、真实 HTTP 登录与 CSRF、实际 FileStore/Host journal；模型与现场资源为用户允许的本地模拟。`node scripts/test-multisite-artifacts.mjs` 覆盖 API→上传→Work/补充→Input/outbox 同引用→重开下载同 hash；包含丢响应重放、并发对象落位、坏摘要、伪类型、图像尺寸、无效历史 JSON、超量与超时、跨用户/工作区、撤权、旧版本、路径与符号链接拒绝。文件 write/fsync/publish/dirSync、元数据 write/fsync/rename/dirSync，以及引用事务提交失败均有独立断言；故障后无成功 ACK、无提前派发。

本轮原始输出保存于仓库外 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`。当前候选需独立审查；未执行 stage、commit、push、部署、真实设备或数据库写入。后续仍为 per-Attempt 代理隔离与 DSH 图片输入，再接真实 XLSX、独立云核验、下载及完整 UI 验收。

## 隔离执行、图片与模型代理（本轮 G 候选）

G 接通了真实图片请求管线与最小页面入口，仍是单开发机、用户允许模拟资源的本地产品增量。两个工作实际运行于两个独立 DSH 子进程，provider 为本地合成响应服务；这证明身份、图片与请求链，未证明真实视觉模型理解质量，也未实现跨机器 Bridge 或 XLSX 业务交付。

### 执行与唯一模型入口

- 生产 Local Host 现在只组合父 Host journal 与每 Attempt 独立的执行子进程。每个子进程使用固定服务器 ID 派生的独立 HOME/DSH_HOME、固定 `config/multisite-runtime.patch.yml`，白名单环境中只有短效 Geneway token，没有 provider 长期 key。父进程保有唯一 journal 和编排权限；IPC 每次核对完整 Work/Delegation/Attempt/epoch/Agent/node/launch/Session 绑定。
- multisite 默认模型入口固定为 `POST /internal/model/v1/chat/completions`。独立 Bearer token 校验不借用浏览器 cookie；服务器固定上游 URL，拒绝 redirect，另行构造 provider Authorization，不转发子进程 token 或任何客户端自报目标 URL。子进程无法通过配置切到直接 provider 请求。
- token 在父进程内映射完整执行绑定、purpose、到期时间、真实 Input revision 与 requestId。attachments purpose 只能读取当前工作已授权文件；模型执行 token 由官方 `llm/stream` 的只读 `options.messages/sessionId` 得到真实稳定 UserMessage ID 后签发。`agent/request` 发生在本轮 user/message append 之前，因此不再从该 hook 的历史快照推断本轮输入。
- launch environment 的其他值固定，只有 worker 私有 token 槽动态更新。读补充附件前通过可信父 IPC 刷新短效 attachments token，并重新检查权限；等待超过 token 有效期后仍可补图。模型工具不能自行续权。
- 12 次预算唯一扣额点已迁至代理 forward 前的 FileStore 事务。DSH hook 不再扣额。每次实际转发前检查当前 root/目标授权、完整绑定、员工和模型 revision、停止状态、真实 Input revision 以及全部历史附件的权限与原字节 hash。预留成功后才允许网络请求；失败或取消不退款，补充与恢复不重置。
- 最小请求事实保存 requestId、完整绑定、Input revision、正文摘要、预留时间、outcome、usage 和所用图片派生引用，不保存正文、provider key 或短效 token。相同 requestId 已预留时拒绝重推。`usage=null` 表示没有可核验 usage，不填默认 0，也不把预留数当账单用量。
- 只有正常 SSE 结束原因与 `[DONE]` 都存在，并成功保存完成记录后，请求才记为 completed。干净 EOF 但缺终止、断流、redirect、完成记录写失败均保持 unknown；上游明确拒绝可记 failed，均不退款。
- 对同一完整执行绑定，持久 unknown 若不属于当前进程仍活跃的 forward，恢复入口直接拒绝并报告 `RUNTIME_REQUEST_UNKNOWN`；不能通过换 token、重开 worker 或新 Session 重发旧步骤。worker 死亡同样被父 Host 观察并进入明确 unknown。实际确认旧进程已退出后，取消可启动无 token/key 的 stop-only 子进程，加载原 HOME/Session，执行 cancel、idle 与 flush；不把死亡直接当作 flush 成功。

### 图片与页面

- stable ref 经当前授权与原字节校验后，由子进程调用官方 `ctx.attachments.saveImage`，将真实 ImageBlock 放入原稳定 UserMessage，再经过原生持久化与 provider 转换。PNG/JPEG 不以 URL 文本替代图片输入；受限历史 JSON 作为已解析资料内容传入。
- 原图 ref、归一化 `sha256:<digest>` attachmentId、描述变换策略的 variantId、实际请求图像字节 SHA-256 分别保存。官方 `readImageRequest` producer 登记派生关系；代理独立解码实际 data URL 并核对字节摘要、类型、大小与绑定来源。相同归一化内容对应多个原始 ref 时保留全部来源，不用 Map 覆盖旧关联。恢复后的历史图仍在每次请求前复核。
- 原工作表单增加“现场资料协作”，只列出当前获准且已配置 placement 的负责人；此模式隐藏并禁用旧 Skill/连接必填项。页面实际完成选图、摘要校验、init/raw upload、稳定请求 ID 创建、结构化追问、补充文本与图片、刷新恢复和停止。
- Work 详情由服务端投影当前报告和已交办资料，提供受控原文件下载。草稿、已选补充文件与焦点在轮询中保留；创建与补充的丢响应重试沿用同一内容的请求 ID。停止终态明确显示“本次执行已确认停止”，不继续显示正在处理或正在确认的临时状态。模型 ready 仅显示处理意见候选，文件仍需生成与核验。
- 新 schema 为 v15，显式从 v14 增加空 `modelRequests` 与 `modelImageVariants` 域，保留已有预算计数；旧版本没有 ledger 时不制造历史请求事实。v15 缺域、新事实降级丢失或不可变预留被删除时拒绝。现有不完整备份拒绝规则扩展至模型执行事实。

### 本轮实际验证与证据

- `node scripts/test-model-gateway.mjs`，以及原兼容入口 `node scripts/test-multisite-budget.mjs`：实际 HTTP 代理 token/purpose/expiry/Input/model 校验；两 Attempt 并发恰好 12 次 forward；同请求拒重发；当前撤权与停止；真实 usage 与未知值；SSE 终止/断流/redirect/完成提交失败；预留 write/fsync/rename/dirSync；v14 保留预算迁移和旧 ledger 拒降级。
- `node scripts/test-multisite-image-projection.mjs`：官方 saveImage/readImageRequest producer 的真实输出覆盖原图、归一化 ID、变换 ID 和请求字节 SHA 四个不同事实。首次回归先复现 validator 错把 `sha256:` ID 当裸 hex，再修复并通过；没有放宽类型或使用手造的正例替代 producer。
- `node scripts/probe-multisite-images.mjs`：真实 HTTP 两个不同 PNG/两个 Work → 两个实际 OS DSH worker → 生产代理 → local provider capture；验证实际 image_url 字节摘要、token/HOME/Session/工具隔离、Input revision 1/2、预算与实际 forward 一致、追问/补充/停止。后续加入 clock 推进 6 分钟后的补图、同归一化多原图引用、杀 worker 后 stop-only 原 Session 校准，实际通过。适用原生证据为 `geneway-evidence/images-native-3bkjaJ`，日志 `probe-multisite-images-expiry-stop.log`；8 次实际 forward，均有对应预留，非账单 usage。
- `node scripts/test-multisite-process-recovery.mjs`：真实 provider 已收到第 1 次请求，而 Host ingestion journal 写入屏障尚未提交、云 ingestedAt 仍为空时 SIGKILL 父进程；重开同 state/journal 后不启动替代推理，provider 仍为 1，unknown usage 保持 null，随后 stop-only 原 Session idle/flush 成功。证据 `geneway-evidence/process-recovery-sSCxkn`。
- `node scripts/probe-multisite-budget.mjs`：真实 HTTP、生产 Host、隔离 DSH 子进程、生产代理与 local provider 连续工具轮次；第 13 次被服务端挡住，provider 实际 12 次、共享预算预留 12、无双扣，实际停止后保留耗尽原因。证据 `geneway-evidence/budget-gateway-native-NwYIdl`。
- 最小 UI 以实际登录、选图、创建、追问、补图、刷新和停止接受独立浏览器检查；使用已安装的隔离 Playwright fallback，没有新增全局工具。初次发现停止终态文案仍显示处理中，已定向修复；浏览器复核与最终独立后端审查由控制器保留各自证据。

受影响的 F 附件/ref、旧文本 HTTP/停止/恢复、报告并发、FileStore 与旧备份回归集中记录于 `geneway-evidence/*-g-final.log`。原有适用的原生与故障证据复用，不因最终汇总再跑全部原生链。本轮仍未 stage、commit、push、部署或写真实设备/业务数据库。

G 结束时尚未实现 XLSX 业务交付；以下 X1/X2 记录取代这一历史进度，不把 G 的 ready 报告当作文件完成证据。


## 整改表生成与受控后台 Job（X1）

固定 `exceljs@4.4.0` 与只读模板 `incident-register-v1`，业务计算直接写入异常日期、描述、责任人、用户整改期限、历史同描述次数、来源与汇总。生成器与独立核验器均不读取测试 oracle，不声称公式重算。已批准的 X1 原始证据包含两个不同业务样本、各两个期限版本的四份真实 XLSX；错误关键单元格、缺行、错误日期、样式、外部关系、macro 内容类型与实际解压限额均有负例。

`Host journal v2.jobs` 是 Job 执行权威。生成由独立 OS worker 异步执行；受理参数、完整执行绑定、Input revision、模板和证据摘要不可改写。同请求幂等，换请求 ID 也不能重复占用同 binding/revision/outputKind。工具仅暴露受控证据读取、生成和 Job 查询，不接收路径、脚本、模块或成果写令牌。表格场景只允许一个执行员工；旧文本、图片协作仍支持原有多目标。

`schema16` 显式保留旧预算、附件、回执与模型请求事实并加入 Job 投影和 Artifact 域。用户整改期限是 typed 日历日期，空日期必须追问；Input 保存服务器模板与计算版本快照。补充未携带要求时继承当前值，携带时整体替换。历史条目以 `sourceRef + entryIndex` 全量唯一覆盖，照片不伪装成历史异常。

## 云端核验、完成与下载（X2）

父 Job manager 持有独立的短效 `artifact_upload` token，绑定 Job 与完整 Attempt；模型 execution token 不能上传成果。真实 HTTP `init/PUT` 接收已封存候选。cloud Job 仅由 Host sealed event 投影并关联 receipt；投影未到时等待原 Job，不伪造云端状态、不再次生成。已有 candidate 等待模型结果持久完成后，通过同 token/binding 的 `POST .../verify` 只重核原 bytes，无第二次 PUT。

附件与候选复用固定根、`NOFOLLOW`、字节限额、hash、文件 fsync、不可覆盖 hard-link 发布和目录同步。F 提取后完整附件回归通过。候选落盘和 metadata ACK 分开；云端独立读取 XLSX 原 bytes、全部历史原 bytes、当前用户期限与模板快照，检查 ZIP/OOXML、行列来源、关键值、次数、汇总、合并与样式。

最后在同一 FileStore 更新内重新核对当前成员、员工、placement/revision、完整 binding、当前 Input、证据、预算失败、停止、待回答问题与所有必要 Job。当前 binding 任一持久 `modelRequests.outcome=unknown` 均等待原 candidate；飞行请求不享受内存 active map 豁免。通过后原子写入 `Artifact.ready`、`Work.completed/artifactRefs/completedAt`、Attempt/Delegation completed 与 settle outbox。完成后新 input/cancel/model/tool start 被拒绝；迟到 started/report/runtime_unavailable 保留历史，不能回退完成状态。

settle 是完成后的独立资源清理命令，撤权后仍可对相同 binding 关闭资源；它不生成 manual cancel。实际 DSH cancel/idle/flush 后关闭 worker，普通与 stop-only 共用 `error/exit/close` 生命周期注册；确定 OS exit 或未 spawn 的 close 都能结束等待，运行中 error 本身不算退出。已有候选恢复优先核对同 bytes，不 resume 模型、不重新生成。started 无可核输出仍为 unknown；`/proc` 检查期间自然退出只在实际身份消失、Z 或换代的 readback 后认定 quiesced，进程仍活时拒绝假确认。

受控 `GET /api/works/:workId/artifacts/:artifactId/content` 每次检查当前 owner/员工授权、Work 与当前 ready revision/version、归属及磁盘实际 hash；无公开 URL 或服务器路径，下载使用正确 XLSX 类型、文件名、no-store 与 nosniff。Web 原工作表单增加生成整改表和日历期限，详情显示追问、生成、核验、完成、下载与停止；保留输入草稿和焦点，终态进展显示已核验或已停止。

### 本轮实际验收与证据边界

完整浏览器旅程在 `geneway-evidence/spreadsheet-native-sDDRZA`，命令 `node scripts/probe-spreadsheet-workflow.mjs` 实际 exit 0。使用现有隔离 Playwright，真实登录、选 PNG 与历史 JSON、创建缺期限工作、实际 DSH 追问、填写期限、修订到 2026-11-20、生成并独立核验、刷新和下载同一 Work 第 3 版真 XLSX。下载 hash 为 `c3a8406ecb67cb3e23973383f9d2d7f9d18fce7377a543e9cd3b80c18b20e2b6`；独立打开核对三条历史明细、次数 2/1/2、期限及汇总 3/2/2。DSH 与 Job 资源实际 settled。第二个 Work 在真实已标识的生成 worker 被测试控制暂停后，由页面点击停止，确认实际 exit、无已发布输出、Work cancelled 且无 ready 成果。两工作共 10 次本地 provider 请求；不把 capture 响应当作真实图像理解。

`geneway-evidence/x2-final-results.json` 汇总本轮实际命令、退出码与原始 stdout。focused 覆盖真实 worker/candidate HTTP、完成终态、撤权后 settle、跨用户下载、原 candidate 恢复、typed 日期和语义占用；核验期间 revision/stop/revoke/question/飞行 unknown，以及完成 write/fsync/rename/dirSync 故障均有实际屏障。飞行 unknown 首次 PUT 409 保 candidate，真实 SSE terminal + DONE 持久 completed 后，同 Job/artifact init 返回 candidate，再 POST verify 200 完成；inode 不变且没有第二次 PUT。pre-rename 故障无 ready/completed/settle；rename 后 dirSync 失败无成功 ACK，重开可能读到原子完成事实，不能称为未落盘。

修复前已有 candidate 恢复误 interrupted、DSH OS exit 后等待 close 悬空、旧进程自然退出时 `/proc/stat` ESRCH 均保存了原始失败和修后专项。浏览器早期失败定位为探针缺 KnowledgeService 或轮询 DOM 尚未更新，分别补生产 fixture 和等待实际 UI 文案；未放宽产品鉴权、未加长超时掩盖。后续 worker 生命周期共用注册、旧进程 proc readback 和 UI 终态文案以相关专项及同一业务对象的独立只读浏览器复核验证，复用适用的完整旅程证据。

本轮是单开发机、用户允许模拟资料和 provider 的本地实现。真实视觉推理质量、跨机器 Bridge、多角色编排与完整附件 v4.2 后续路线仍未完成；X2 通过不能推导全 M0/M1 或整方案完成，也不构成 release-ready 认证。没有 stage、commit、push、PR、部署或真实设备/业务数据库写入。

控制器记录本批后端独立审查为 APPROVE，三项 Important 均已关闭；独立浏览器对同一已完成 Work 的终态、下载 hash 和业务值只读复核通过。复核用无 hosts 的只读 HTTP 服务已按要求发送 SIGTERM 结束，实际进程消失且端口关闭，全部证据目录保留。整方案 goal 继续 active，下一批仍按原 v4.2 继续多角色与 Bridge 等后续实现。

## 主动多级委派、持久等待与回报（D1）

本批在现有 LocalHost 与每 Attempt 独立 DSH 进程上增加主动协作。管理员通过员工配置的 `expectedRevision` 更新 `multisitePolicy`，分别声明 `execution` 和 `delegation` 的能力、资源与允许目标。缺少该字段的旧文本、附件与单执行员工整改表路径保持原授权语义；迁移不会替旧员工授予主动委派权限。`placement` 只表示节点资源上限，不能代替执行或再委派授权。

- 新增实际 DSH 工具 `geneway_delegate`、`geneway_wait_dependencies`、`geneway_complete_delegation`。父进程将真实执行绑定送入同一 FileStore 事务，模型不能自报发送者、父委派或成员身份。委派命令、内容摘要、子 Delegation/Attempt、当前用户 Input 的新增 delivery 与派发 outbox 同次提交，成功后才返回受理回执。重放沿用原 ID；同键不同内容拒绝。
- 根授权来自显式 policy。子执行范围须同时满足父再委派范围、成员当前权限、目标执行 policy 和节点资源上限；显式越界请求整体拒绝。子再委派范围继续取交集，并排除祖先 Agent。每次派发、模型请求、工具与结果提交重新核对当前成员、根协调员工和全祖先授权。执行资源与可再委派资源分别保存，D1 不新增本地文件或设备读取能力。
- 子委派立即返回稳定 ID；等待先持久保存 dependency wait，再正常结束工具。下一次官方 `agent/pre-step` 返回 `reject`，Host 在执行外确认 idle、`whenIdle` 与持久 flush 后释放普通 Loop 槽位。保留原 Session，不能用人工取消充当等待。若 pre-step 已取走同时到达的输入，使用官方 `next-turn` inbox 操作停车；重新唤醒原对象，并通过实际 `user/message` 与 flush 单独确认消费。
- 结果先到或等待先到都由同一事务决定一次唤醒。不可变结果使用 `geneway.delegation-result/1`；证据引用仅接受当前 Work 内已验证的附件或成果，不接受任意路径或 URL。空证据数组只证明结构化回报。`multisite.messages` 记录真实发送者绑定和定向接收者，独立保存送达、实际消费事实，不伪装成新的用户 Input，不增加用户要求 revision。
- 当前子执行只能产生一个有效结果，完成不代表整个 Work 完成；同键丢回执可在仍具读取权限时重放，换新键再次完成拒绝。旧 revision 的已消费结果只保存历史，不改变当前 Attempt、不唤醒、不停车。已完成子执行不接收新用户要求；新要求需要当前父执行明确续等或新委派。已经投递的依赖子集、排列或重复等待拒绝，避免空唤醒。前一次 wait 虽已生成唤醒，但定向消息尚未实际消费时，也拒绝新的 wait；原命令重放仍返回原回执，消费后可明确等待其他依赖。
- 父取消与活动后代的停止命令原子持久化；已完成子执行保留完成事实，停止与 settle 在普通权限撤销后仍可进行。工作模型预算继续共享 12 次真实 forward，委派、等待、回报本身不另扣请求或重置预算。当前有界样本限制为根深度 0、最大深度 3、总子委派 8、每 Agent 一个活动 Attempt；槽位限制独立于保留的进程与 Session 数量。

状态版本为 `schema17`，显式从 v16 保留既有 Work、预算、附件、Job、Artifact、模型请求及协作事实，增加空 `results`、`messages`、`dependencyWaits`，不制造历史结果或 grant。已使用 X2 原生完整旅程的真实 v16 状态做只读迁移，逐域断言原事实不变。

### D1 实际验证与边界

证据总根仍为 `/home/gewu/.codex/task-checkpoints/geneway-evidence`。本批使用用户允许的单机隔离数据与本地 provider 替身。`delegation-final-results.json` 保存最终 18 个脚本、真实 v16→v17 迁移、diff check 与暂存路径检查的命令、实际退出码及原始 stdout/stderr；21 条均 exit 0，暂存路径为空。

| 命令 | 实际结果与可复查证据 |
| --- | --- |
| `node scripts/test-multisite-delegation.mjs` | exit 0；`delegation-focused-f9WAgA`，真实 FileStore/Host/AgentDelivery producer 验证三层委派、消费、幂等、越权、环与父取消；runtime 为模拟器。 |
| `node scripts/test-multisite-delegation-edges.mjs` | exit 0；`delegation-edges-KkChEs`，结果先到、完成后回执重放与新键拒绝、新用户版本保留完成子执行、历史结果不停车、冗余子集/排列等待拒绝、前次 wake 未消费时拒绝新 wait、撤权、实际 gateway 截断 SSE 导致 unknown 时拒绝完成、write/fsync/rename/dirSync 故障。rename 后 dirSync 失败允许读回原子事实，但没有成功 ACK 或提前启动。 |
| `node scripts/probe-multisite-delegation.mjs` | exit 0；`delegation-native-ynYNqs`，真实 HTTP→生产 gateway→三个独立 DSH 子进程与 HOME，固定一个 Loop 槽；协调工具委派 B、B 工具委派 A、结果两次回流并实际消费，8 次 forward、用户 revision 仍 1，子执行 settled 后父取消成功。 |
| `node scripts/probe-multisite-wait-race.mjs` | exit 0；`delegation-wait-race-Y76vxB`，真实 DSH 在等待工具中注入并实际 claim 非空补充，原 ID 停车后只消费一次；等待时 provider 不增加，恢复后总请求 2，没有取消。此专项使用受控工具回调，完整 IPC 另由上行主链覆盖。 |
| `node scripts/probe-multisite-revision-wake.mjs` | exit 0；`delegation-revision-wake-DvNBOH`，真实原生屏障令 revision 1 的 wake 已提交但未派发，再真实 POST input 2，恢复派发后旧 wake 零 forward、当前要求两次 forward、总预留精确 5、同父 Session 正常消费并停止，无卡住。未据此增加产品机制。 |
| `node scripts/test-multisite-delegation-recovery.mjs` | exit 0；`delegation-recovery-dJgPJb`，父已等待、子模型流 unknown 时实际 SIGKILL 服务并重启，保留父 Session，恢复阶段零推理子进程、forward 仍 3，随后实际 stop-only 收敛 cancelled。 |

相关回归已实际 exit 0：`test-model-gateway.mjs`、`test-multisite-budget.mjs`、`test-p6-state-store.mjs`（v17）、`test-multisite-spawn-failure.mjs`、`test-multisite-journal.mjs`；真实预算探针 `budget-gateway-native-bPRmYS` 仍精确 12 次，旧进程恢复 `process-recovery-OLFaPW` 仍禁止 unknown 自动重发。既有 X2 的真实 candidate HTTP/原字节核验/下载与业务 oracle、完成竞态、candidate 恢复、settle 分别通过于 `spreadsheet-artifacts-IkWTJq`、`spreadsheet-completion-races-ppuP7W`、`spreadsheet-candidate-recovery-Lp3MB9`、`spreadsheet-settle-PRLDw2`。

原始失败仍保留：首个 native probe 的 provider fixture 错把 DSH 合并文本块当成换行 JSON（`delegation-native-SvvbrY`）；停车分支官方 target 与待消费输入重新唤醒接缝的 focused 失败在 `delegation-wait-race-zC9YsC`、`delegation-wait-race-vZ3YmT`。这些失败不是成功证据，修后专项分别验证官方 inbox target、原对象唤醒和实际消费不重复。独立源码审查提出的结果终态、历史回执停车、冗余等待等问题均按本批合同最窄修复；控制器已记录本批有界后端独立审查为 APPROVE，无未闭 Critical/Important；跨 revision 原生专项随后通过。

D1 只证明 LocalHost 上真实 Agent 主动委派、持久依赖等待和结构化结果回流。Gateway/独立 analysis 的完整业务资料读取、三方群证据问答、出站 Bridge、全拓扑 XLSX 与附件 v4.2 后续阶段继续实施；本批不修改已验 X2 的单执行员工表格限制，不声称实际多机、真实识图或完整业务拓扑验收。没有 stage、commit、push、PR、部署或真实设备/数据库写入。

## 节点控制面与出站 HTTP Bridge（D2a）

生产启动新增 `GENEWAY_MULTISITE_HOST_MODE=local|remote`，缺省仍为 `local`。remote 模式的云 API 不构造 LocalHost，也不拥有或关闭远端 DSH 进程。独立 Host 通过 `packages/agent-host/remote.mjs` 启动，只有出站 HTTP/SSE；`process-runtime` 使用受限 HTTP adapter 取得当前执行的模型快照、必要 Work 标志及短效 token，不能取得 cloud Store、全部成员或其他 Work。当前 D2a 不启用远端图片、Office Job 或 Artifact 上传。

- 管理员经真实 Cookie、Origin、CSRF 和 revision 配置 Node/Resource 与短效一次配对码。Node 的 `allowedAgentIds` 与员工唯一 `placement.nodeId` 必须同时满足，不另设 deployment 权威。Resource 只保存所属 Node/site、能力与 revision；本地路径和业务凭据不进入云目录。
- Host 在兑换配对码前，先以 0600 文件持久保存自己的长期 credential、稳定 pair request ID 与 `nodeInstanceId`。重开既有身份文件也先重新确认 file 与目录 sync，失败时不出站、不 ready，保留原 credential 与 pair request。云端只保存配对码与 credential 的 hash；同一兑换 ID、内容与实例重试返回原注册事实，换 secret 或实例拒绝。Node 注册版本、实例及员工/资源版本进入执行快照，普通派发、工具、模型和回报重新核验当前权限。
- `nodeInstanceId` 属于持久数据根，重启保持；`hostRunId` 属于本次父进程。每根使用真实 flock 保护。父进程持有与锁 helper 相同的 open file description，helper 异常退出时，锁仍保留至原 Host 真正完成 HTTP、worker 与日志清理。重复 close 共用同一 Promise，SIGTERM 不会越过已在进行的 quiescence 提前退出或释放锁。
- SSE 只扫描已提交且未 exact ACK 的原 outbox。建立连接立即扫描，周期校准补后续提交；Last-Event-ID、写入 socket 和 drain 都不清除 pending。每连接有界 inflight、帧与 buffer，背压等待有超时；新连接替换旧连接后，旧 close 只能删除自己的 generation。resync 从一次 Store read 返回有界 binding 和 command 批次，按真实 JSON 字节限制，普通响应不超过 256 KiB，binding 投影单独限制为 32 KiB；余项留在同一 durable pending，并显式标记未返回全量，不建设第二队列。
- Host accept 先 journal 持久化再 POST exact command ID、摘要、完整 binding、注册版本及实例。上行事件先 Host journal，再经 HTTP 进入原 `acceptHostEvent` 事务；服务端状态与 receipt 同次提交后才返回原 ACK。Agent command 仍由 D1 唯一事务写者受理，Node 身份不能代替员工、成员或祖先 grant。
- 模型 token 兑换前，真实 Host 校准原消息实际消费并 flush/POST 回执。服务端要求当前用户 Input 和对应 Agent 消息的实际消费绑定；不能凭 Node 自报一个 input ID 取得当前请求。兑换网络重试复用稳定 client request ID 与持久 model request ID；真正 forward 仍由原模型账本唯一预留，unknown 不自动重发，Work 预算仍为 12。
- 撤权同事务保存 cleanup-only、冻结既有 binding 并排入 cancel/settle。此凭据只能读取这些清理命令、提交 exact ACK 和真实 stopped/settled，或重放已经接受且摘要完全相同的原 receipt；不能产生新目标、普通报告、模型或文件权限。旧普通事件被拒时保持 Host unacked，但可继续发送后方真实停止回执。若 started 尚未上报，合法 stopped 只能按服务端 `geneway-${launch_id}` 预绑定 Session 校准，任意 Session 拒绝。已耗尽预算的撤权保留原 BUDGET_EXHAUSTED、计数与账本。
- remote 生产 API 关停先停止新 intake，再关闭本 API 持有的连接；活模型连接关闭沿原 gateway abort 保留 unknown，不关闭远端 Host。重启只恢复原注册、outbox 与 receipt，不误恢复推理、不创建新 Attempt 或重置预算。远端父进程死亡后沿原 DSH/进程证据校准，unknown 在新推理 worker fork 前拒绝，仍可用同 Session stop-only 收敛。

状态版本为 `schema18`。显式从 v17/v16 及旧版本保留既有预算、附件、Job、Artifact、模型、委派与回报事实，增加空 Node、配对、资源、命令及 token 受理域；旧 local 不会自动注册远端。未覆盖新 Node 事实的旧备份/恢复路径继续明确拒绝，不丢弃注册或执行事实。

### D2a 真实验证与证据范围

`geneway-evidence/bridge-final-results.json` 保存本批最终相关命令的实际退出码、原始 stdout/stderr、诊断索引，以及复用既有主链证据的适用范围。最终 19 个脚本及 diff/暂存检查共 21 条均实际 exit 0，暂存为空；不是发布认证。

| 命令或同对象证据 | 已观察的结果 |
| --- | --- |
| `node scripts/test-multisite-nodes.mjs`，`nodes-focused-WFtOxx` | 真实 HTTP 管理员权限/CSRF、hash-only 配对/丢 ACK 重放/expiry、Resource CAS、跨 Node 与伪 Session 拒绝、稳定 token 受理、cleanup-only 限定、首次 Session 未上报时停止、真实 12 次 gateway forward 耗尽后仍可撤权停止并保预算。Host runtime 为模拟器。 |
| `node scripts/test-multisite-bridge.mjs`，`bridge-focused-xK5p0L` | 真实 identity rename 后 dirsync 失败、重开 file/dir sync 失败均零兑换 HTTP/不 ready，成功确认后原 credential/原 pair request 重试；真实空闲 Host 的 journal 持久确认后 ready，持久失败不 ready；真实 flock、helper 死亡仍持父锁、稳定实例与 credential/新 run；split UTF-8/CRLF/半帧/超量拒绝；真实 SSE 未 ACK 重投、Last-Event-ID 不跳过、exact ACK、resync 之后提交与旧 close、新 payload 拒绝和原 receipt 清理后重放。 |
| `node scripts/probe-multisite-bridge.mjs` 及已验证模式 | `bridge-native-bkxc1B` 的五个独立父进程完成协调→B 主动委派 A→结果回原 Session，三个实际 DSH Session、四个独立 Node 根和 journal、每 Host 槽 1、8 次 forward，实际停止；同一对象两次切至真实 production start/remote 模式，远端 worker PID、Session 与工作状态保持，不误 recover，也不新转发。 |
| `node scripts/probe-multisite-bridge.mjs --owner-loss`，`bridge-native-FpucPO` | 对真实 DSH worker 使用 SIGSTOP 屏障，杀锁 helper 后再次 SIGTERM 原 Host；worker 尚未退出时原父不提前结束，第二 owner 仍拒绝。CONT 后实际 worker/Host 清理完才释放，替换父同 instance、新 run、原 Session，无额外 forward；worker 环境不含 Node 长期 credential。 |
| `node scripts/test-multisite-bridge-backlog.mjs`，`bridge-backlog-I3q9P9` | 真实 HTTP 离线追加 20 条合法 16000 字符输入，共 21 个 pending/revision 21；有界 resync 加原 durable pending 经 HTTP/Bridge 补齐，全部 exact ACK，同一实际 DSH Session 消费当前 Input，旧版本零 forward，当前仅一次 forward，预算 1 后真实停止。未捕获余项究竟来自 connect 的第二次 resync 还是 SSE，不据此单独声称 SSE 补齐。 |
| `node scripts/test-multisite-bridge-recovery.mjs`，`bridge-recovery-Xyr1wd` | 真实 production API 在第三条活模型流中 SIGTERM 并终态退出；重启原请求仍 unknown，拒绝重发、总 forward 仍 3。随后真实 SIGKILL 远端 B 父进程，同根恢复没有新推理 worker，保持根 Session，经实际 stop-only 收敛 cancelled，账本与预算不变。 |
| `node scripts/test-multisite-bridge-backpressure.mjs`，`bridge-backpressure-QZuWgt` | 合法文本/资源声明生成 35 条均小于 256 KiB 的命令；真实 TCP 读端暂停 6500ms，恢复读取时观察服务器连接已关闭，SSE 写入没有算 ACK，35 条 pending 原样保留。新连接重投原 ID/摘要并逐条 exact ACK 清除，模型预留为 0。客户端观察时间不是精确服务器关断时延承诺。 |
| `node scripts/test-multisite-production.mjs`，`production-remote-q7Kv5e` | 直接执行实际 production start，模型上游仅注入本地 fixture；真实登录、remote 无 LocalHost worker、已有远端 Attempt/模型账本不被误改、正常关停保留 Node 状态。活模型边界由上述 recovery 专项覆盖。 |

最终相关回归还包括 D1 三层委派及边缘命令、真实非空 claim 等待恢复、模型 gateway、runtime 配置、旧本地附件 HTTP、真实 DSH 图片派生与本地图片子进程、X2 真实 worker/candidate HTTP/原字节核验/完成竞态/candidate 恢复/settle、旧服务关停与 schema18 store。真实本地图片证据为 `images-native-x7YFij`，X2 新证据分别为 `spreadsheet-artifacts-Wj7j3K`、`spreadsheet-completion-races-c3ZDM6`、`spreadsheet-candidate-recovery-WBU8i7`、`spreadsheet-settle-TbYC8E`。这些检查服务于本批改动的授权、Host 和状态接缝，没有重新声明完整浏览器 XLSX 或真实识图验收。

保留的非通过诊断为 `bridge-native-9pAd86` 的过早读取最后模型账本、`bridge-native-I5RBtX` 的空闲 Gateway 日志未先建立、`bridge-native-ho7Jib` 的生产 fixture 缺必需可信连接目录，以及 `bridge-recovery-rDtOPI` 的活模型连接阻止 API 终态关停。分别先在最近边界补确认条件、启动持久日志、真实配置和 API 自身连接关闭，再执行对应专项；没有提高预算、删步骤或把失败改报为通过。控制器已记录 D2a 独立最终有界审查为 APPROVE，所列 Critical/Important 均已关闭；此结论只覆盖本地 D2a 增量，不代表整份 v4.2、D2b 或发布认证。

本批仍是同一开发机的 loopback 隔离模拟。Gateway 与独立 analysis 已注册 ready，但尚未完成 D3 的真实受控资料、网关只读工具、三方群证据与定向问答；远端图片/Office Job/Artifact 属于紧随的 D2b。没有跨公网、多机或完整 v4.2 验收结论，没有 stage、commit、push、PR、部署或真实设备/业务数据库写入。

### D2a 大命令引用与等待受理尺寸修复

D2a 最终审查另发现一个合法聚合域缺口：`nodeId='节'×16000` 的配对请求仅 48256 字节，八个分析子执行各回报短摘要“已回报”即可生成 392267 字节的 wake。原候选已持久接受 wait/results，但最后的 256 KiB SSE guard 关闭连接，resync 也无法容纳单条命令。前述 21 条通过只覆盖所测场景，不能证明该聚合域可恢复。

修复保留原 outbox command、ID、摘要、Host journal、wait generation 与 exact ACK。普通 SSE/resync 仍为 256 KiB，不能内联的命令改发 `command_ref`；Node 父进程经 `POST /internal/bridge/command` 按 ID/摘要读取原 sealed command，只有该专用响应 reader 允许最多 4 MiB。服务端重新校验 Node/实例、完整 binding 与当前授权，客户端重新核验 seal、ID 和摘要，之后才进入原 Host 持久 accept 和 exact ACK。它不是文件代理、模型工具、通用 RPC 或新的调度权威。

新结果的规范化 payload 限制为 256 KiB。新等待受理与实际派发共用同一 command builder：已就绪结果计实际 payload，未就绪结果以 null 候选加每项最大结果增量，使用真实 sender binding、服务端预绑定 Session、实际 key 构造、最长 ISO 日期和安全整数位数计算完整 sealed command 的字节上界。上界超过 4 MiB 时不写等待回执、不停车、不占用 generation，可以在原 Session 分批等待。`envelopeVersion/upperBytes` 只记录受理检查事实，不是新的模型预算或权限来源；真正 queue 仍同事务断言实际命令字节，超限整体回滚。

已持久且在 4 MiB 内的大命令可原 ID 取回，不重新 seal；更大的旧命令保留 payload 并返回有界 unavailable 诊断，不假 ACK，也不无限断流。诊断与等待 exact ACK 的业务 inflight 分开计数，不能占满窗口挡住后续 cancel/settle。旧无尺寸预检且未来上界过大的 wait 也有明确诊断与停止路径，不把新受理保证追溯成旧事实。取回失败保持 pending，Remote Host 可继续经重连和原 pending 收到停止命令。

本修复的最终命令与原始 stdout/stderr、负fixture说明、原生结果及请求账本关联位于 `geneway-evidence/command-fetch-final-results.json`；原 `bridge-final-results.json` 已增加对此补丁的引用，原始 21 条记录未改写为全域证明。

- `test-multisite-command-fetch.mjs` 最终证据 `command-fetch-Ff4Yun` 使用真实 FileStore/v18 校验、配对 HTTP、Host journal 与 AgentDelivery，覆盖 wait 先于结果和结果先于 wait，两者均生成原 392267 字节 wake，取回原 seal/digest、API 重启后仍为原 pending、八条真实 payload 消费和 exact ACK。跨 Node、错摘要、坏 seal、错 command、取回失败和响应超过专用上限均不 ACK。其 `negative-limits` 明确将超大 metadata/旧记录标为负fixture，仅证明 byte guard、事务回滚、无回执/停车/generation 占用、旧 wait 诊断、33 个 unavailable 不占业务窗口及后续 cancel 可达，不作为合法业务正例。
- 修正 UTF-8 采集后的 `probe-multisite-command-fetch.mjs` 在 `command-fetch-native-H7KOGA` 实际 exit 0。真实 remote 入口、九个独立原生 Session、八个子结果生成 392273 字节 wake，经一次专用取回进入原协调 Session 的实际模型输入，八条报告均可辨认；共 12 次 forward，未提高工作上限，随后真实停止。全部 12 个 provider body 的 canonical digest 与 12 条 ledger 一一对应，无 U+FFFD 替换字符。
- `--fetch-failure` 在 `command-fetch-native-ynaT8y` 实际 exit 0。受控代理拒绝三次取回，原 wake 保持未 ACK、没有结果误消费或额外模型请求；同一协调 Session 收到后续用户停止并实际收敛，工作共 10 次 forward。全部 10 个原始请求摘要与账本对应。
- 受影响接缝定向重跑六个脚本均 exit 0：新完整 producer、D1 delegation edges、Bridge focused、合法积压、真实 TCP 背压与 model gateway；分别保存在 `command-fetch-final-capture-plnu5vfk`，没有重复整个 21 条套件。identity、ownership、生产关停、旧附件图片与 X2 等未改接缝按原记录的适用性复用。

早期 `command-fetch-native-dNXNSt` 的 probe 虽 exit 0，但逐 Buffer 单独转 UTF-8 使最后两个大中文请求捕获出现 U+FFFD，不能称为完整 raw body/ledger 关联通过。独立审查仅将原生 Session 原始 user 内容还原，即精确对应原 ledger；随后仅修采集为合并 Buffer 后解码，并重跑上述正常/失败两原生专项。旧证据保留为采集差异诊断，未据此修改产品转发、预算或结果数据。

D2a 最终收口由控制器记录为独立有界 APPROVE，包含上述大命令引用修复与最终原生请求关联。随后 D2-IDENTITY-TEMP 固定临时文件残留问题由独立 owner 最窄修正并收到 FINAL APPROVE：使用唯一临时名，保留原身份、锁、NOFOLLOW/0600 与 fsync 顺序；8 个定向 case 通过，修前两反例保留。批准与原始证据导航在 controller 的 `host-identity-temp-final-approval.json`，不将该本地组件结论扩大为业务链或 OS 断电测试。

## 远端图片、表格 Job 与成果上传（D2b）

控制器已记录独立最终有界审查为 APPROVE，无剩余 Critical/Important。该结论覆盖下述本地 D2b 候选、故障专项与同成果独立浏览器复核；不扩展为完整 v4.2、外部真实业务或发布认证。

远端父进程现在可显式配置 `officeEnabled:true`；默认关闭，本批只在 B 开启。父进程通过 Node HTTP adapter 注册图片 variant、刷新附件短令牌，并访问现有表格 authorize/read/prepare/revalidate 服务。表格仍使用原受控模板、原生成 worker、同一个 Host Journal Job 域和原云端独立字节核验。Node 长期 credential 只保留在父进程；模型、附件与成果上传各用原专用短令牌，Job、工具返回和 worker journal 不保存上传 token。

新增 Office HTTP 路径只接受当前 Node/instance/完整 execution binding，按当前员工/grant 重验权限。`upload-token` 仅接受 binding 与 Job ID，从云端已接受的 sealed Job receipt 投影选择原输出，不接收 Host 自报路径、摘要或整 Job。ready 只读回执同样重验当前授权，完成状态不会发放新的业务 token。普通 Bridge/SSE 仍为 256 KiB；prepare 请求/响应与 Job event 使用独立 4 MiB 上限，复用原 event/digest/ACK 事务。共同 Job 投影校验明确限制固定字段、1600 行、每行八个照片引用、既有引用格式、时间戳、reason 与停机文件声明；不以尺寸校验替代成果核验。

累计资料仍限定去重后八份。修前真实 FileStore producer `attachment-admission-VncK0S` 已证明第九份补充可以受理、随后 gateway 拒绝执行；修后在新 input 的同一附件受理事务内先校验完整历史 union，再绑定、增版本、写回执。`attachment-admission-kFWTtS` 证明越界事务回滚、原附件未绑定、同 key 可改为合法请求后精确重放，取消仍可用。原历史与已接受命令回执不重写，也未扩大总引用上限。

本批三个权限/停机接缝采用了最窄修复：请求体到达后重新读取并认证 Node；ready init/verify/content 与上传回执在相关 I/O 后按最新授权返回；真实 stopped/settled 且有同 binding Job 停机证据时，被拒的普通 Job event 保持 unacked，后续真实停止回执仍可提交。UI 只根据已接受停止回执里的 Job 停机证据显示“生成已停止”，不把旧云端 Job 历史改成停机事实。已经匹配原 sealed receipt 的 event ID/digest，可在当前 Node credential/instance/full binding 校验后返回原 ACK；cleanupOnly 仍拒绝新 Job、变 payload、读资料和新 token。

### D2b 实际验证与边界

- `test-spreadsheet-remote.mjs` 使用 FileStore、真实 HTTP Node client、原 Host Job 与真实 XLSX worker。`spreadsheet-remote-zBS8gz` 的六份历史/两张照片覆盖 1200 行，prepare 请求 640456 B、响应 996561 B、Job event 641542 B；`spreadsheet-remote-AoGHQT` 覆盖八份历史/1600 行。`spreadsheet-remote-7ZFP7Y` 另测每条 description 2000 字、owner 200 字的合法原文件、超 4 MiB 请求和超限 envelope 字段拒绝。均完成原字节云端核验与独立 ExcelJS 读取，不把无效的十六份 union 当容量正例。
- `probe-spreadsheet-remote.mjs` 最终在 `spreadsheet-remote-native-NfHEPW` 实际 exit 0：真实生产 `start` 的 remote API、独立 B 父进程、原生 DSH、浏览器上传照片/历史、追问期限与两次 typed 修订、实际 read/start/get 三个工具、原 Job worker、候选 HTTP 上传、云端独立核验、刷新下载与 settle。期限为 2026-11-20，三条次数为 2/1/2，汇总为 3/2/2；下载 SHA256 为 `926a215decdef188fc564334e1b3310a080c32a5d5aba98bc70da4dc5531905d`。全部十条原始 provider body 的 canonical digest 与 ledger 对应，各 Work 仍共享自身十二次上限。忙生成器通过 UI 停止，实际进程退出、无 ready artifact，表格面板明确显示已停止。控制器及独立浏览器随后只读重开同一结果，重载、下载与停止页证据在 `d2b-ui-independent`，没有重新生成工作。
- 权限竞态真实 HTTP baseline `spreadsheet-remote-AmtjAB` 在暂停请求体、撤权、续体后错误返回 ready；修后最终定向脚本 `spreadsheet-remote-YJtmdx` 为 403，原候选 token 的 init/verify/content 三路径同为 403，合法 completed receipt 重放仍成功。已接受 Job event 撤权后精确返回原 ACK，变 digest/新事件拒绝。`spreadsheet-remote-rMxkFe` 证明普通 Job event 被拒后仍未 ACK，而真实 stopped ACK、Work cancelled 与停机证据投影可收敛。`spreadsheet-remote-Ttjchj` 以真实 Job stop producer 验证旧 Job 已停、Attempt 仍 runnable 时，新 revision 的输入、Job 与最终 settle 可继续；该专项使用模拟 Agent，不冒称额外模型停机工具。
- `--offline` 在 `spreadsheet-remote-eL9pP6` 和控制器独立的 `spreadsheet-remote-c4x9j4` 通过：受控 HTTP 503 使三次派发前 revalidate 失败，Job 保持 accepted/not_started、无 worker；恢复 HTTP 后同一 Job 正常生成交付。这是连接失败注入，不是物理断网实测。`--old-version` 的 `spreadsheet-remote-UVjPoP` 拒绝新版本下旧 Job 的 token 和旧 token 的 PUT，保原候选字节、无 ready，并可实际停止。
- `--response-loss` 的 `spreadsheet-remote-V8jdsN` 在云端已处理后分别断开 upload-token、candidate init、content 的 HTTP 响应；重试使用原 binding/Job，最终仍是一个 artifact 和原字节，已发布文件 inode 不变。上传 token、Node credential 与跨 Job token 用途互换均拒绝；没有将 token 响应丢失当模型重试。
- `--api-restart` 的 `spreadsheet-remote-mQMKnc` 关闭并重建实际 HTTP API 服务实例，在原 port/FileStore 上使用新的 Artifact token map；旧 token 返回 401，原 Node 身份可为同一已封存 Job 取得新 token，原生成文件的 inode/字节保持，随后正常核验交付。该专项是同进程内服务实例重建，不冒称 OS 进程 SIGKILL；D2a 的生产 API 进程重启按原接缝另有证据，Node 父进程重启不被当作本条 token map 丢失证据。
- `probe-spreadsheet-remote-recovery.mjs` 的候选路径 `spreadsheet-remote-recovery-iCSyX6` 在实际 B 父进程 SIGKILL 后，使用同 Node instance/Session、原 Job、原 inode/字节恢复并核验 ready；forward 前后均四次，无新生成或推理 worker。运行路径 `spreadsheet-remote-recovery-h5YnCG` 在模型轮已 idle 后杀父进程，按旧 PID/startTicks 终止原 generator、保留 unknown/无输出，随后取消收敛；forward 前后同为四次，无新生成。此路径可为 Session 读取或清理创建 runtime 进程，默认附件短 token 的存在不等于新的模型许可；不声称零 runtime/token，也不泛证全部模型飞行组合。原生恢复前后角色快照保存在该根。
- 冻结源码的四个定向回归及 diff/staged 检查均 exit 0，原 stdout/stderr 在 `spreadsheet-remote-final-capture-0b87o67a`：远端正常权限/回执、实际 Job stop、旧本地 X2 artifact 核验交付、D1 delegation edges。另本次旧 X2 完成竞态十种窗口为 `spreadsheet-completion-races-s2IrNr`，四种恢复与旧状态迁移为 `spreadsheet-recovery-sKojqy`，派发前停止/撤权为 `spreadsheet-launch-stop-lMEGkA`，Bridge 身份/SSE/清理回归为 `bridge-focused-fKvkHK`。旧已适用的预算、图片规范化、命令 fetch 与生产关停证据复用，不重复整个 D2a 套件。

保留失败诊断：`spreadsheet-remote-native-KxGHFY` 的 Job 403 阻塞真实 stopped 为产品接缝，修复后由 focused 与最终 native 关闭；`xUALO6` 的 API 不能有任何 child 断言过强，后续实际记录其 child 为 flock helper；`6ouj3T` 只覆盖 read/start，第三工具的 fixture 关联修正后才取得最终 NfHEPW。恢复 probe 最初 HPMqUL/Nl1w1S 的 refs 正则错误和 WPLiy8 将清理 runtime 误判为推理的断言均保留，不改写为通过。完整索引为仓库外 `spreadsheet-remote-final-results.json`。

本批只完成单远端 B 的图片和 X2 成果路径，仍是同一开发机的 loopback 模拟与受控 provider；不证明真实图像理解、公网多机、真实工厂数据、Microsoft Excel 桌面运行或完整五角色业务。后续 D3 的受控目录/网关只读工具/独立 analysis/三方群证据，以及 D4 五角色合表仍按批准合同另行实施。身份临时文件后续修复见 D2a 限定批准记录。本批未 stage、commit、push、PR、部署或写真实设备/业务数据库。

## 受控资料采集、Evidence 与发布者自读（D3a）

本批实现 A 的受控历史 JSON 读取和 G 的受控站点快照，经过父进程安全采集、持久封存、独立 HTTP 字节核验与授权分页读取。控制器已收到原独立 reviewer 的最终有界 APPROVE，无未闭 Critical/Important/Minor。完整原始结果导航为仓库外 `geneway-evidence/evidence-final-results.json`；本章记录实际验证及适用边界，不授予发布认证。D3b 的跨收件者分享、三方群问答、独立 analysis，以及 D4 全拓扑合表尚未进入本批。

### 权限、采集与页边界

父进程 profile 固定资源到本地根目录、dataset/section、能力、条数/字节/window 上限、导出员工和时钟信任。模型只见资源与有限参数，不取得根目录、Node 长期 credential 或业务 secret。源文件最多 64 KiB、200 项，使用原安全文件机制核验祖先与文件类型、NOFOLLOW、打开前后 inode/大小/mtime。history 和选中 site events 均在筛选 window 前完整校验；未选 section 不读取、校验或导出为已采集事实。仅显式选择 `collector_health` 才有 health，未选择 `recent_events` 不以空数组冒充已查询无事件。

云端 Evidence 是独立不可变域，验证实际 bytes/hash/schema、完整执行 binding、已消费 Input、当前成员/员工/grant/资源版本，再与 ready、唯一生产 access receipt 同次提交。`EvidenceReady` 不完成 Work。发布者自读要求资源 `evidenceReaderAgentIds` 与封存 profile 的 `exportToAgentIds` 都明确包含生产员工；缺省均为空，采集权限不自动授予云正文读取。工具采集返回有限 ref/quality/time，正文只能经实际 `read_shared_evidence` 授权入口取得。每次发 token、metadata、页以及相关异步 I/O 后返回前均核验当前授权和 revision。

分页上限为每页 16 KiB、最多 16 个完整 item，非 entries 开销最多 2048 B（包括最长 1024 B cursor），每链最多 32 页和 128 KiB。长资源 ID、完整 binding、profile 等只在受保护 metadata GET，不重复进入每页。签名 cursor 绑定 ref/version、receipt、revision、索引、链页数/字节与有效期；篡改、过期、跨 receipt 和版本不符均拒绝。site 的 `current` 仅指固定测试策略下 `0 <= observedAt-sourceTime <= 120s`，过旧为 stale、未来/缺失/不可信时钟为 unknown；始终标明 fixture，不宣称物理现场真实性。

Store 为 `schema19`，Host Journal 为 v3。迁移从旧版本增加空 Evidence/receipt/capture 域和默认空 reader ACL，保留预算、模型、委派、附件、Job 与成果事实。旧含 multisite/Node/Work 的外部状态备份仍由原 guard 明确拒绝；没有另建 Evidence 文件备份平台。旧 X2 模板、单执行员工限制和 Work 的十二次模型预算不变。

### 封存传输与停止

新采集采用 v2 顺序：本地快照文件 fsync，普通当前授权下 init 持久云 pending 声明，再 journal sealed，最后 PUT 原 bytes。声明固定 capture ID、完整 binding、revision、资源与 profile digest、原 SHA/size；同 request 重试不会因源文件改变而重新取样。profile digest 固定影响采集/导出的根目录、映射、能力、限额、export 与 clockTrust，云端不保存本地路径。

父进程恢复扫描只允许匹配已存在的 v2 pending/ready 和原 declaration digest。原 sealed 文件及 profile 校验通过后，经专用 `resume-upload` 取得有限传输 token；unknown 或因中断 interrupted 只在此原声明传输入口例外，不能新建采集、改 hash、读页、推理或完成 Work。扫描不占 Loop 槽、不调用 runtime start/resume、不读取源文件，也不把发布成功当成活动证明清除 unknown；网络不持 journal/runtime 锁，停止可中断并等待清理完成。整个 Host 仍可能为读取旧 Session 或 stop-only 创建 runtime，实际保证是模型账本零新增 forward，而非整个父进程零 runtime/token。

旧 legacy1 sealed 的普通当前重试仍可由父进程复验持久原 request/binding/hash 后，带有限 `legacyRetry` 走普通 init；模型不能选择此参数，新采集只能 v2。云端不声称能证明旧本地历史，不存该标记、不补 profile/declaration digest、不升级旧事实。unknown 自动恢复始终拒绝 legacy。遗留 accepted 或持久 failed 且没有封存的原请求，返回安全的“未完成封存；请使用新的采集请求重新读取”提示；首个 ENOENT 保留错误码而不向模型泄露私源路径，sealed 网络失败仍要求原请求重试。

资源撤权时，普通读取/发布/模型权限继续严格拒绝；当前 Node credential、实例、workspace 和既有完整 binding 校验后的 cancel/settle 清理不再依赖已撤销的执行资源权。active Node 的旧普通事件若被拒，仅在同 binding 已有真实 terminal 以及 sealed idle/never_started 停机证据时可让后续停止回执先发，旧事件保持 unacked，stopped/settled 自身失败绝不跳过。已有 Node cleanupOnly 与 Job 的实际 workerExit 清理语义保留。

### 实际验证、修前诊断与边界

| 命令或原始证据 | 实际观察与适用范围 |
| --- | --- |
| `test-multisite-evidence.mjs`，`evidence-focused-Y8zHCz`；控制器独立 `VSupYS` | 当前 v2 的真实源文件、FileStore、HTTP、自读 receipt 和 AgentDelivery；history/site 各 200 项、13 页，源变后仍原 sealed bytes，新 revision 拒旧 read。Agent 模型运行时为模拟器。 |
| `--no-reader` / `--no-export`，控制器独立 `qlJ3t2` / `16yFh1` | 两员工实际采集发布，但 ACL 交集缺一即没有 selfReceipt、read 拒绝；不手造正 receipt。 |
| `--long-resource --site-worst`，`XGwRV2` | 合法 200 字符资源声明不重复进入页；最大转义 site event 和 health 的实际最大页 16315 B，200 项共 13 页/50200 B，原 16 KiB/2048 B/32 页/128 KiB 均满足。源的 64 KiB 上限仍在，不声称可塞入 200 个最大 item。更早 16000 字符 ResourceID 被既有 grant ID 上限拒绝，是不支持输入，未扩大域。 |
| `--site-policy`，`3X2Wj1`；控制器独立 `M4eLZJ` | health-only/events-only 省略未选 section，未选畸形/secret 不导出；current/stale/future/unknown-clock；实际 HTTP 受控 clock 验 token 401、cursor TTL/tamper/ref version 拒绝和新链。不是实际等待或现场时间验证。 |
| `probe-multisite-evidence.mjs`，`evidence-native-wTq4zZ` | 真实 production API、独立 A/G 原生 DSH 各自采集、各读两页 32 项；两 Session、两 Evidence/生产 selfReceipt，10 个原始 provider body digest 与 ledger 对应，内容顺序/独立 oracle/秘密不导出/实际停止通过。每源尚有 8 项未读；200 项全遍历是上行 HTTP 模拟 runtime 证据，不合并成原生全读。该原生旅的工具/页路径适用，后补 v2 顺序由恢复旅另证。 |
| `test-multisite-evidence-faults.mjs`，`p74HeP`，当前 response-loss `evidence-faults-Lqn4TH` | 真实读取中撤权/改 revision、hash/schema 拒绝、HTTP 成功后丢响应、源变仍原 bytes/单 EvidenceReceipt。ready-write 仅在临时 metadata handle.writeFile 看到 ready+Receipt 草稿后注入 EIO，属于 pre-rename 写失败；不能表述为新测 fsync/rename/dirsync 四类。控制器另独立 `iebZdT`、`dDz29f`，原 F 文件故障机制按相同接缝复用。 |
| missing-source，`crR5W0` / 控制器 `RLe91M`；accepted 负组件 `evidence-unsealed-component-e3ISek` | 官方 DSH ToolRuntime 实际输出明确未封存/新请求指引；首 ENOENT 无 path、持久 reason 保留。accepted 恢复从真实 binding 仅负向 clone accepted/nullseal，真实 journal/manager 变 failed，其余 facts 不变且零读取/init/publish；不是 OS accepted 崩溃或新的正向云事实。 |
| `probe-multisite-evidence-recovery.mjs`，`Y1VSYC` | 新 v2 云 pending、本地 sealed、PUT 前真实 SIGKILL，移除源，同根/实例重启后原声明/hash/bytes ready+published；唯一 raw provider digest 对唯一 ledger，forward 1→1、Attempt unknown 保留，实际停止。 |
| 同 probe `double-restart`，`HQvxQ1` | 第一恢复上传成功丢响应，本地仍 sealed；第二次真实 SIGKILL 后仍原 ref/bytes 发布，forward 1→1、unknown、实际停止。 |
| 同 probe `profile/missing/corrupt/revision/revoke-node`，`o7KTEY/LF0F6n/Tct5QC/CdfnDz/by5Cyt` | 分别拒 profile 内容漂移、文件缺失/损坏、旧 revision、Node 撤权；无新发布/新 forward，随后实际停止。profile 等快速负例截取时 runtimeStatus 仍 running，不冒称所有负例均已 unknown。 |
| 同 probe `revoke-resource`，`drFjoM`；`test-multisite-cleanup.mjs`，`cleanup-focused-OcwdOs` / 控制器 `1TJB7V` | 原资源撤权后 cancel 实际到达，真实 idle stopped/sealed proof 精确 ACK，旧 ordinary runtime_unavailable 保持 unacked，Work cancelled。guard 对错身份/实例/版本/workspace/fullbinding、无 proof/错 binding/未验证 proof、stopped 自身失败均不放行；正例来自真实 HTTP/AgentDelivery/stop，负 proof 仅删改已有事实。 |
| `test-multisite-evidence-legacy.mjs`，`lcry2M` / 控制器 `Z8cDMK` | 使用原 tvkq42 真实 v1 sealed 快照及原 bytes，源缺失、云无行、current 普通重试成功；旧字段不升级/不补 digest/flag，真实转 unknown 后 legacyRetry/resume 拒绝。 |

修前失败与诊断全部保留：`vGYWeA` 实际复现 invalid-time 被 window 滤掉后错误发布 empty/current，修后 `6tGQKf` 及控制器 `X4Pcin` 在发布前拒绝；`UHhnAM` 实际复现缺失源路径泄露，修后有限错误出口关闭；`tvkq42` 是旧顺序真实父恢复无法发布的 baseline，不当恢复成功；`LQpubZ` 证明资源撤权后 cancel 尚未投递，Host 只有 launch、没有 stopped，不能称其已实测停止回执 HOL，后者原先是源码可达推断、随后 guard 和修后 native 实测。最早 `LgYupE` 为测试 command key 跨 Work 复用，`LK6fp8` 为生产 Resource DTO 尚缺 reader 字段，分别在最近边界修复，原证据不删。

最终八条定向命令及原始 stdout/stderr 在 `evidence-final-capture-zxpuemq2`，实际均 exit 0：当前 v2 response-loss、旧本地 X2 artifacts、远端 Job stop、旧 XLSX 四种恢复和 Host 迁移、P6 schema19、P2 原备份 guard、diff、空暂存。旧 cleanupOnly Bridge 回归 `bridge-focused-0RxvPY`、控制器 D1 `delegation-focused-iDv64C`、原 F 附件 checks 亦通过，只支持各自受影响消费者。没有重复 D2a/D2b 整包，未改 identity/ownership/生产关停接缝按原索引适用性复用。

这些结果只覆盖本地隔离 loopback、受控 JSON 和合成 provider，不证明真实工厂数据、公网多机、全部 HTTP/模型飞行组合或完整五角色业务。身份临时文件残留已按前述限定范围独立修复并批准。当前没有本任务 live fixture，未 stage、commit、push、PR、部署或写真实设备/业务数据库。

## D3b：显式证据转交、定向问答与 Work 预算（本地最终候选）

D3a 已收到独立最终 APPROVE；本章在其 v2 sealed/pending 恢复、legacy 普通重试和清理不变量上继续。D3b 与本次原计划所需预算增量的源码已完成，原始命令、实际退出状态、诊断和证据适用性集中在仓库外 `geneway-evidence/sharing-budget-final-results.json`。本章记录实现和本地实测，不将局部审查代替控制器的整批最终结论；最终多来源 XLSX 与协调员工验收属于后续 D4。

证据转交只由原 agentCommand 事务创建精确 receiver Receipt：delegate、child result 到直接 parent、明确 share 各有独立来源。交集仍是 issuer 当前读取 Receipt、Resource readers、sealed export 和同 Work 有效接收者；裸 ref 不授读。B 的 execution 无 A/G 私源采集权，实际 capture 拒绝，但可委派 A/G 并在真实 result 转交后分页读取。独立 analysis 有自己的 Session，所有新 `analysis.classify.v1` 委派使用固定 `geneway.analysis-result/1`，旧已持久 schema/result/ACK 不回写。云端校 hash、条目/事件边界、sections、当前权限和确定性字段约束，不认证任意自然语言结论真伪。

observation 只记历史，不产生 wake 或读取 Receipt。question 指定唯一责任 Attempt，answer 要求该责任方真实消费原问题；Host 依 sealed wake 的精确 message ID 记消费，不按 replyTo 批量补读。系统 question_closed 使用独立 Host control_consumed，明确区别于模型 ingested；界面显示“关闭通知已送达”。真实修订、取消和撤权关闭相应等待。临时预算不足、deadline-only、运行结果未知本身不伪称撤权：问题生命周期通过仅供内部调用的完整 current authority 检查，继续核双方 binding/member/employee/Node/祖先 grant/route/附件；普通模型、工具、answer 和未知恢复资格保持原门。

FileStore 当前为 v21，Host Journal 保持 v3。预算策略独立绑定 workspace 和实际 Work 负责人，管理员 session/Origin/CSRF、CAS、稳定命令 ID 与原因审计均沿原服务事务。只有新工作明确选择策略才保存 v2 冻结快照；未选或旧 Work 仍原 `limit/reserved/exhaustedAt` 三字段 12 次，不补虚构 token/费用字段。现有工作只能明确调整当前限额与执行截止，不改原价格/估算策略、旧请求、未知事实或员工权限。管理员界面可编辑策略，新工作可显式选择，工作详情可调整同一工作并查看审计；冲突时保留草稿，须回读新版本。

唯一 forward 账本仍为 modelRequests，实际完整 JSON UTF-8 字节、实际授权 max_tokens、冻结服务端 provider/model 模拟单价按整数向上取整预留调用/token/费用。失败和未知不退款；实际 usage 未知及按 usage 计价金额未知保 null，不写 0、不称供应商账单。v2 不足形成明确 no-forward hold，原 request ID 未预留账本；只有官方 idle → whenIdle → flush → 再确认 idle 后释放普通槽，管理员调整后由精确 resume 真实消费续行。同 Work 新 Input 不解除不安全 hold；queued 旧 revision 的 no-forward resume 可安全历史化，晚到旧精确 receipt 只记历史，不能授当前模型执行。

执行截止与业务整改期限分开。普通派发、模型、工具、采集、Job 启动和关键结果/ready 提交仍核当前 deadline；短 token 不晚于截止，调整后收紧旧 token。已排定的长流中止 timer 不依赖到点后的 Store 读取，明确延长只重校同一请求的 timer，不重发或改原 reservation。已 forward 后到期保持 unknown，重开或延长不使其重发。精确 closure、cancel、stopped/settled 和旧 receipt 清理仍可达；已 ready 的用户文件下载仅继续校原数据权，不将执行截止当数据删除，Agent 工具没有该下载例外。

| 实际命令/证据 | 实测边界 |
| --- | --- |
| `test-multisite-evidence-sharing.mjs --questions`，`2YK6ay` | 真实 source/HTTP/Receipt/AgentDelivery，共 2 Evidence、10 Receipt、3 observation、5 question；B 仅读授权证据、独立 analysis 固定结果、键顺序等值/重复 ref、越条目/事件、丢 ACK 与精确解除证明均过。模型 runtime 为模拟器。 |
| `--permissions/--denied-export/--question-revision/--question-cancel`，`cuDRr3/uihGB5/6KKix3/iXQvIK` | 跨 Work/错 hash/旧 revision/已完成 receiver/缺 sealed export 整事务拒；旧 answer 历史化、control 消费与普通未读门区分。 |
| `probe-multisite-evidence-sharing.mjs --control-revoke`，`URTRS9` | 原生 B 已停轮后另一 Node 撤权，完整多 frame zstd 读取中原 user/message 为 1→1，control 不进 DSH；7 raw body/ledger，0 新 forward，真实停止。旧 `oOuNso` 仅首 frame/header 的 0==0 采集缺口保留，不能据其宣称消息不变。 |
| `--with-question`，`8ub2Dz` | 原固定 12 下真实问答已消费，analysis 第 13 次未 forward/未完成；这是 budget_limited 原因证据，不当业务完成。 |
| `--budget-resume`，`ysoEvQ` | 同一 Work、4 个原 DSH Session：12→官方安全 idle/flush→明确管理员 20→精确 resume append/flush/云消费后再预留→analysis 及 B 真实消费。15 raw canonical digest 对 15 ledger，原 12 前缀和 A/G 结果不变；usage 未知保 null，最后实际停止。合成 provider/单价仅为测试配置。 |
| `--budget-latest-input`，`nMSfZw`；HTTP `--queued-input`，`1kf3Mo` | 前者原生旧 resume 未投递屏障后实际 Input2/B+analysis 原 Session 新 body，14 body=ledger、旧结果不升级；后者 HTTP/模拟 Session 已消费但 receipt 晚到时仅历史 ACK，最新 Input2 仍可消费。两个窗口分开，不冒称原生晚 receipt。`um4a7q` 的最终 3 ledger 在 `api/state.json`，顶层 state 是续行前 2 ledger。 |
| `test-multisite-work-budget.mjs --store-faults`，`CAO4Ea` | reservation、hold、adjustment 三个临时 metadata writeFile 在底层写之前注入 EIO；无 false ACK/额外 forward/audit，同 key 重试唯一事实，FileStore 对象重开预算域/账本不清。不是本片新测 partial write/fsync/rename-dirSync/OS 断电。 |
| `test-multisite-budget-deadline.mjs`，`GqTiaY` | 真实 HTTP 长流跨旧短 deadline 延长后仍活，再缩期限中止；1 body/unknown reservation 不变，API 对象重开后延长仍拒重发；过期普通业务拒，cancel/stopped/旧精确 receipt 通。独立 reviewer 另用 Store read 屏障验证 timer 在读仍挂起时已 abort，是内存网关/stream 组件证据。 |
| `test-spreadsheet-deadline.mjs --candidate`，`OeblG8`；不加 flag，`kLbjEE` | 真实 XLSX worker/云独立 verifier 后屏障跨 deadline，候选拒 ready 并保留、过期可停；真正 ready 后到期用户 HTTP 下载原 SHA/ExcelJS E3 业务日期，Node 数据权撤销后同入口 403。模拟 Agent，不冒原生 Office 新旅。 |
| `test-multisite-evidence.mjs --deadline`，`OPVNXb` | A/G 各 200 项/13 页，实际 v2 init/seal 后 PUT 屏障跨期限；旧 token 401，新读取/采集/resume 409，pending 原事实无新 Receipt，原 ready 不删，停止通。 |
| `test-multisite-budget-dispatch.mjs`，`JPzEUa`；`--question-deadline`，`LTT41H` | 本地真实 drain 在 Host intake 前挡过期 launch、runtime 0 start、never_started 清理；过期普通 observation 拒，但精确系统关闭通知仍真实 control 消费/fetch/ACK，未假模型 ingested。 |
| `probe-multisite-budget-parent-death.mjs`，`dSD7eb` | 单 B 原生，受控 HTTP 扣住 WAITING_BUDGET 响应与未投 budget_wait，云 idleAt null/本地 slot 仍占且无 idle proof 后真 SIGKILL；同根同 Session 重启 unknown、原 1 body/ledger 不变、无 resume，管理员不能复活，实际停止。不是以错误响应冒 idle。 |
| `test-multisite-question-budget.mjs`，修前 `5U568P`；修后 `qeY1Kl/Ho5l3H` | 修前真实已消费 openQ 在 hold 后被 drain 错关闭；修后预算暂停与单纯到期分别保原问题，明确调整后责任方同 Session 答原 ID/B 实际消费、无新 human revision。第二方撤权/后置附件坏与 unknown 分类为真实 scanned 状态负 clone；deadline-only 修前是同门源码因果，未补称原 HTTP baseline。 |
| `probe-multisite-budget-ui.mjs`，`1du9Vh`；独立 `budget-ui-independent` | 实际桌面/390px浏览器、同工作调整/原因审计/CAS 保草稿、独立策略编辑和新建、空闲 C 显式 v2/已完成 A 默认 legacy12，原 ledger/Evidence/results 不变、0 新模型。独立只读浏览器 GET+login、7截图、整 state deepEqual；本次不 submit，CAS 冲突依作者原操作，fixture 无 dueDate 不冒视觉核实其值。 |

最终相关回归的实际 exit/stdout/stderr：`sharing-budget-related-9d0xrylz` 中管理员 HTTP consumer 和 `--questions` 为 0；`sharing-budget-related-zo3k9zl7` 的真实 D3a v19→v21/Host3 保事实迁移为 0；`sharing-budget-related-wpgg1xwh` 的旧 model gateway 为 0，保共享原 12、unknown 不重发、usage、SSE 结束与 reservation write/fsync/rename-dirSync 旧机制。最初旧 gateway 脚本没有真实消费 Input 被正确拒；补 Host 后故障循环未停止、占满槽，又正确未投递。只改验证 producer 为真实 Host/AgentDelivery 和每个独立故障后 cancel/drain，生产消费/权限/槽位门未放松。首迁移命令目录前缀误写 ENOENT 也保留，仅纠正真实证据路径。

其它失败诊断保留原产物：QTK7fY 已到期拒绝后测试误假定 optional artifactRefs；c2y3Wl 已下载但 oracle 读 E2 标题而非 E3 日期；Ae8Mzz 代理误把 POST Hostevents 与 GET SSE 一起 503、未到父死点；cqkfUv/ZnAgDH 的新建步骤误用仍活动 B，被原 AGENT_BUSY 正确拒绝。最终 UI 改用合法空闲 C/已完成 A，没有解除每 Agent 单活动 Attempt。旧本地 artifacts `sq2Iqo` 与 candidate recovery `gmtk0j`、typed command-fetch `5R0fS6` 是控制器独立通过的受影响 consumer，直接复用，不重整 D2a/D2b。

当前结果均为本地隔离 loopback/受控源/合成 provider 与模拟价格，不证明现场物理真相、真实厂商账单、公网多机或全部飞行组合。D4 最终五角色与多源 XLSX 尚未在本章实施。未 stage、commit、push、PR、部署或写真实设备/业务数据库；用户旧计划文件保持原状。

最终费用显示 Minor 已最窄修正：合法最大安全整数 `9007199254740991` 微单位不再经浮点 `toFixed` 显示为 `9007199254.740992`，改用整数拆分准确显示 `9007199254.740991`；当前 Web helper 本身的 0/1/999999/1000000/MAX_SAFE_INTEGER/null/undefined 与币种原样断言、Web 语法均通过，原账本和授权门未改。原表达式反例及实际命令 exit/stdout/stderr 在 `budget-money-_j3jhsr7`，未重跑原生或浏览器业务旅程。

D3b 与 Work 预算增量现已分别收到独立最终 APPROVE，对应 `sourceFrozenAt=2026-11-05T21:17:02.613931Z`，均无未关闭 finding；上述实测与未验边界保持原表述。控制器随后授权继续 D4，不将此结论扩大为整个附件目标或部署通过。


## D4 多来源整改表：本地实现与模拟验收已批准

D3b 与预算最终批准后，本片新增受控 `incident-collaboration-v1` 四工作表模板、固定 B 产出绑定、同 B Attempt 的显式期限采纳、服务端来源 manifest、候选专用结果，以及协调者实际单元格分页与最终审核。旧 `incident-register-v1` 仍保留单员工协议和原文件完成路径。schema 21→22 仅增加空的产出绑定、采纳、读取、审核与用户问题域；两份原 v21 真实状态（原生预算/Evidence/结果、旧 ready XLSX）经 FileStore 迁移与重开，所有旧字段深相等。原始命令、结果与边界索引在外部 `geneway-evidence/spreadsheet-collaboration-results.json`。本片已由两位原独立 reviewer 批准当前实现及模拟验收；Office 容量按后述 v2 与完整字节界收口，ready 后权限依用户最终选择沿成果自身授权，定向证据见后文。

首个 v1 生产原生主旅程 `TtpTu2` 已实际退出 0：手机上传照片、协调者委派 B、B 委派 A/G 真采集，三条 observation 与定向问答、独立 analysis 读取两来源各 20 项并提交固定 schema、B 实际消费结果；稳定用户问题由另一 browser context 回答。真实 rev2 生成进程忙时手机提交 typed dueDate 修订到 rev3，B 原 Session 显式采纳旧 producer-rev1 来源、重新生成当前版本。rev2 worker 在 Input3 后 SIGCONT 自然完成历史 candidate，并非被修订中止；只有 rev3 candidate 最终发布。B 的云核验只产 candidate，B 经专用结构化结果完成候选职责并显式分享来源；协调者原 Session 读取四 sheet 全部 23 页，完整正文进入实际模型请求后，原 Artifact 服务单事务写 ready、Work/root completed 和 settle outbox。手机 reload 下载与云原字节 SHA 一致。实际 45 raw provider body 对唯一 45 ledger；测试显式策略为有限 64 次与模拟单价，不修改默认 12，也不预称 20 次足够。

作者独立 oracle 脚本不导入生成器或产品 verifier：直接核原模拟源与 ExcelJS 下载回读的 20 条历史、汇总 20/2/19、20 条现场事件/health/unknown/fixture、两个 analysis finding 的 basis/limitations、原 manifest，以及五个 Session 各责任 Input 的稳定 user/message 恰一次。此是作者的独立 oracle 方法，不代替独立 reviewer 结论。另一个同生产入口 Work `RNpMSt` 在真实 worker SIGSTOP 屏障后由手机 UI stop，实际 exit_confirmed、no_published_output、Work cancelled、无 ready/review，页面明确“生成已停止”；24 原请求与 24 ledger 对齐，取消时在途结果不冒成功。

唯一最终门复用 D3b 必要消息消费谓词：真实未读普通 answer 的修前 `m277MF` 可错误完成，修后 `J2V5L4` 即使完整页已进入模型也拒绝，原 Host 真消费同答复后才同 key 完成，不加用户 revision。只有有效 `question_closed.controlConsumedAt` 可按原合同豁免，不能给普通 answer 写控制字段假已读。稳定用户问题来自真实 B report event，当前 output B/问题 ID/责任 binding/revision 受理；`TK94Eg/U9jHz7/Y8GMMA` 覆盖预算 unsafe hold 仍可由 owner 回答、真实 Node 撤权及 unknown 分类拒、陈旧回答/原 ACK 不清新问题、第三者与非产出角色拒；保持普通模型预算门和真实各 Session 消费。

`Jid8H5` 真实 HTTP/AgentDelivery（模拟 runtime）证明 completed B 后新 Input 不复活旧 B：旧 candidate 不能当前读/审核，不能跨 Attempt 采纳旧 Receipt；明确新 B、新 A/G 采集和独立 analysis 真读/结果回流，全 Work 非 root child 精确 8，第 9 个明确 CAPACITY_EXCEEDED，旧事实不改且停止可达。`iou1Zc` 在 C 完整页模型消费后真实 Resource CAS 撤当前来源权，后续页、携旧正文的模型请求和最终审核均拒，零新预留/forward，无 ready；原 Job 上传重试保原 Artifact/Job 事实。原 IO 和 Unicode 阻断已按前述独立子审关闭，旧失败证据保留。

修前容量实证 `rk7OHN`：同一获准历史 Resource 的 31 次合法快照各 200 条，加一份 site Evidence，共 32 个生产引用；完整 6200 行/一张照片请求 2,353,325 B 可进入专用 HTTP prepare，但同 builder 与原 sealed bytes 的完整输入为 5,222,750 B（其中 rows 2,352,591 B、内含重复 rows 的 manifest 2,381,911 B），超过既定 4 MiB。当前明确拒绝 COMMAND_TOO_LARGE，资料未截断、无 Job/Artifact/事实改写且可停止；该原始拒绝证据保留。控制器随后冻结 v2 紧凑表示与双向字节受理界，未提高传输上限或降低 32 refs/行范围。

直接受影响回归 `spreadsheet-collaboration-related-Uujofr` 8 条实际 exit 0，逐命令 stdout/stderr 已持久：旧 X2 Artifact、候选恢复、roundtrip、D1 委派、cleanup、预算期限、模型 gateway，以及新四 sheet/来源/消费负例。真实文件 I/O、真实 HTTP、模拟 runtime、原生 DSH、浏览器与独立审查按各证据实际层级分别记载；本地合成链不证明真实现场、厂商账单或公网多机。未 stage、commit、push、PR、部署或写真实数据库/设备；用户旧计划未改。

控制器复用的独立只读浏览器 `d4-ui-independent/run-H8a3UC` 实际 exit 0，10 张截图已逐张查看：同一成功对象 rev3/期限 11-25/下载 SHA 与四 sheet oracle，相同停止对象 rev2/期限 11-20/无下载；390px 无横向溢出、控件可达。只做 GET、登录与下载，两份 API state 和 provider JSONL 45/24 的原字节不变；不将这次只读核验扩大为 CAS/冲突提交操作。两 same-result HTTP 服务随后由 owner 优雅 SIGTERM，实际退出 0、PID 消失且两个端口关闭，无 Host 或新模型调用。


### 当前 v2 编码与最终定向补充

新受理采用 `inputEncodingVersion=2`、`geneway.spreadsheet-source-manifest/2`：有序 sources/photoRefs 字典与唯一 `rowMap={sourceIndex,entryIndex,photoIndices}`，typed dueDate 全局保存；prepared、Job projection/event 不重复 full rows，生成/验证仅临时展开。源 payload、analysis、各 Snapshot 身份不合并不截断。无 encoding 的既有 v1 Job 仍按其持久原 encoding 重建，原 manifest/input digest/文件字节不回写，模型参数没有旧编码开关。

当前受理域同时满足结构与完整 JSON UTF8 字节界：完整 request、prepare response、后续 sealed Job event 在 Job 受理前分别检查 4 MiB；不靠 `input-size-1024` 估计余量。`uAMA5E` 真正 32 Evidence/6200 行请求 2,353,325 B，v2 完整响应 853,345 B，四个实际 Job 包 366,785/366,781/366,812/367,018 B；真实 worker 输出 269,276 B，云候选核验、全部 6200 行原来源/描述/责任/期限/次数 31 回读与停止通过。字段极端组合可明确拒且不创建 Job/Artifact；`6gtYtu` 独立组件证明短 request 2,413,322 B 仍会因完整 response 4,348,929 B 单独拒。长 Node/Resource 字符串仅 codec/wire 组件，不称真实注册或全协议可达 metadata 上界。6400×8 photoIndices 是 DTO 上界组件；32 refs 且必需一份 site 时该样本最多 31×200=6200 条 history，不能把 6400 假称生产事实。

`os4rmP` 是新的 v2 完整原生/浏览器主旅程，实际 exit 0：五个原 Session、同稳定问题换端回答、真实 worker 忙时 typed 修订至 rev3、B 采纳/真实生成/云候选、C 完整 22 页实际模型消费、唯一完成/root settle、手机 reload 下载。45 原 body 对 45 ledger，下载 SHA `1a4e47703199d9c3dac8b4a6d61cff6861de9965f717ad6ac8b9d3098e2236a8`。其原源 oracle 与 Input 稳定 ID、4 sheet 内容均已独立代码回读；这是作者 oracle，不冒独立 reviewer verdict。该原生运行早于随后严格 revalidate 完整映射检查及 OOXML 字符补充；普通值不变，后两者分别有下述定向生产入口/原值证据，不将 45 次冒称跑在后改动之后。

`3HuUpr` 真实 Node HTTP 拒漏行/重复行/错 source/photo index、修正索引后乱序字典、混用 v1/v2、自报无 sealedJob 的 v1，各次 Store 深相等、无 Job/Artifact/成功命令，再正常 v2 worker/candidate/stop 通过。`compat-6MmWSd` 用真实旧 v1 状态副本验证 HTTP revalidate/重建/云 reverify 原 candidate，原 SHA/inputDigest/manifestDigest/Job 均保留；明确管理员仅调整当前测试副本执行期限，不恢复模型。旧 accepted 未上云、已上云丢 ACK 两窗用原 sealed event/immutable input 的受控历史回放，真实 HostJournal/Host.process 先精确 ACK 再 jobs.process spy 校原 revalidate，随后停止于 worker/runtime 之前：0 新 worker/runtime/model，不冒 OS 崩溃恢复。旧 X2 实际 worker/HTTP/下载回归 `2mlk9B` 由作者原 exec 句柄 `74447` poll 得到 terminal exit0；该脚本只输出终端 stdout，不生成 result.json，保留 state.json/host.json/Job 与 Artifact 原文件，索引据此引用。

新模板原合法文本还存在 OOXML 往返问题，修前组件 `bEmQ6f` 实际显示字面 `_x0041_/_x005F_` 被解码、C0/DEL 被剥、CR 变 LF、FFFE/FFFF load 报错与 lone surrogate 替换。最窄修仅在新四 sheet 最终 string cell 写入时做 OOXML 码元保护，先按 codepoint 分片再编码，保护重叠字面 escape，非 string 不变；原 Source/DTO/hash/verifier 继续比原逻辑值，旧 X2 未动。`B2pbKU` 17 组实际 ExcelJS 原值回读覆盖 C0/C1、TAB/LF/CR、emoji/ZWJ/组合字、lone surrogate、相邻 literal；`HjHvG6` 原 Unicode 分片回归保持精确。`C80Wbe` 将 literal/C0/CR/emoji 放入真实私源 JSON，真采集/封存/HTTP/worker/云核验/C 页模型输入/最终下载通过，模拟 runtime、3 个实际模型 HTTP body，不扩大为新 45 次 DSH 旅。

最后 I/O 门补充 `RMeOAw/VAQHv4` 均实际 exit 0：真实 workbook verification 完成之后，在 FileStore update 锁外屏障分别夹真实 HTTP Input2→3、真实 HTTP Resource CAS 撤 C reader，再恢复最终审核；当前事务拒绝，无 ready/review/新预留/forward，候选与旧 facts 保留且实际停止。此验证避免锁内等待变更造成死锁，也不把较早的 `Jid8H5/iou1Zc` 初始门证据冒称末次 I/O 门。

用户已明确选择已发布成果沿用自身权限：A/G 来源 Node 或 Resource reader 撤权不传播至既有 ready Artifact；当前 owner/root 与产出 B 自身权限、Work ref/version/hash 和原文件仍须有效。prepare、候选、协调读与最终审核前的来源全核继续严格执行，不授跨 Work Evidence 读取。`ready-artifact-authority-iMClu6` 对同一真实 v2 ready 文件实测 source-only 撤权后 200 且原 SHA 相同、随后 B 自身撤权 403，原 45 ledger 与业务事实不变。两位原 reviewer 已定向批准该用户决策差异。

D4 本地实现与模拟验收现已由 controller 记录为已批准，无未闭 Critical/Important/Minor，范围含 v2、OOXML、v1 兼容、真实页消费、最终 I/O 窗及用户确认的 ready 自身授权规则。记录位于外 Git `spreadsheet-collaboration-review-status.json` 与结果索引；不扩大为完整 M1b/M2、现场或部署完成。

### T26 固定可信 HTTPS 入口候选（本地 TLS 验证）

`GENEWAY_TRUSTED_ORIGIN` 由生产启动与 factory 共用规范化函数，未设置仍为 loopback HTTP，显式 HTTPS 根 origin 可经同机代理进入。API 监听仍限 loopback；Cookie 签发/清除只按固定 scheme 加 Secure，Origin 与 CSRF 仍分别验证，Host/Forwarded 不授予权限。内部模型本机地址、Node Bearer/实例绑定保持原路径。SSE 仅原 scan 空闲 15 秒写 comment，复用原背压，无新增业务 ID、ACK 或 timer；必要 DSH 子进程环境只新增标准 `NODE_EXTRA_CA_CERTS` 路径。

实际命令与局部失败边界集中在外 Git `geneway-evidence/https-entry-results.json`。`Cqzmys` 真实 Chrome155 通过独立 CA/临时 HOME 的系统 NSS 正常验证，产品页登录/会话/CSRF 写与手机退出、Secure 清除及随后 401 均通过；同时保存未知 CA、错误 hostname、Origin/CSRF 拒绝及仅 Cookie 属性的去敏观察。此前 Homebrew certutil 与系统 NSS 对同库 trust 显示不一致，Chrome netlog 将正确链的 CA 标 UNSPECIFIED；使用系统工具创建临时库后修复，未导入系统 CA、未忽略证书错误。

`https-entry-iZWDM9` / `spreadsheet-remote-native-CWwNtz` 真实 TLS proxy→生产 remote API→独立 B 父/DSH→照片 variant→原受控 XLSX worker/candidate 上传→云核验→reload 下载及忙时 UI stop 通过，11 原 provider body 对 11 唯一 ledger。三份实际 XLSX 7660 B 同 SHA `83fb5ae0329dc5a54b1dfe85469b7e45f57231b91443231ec019856ad1181795`。proxy 的 bytes 是上游响应 chunk，568 B 候选 metadata 响应不是上传 PUT 文件字节；下载由实际 driver downloadEvent 与下载/Host/cloud 字节支持，不倒称 browser-network 有 Artifact GET200 行。

`https-bridge-9HbyAk` 最近 `--skip-idle` 命令实际 exit0：未 ACK 原 command/digest 经真实 TLS 断流重投、精确 ACK 后 pending 清、Host 单 launch；活动流 Node 撤销后 cleanup-only 真 stopped 精确 ACK；真实 `src/server.mjs` 活动 SSE 上 SIGTERM exit0、端口关闭、未 ACK outbox 深相等。空闲测试明确复用 `nIfv5F` 命令已完成前半的 33.5 秒两条 13 B comment/之后真实 command，且同 proxy 无 comment control 于 30 秒断流；该命令后来因 fixture 连接目录非 0600 启动失败，整体 exit1 不冒通过，`1HyDNv/production.log` 留实际原因，下一最近分支修正 mode 后通过。HTTP 原 Cookie 无 Secure/login/CSRF/logout 与默认 HTTP/显式 HTTPS 启动关停另定向实际 exit0。

当前候选准备独立审查，未称公网、双出口、现场多机、多 OS 或部署完成；资料/provider 均模拟，真实模型理解质量不在该 transport 验收结论内。自身进程/浏览器/proxy 已关闭，不 stage/commit/push。

T26 原独立 reviewer 已给出 FINAL APPROVE，当前本地固定 HTTPS 实施范围无未闭 Critical/Important/Minor；批准记录由 controller 保存在外 Git `https-entry-final-approval.json`。上述 partial idle、terminal 转录、模拟 provider 及下载证据边界保持不变，不提升为部署或现场验收。后续按冻结合同实施 M1b T19b。


### M1b T19b 本地候选收口与验证边界

本片当前实现和本地模拟验收候选已收口，最终批准由 controller 的独立审查记录确认；不将其扩大为人工暂停、完整 M1b/M2 或部署完成。FileStore v23 只增加空 Thread/SourceEvent/intent/路由/订阅/续办域；Work 前 Router 采用独立配置身份、有限当前授权目录和显式预算，forward 与实际 Work 的 intent_review/ordinary 均沿同一 modelRequests 的用途分支，未造 Attempt。legacy Work 仍原 12，实际新 Work 只有用户明确选择策略才保存新冻结快照。

真实 Web 自然语言续办、旧 XLSX 业务预览、明确新关联工作、多个短选/第二 context 陈旧 409 保草稿与无匹配不创建，分别记录于 `interaction-ui-pXDFLh/KxA7R7/TTzNDu`。原对象保持不变，UI 本身不证明新 Agent 消费。只读独立复核复用同 H4RRp5 最终状态与冻结 Store，不启 Host/provider/后台扫描；初次有限 fixture 缺 confirmations/knowledge、Work GET 触 recover 的失败均保留，最终真实 GET 投影/桌面与 390px、新 Work详情、accepted 卡补验分别由独立 browser 原始目录记录，不倒改早期整体 exit1。

`interaction-native-CgUmBp` 实际 production API、持久配对 remote 父与原生 DSH、真实 Web 创建同一新 Work，消费原文件业务内容后实际 context/ask、手机独立问题回答、accept、新正式 Input 消费，再 split 已生效 Input 为独立待定位意图与原责任人 reply。12 原 body=12 ledger，原 Input/effects 不回退。`l3lJSq` 同主链后实际两责任 Session 各 handback，第二次明确澄清，19 原 body=19 ledger。`ZaTgaT` 独立 child 已在途请求通过受控屏障后真实只读 context，实际 reply 被拒，0 intent wake 给观察者，21 原 body=21 ledger。后两根 C context 工具曾因 fixture 重用同 clientRequestId 发生幂等冲突，不能称所有工具均成功；handler 的 SourceEvent 消费、实际 HB 和 child 读取各有原正文/工具结果证据，后续 fixture 已改每 intent 的稳定独立命令 ID。上述不是现场资料或真实模型判断质量。

`test-interaction-security.mjs` 的 `PiWN0L` 用实际两 actor/Node/gateway/upstream HTTP 验证两个 Router 与独立 Work 在途、当前候选 scope 隔离、routing/execution/附件 token 用途互换拒、scope CAS 后旧 token 拒及 completed/rejected 不伪 unknown；3 body=3 ledger。`epFBvz` 实际截断 routing SSE 后 unknown、同 FileStore service 重开不重发，1 body/原 reservation 保留；明确是服务对象重开，不冒 OS kill。22→23 原业务域深等迁移在同 producer 验证。

原生预算恢复卡口 `j3s7YY` 和源编辑旧问题卡口 `0NZeDU` 的原失败保留，后者仅模拟 runtime，不能称原生 baseline。`FYN8St` 真原生以显式低限 2 触 no-forward hold、官方 idle/flush、同 Work 明确调 24，再以实际 resume 消息 ID 与原 sealed intent descriptor 双 proof 恢复受限判断；12 raw body 对 12 ledger，原 held request 不预留，普通 phase 未借此放行。`kPU8ou` 真原生 Sourcev2 关闭旧独立 Q 的 Host 控制回执不进 DSH，新版正文进入同 Session，14 body/ledger；随后手机回答、accept 和新 Input 消费通过。`WG35Hz` 实际 HTTP/Host 模拟负例核错 Q/revision/Input/epoch 控制 proof 拒绝、intent token 不能读附件或调用 Router、closed 当前 routeRevision 选择仍 409，Store 全等。selection 状态白名单原本存在，本批只实测，不冒称新增修复。

C04 生命周期原 before `PMWU4s/QWHb3n` 分别证实停止后旧 handle 仍截走未定向消息、member 撤权后同 Thread 新消息被旧关联挡成 404。修后 `TPM5zR/I607Pa` 以每个原 binding/Delegation.currentAttemptId 独立校准 closed/revoked，再让新消息走当前 Router；有权显式历史 reply 仅 proposal，不复活。`cE4wzN` 真实 child consume/固定结构完成后仅其 context closed，parent handler 保留、child 新读与 wake 拒；`XRpMxN` 实际 Node 撤权时同 Node 的 Router 也不可用，新消息明确 clarify，只有原 1 次 Router，不把旧结果中的宽字段当新增调用证据。`l4iFFK` 真实 admin disable model 后旧订阅 revoked，配置与未配置的新 Thread 合法 Source 均可持久 clarify；只将已知 MODEL_NOT_CONFIGURED 归类权限失效，不吞存储或未知异常。`6VjUVF` 另对真实 hold 快照及 deadline/unknown 负向资格投影证明订阅不误撤，普通执行仍拒；后两者是隔离组件，不冒 HTTP/OS事实。

自然完成使用 `test-spreadsheet-remote.mjs --interaction-lifecycle` 的 `0YAz45`：真实 Thread/selection/accept/Input2 后，受控 XLSX worker、原 bytes HTTP 上传、云 ready、root completed/settled 后 handle closed，新未定向消息 clarify，显式历史 reply proposal；不是以 ready report 冒业务完成。同包 accepted 新 key 选择 409、旧原 key 只返原 receipt，不添事实。`iIthHf` 实际 HTTP/Host 模拟组合验证 intent hold/安全 idle/admin 调整后，Sourcev2 显式当前 Work 直通产生 Input2，旧 hold/resume/token 不获新权限、不 forward；新版实际消费后可普通 forward，总 3 body/ledger，旧 held request 始终无 reservation。

`zShLsB` 真实 API 顺序创建、消费并停止 10 项历史工作，另有真实资源声明工作和隐藏 peer 工作；owner 当前目录 13 项按 8+5 分页，标题、有效 Input、Resource 与日期查回首屏外目标，隐藏名称不入投影。真实 Router 从截断 8 项自动 attach 被拒，用户过滤后明确选择不增加模型请求。只证明这组有限实例，不称搜索性能或全 metadata 域。`9XYTKX` 在生产 Router 已实际 forward 的流上 SIGTERM，原 API exit0、unknown row/request 落盘；同 FileStore 新 PID 重启仍 1 body，无重发。`Wz9Xke` 用实际 retained D4 v22 文件经 FileStore update/reopen 到 v23，原 45 ledger/2 Evidence/15 Receipt/1 Artifact 及全部旧字段深等。`4gD14C` 只注入 Source 与 Router reservation 临时 metadata 底层 writeFile 之前的 EIO：Source 失败无 false ACK、同 key 重试唯一事实，reservation 不 forward/不留伪 ledger；不是新增 partial-write/fsync/rename/断电矩阵。

相关旧消费者保留 `interaction-related-EJDIwG` 中四份原 stdout/stderr 与实际 exit0：service、shutdown、delegation、model gateway。`Fm30or` 普通预算 HTTP consumer 为 0；`OlXskr` 单 Agent 普通预算实际 hold/idle/admin/原 Session resume 为 0，4 body/ledger，不扩大为另一问答旅程。未配置 Router Web `lTmzmW` 是真实空选项、确定性 clarify、0 RoutingRequest/forward/新 Work；不以静态页面或 API 代替浏览器。自身 fixture 均已收尾，未 stage/commit/push。

T19b 核心本地实现与模拟验收已由 controller 汇总各独立范围批准，目录 focused 末项也已批准。人工 pause/resume 按下章独立实现与验收；T20b/Watchdog/T11/M2 不由 T19b 或人工控制局部证据宣布完成。


## 人工暂停/恢复：当前实现与本地验收

本章记录实现候选，整片结论由 controller 的独立审查收口确认。原始命令、实际退出和适用边界集中在仓库外 `geneway-evidence/manual-control-results.json`；重叠范围的单独 Agent 阻塞中间窗已由最近 `wxnO0C` 定向补验，其余已验旅程没有为此重复运行。

Work 与 Work 内 Agent 共用单一 manualControls 事实域。scope 代次单调，暂停受理、Host 接收、官方 idle/flush、安全释放、用户解除事实与实际续行消息消费分别记录；不改业务 revision、预算或原问题/依赖等待。当前 owner/root 授权独立核对，按钮和受理使用同一资格门。Work 与 Agent 两层 fence 同时进入模型签发、最终预留、工具和新 Office 受理；解除后旧 token/尚未受理的旧请求不能重新生效。用户 release 事实可以保留，而 Node 撤销、unknown、预算、截止或另一个人工范围仍阻止执行。

已受理的 Job 以原封存身份归档事实，新准备请求只存命名空间独立的 `spreadsheet_prepared` 最小 admission（Job/input/request digest、binding、当时代次），不复制 rows、不当作 Job/launch/成功 ACK。真实 I/O 后与 pause 同 Store 事务复核，未知 Job 无 admission 不能事后归档。已知安全未启动 Job 在解除后可先运行并形成原 candidate；新模型继续仍要求 fresh manual_resume 或当前受限 intent_review 真消费，防止 Job 与模型互相等待。ready 用户下载继续沿成果自身当前权限，不继承 A/G 上游撤权传播。

实际主旅 `2RvRxX` 使用 production API、持久配对 remote 父、官方 DSH、桌面与 390px 双 context：在途请求期间只显示正在暂停，官方 idle/flush 后才已暂停；新 Source 保原 handler、零新增 forward；另一 context 显式解除，同 Session 受限判断、accept、正式 Input2 真消费，6 原 body 对 6 ledger。`VbTwiw/ax4iWl` 分别补无新 pending Source 的受限意图/普通 fresh resume，5/2 原 body 对相同 ledger，未重放已消费 Input。独立 UI 原图和网络核对只证明对应已操作场景。

`IIedIG` 真原生在暂停前提出独立 Q，暂停不关闭，手机回答仅排队，解除后精确 question fence 在同 Session 消费，6 body/ledger。正式 Input2 保原 Source 正文，回答另在 intentAnswer/context。原运行两张手机图只取到 composer；后以同两份真实 snapshot、冻结 Store、禁后台/Host/provider 的真实 server GET 投影补四张桌面/390 精确 Q 卡，`manual-question-ui-independent/run-Qd4UZm` 实际通过，未重新答题或重演运行。反向顺序 `8Ey4PT/tFfo7p` 是 HTTP/Host 模拟：解除时 Q 仍 open 不产生 wake，稍后真实回答才单次释放对应等待。

人工与预算两个解除顺序分别由 `fFanMv/t62Uye` 实际 HTTP/gateway/Host 模拟验证；`DHiUsk` 补官方 DSH manual-first 同 Work 显式预算调整，4 body/ledger，budget_resume 的真实消息与原 intent descriptor 双证明保持受限用途。`kyUaTl` 由另一 fixture owner 跑官方 DSH/真实 OS Office worker：同 Job 在 release 后且 fresh resume 消费前启动并形成 7489 B candidate，4 body/ledger。upload token 人为保持 503，不能将它称 Artifact ready；cleanup Job 的部分 403 未 ACK 也不写成全 ACK。

`OhYvvm` 是 current token 入口已通过、真实凭据读取完成后受控屏障夹 pause、最终预留拒绝，0 新 ledger/provider。`YnL7WN` 用真实 candidate、协调完整页与实际 gateway 正文消费验证旧 read/review fence 拒；`QqN588` 补缺省合法调用方在首次 snapshot 捕获 fence，真实文件同步及最终核验 I/O 换代后分别拒旧 read/review；真实 workbook verification 完成后再次 pause/release，最后 Store 拒旧代 review，新代对照唯一 ready。该项修前只有可达源码推断，不倒造修前 HTTP。`FBukoX` 则实际复现暂停中独立 S 的旧 rev1 review 在正式 Input2 消费后永久滞留；`L9TUPJ` 修后保旧命令/sub 历史，先 Input2 一次，再为同原 S 建新 sub/current-revision 受限 review，未自动 accept、未造新 Input/model。`cB2I9n` 再以 production API/官方 DSH 同一 Session 补实际动态切换：Input2 一次后 S 的新 sub2/current-revision 原正文入实际 provider，仅受限 context→accept 后才 Input3 一次，6 body/ledger；模拟层不替代此消费者。

`OdKM0w/CcJrt0` 的真实 HTTP/FileStore/Node/Host 模拟验证 Work-Agent scope 不误挡另一角色和另一工作的同 Agent（公开 legacy 无 grant 多 root 兼容，不放宽 grant 的 AGENT_BUSY），另两项各实际 forward 一次。临时 metadata 底层 writeFile 前 EIO 无 false ACK、全状态不变，同 key 重试唯一控制；它不是 partial-write/fsync/rename/断电矩阵。Node 真 revoke 后普通发行拒，release 只事实，cleanup 能结束原绑定，stop 后 resume 不复活。`g98sEJ` 用受控应用时钟到期限后同样保 release/no-wake，管理员明确延长后 fresh resume 真消费才 1 次实际 forward；不冒真实墙钟等待。

`iJ04pX` 在 pause exact ACK 但 SDK 尚在途/无 idle 时只 SIGKILL 自己的 remote 父，重启保 unknown/interrupted、原 Session/账本、无自动续行；明确 stop 后才启动 stop-only 清理并 exact idle_after_cancel。原 manual idle 仍 null。该根未记录进程 startTicks/精确退出时刻，不能称 OS reboot 或进程出生审计。独立迁移 `manual-preservation-sol-20261106` 以六个真实旧归档副本经公开 API read/update/reopen：FileStore23→24 仅 version 与空 manualControls，旧 Journal3 全树同，原源 bytes 未改、unknown 保留，无回填假 idle 或消费；未运行旧 Session。

早期 `deXnKk/6Ezzyf/SXVahD` UI 探针失败保原 exit1，分别为卡选择/浏览器 fetch.ok/返回对象读取问题，不将它们拼作完整成功。`r7UWXG` 原生整体 exit0 只证明两范围最终独立解除和共同一次续行；Work holder 安全释放 ACK 晚于 Agent release API，不能据该根声称已观察“Work 已安全解除、仅 Agent 暂停阻塞”的中间因果窗。后续定向补验证与独立审查按实际结果更新。


重叠补验 `wxnO0C` 与真实双 context UI `oijfOT` 实际 exit0：Work gen2 非空 holder 全部安全 release ACK 后，Agent gen1 仍 paused/idleConfirmed，pending Source 未消费，原 2 forward/ledger、业务 revision/Job/Delegation/无 resume command 全不增。UI 保存当前 DTO 与双端四张 scope 图，父收到 phase 后独立读真实 Store 保存 `overlap-work-released-agent-paused.json`，再回 ACK 才允许 Agent resume。之后同 Session 单次当前意图消费、context/accept/Input2/report，共 6 原 body/6 ledger，再真实停止。前一 `Loiual` 只达到 GET/保存 DTO，因 details 折叠且精确文本不含员工名前缀而整体 exit1；探针最窄修复后当前补验成功，未改产品文案或后端。原失败和中间边界保留。

新代暂停后的原 exact idle/release 回执、原 Inbox 重投与 Node resync 在 `82Gqtj` 实际 HTTP/Host 模拟负窗保当前 gen3 无 idle；当前 inspectState 真返回模拟 idle 后才生成该代证明。直接受影响的既有 model-gateway consumer 实际 exit0，沿原 12 次共享预留/unknown/令牌用途及持久化故障门保留；未因此宣称全部旧业务或 T11 六故障窗已验。

人工控制完整有界增量随后经独立 reviewer FINAL APPROVE，controller 已记录于外 Git `manual-control-final-approval.json`。它只批准上述本地实现与模拟验收，不代表整个 M1b/T11/M2 或部署完成；原阶段源码指纹是历史冻结记录，后续 T20b 接线后不再声称所有旧指纹与当前源码相同。

### T20b 有限历史资料读取候选与证据边界

当前实现从真实新关联 Work 的唯一 continuation、首 Input 的来源事实及原受理订阅确定选定根读者，再独立核当前实际 modelRequest/inputMessageId、ordinary 或 intent_review 用途和两层 manual fence。metadata 发行不创建实际模型轮次，也不覆盖父进程的 active model step。child、context-only、Router、其它 Session 不因知道旧 Work ID 而继承该来源权限。真正仍在途、由当前 gateway 拥有的 unknown 预留可用于本轮读取；失去在途归属的断流 unknown 拒绝读取与自动重发。

`geneway_read_context` 经可信父进程把当前实际 step 送入 `/internal/context/read`。模型只提供有限参数，关系从 continuation → 旧 Work → ready Artifact → 原 Job/manifest → immutable result → sealed Evidence 逐跳派生；任意 ID 不作为跨 Work 授权。原成果沿用自身当前权限，A/G 上游失权不会级联拒绝 Artifact 内容；Job 的失权关系被过滤，旧缓存页含已失权关系则拒绝再次返回或计模型消费。历史 Evidence 仍须当前 Resource reader 与原 sealed export 的交集，普通 Evidence receipt 不能替代本片读者授权。

完整 JSON 每页最多 16384 UTF8 bytes、16 items；每对象每窗口 32 页/128 KiB，实例窗口 64 reads/256 KiB，关系最多 6 hops。按完整 entry/event/行内 cell group 及 Unicode codepoint 切页，不截断原值。首次窗口锚人类明确续办，模型新请求、正式 Input、purpose 或 manual/budget 变化及并发 cursor 分叉均不自动增加额度。读入模型的证明匹配真实 tool call ID/name/参数、完整返回页和 page digest，账本只存必要 receipt ID，不持久化第二份模型正文或密钥。

用户在原 WebThread 点击“继续读取资料”只产生互斥的结构化 Source 和唯一新窗口，不造正式 Input、Q answer 或解除等待。同对象新窗从原 parent.nextIndex 原位续读；完整元数据耗尽窗口时，则从原已返回父边确定的未读关系目标0继续。ordinary 用真实 typed notification；已 idle 的受限 intent 用同 Source/route/reader 的新 subscription revision 与新投递，实际消费后仍只能受限判断。Q 未答时仅批准待处理，真实原 question/route 回答后精确 waitRelease 才继续。正式 Input 在已排通知后升版时，新通知按 window+当前 revision 取独立身份，旧 sealed command、窗口及首 delivery ID 保留。

实际主要命令与证据均在 `/home/gewu/.codex/task-checkpoints/geneway-evidence/` 下。表中 exit 是 producer 的实际终态；独立审查由 controller 单独汇总，以下不自行授予全片批准。

| 实际命令 | exit / 证据根 | 已验证范围 |
| --- | --- | --- |
| `node scripts/test-context-read-native.mjs` | 0 / `context-read-native-mTpmRX` | 新鲜五 Node/200 history+G event 的 D4 ready、同服务真实自然语言 Web 新关联、官方新根 SDK 36 页；174 边界后真实双 context 人类许可，typed 通知消费后原位续读；185 raw=185 ledger。 |
| `node scripts/test-context-read-native.mjs --intent-idle` | 0 / `context-read-native-hl55Ch` | 真受限轮停闲后，人工许可形成唯一 sub2/new delivery、同 Session 受限 174 续读；全文实际 provider credit 后才 explicit accept/Input2。40 新 raw，原 149 保留。 |
| `node scripts/test-context-read-native.mjs --question-open` | 0 / `context-read-native-C16inr` | 批准时原 Q 仍 open、0 delivery/read/forward；另一真实浏览器回答原 Q 后 sub2/精确 waitRelease 续读174，全文进入 provider 后才 accept/Input2。40 新 raw，原 facts 保留。 |
| `node scripts/test-context-read.mjs --revoke` | 0 / `context-read-7KxTh2` | 真实 Resource CAS 后旧关系缓存 RPC/forward 拒绝；fresh Artifact 内容与原文件逐 cell 相等且仍可下载，新 Job 只暴露当前有效关系。 |
| `node scripts/test-context-read.mjs --request-lifecycle` | 0 / `context-read-Jpp2pl` | 实际 upstream 在途可读；真实截断成为 orphan unknown 后同 key/新 key 都拒、新 issue 拒；其它 Session 请求拒且无新事实。5 raw。 |
| `node scripts/test-context-read.mjs --own-revoke` | 0 / `context-read-vGLacT` | 真实 B Node 撤权后 Artifact context 与原 download 均拒，失败不新增读取或账本。 |
| `node scripts/test-context-read.mjs --quota-fork` | 0 / `context-read-GKcXZ1` | 真实 HTTP/FileStore 的第64次读取两并发仅一成功，另一 LIMIT；旧前缀不改，下一实际模型 forward 不重置窗口。 |
| `node scripts/test-context-read-window.mjs`、`--intent`、`--question` | 各 0 / `context-read-hUeMUQ`、`nmgsB6`、`weyVgS` | 真实 HTTP/HostSim 三种通知资格、旧 step 拒、174 原位新窗；最后第14张新页取回发生在各包最后 forward 后，不冒已进入 provider。该层空缺由上述真实 SDK 三正例补证。 |
| `node scripts/test-context-read-window.mjs --input-before-notice` | 0 / `context-read-27nhqA` | human 批准后另有真实正式 Input2；原 command 深等、首 delivery ID 保、仅 append 新 revision 通知并真实消费，同窗口原位174继续。 |
| `node scripts/test-context-read-scope.mjs --context-only` | 0 / `context-read-scope-OMQIvl` | 六 Node 初始当前 readers 含 auditor 而 sealed export 排除它；合法 Artifact 正读对照 Evidence 猜读拒；真实 child 有效模型 step 拒，真实 context-only Source 上下文可读但无根资料权。 |
| `node scripts/test-context-read-io.mjs` | 0 / `context-read-io-7O2Yyi` | 真实文件 read/hash/ZIP/sync/close 后、最终 Store 前，夹真实 Input2 消费或 manual pause；旧读拒且无 receipt/model 残留，新 step 保原 instance/window，旧 phase cursor 拒。切点在行页解析前，不冒解析后的独立屏障。 |
| `node scripts/test-context-read-state.mjs` | 0，9/9 / `context-state-sol-20261106` | parent 路径/环与合法分页、唯一人类新窗及起点、完整 JSON bytes、并发候选末额等纯状态不变量，不冒真实 API 并发。 |
| `node scripts/test-context-read-source-rejection.mjs` | 0 / `context-source-rejection-d0txPU` | production FileStore/service 的15拒绝整树及磁盘 bytes 不变，含 beforeCommit 真 ENOENT；真实未读快照正向批准一次及重放不增事实，不冒 HTTP/SDK。 |
| `node scripts/test-context-read-compat.mjs` | 0 / `context-read-compat-yI9U2m` | 三个真实 v24 归档经生产 read/update/reopen 成25，只增三个空 context 域和版本；原 ledger/manual/unknown/Evidence 全树及源 bytes 保，不运行旧 Session。 |
| `node scripts/test-model-gateway.mjs`、`node scripts/test-manual-control-integration.mjs --idle-ordinary` | 均 0；后者 `manual-control-integration-XFC8dJ` | 受影响旧工具/预算/unknown/发行持久化门及普通 manual fresh-wake 消费门。 |
| `node scripts/test-ready-artifact-authority.mjs` | 0 / `ready-artifact-authority-IHYpnp` | 当前 consumer 的 source-only 撤权200同SHA、B自身撤权403，原业务事实/45账不变。 |

三条真实 SDK 正例的原 sealed 200 history/G event、三份真实 XLSX 和 1909 个非空逻辑 cell 均逐项对照，36 页的真实参数/返回全文/下一 provider credit 已由独立 reviewer 限定核验。D4 前置样本使用显式独立策略192；最初64曾实际耗尽，旧一次管理员192调整和真实 budget_resume 保留。新 T20 Work 仍显式64，未改 legacy12、默认预算或漏计路由/模型。最末 report 已受理后 producer 显式 cancel 导致 SDK 后续节点拒绝；首次 partial 停轮 completed，不能写成所有 turn completed 或 SDK 零 error。

原失败证据继续保留：`VvN2mr` 为官方 frozen options 原地赋值，15 frames/0 forward，已最窄修并由后续真实旧普通/Office及 context 入口证明；`edYmY8` 为 fixture 同 revision 反复 adopt；`iqs84a` 为 fixture 只读最新 user 丢已消费 candidate；`XEeXvl` 是实际128 KiB 剩余额度缺口，原 nextIndex160已持久化，不是未读位置丢失。修后按剩余完整 JSON 动态切14项至174再明确续窗；没有提高限额或跳过原资料。`CCgFti` 实际发现旧通知在正式 Input2 后重封撞重复身份，修后 `27nhqA` 对照；早期 `Q8JXVL` 只弱断言，不替代后者加强原命令保留检查。`jlEz7i` 与 `co5clY` 是新增探针分别误读旧归档空域、给 intent_context 加未声明字段，整体 exit1 不冒通过。

各 native/UI/HTTP/状态/兼容支持层先分别接受限定独立审查，随后完整 T20b 经下述最终增量复核批准。没有把本地模拟资料/provider 扩大为现场数据、真实模型理解质量、公网多机或部署验收，仍无 stage/commit/push/PR。

notified 文案以 `C16inr/focused-final.json` 原 pre-cancel 完整快照只读补证：真实 server 授权 GET/登录、冻结 Store 拒绝 update、后台关闭，metadata-only adapter 没有模型凭据或执行入口。首 `run-8o8w6Z` 虽执行 exit0，controller 复核发现文案把批准时的61项写成当前未读；该准确性通过声明已撤回，旧图/操作保留。Web owner 只将已批准状态改成“历史资料续读 / 批准时剩余61项”，available 仍用当前未读文案。随后独立 `context-read-notified-independent/run-o03zEZ` 实际 exit0，桌面/390 两图已查看，原快照的 Artifact 已235/235且 partial=false，界面正确标记历史余量，送达不等已读说明、无继续按钮/reload 保持；实际 served HTML 等于当前 index 与保存 served-index，SHA `9c90fe90730f8965f65257b2e0580c9561c8cb5bb4faf0330396fb0d37648bc8`。这是当前源码对真实历史快照的只读渲染，不是原运行 live 转场或原 run HTML 的追溯绑定。当前墙钟已超过原期限，DTO 的 EXECUTION_DEADLINE 如实保留，未改时间或权限。原 snapshot/provider/capture 与新复制 state 前后字节不变，0业务写；两次 owner6929/PID827810 和10380/PID861427均实际 SIGTERM exit0、PID消失，33877/40027端口拒绝，未留下服务。

末两 HTTP 负例首轮 `xKmZn8/SilSnh` 的第五次真实 forward 只在内存与账本校验，provider-bodies 在新分支前保存仅四条；独立审查发现后没有倒补旧 raw。脚本 finally 改为保存全部实际收到的 body，最近 `Jpp2pl/GKcXZ1` 均实际 exit0，盘上各五原 body 与五新 ledger digest 精确相等；表中采用这两个完整新包。该采集修不修改产品或旧事实。


完整整合 gate 的唯一新增 Important 为完整元数据页耗尽全窗后无 partial 入口。修前真实 HTTP `lPnQkV`（`node scripts/test-context-read.mjs --metadata-exhaustion`，实际 exit1）保留64张完整 root/Work 页及合法首 Artifact 读取 LIMIT、Thread 投影为空；原页都未丢失，但没有可批准的续点。未改写旧封存页为 partial 或提高额度。

修后在原 window 保存最多一个有界 `blockedFrontier` 控制元数据；只有当前真实 step/权限/双 fence 通过、下一合法关系页因当前剩余额度不能容纳且 fresh 窗可容纳完整项时，才在末 I/O 后 fresh Store 事务保存。它不是 read receipt、模型 credit 或新额度。64 reads 已饱和也可从实际返回的 nextRefs、当前覆盖及唯一最近父页派生该位置；已读或已有 partial 的目标不得从关系0覆盖，旧 partial 仍按原 nextIndex。人类 Source 的 readId 仍指实际原父页；新窗口固定 continuationTarget 的对象/version/view/起点/路径，当前通知实际消费后首读必须精确相符。

最近 `4yiBQC`（64张完整页）与 `LHTghr`（45 reads，260860 bytes/tokenEstimate、剩1284非零）两个实际 HTTP 命令均 exit0。各自只有真 Source 与一次 replay 的唯一新窗口；旧 step 不得用新额度，当前 notice 真消费后首 Artifact/result 从0与原父 edge/path相连；随后各第3个实际 provider body含完整该页，当前 ledger.contextReadReceiptIds 精确匹配。字节场景的父 Job 是 manifest view、新 result 是 content view，通知明确使用批准目标视图，不误让新轮继续 manifest。两个原窗口不增加额度或重写旧64/45 receipts。较早 `VcKBSD/A3edEY` 是相同位置的初版 after，表中结论以最近包及原始 body 为准。

直接相关回归 `1stUlP` ordinary 与 `Opoa7u` question 实际 HTTP exit0，仍从旧 partial174继续；末新页是否进入 provider的支持层边界与此前相同，不冒新 SDK 回归。state 脚本现12/12 exit0，新增完整父页关系、错误 target/version/view/offset、单次不可改 blockedFrontier 与已有 partial不回0。`test-context-read-source-rejection.mjs --frontier-source` 的 `FegK5a` 实际 production FileStore/service 验证新目标 Artifact 的 beforeCommit 真 ENOENT 整树/磁盘 bytes rollback、正常只增一次 Source/window及重放不增；旧 partial 默认 `uemTha` 同样 exit0。均未改时钟、原资料或权限，不扩大为 HTTP/SDK。

GET 的新 relationPending=true明确表示关联目标数量尚未读取，nextIndex/totalItems均null；Web显示“后续关联资料尚未读取”，已批准分支采用历史/中性说明，不将null算成0项。独立只读浏览器 `metadata-frontier-ui-independent/run-C4eMRw` 实际 exit0，desktop/390两图已查看，继续按钮可见但只读复核未业务点击，reload保持；原64页实际快照/blockedFrontier、wrapper、provider原 bytes均不变，0业务写。实际 servedHTML等于当前 index/served-index，SHA `c750b5c65dada2212f5abe64a5ebbbe8185ac417d3fdc14c4dcf19dd286d5abd`。owner39580 实际 poll exit0，PID1097044 已消失/39995端口拒绝；最后 SIGTERM 命令返回进程不存在，不将该次命令写成终止了仍存活进程。该图仅核available关系分支，不冒新 approved/notified live转场。


同一 Important 的跨窗父边子情形随后在真实 HTTP `r60Xst`（`--cross-window`，exit1）复现：window2 已读A并再次实际耗满64次，G的 blockedFrontier 归window2，但原Job父页仍在window1且此前已用来批准A；旧parentReadId终生去重和旧window查找阻断了第三窗。原07:51冻结及首窗正例不被倒称覆盖该情形。

当前续点/去重以实际消耗的 current window 与原父边、target/version/view/position为作用域，新window保存 sourceWindowId；旧父页仅为出处，不要求来自当前窗。旧Source事件重放仍返回原receipt/window；当前尚未开始消费的同slot并发重试不重复开窗；当前窗已实际消费并再次耗尽、不同合法target须新的人类Source才能开下窗。beforeCommit精确校验本次服务端批准window ID及target，不能find第一个同parent旧窗；投影优先当前未读G而不是旧已通知A。旧window/pages以及缺少新字段的legacy事实不回填。

当前真实API补证 `otaiHP` 与真实双slot Web支持包 `HkTjN7` 均exit0、各5 actual body与5新ledger精确相等。后者使用同一个desktop页面两次操作，原父readId不变，A的window2真通知消费/实际读取/credit后，父流程再用root32+Work31耗满window2；G的首读LIMIT给当前frontier。desktop只刷新Thread（timeOrigin保持），第二个真实Source批准window3.sourceWindowId=window2，实际新notice消费后G从0进入第5个provider body并记receipt credit；旧A Source仍准确返回window2，旧窗口/页和正式Input1不改。

为使同父页的新slot不复用失响应时缓存的旧请求，GET增加opaque continuationKey，来自source window+父页+精确目标；UI只用它区分稳定重试缓存，POST仍只有原readId，不接收客户端目标/offset/新权限。独立UI `HkTjN7` 关联 `daNYkp` 八图已实际查看，无取景阻断；两次POST成功、新client/source/window、当前GET key变化、首业务POST后无desktop根导航均核。它没有实际lostACK注入或Map内存trace，不能将成功两次操作冒称丢ACK重试实证；生产函数的失ACK旧缓存红绿仅为组件支持证据。该包没有额外notified图或原servedHTML指纹，原独立只读可视化范围不提升。

跨窗纯state现13/13 exit0，新增旧parent/current源窗分离、G0严格首读、同slot去重与旧Source回原窗；当前实际旧partial/Q消费者 `F7vyIN` exit0，生产Source新Artifact I/O rollback `m6ryf1`、旧partial默认 `otjpE6` 均exit0。完整 T20b 整合 gate 随后由 controller 在本次增量复核后批准，批准范围见下文，不代表全 goal 完成。


最后 Source consumer `--third-window-source` 的 `fnMp30` 实际exit0：直接使用 `HkTjN7/cross-window-before-third.json.state` 原完整树，14拒绝整回滚及 production Source3许可、新window3.sourceWindowId=window2、sameSource不增窗、原Source2实际payload回旧window2/current仍3全部通过。薄spy只记录并委托真实 verifyWindowApproval 第5参数，证明确为本次新window3/targetG而非旧A；未模拟审批。G是immutable result，没有文件I/O，明确跳过G文件ENOENT，不制造该测试。原Artifact frontier `le2djA` 和默认partial `5Ujdli` 均另实际exit0，当前Date.now、原源bytes/权限不改；state/Source脚本owner随后停写。

完整 T20b 有界实现及本地模拟验收已由原独立 reviewer FINAL APPROVE、无 C/I/Minor；controller 于 `2026-11-06T08:36:47.925Z` 接纳，外 Git 记录为 `context-read-final-approval.json`。`root-cross-window-frozen-source-manifest.json` 是该阶段的历史源码冻结；下一 T11 修改后不再声称其全部旧指纹仍与当前源码相同。该批准不代表完整 M1b、T11、M2、现场模型理解质量或部署完成。

## T11-M1b 六个最低故障窗口

本片按已批准的 `geneway-t11-plan.md` 实施。产品变化只在 Node Bridge 事件订阅：当前 Node/实例认证后，非空 `Last-Event-ID` 返回 `409 RESYNC_REQUIRED`，要求先重新同步 pending；无 hint 仍走原 SSE 与 generation 规则。不维护历史游标或推断 hint 是否过期。既有显式 hint caller 改为验证拒绝、真实 resync 后原 sealed command 仍可重投及 exact ACK。其余故障只用具名测试构造或透明代理注入，不增加 profile、环境变量、HTTP 故障开关或自动恢复平台。

以下命令均在仓库根执行，原始产物根均位于 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`。各 producer 已实际终态并清理自身 API、Host、provider 和浏览器，没有把 result 文件存在等同进程已经退出。

| 窗口与实际命令 | actual exit / 原始根 | 已观测的资格及边界 |
| --- | --- | --- |
| E06：`node scripts/test-t11-host-faults.mjs` | 0 / `t11-host-inbox-precommit-1WUQC3` | 真实空 resync/SSE 在线后生成业务 command，沿原 parser/remote/Host/Journal 在目标 Inbox rename 提交前 EIO；下一 resync 真屏障时磁盘 Inbox/executions、ACK、模型均0，云 command 未受理。恢复后同 ID/digest 唯一落盘、exact ACK、官方 SDK 实际摄入且仅1 forward。不是 rename 后目录 sync 故障或物理满盘。 |
| E07：`node scripts/test-t11-bridge-resync.mjs` | 0 / `t11-resync-gap-fBJxmB` | 首真实 GET 注入 hint 收409，生产 connector 实际失败后重新 resync；真实 snapshot 冻结后、无 hint 订阅前新增另一 Work command。两个 command 均唯一持久与 exact ACK；snapshot 后无额外 resync 补齐第二项。测试代理有意拒绝模型 token，属于传输/持久入口，0模型，不冒 SDK 业务验收。 |
| E07 既有 caller：`node scripts/test-multisite-bridge.mjs` | 0 / `bridge-focused-xxyArS` | 新409合同与原 sealed command 重投、幂等、ACK、正式 Input2 及清理仍通过。 |
| E08：`node scripts/test-t11-sse-faults.mjs` | 0 / `t11-sse-generation-mHc1qL` | 两条真实同 Node SSE；旧 socket 已实际关闭，仅暂扣旧 response 注册的应用 close 回调。新流先持久/ACK Input2，才释放旧回调，之后 Input3 仍由新流唯一持久/ACK。未修改 connections Map 或先 abort 旧流；Host 模拟、0模型。 |
| E10/H04：`node scripts/test-t11-host-faults.mjs --outbox-death` | 0 / `t11-host-outbox-death-J9JrWz` | 官方 SDK 普通 report 已云提交、所有该 ID ACK 被扣，真实本地未 ACK 后 SIGKILL 父；同 root/identity 新 PID 重发原 event/digest/full binding，收到原 exact ACK 后本地才 acknowledged。云仅1 receipt、Work/Q/11域/模型账和 Inbox 无重复效果，始终1 provider。原 SDK turn 被中断；旧后代进程等待退出但未保存逐 PID 出生信息，不称宿主 OS 重启或完整进程出生审计。 |
| H07：`node scripts/probe-t11-report-history.mjs` | 0 / `t11-report-history-bpmonX` | 五真实 remote Node/官方 SDK/受控 XLSX worker；旧 B 真 completed/settled、原 report 始终封存未 ACK。正式 Input2 后同 Work 同 office 新 Delegation 的真实 SDK User 与云 ingested2 已成立，才首次发送旧 report；原 binding historical/exact ACK，当前 Work/output/Q/Artifact/输入/模型无污染。25 actual body 与25账精确相等。不是同 Delegation retry，也不是已在途 HTTP 乱序。 |
| H09 当前消费者：`node scripts/probe-manual-control-native.mjs --overlap` | 0 / `manual-control-native-iVZR1a` | T20 影响共享 runtime/model 路径后定向复核双 Web/Work+Agent：官方 idle/flush，暂停中新 Source 只入队；Work holder 安全 release 已 ACK、Agent 仍独立 pause 时无新 forward，Agent 显式解除后同 Attempt/Session 受限判断、accept Input2 真消费再 ordinary report。6 body/ledger。原 Q 等其他组合沿已批准人工阶段证据，不用这一窗冒完整人工矩阵。 |

E06 的 Journal 注入仅由测试 driver 在生产构造引用处接原 `operations.rename`，故障精确命中新增目标 Inbox 提交前。E08 只在测试 server 真实 request/response 接点扣一次原 close 回调，不改变生产 generation 判定。

H07 为解决原串行 Outbox 的选送限制，测试 driver 仅替换原 Journal 构造引用；wrapper 总是读取完整持久树，只有原 `host.mjs` 私有 `flushReceipts` sender 直接调用行获得暂不选送该真实 report 的视图。`synchronizeInputs`、inspect、更新、cleanup、安全证明及同函数其他行均保留完整未 ACK 事实；其他事件照常真实 HTTP/exact ACK。实际61次 sender 选择记录保存原/选送 hash 和目标行，其他完整读见证仍包含该行；解除后经原路径首次 POST。`selection-seam-source-after-run.json` 明确是 producer 后源码读回，不冒启动时指纹，`author-readback.json` 核25 raw/ledger、exact historical ACK和5父进程 exit0/当前 PID 消失。该测试模拟队列晚发，不授生产任意乱序或假 ACK。

E06/E10 的原 SDK 全帧、H07 的六个真实 Session 全帧及原 wire/事件/磁盘快照均保留。E10 `terminal-host` 是 stop ACK 完成前的较早快照，随后实际 Journal 已确认 ACK，不能将较早快照写成当时全部 ACK。所有本片结果是本地受控故障与模拟 provider 的资格证据，不包含现场真实模型质量、公网多机、物理满盘、完整 M2 或部署；T11 最终整合批准范围见下述 controller 接纳记录。

T11 六窗随后由原独立 reviewer 完整有界审查 FINAL APPROVE，controller 已核本片14条源码指纹、HEAD 未变和暂存区为空，并接纳外 Git `t11-final-approval.json`。该阶段源码冻结与 producer 是历史记录，后续 T23 的必要产品接线不倒称仍与旧指纹相同；完整 goal 继续。

## T23-M1b 独立监督候选

新增监督 CLI 作为 API/Host 的兄弟 OS 进程独立运行。产品 Store v26 仅增加空 `supervisionFindings`、`supervisionActions`；原 Work、Session、模型账、人工控制、资料窗口及封存事实不回填。专用 observe 身份只能取裁剪快照与幂等提报，独立 recover 身份只能申请有限原命令重供；两者均不复用浏览器、Node 或模型身份。未配置监督身份时，专用入口返回403。

生产 API 用仓库外 `GENEWAY_SUPERVISION_CONFIG` 指向 JSON 身份配置，字段形式见 `config/supervision-identities.example.json`，凭据经 secretRoot/credentialRef 读取。监督程序入口为 `node src/supervision-watchdog.mjs <配置文件>`，配置形式见 `config/supervision-watchdog.example.json`；样例默认只有观察凭据，明确加入不同的 recoveryCredentialFile 才可能处置。实际运行时应使用与 API/Host 独立的 OS 进程；未安装 systemd、未部署服务或改动真实机器业务。可选本机进程观察必须显式保存 PID 与 `/proc` startTicks，不能将 PID 存在当业务进展或应用响应证明。

三个专用路由为 `GET /internal/supervision/snapshot`、`POST /internal/supervision/findings`、`POST /internal/supervision/reoffer`。权限固定到 workspace、Node 集合及可选 Work 集合；投影只返回必要 binding、阶段/检查点、双 scope 人工 holder、预算计数/未知、问题与受限 subscription 身份、Job 阶段、未 ACK 命令身份和必要事实引用，不返回目标、正文、模型 body、Session 原文、Journal 或凭据。资料新范围按实际对象/version/view去重，声称模型已读另依实际 `contextReadReceiptIds`；心跳、token、PID、重复带旧页或自由 report 文本不刷新进展。用户、依赖、人工、预算、期限、unknown 和正常 Job 等原因分别保留，不把 unknown 预留当进程已经死亡。

本片监督身份与 scope ID 只支持1–180字符的 ASCII `[A-Za-z0-9_.:/@-]`，覆盖本次固定样本；原 Node 注册/执行仍保持其原合法 ID 范围。中文或更长的合法 Node ID 尚未适配监督入口，不将本片称为全 Node 身份兼容；该支持范围留后续完整资格核对。

独立程序将最近同样裁剪的成功快照、采样时点、stale/currentBusiness、进程观察和待报 episode 持久到自有 `watchdog-state.json`。API 不可达时当前业务为 unknown，最后成功快照仍保留其原采样事实；不直接写产品 state。恢复后原入口以同 episode 幂等补报；同一观察时间变化只更新原 finding 的 lastObservedAt，保原 firstObservedAt、首次受理及处置次数，不生成新告警身份。

有限处置仅对仍有效的普通 launch/deliver，要求原 commandId/digest/full binding、当前 Node 实例和同 SSE generation、原 pending 且已 sent。每 command 只能持久 claim 一次，总窗口有限，监督重启不能清零。claim 事务、解除该 ID 发送抑制前及本次目标实际发送前共用同一当前资格谓词；ACK、换代、未知模型结果、当前负责用户问题、受限意图、手停、人工、预算、期限或失权均不自动处置。只有该目标临时解除一次 sent 抑制，仍走原 scan/容量/鉴权；不 clear 全 sent、不伪 ACK、不改 acceptedAt、不造 Attempt/Session、也不替人 resume/answer。已持久 claim 但发送异常尚未确认时保留 claimed，不能据重启重新领取或伪称已发到 wire。

当前已完成的实际窗口如下，原始根位于 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`：

| 实际命令/范围 | actual exit / 根 | 证据边界 |
| --- | --- | --- |
| `node scripts/test-supervision-contract.mjs` | 0 / `supervision-contract-5RQ3Zg` | 三份真实 v25 经生产 FileStore 迁移26只增两空域/版本，旧全树与源 bytes 保；生产 handle 组件验证专用身份/角色/scope/请求界、持久幂等、真实损坏副本503、六种等待投影。不拿无连接 no-op 冒已 sent 恢复门。 |
| `node scripts/probe-supervision-process.mjs` | 0 / `supervision-process-7Uo2uX` | API 真 SIGSTOP 两离线样本、兄弟监督重启保同 episode、CONT 后唯一 HTTP_TIMEOUT finding 补报；Host 真 STOP 与仅断 proxy 的同 PID/startTicks 区分，API 真 TERM 对照。observe-only/actions0/provider始终1，原 unknown 账/业务深等。 |
| 首短正向 `node scripts/probe-supervision-reoffer.mjs` | 0 / `supervision-reoffer-JpGa9M` | 同 SSE 两帧，同 ID/digest；首 ACK 到云前扣97ms，proxy见第二帧即放 ACK；1 Inbox/1官方 SDK User/1模型账，监督重启不多 claim。只证明该启动源码，后续资格修后的最终正向见下一行，不把旧源码等同当前。 |
| 最终短正向 `node scripts/probe-supervision-reoffer.mjs` | 0 / `supervision-reoffer-KkaM1V` | 首 ACK 入云前扣102ms，真实同流第二帧即时释放，2帧/1 Inbox/1官方 SDK User/1 completed model、2次 exact ACK但acceptedAt稳定，监督同 root 重启仍唯一 claim。9份启动/结束源码及保存原件一致，独立 native reviewer 核通过；之后只有观察 waiting 的同父新目标分支变化，该 run 没有 context instance/read，已按不执行该分支限定复用。 |
| `node scripts/test-supervision-contract.mjs --connected` | 0 / `supervision-contract-eg7r95/connected` | 原命令未 ACK 时真第二 SSE generation 安装，旧代请求0 claim；持久 claim 返回前只在锁外扣 wrapper，另真实 pause API 后再放行，0新增目标帧、保 not_offered 处置事实。Host 模拟/真实 HTTP，不冒 SDK。 |
| `node scripts/test-supervision-contract.mjs --connected --unknown-race` | 0 / `supervision-contract-tbXQCD/connected` | claim 持久后，真实当前 Input 摄入及 gateway/HTTP provider 阻流形成 unknown1，末发送资格拒、无新目标帧；放开原模型正常结算，监督没有重发该模型。真实换代原两帧不计作监督额外帧。 |

`7Uo2uX` 的原 SDK seq13 `TRANSPORT/terminated` 在主动断 Host proxy 后、API TERM 前发生；不能写成清理之后才出错或 SDK 零 error。证明是原 ledger 保持 unknown/completedAt=null、业务深等、provider1且无自动重放。首 `bFYlaH` 实际发现 TimeoutError 数字23被持久待报后遭 INVALID_REQUEST，整体 exit1；原事实/失败保留，未修改旧 episode 装通过。新观察产生时按实际 exception.name 规范化 HTTP_TIMEOUT，修后新根才通过；不为试验坏记录推断补历史身份。connected 首 `geBenT` 的末断言误要求暂停后 sent 集合保原 ID，与原 scan 合法清除不再 pending 项的规则不符；保该失败，后两根以云原 pending/0新 wire/原 claim 事实判定。

完整 gate 的源预审发现并已最窄修三个本片接缝：恢复专用资格不能被普通 allowed 代替；普通/D4 用户问题须按当前负责 binding/revision识别，不能全 Work blanket wait；结构化错误须来自真实 runtime_unavailable receipt 独立 eventId/reason，不能读取 ledger 不支持的字段。`supervision-projection-regressions-20261106/verify.mjs` 实际 exit0，生产投影对真实 TtpTu2 原 Q 只标 B WAITING_USER、C仍为依赖等待，dSD7eb 原 RUNTIME_PROCESS_DIED receipt 原 ID进入 errors，旧源 bytes 不变；这是归档生产组件，不冒真实新问题 HTTP。CLI lastObservedAt 同 ID 单调补报另经 reviewer 的实际源码 VM/内存 I/O 消费者对照，T→S→T保持同 episode，两次 POST使 serverLast=localLast、原first/首次submitted/actionAttempted不变；旧 OS 包不倒称已覆盖该后续分支。

最终整合审查另指出同父不同资料目标的观察误判：实际 `HkTjN7/cross-window-before-third.json.state` 中 A 已批准，当前窗口又已耗尽并阻在 G；原按 parentReadId 永久排除的规则漏标等待用户。`supervision-context-wait-regression-20261106/verify.mjs` 同原归档/同断言实际 before exit1、after exit0。仅 T23 观察投影改为比较 production contextResumePosition 的当前精确对象/version/view/offset/path 与已批准目标；T20 窗口、页和额度全不变。`controls.mjs` 三个真实快照对照均0：A已批准未消费、原partial已批准未消费不再要求新许可，旧有cursor且无limitReason的partial仍可读。controller integrator 独立关闭该项；不是新跑三个资料 SDK 入口。

Kka 的清理最后追加一条 proxy ECONNRESET/aborted，不能写整包零 error；实际 SDK turn completed，原 claim/模型/SDK/ACK 证据不因清理记录被改写。作者 `supervision-final-checks-20261106/startup-current-comparison.json` 对保存原件逐字节核，9份中8份当前相同，唯一差异是上述观察分支；不将 canonical-string source digest 冒原始文件 bytes SHA。直接旧 Bridge consumer `bridge-focused-mwZy5h` 实际 exit0，原 hint409/resync/SSE/replay/ACK/generation/身份与锁入口保持。

FileStore26 的直接兼容 consumer `node scripts/test-context-read-compat.mjs` 已最窄适配，当前 `context-read-compat-CYW9v3` 三 case实际 exit0、syntax0。仍使用原三个真实 v24 源，不换输入；预期整树只变 version26、原三个空 context 域和新增两个空 supervision 域，全部旧字段与源 bytes 相等，不弱化为 subset。原 v24→25 产物继续作为 T20 历史证据保存，未改旧阶段事实。其他早期版本测试债或 state-transfer 扩展不在此片顺手修改。

T23 本地有界候选随后经原完整 integrator FINAL APPROVE，controller 再核17条 SHA/bytes、HEAD 和空暂存区后接纳，记录为外 Git `t23-final-approval.json`。该批准不包含 M2 语义偏航、远端机器死亡/断电、自动重启主机、完整全路线或部署验收；没有 stage/commit/push。后续 T10b 不改这17条中的业务产品，状态文档继续记录新阶段，旧冻结指纹保作历史。

## T10b 当前候选两段合流验收

新增专属 `probe-multisite-integrated.mjs`、`integrated-watchdog.mjs`、`verify-multisite-integrated-result.mjs`，只组织当前已有业务入口与独立只读 oracle。本片没有修改业务产品代码、既有 D4/T19/T20/T11/T23 探针或 Web。实际原命令 `node scripts/probe-multisite-integrated.mjs` 第三根 `multisite-integrated-a0Sa20` 为 actual exit0；外层原 stdout/exit 为 `multisite-integrated-launch-20261106-r3.log/.exit`。它先完成并独立封截源 D4，再在同一 API、原五个 remote 父进程仍存活时执行真实 Web 续办；不把两个不同源 Work 的历史成功拼成当前合流。

| 本片出口 | 当前状态与实际证据 |
| --- | --- |
| 五个原生角色、手机创建与照片、B自主委派A/G和独立analysis | passed：本 run 五 Node/五原 Session，来源为实际封存的20历史项/20站点事件；手机上传原照片，保原身份/权限/Node revision。模拟图片与来源不代表现场识图能力。 |
| 同稳定用户问题由另一 browser 回答 | passed：`question-state.json` 原 questionId，另一 context 实际表单答复形成正式 Input2，原Q已答；没有预填初始 dueDate 绕过用户问题。 |
| 真实 Job2 忙时 date-only 修订到 Input3 | passed：原 worker PID2738359/startTicks11262749，在 UI 修订前及已持久 revision3 后均有实际 `/proc` OS-T，之后明确 SIGCONT；原 Job2 未被当当前 ready，最终用当前 Job3/来源采纳与日期11月25日。 |
| C完整四表、唯一 ready/完成与根 settle、手机 reload 下载 | passed：源45份实际 body/45账；源 phase 的独立 ExcelJS/三份 XLSX/原 sealed A-G/完整候选页进入 provider 全通过后，才启动续办。Artifact SHA `eb534c55f516750e8ea88295ba2a208ecb0564ffe06d23607aeb90c4916e1077`，下载、B worker文件和云文件逐字节一致。 |
| 同 live 服务自然语言 proposal→preview→明确新关联 | passed：真实 Source、preview及continuation POST200，新 Work/Attempt/Session；新目标未预填A第19项或G正文，也未默认请求新 XLSX。原 Work/Input3/ready/filehash/旧45账保持。 |
| 新 Root 逐跳真实历史资料读取与模型消费 | passed：新 Root12份 provider，独立 Router1份，总58 raw/ledger；14页实际 Artifact→Job/manifest→result/Evidence，A第19项的第二页 readId `4bbb8efe531ba329ba89f0b46b507e49`、G原封存页 `bfc6493a8b8d66ed4465e7f6c1544b5b` 均有完整 tool-call/参数/返回正文与下一实际 provider 的 `contextReadReceiptIds`。20项不冒200项/多窗重测。 |
| 正式只观察 watchdog 的同 run 阶段 | passed：创建前已启动独立兄弟 OS CLI，observe-only/actions0；7份实际阶段快照覆盖等用户、Input2、Job2、源完成与新Root资料消费。生产结束时作者 oracle先读到270条，最终收尾 JSONL为275条，均有实际裁剪 snapshot，metadata-only为0，时段11:54:26.740–11:54:54.192；不将两个采样时点写成同一个总数。 |
| 阶段计时、介入与费用事实 | passed（数据采集范围）：单样本；创建/答Q/忙时修订/自然语言Source/明确新关联各1次，资料新窗许可0次。usage58条全null，实际费用null，仅显式模拟价3/7的保守估计合计116微单位，不冒实际账单。p95/SLO与真实人类操作效率 not-run。 |
| 既有多候选/无匹配、权限、handback、200项/跨窗、故障专项 | not-run 本次成功旅：按各原有独立批准及未改源码范围复用，不在本 run 叠加 T11/T23 故障或扩大这些历史证据。 |
| 真实现场模型理解/现场图片质量、F08真实两出口、F17 clean checkout、C12并发问题、M2 | not-run：本 run 为同机隔离进程、模拟 provider/来源与脚本驱动浏览器，不能冒真人、公网多机或完整路线验收。Web UI/浏览器交互本次实际验证；Agent原生GUI代操作/接管未选，C09/H16按条件not-applicable。 |

源段 `source-oracle.json` 在第二个 Work 出现前完成并保存，45请求和五 Session 只按源 Work/binding核对；随后默认完整 oracle按新 Work检查页和全文 credit，未硬断言全 Store仍五 Attempt。`completed-state.json`、`d4-capture.json`、`sessions.json` 是源封截；`context-final-state.json` 是新Root读完后封截；原 SDK 六组 allframes、全 raw provider、浏览器 network/截图、worker出生/停止/释放事实及全部进程退出日志均保留。

新Root末尾使用 `new-root-official-idle.json` 中精确本 Session 的本次 report call/result 之后的 official `turn/end completed`，再确认真实账结算并封截最终状态；没有用固定 sleep、旧 partial completed 或一次“没有unknown”的瞬间代替。该新Work封截时仍为running，SDK轮次completed不等于业务Work completed；随后显式 fixture cancel新Root并等 stopped，清理后为cancelled，再正常关闭全部父进程。源 Work始终已完成，未因清理重新执行或改写来源。

时间事实按服务受理、SDK实际消费、工具/Job检查点、ready/settle及下载观察分别保存。源受理11:54:26.960，首次对应消费27.672；Q创建34.459，Input2实际 `at` 为36.084、消费36.795；Input3 `at` 为37.904、消费38.304；ready验真45.877、根settle45.983、手机下载观察46.364。新Root受理49.379、消费50.319、首次资料读取50.527、末页52.896、报告受理53.225。原 `timing.json` 首版误取不存在的 Input.createdAt，两处为null，按当时产物保留；固定 raw 的 `input-at-timing-readback.json` 依据真实 Input.at补算，当前 probe两处字段也已最窄改为at，未重跑业务。脚本控制的Q到答复受理1625ms不是人类响应性能；没有从单样本计算p95。

两次初失败均保原证。`vMZTPg` actual1：真实源已到ready/download，新增 probe 的 workerBeforeRelease漏写约定 jobId/revision引用，严格 source oracle 拒，第二段未起；只补新 probe与真实 heldWorker的元数据关联，不补旧 `/proc` 事实。`GMRf6L` actual1：源 oracle通过且真新Root14页已执行，但父探针过早截57账，report之后 SDK正常最后一个 stop响应使 raw/capture/terminal为58；第58条实际completed原账及body保留，不裁掉造相等。修后第三根才按本次report后的官方终点收口。

第三根启动/运行结束源码副本相等；结束后 verifier唯一 U+FFFD 断言由查字面 `\\ufffd` 改为查真实 replacement 字符，固定 r3原raw上只读重跑默认完整 oracle actual0，日志为 `integrated-oracle-sol-20261106/unicode-r3-stdout.log/exit.txt`。另有上述 probe两处时间字段修正；这两类精确差异如实记录，不冒启动源码即当前全部源码，未为它们重跑 producer或改原raw。

独立 native reviewer 全解本包444个原 SDK frames：turn/end 为11 blocked、3 completed、1 error。唯一 error 在旧 B同 Session 的 revision2 turn5/seq99，11:54:38.107为 UNKNOWN/“节点请求无法完成”；它发生在正式 Input3受理37.904之后、新 Input3实际 User seq104/38.279及云消费38.304之前，旧 getJob的 result seq94本身成功。之后同 Session turn6真实消费 Input3并形成唯一 revision3 ready，没有额外 Attempt或 unknown ledger。原包没有这次精确 HTTP拒绝原文，因此不将根因擅定为“授权拒绝”，也不将它挪到 cleanup 或声称全程 SDK零 error；provider的 capture.errors=0是不同证据层级。上述两段必需出口仍按实际原证成立，没有为未定根因扩修业务产品或重跑 producer。

§18.4的运行时导航补在本根 `runtime-version-readback.json`：明确是 producer结束后的只读版本读回，实际 Node v26.5.0/linux/x64及execPath、按生产同一 createRequire实际 resolve的dsh-agent-loop/dsh/app-boot/tools 0.2.0-rc.2、ExcelJS4.4.0的安装路径/package manifest/entry摘要、repo package/lock摘要均可复核。它同时指向本文件原M0“上游来源与受控移植”表、固定上游 `6337fc823ce20251c8de8085948165c81aaa701e`、MIT和实际移植模块；不冒启动时版本采样、新上游fetch、独立上游完整suite已跑或新依赖安装。

`owner-process-port-readback.json` 读回 producer/API/五Host/watchdog/UI九个记录PID均消失，API33811端口拒绝；原 API/五Host/UI退出日志与 watchdog exit均0。provider运行于producer同进程，未单独记录其端口；不冒未记录的浏览器PID出生审计。当前三新文件与本文冻结后交 controller 独立 native/UI/完整整合 gate；作者 oracle与本地 actual0不自行授最终批准。没有 stage/commit/push/deploy，完整 M2 仍后置保留。

## Work 成员访问否决与局部停止（状态版本 27）

本片增加单向的本 Work 成员移除：工作负责人在原详情页操作实际参与过的逻辑员工，`POST /api/works/:id/multisite/remove-member {employeeId,clientRequestId}` 复用原会话、Origin/CSRF、owner 和幂等事务。稳定主体是 workspace/Work/employee，Node、Attempt、Session 与协议群成员均不能替代这一主体。同键同体返回原回执，异体冲突；同员工再次移除不追加事实或重复停止。历史状态迁移只增加空 `workMemberRemovals`，不回填历史撤权，也不更改全局 Node、Resource、员工或工作要求版本。

集中成员门收窄原执行、目标委派、当前祖先授权和新数据访问；原有授权仍须全部成立。撤销当前父授权时，仅其真实当前后代一起清理。未完成执行排原 cancel，已完成但未停稳排原 settle，停止证据未到时界面仍显示“执行停止待确认”。原工作不会被局部清理误取消，原 completed 工作不降级。父执行收到精确 `dependency_unavailable` 消息，不会收到伪成功结果或自动替换员工。与被移除执行有关的问题和订阅精确关闭，其他成员及其他 Work 保持原权。

旧 sealed transport ACK 与新权限分开：原 command/event ID、digest、Node/instance 和完整 binding 仍须精确一致；最小已提交命令回执不重新取正文、prepared input 或 token。移除后新普通报告可作为 historical 事实接纳并回精确 ACK，不推进业务；原已受理 Job 的连续生命周期事实仍按原序号记录，才能让最终 stop evidence 经 FIFO 到达，这不授予新 Job、上传或 ready 权限。特殊控制命令的 ACK 不再误用执行准入，但其实际消费、模型、工具与数据门不放宽。

历史资料的来源 Work 与当前消费 Work 独立检查实际 reader employee。来源 Work 移除读者后，新的页、旧 cursor 和旧 Session 缓存页重新进入 provider 请求均拒绝；消费 Work 自身的原合法请求仍可执行。已发布成果的 owner 与产出员工自身 ACL 保持独立：来源 A/G 被移除不级联到仍获授权的 owner/B 成果；原本无 owner 权限的访问仍拒绝。该规则不等于删除对方以前已经取得的本地副本。

作者本地验证原件位于 `geneway-evidence/`，最终是否接纳仍由 controller 的独立审查决定：

| 实际入口与观察 | 原件与边界 |
| --- | --- |
| 原 Node G 读第一页并发言，owner 移除后旧页 token/cursor、新命令和旧模型 token 拒绝，模型无新 reservation/forward；原 metadata receipt 重放不生新效果，异体冲突；真实原停止后同 Node G 在另一 Work 仍合法 | 首包 `work-member-http-4VCmCf`；稳定候选组合包 `work-member-http-JDD8os`。真实 HTTP、FileStore、封存来源与 Host 消息/停止流程；Agent 推理为 HostSim，不冒原生 SDK。 |
| 特殊控制命令已持久进入 Host Inbox、尚未云 ACK，随后移除，原精确 ACK 200/acceptedAt 落盘；坏 digest 拒绝，新 command 取回仍拒，后续原 stop 正常闭环 | `JDD8os/control-inbox-before-remove.json`、`control-ack-after-remove.json`、`after.json`；独立组件 before 403/after 200 来自原 reviewer transcript，和真实 HTTP after 分列。普通 launch/deliver 的原 Node 身份检查未改变。 |
| 模型旧附件 token 的实际读取、hash/格式验证已完成，在 download 返回前屏障中提交移除，放行后 403 且无原附件字节；无移除正控 200/原 bytes | `JDD8os/attachment-io-complete.json`、`attachment-race-response.json`。该组合 HTTP 屏障期间也有 G 人工暂停，HTTP 拒绝属于复合控制，不单因归于成员移除；member-only 因果来自独立组件 44ccce→d7b812。屏障只包装真实附件 download 返回；生产修复在返回字节前重新检查当前执行、原 ref、token 有效期和原 manual fence。Owner Artifact 下载入口未改。 |
| 真 Source/continuation 创建新的 root Work，原资料三页确实进入下一 provider；仅来源 Work 移除实际 reader 后旧页重读、旧 cursor、缓存再 forward 拒绝且无新增 read/reserve/forward，当前 Work 独立 forward 200 | 最终 `work-member-context-3oAxPG`，`before-remove.json`、`after-read.json`、`provider-bodies.json`。来源是已验 D4 原字节的独立 clone，新 reader 和执行为本次真实 HTTP/HostSim；不冒重新跑原生 D4。 |
| 完成的小 Work 移除 A/G 后 owner 同 hash 下载 200，非 owner 的 B employee 对照仍 404；第二 Work 的 B 真实 OS worker 运行中移除后，原产线 cancel 形成 Job stopped/exit_confirmed/no_published_output、sealed stopped/exact ACK、slot false，Work 保持 waiting_input | 首包 `work-member-job-38PFBX` 为 end-only 源观察，不能倒称 startup 一致；最终 fresh `work-member-job-JFdw78` 的24份 source-start/end 原字节与摘要全等，真实 worker521360与owner520374退出原件、Job stop/ACK 均在本包。推理为 HostSim，文件 worker 为真实 OS 进程；未用测试 kill 代生产 Job 停止。 |
| owner 桌面 1366 与手机 390 两浏览器真实点击，先读到 access removed/cleanup stopping；保存 Store 后才放行原 Host pump，随后真实 stopped，两端按钮消失，协议群显示不适用，Input/revision/草稿保留 | 首 UI 包 `work-member-http-qUhmo5` → `work-member-removal-ui-TmKgH6` 六图已独立查看；最终 `JDD8os/ui-phase.json` 指向本次六图。最终实际 served-index 与源码原字节一起保存。没有外接协议群，本片不虚构外部群 pending，也未测所有 Q/unknown UI 分支。 |
| 原 v26 备份经当前 CLI restore 为 v27，空撤销域、原整树保留；非空撤销、旧格式未来域、原不支持的 multisite/字节/模型与未开放 21–25 版本在目标写入前拒绝 | `work-member-original26-6WrNui` 是 bump 前原 CLI 真备份，主要证明格式/版本；另两份真实丰富 v26 归档迁移全树深等证明历史保留，不把空备份冒充丰富历史恢复。新 state/compat 测试以及原 context/supervision 直接消费者已适配 27，原真实源不换、不削弱整树断言。 |

源预审发现并修复的两个本片阻断分别为：特殊控制 transport ACK 在移除后误走执行门，以及旧模型附件 token 的末 I/O 仅复验 manual fence、缺当前成员门。原 reviewer 的 before 为归档绑定上的内存 Store/真实生产 handler 组件观察，不能称真实 HTTP 故障；after 的对应组件与本片真实 HTTP 情形分层保留。早期新增 pending-control 测试对 `MANUALLY_PAUSED`、`REVISION_CONFLICT` 与 `FORBIDDEN` 检查先后预期错误，以及附件 HostSim 未声明能保存附件投递而未启动，均保原失败根，不当产品故障或覆盖原包为绿。

最终候选只重跑本片最小 HTTP/UI、T20 supporting 和单行 OS Job，未叠完整 T11/D4/200 项矩阵。原协议比较、群治理、T03b 选型、真实现场/公网两出口、clean checkout 和完整路线剩余范围继续后置；本片不选协议赢家、不部署，也不以作者测试授最终批准。

## 按 Work 绑定的协议群本地窗口

共同 Work 成员否决片已由 controller 接纳后，本片仅增加可选 owner Work详情 GET 的只读协议状态 provider 与原卡的 pending/unknown/confirmed 展示；不升状态版本、不添主 Store 域、不改变已接纳成员门或成果独立 ACL。provider I/O 后按当前 removal identity 再校准，只输出枚举，不暴露 DID、日志、URL 或秘密；未配置才不适用，已配置不可达为 unknown。其余协议实现全部在独立 experiment，默认生产启动不安装或同时启用两个 SDK。

真实本地根 `protocol-work-group-a2a-yrc16K`、`protocol-work-group-anp-RlDyLz` 均先在本根原 Work 建立真实 B/A/G Node/binding，再建私有工作群，完成实际双收件人广播、原责任问答与单事件当前权限解析；随后真实浏览器移除 G。三方 source/Evidence 仍走原授读门，另一个在群且有自己来源权限的 actor 对未授予的 G 来源仍拒绝。群副本不再唤醒原定向 Session。

同根保留 product removal 已 commit、control 尚未 enqueue 的观察，随后真 SIGKILL 所选桥，API/原 Host 与 ANP GroupHost 不停；同 root/identity/endpoint 重开后 fresh scan 补稳定 removal key。移除真正到 Host/应用控制前仍有屏障，当前 G 原 Node/旧 token/managed 操作立即拒绝，B/A 新 fanout 也等待校准，旧 locator 不能重新解正文。释放后，A2A 应用成员/目标积压逐项标定，原 offered opaque ACK 不改正文权限；ANP 的原 signed remove receipt、fresh unsigned roster 与只读 SQLite/目标收件校准同时具备，G 最终 state_changed 到达才确认。ANP 本次版本/序号 5/9，非目标合法 recipient 的队列不要求被清空。

两根各35份 source-start/end 原字节相同；新 UI 两根各十图（`Slbfk1`、`4jeRVr`）已由独立浏览器 reviewer 实际逐张查看，served HTML 与运行源绑定。实际状态分别是业务访问撤销、执行停稳、协议 pending→桥不可达 unknown→恢复仍 pending→confirmed；不是只看到停止就宣称群撤权完成。B/A 权限、原正式 Input/revision、双窗口草稿和 Node/Resource 版本保持，G 真实停止后同 Node 在另一 Work 的原操作合法。

作者与独立 oracle 的原件层边界分列：标准 wire、原 HTTP signature/origin/Group receipt 可重算；roster/SQLite 观察本身 unsigned。当前新路径是 HostSim 加真实 HTTP/文件/协议/桥进程与本机模拟，不冒新的原生 SDK 全矩阵、真实设备/公网或完整 Task/Group 资源成本；原 published owner 成果自 ACL 资格按未改授权路径复用，不重跑整 D4。剩余 profile 声明/七硬门/成本/ADR 仍在完整路线内，此窗口不选赢家、不授生产双 adapter 或 T03b。

原 X03 full 两根确认后的最后 B publish 是旧已接受 locator/operation 重放，只记为幂等/仍获准旧摘要读取。全新 B/A 发布在另两新 Work 短窗 `protocol-work-group-a2a-JMn1Xa`、`protocol-work-group-anp-PEaoQQ` 实跑，各含真实新 messageId/new locator/new protocol operation、对方实际 receive 与本人 Node 新摘要读取、G 有效身份/新正文拒和模型账不增；不把这些原件拼成旧 full 同 run。新审查的 300 秒 proof 过期阻断已按不变领域 method/meta/body/digest/operation 续签认证修复，`anp-work-group-renewal-K2inBo` 在旧 Host 根的独立 clone 上真实过期拒/续签原 receipt/版本事件计数不增/改体冲突。自动 result:null 续签与 attempt fsync-before-fetch 仅独立源码检查，未实跑该自动分支或再次崩溃，旧 full 35 源只维持旧短窗资格。两小 positive 根 35 源 start/end 与当前运行候选一致；最终身份差异与实际命令/exit 在本片唯一 source manifest 中分列。
