# P5-K1：Kivo TPM 事件与主动持续工作

> 合同 v4.4 当前执行计划。2026-10-16 07:40（Asia/Shanghai）形成，早于 P5-K1 探针、代码与服务运行。状态：**实施与独立技术审查通过；2026-10-16 final03 同一候选完整旅程 17/17 通过；验收材料已发送飞书并逐条回读；用户已确认“P5 通过，开始 Team Astra 规划 P6”**。
>
> v4.3 的 P5 PASS 仅证明旧 DSH / GearJob 路径；原计划与历史证据保留在 Git 历史，不是 Kivo 验收。P4 已由用户于 2026-10-16 07:21 确认功能通过；普通界面逻辑后置至全量功能实施后统一调整，权限、安全、误操作和必需入口不可达仍当期解决。

## 1. 目标、基线与权限

按合同 §5.6、§9 完成 J8 / AC-18 的 Kivo TPM 签名 webhook 路径：真实受权的人类 HTTP 更新 synthetic 单据，经业务事务、outbox、真实 mes-worker 投递，Geneway 持久受理并在 10 秒内返回 2xx；异步通过当前授权 MCP 读取当前事实、创建有界工作、由 DSH 分析，并在 Web 和模拟渠道回读。兼容原每日定时语义，重新验证 Kivo 目标与通知。

- Geneway：`/home/gewu/.devspace/worktrees/geneway-f4222c66`，`rebuild/dsh-greenfield`，实施前基线 `5d1a1efa76bb6ee38387d880561043fd6832c8ca`。
- Kivo：`/home/gewu/.devspace/worktrees/kivo-geneway-mcp`，`codex/geneway-kivo-mcp`，基线 `c429483ac0d423cc1092c1d9d6d517dc4c910e44`。只用此独立 clone；不得触及共享 Kivo 工作区或改写其 refs。
- 只在本机独立数据库、Redis、端口和 synthetic A/B 实例验证；仅 loopback。只本地提交，不 push、PR、merge、部署或发布。不向真实成员发产品消息，不扫描联系人或群。
- 不读改暂存清理 `ui-sketches*`。秘密只在服务端独立 secret store；不从旧项目扫描。普通管理员不能读取成员正文。
- 模型固定 `deepseek/deepseek-v4.1-flash`，无 fallback；渠道为模拟验收，经实际 iLink 和飞书通道代码。
- P5 不开放机器写入、不增加通用事件总线、第二队列、第二 MCP、补历史事件工具、任意 cron、字段过滤 DSL 或部署入口。P6 的创建维修单仍单独规划实施。

## 2. Team Astra 规划与审查门

两名独立只读规划者先分别形成方案，随后交换分歧并形成共识：

- `/root/p5_k1_product_planner`：Astra/high，产品语义、旅程和验收。
- `/root/p5_k1_engineering_planner`：Astra/high，生产者、受理、安全和恢复。

主代理汇总本文件，两个 planner 均未实施或启动探针。共识包括：目标单据 revision 是唯一变化依据；受理不等 MCP；固定 60 秒对账；激活 baseline/CAS；单 store 原子关联；严格来源配置；备份绑定来源配置；精确 action 回声识别及 P6 真实写链界限。无未决产品分歧。

独立审查者必须未参与规划。两名审查者接收相同合同、当前决策、计划和源码候选，首轮互不提供对方结论或预设 PASS：一名审查复杂度，一名审查合同、正确性和验收闭合。争议复杂度先做有界消融，再修订原位计划；不能以实现代替计划证明。只有正式复审通过才开放下表实施任务。用户保留阶段最终验收权。

独立过度设计审查 `/root/p5_k1_overdesign_review` 已通过只读有界消融：删除持久入站、对账或版本/activation 会破坏明确验收；另建队列、listener、trace 表和配置框架无必要。正式阶段审查 `/root/p5_k1_plan_phase_review` 首轮指出 active 无 occurrence / ACK pending 时改绑的基线缺口。两名原 planner 再次独立判断后形成“仅 draft 改身份”的共识，已在 §3/§10 原位闭合；过度设计审查也确认该变体避免活动改绑迁移事务，最终正确性复审已通过，审查内容 SHA-256 为 `ac0d5ebdd757aaf3cf80e59367282b40ccf7762e7b402efea6c875603746f402`（随后仅更新审查状态）。独立复审仅证明计划就绪；此过程未运行探针或实施。

## 3. 用户行为与规则边界

成员为明确的 Kivo TPM 单据选择“每天核对”或“跟进该单据新版本，核对当前状态”。输入为 `{recordType, reference}`，仅 `repair | maintenance | inspection`，绑定明确可信 connection，不可按同名单位自动换实例。

事件规则跟进整个目标单据版本，不做字段过滤或字段投影。Kivo 当前业务事件覆盖维修 `status/executorId`、保养 `status/assigneeId`、点检 `status/startedAt/completedAt`；其他更新由对账发现。界面说明事件可及时唤醒、每 60 秒发起当前状态核对，不能承诺所有目标在 60 秒内完成或逐条历史变更恢复。相关设备版本变化不触发单据规则。

首次启用或恢复时，MCP 读取稳定 recordId 和 `records[0].facts.revision = R`；随后 CAS 规则配置 revision/status 并复核当前权限，才写 active、activationId 和 baseline R。读失败保持 draft/paused。activationId 可用本次激活配置 revision；handledRevision 独立推进，不改变用户配置 revision。GET 与 CAS 之间的 R+1 必须由后续事件/对账发现，不按 occurredAt 早于 CAS 丢弃。

仅 draft 规则允许修改身份字段：目标 `recordType/reference`、connection 及可信 source 身份、employee/skill、`trigger.kind`。首次成功激活后身份固定，不以是否已有 occurrence 为条件；active 尚无 occurrence、已持久 ACK 尚未生成 occurrence、paused 均不得改绑。更换身份须新建草稿，不自动停用旧规则。身份比较只取上述字段，不比较整个 trigger；每日 `HH:mm` 不是身份。

首次启用的 MCP 读取或 CAS 失败保持 draft，可修正身份后重新启用；读取基线期间若配置已改，旧 revision CAS 必须失败，不得把旧目标 baseline 写给新目标。恢复失败保持原 paused，不新增“从未激活但 paused”状态，不因缺少 occurrence 或 activation 证据自动解锁暂停规则。

累计预算、本人通知目的地和每日 `HH:mm` 按现有权限、配置 revision、生效时间及日期去重规则修改。非身份编辑不更换 activationId、不重置 baseline/handledRevision，也不单凭配置 revision 变化终结同 activation 已 ACK 的 pending。pending 原子认领采用最新预算、通知身份及当前授权，记录当时配置 revision；已有 occurrence/work 保持原关联。所有成功的配置 revision 更新均沿用既有通知失效规则，包括预算与每日时间修改：已有 occurrence 的旧未发通知失效，sending 按真实结果处理，不迁移旧消息或重跑工作；这一门禁不终结尚未关联 work 的同 activation pending，其后认领使用最新 revision。无需另设通知版本水位；预算终态跳过不因后来加预算复活。

旧 GearJob 规则只保留历史、暂停和撤销入口，不能映射为 Kivo 或重新启用。暂停后恢复必须显式操作并建立新 baseline；暂停期间不补历史。

保留原有边界：

- 每日只支持上海 `HH:mm`，到时 60 秒窗口；`ruleId + 当地日期` 去重，漏定时不补，重启或同日编辑不重复。
- 累计预算 1–10 次，默认 10；创建并原子关联 work 才消耗；失败、停止、中断不返还。纯读取、重放、回声和通知重试不消耗。
- 单次 120 秒硬截止，全局自动并发 2。overlap/capacity/budget 为终态跳过，不排队或暗中补跑。
- “现在核对一次”读取当前事实并遵守预算，不冒充历史快照。
- 停止本次、暂停规则和取消待发通知作用于不同范围。暂停不主动调用已有 work 的取消入口，但阻止新发生、旧 activation pending 的认领，以及已有 work 后续尚未发送的受控模型请求、业务 I/O 和重试；不能保证在途工作继续完成。停止本次只取消该 work，不隐含暂停规则。暂停沿用既有通知失效门禁，旧待发通知不得继续发送，sending 按真实结果处理；单独取消通知不停止工作或规则。已发出的外部请求和已发通知不伪称已撤回，已持久结果按当前访问权限保留。成员、员工、Skill、连接、模型路由及上游权限仍在各请求边界独立复核。

2026-10-16 08:27 两名原 Astra planner 对暂停边界先独立核对再交换，按合同 §4.1/§4.2/§5.5 与既有 active grant 门禁形成以上精确说明；未放宽规则停用后的派发权限，未新增产品行为。恢复仍使用新 baseline，不复活旧 pending、终态执行或已失效通知。

## 4. 可信来源与窄接收入口

复用 Web loopback server 的固定 `POST /api/events/kivo/:sourceId`；在 Cookie 认证前独立执行严格 HMAC 路径。automation owner 成功取得后才 listen，未持有 owner 不受理。不得增加第二 listener、端口或泛化 webhook 框架。

唯一配置固定在 `${runtimeConfig.dataRoot}/event-sources.json`，dataRoot 是 stateFile 所在目录。runtime 与备份共用严格 loader；不提供可覆盖路径环境变量、CLI 或 state 内副本。每个 source 明确映射 connection、可信 MCP resource/source instance、signingSecretRef、允许上游 subscription ids 和 enabled。body 中自述的来源字符串不能建立信任。缺失、停用或失效来源不受理事件；每日定时独立。

签名遵从真实 Kivo sender：`whsec_` 后 base64 解码密钥，`v1` HMAC-SHA256 over `id.timestamp.rawBody`，常量时间比较。只对原始 bytes 验签；header 唯一、delivery id 与 body 一致、时间戳容差 ±300 秒。初始 body 上限 64 KiB、读 body 截止 5 秒，T0 用真实 payload 验证容量，不凭空扩大。只接收严格 `generic_json v2 / business_event`，拒绝 v1、错误对象、版本、时间、来源或订阅。展示 message/link 不进入模型或目标选择。

同 deliveryId 同 raw digest 返回既有受理结果；不同 digest 返回 409。digest 不含签名时间 header，合法重新签名不改变内容身份。同 eventId 的不同 delivery 允许 message、basis、display、link 和上游 rule 等展示/投递差异；业务 typed fingerprint 冲突返回 409。fingerprint 包含可信来源/adapter、kind/version、对象身份、revision、occurredAt、trace/actor/action、before/after 和安全相关 subject 身份；label 不充当业务身份。

## 5. 持久受理与异步处理

复用唯一 file store，增加窄入站集合：每个 source+eventId 一条 canonical 事件，包含最小 typed facts/fingerprint、deliveries 的 `{id, rawDigest}`，以及首次受理时 active 规则的 targets `{ruleId, activationId, pending 或终态 occurrenceRef/reason}`。同事件后续 delivery 不扩展到后来启用的规则；首次无 active target 永久 ignored。

在 store durable sync、rename、directory sync 后才返回 2xx，正常须小于 10 秒；绝不等待 15 秒 MCP 或模型。存储失败不虚报成功。Kivo 503/响应丢失可能进入 unknown 而不重投，必须靠对账补偿，不能宣称生产者必然重试。

异步后处理与定时对账共享 claim：`ruleId + 可信 source instance + recordType + objectId + 当前 MCP revision`。事件 revision 为 r，当前查询 R>r 时最多生成一次 R 工作，并分别展示事件时间/版本与查询时间/版本。当前 R<r 保持 pending、等待后续周期；低于已处理版本则阻断，不倒退。相同版本由 webhook/对账同时发现，也只能关联一次工作。

work/occurrence、handledRevision、target 终态在同一 store.update 中闭合。每个 accepted target 必须有可解释 pending 或终态；不能先推进 handledRevision 后丢 work。首次目标固定于 activation，暂停、恢复、撤销或删除后的旧 pending 不复活。

固定 60 秒对账读取当前目标版本，不做快速重试或历史补取。断线跨过多个版本最多补一次最新状态；不得编造每个中间 transition。

## 6. 当前授权、失败与恢复

metadata、token、每次 MCP tool、关联设备二跳和重试，work 受理、模型执行、业务 tool、通知发送及重试均复核当前授权。不能仅凭事件签名或激活时授权长期执行。

确认账号/密钥/权限被撤销：规则 paused，显示原因，旧 pending 终结。恢复权限后用户显式 resume，建立新 baseline。timeout/连接暂不可达：保留 active，下一 60 秒周期再核对，不推进 handled、不耗预算、不忙重试。区分硬撤权与软失败，不能把所有 403/异常都当网络抖动。

普通进程重启只重新只读处理 pending；已有 work 不再次派发，活动 work 沿用 interrupted 语义。保留去重 tombstone；不增加 TTL 清理任务或历史重放 UI。

备份恢复必须保持：active 规则变 paused，pending 入站变 restore-suppressed，渠道关闭，sending 变 unknown。旧 webhook 重投不得复活规则或派发工作。

## 7. 精确回声识别与 P6 边界

只识别已持久化的明确 Kivo 维修创建 action：action.id 严格等于 trace、有 attempt 且非 noEffect；preview.target 包含最小 `{resource, sourceInstance, recordType:'repair', orderNo}`。复用现有 action intent/preview，不新增 trace 表、写工具或第二 action 状态机。

创建前 UUID 未知，事件 subject.label 不等于可信单号。复用必需的当前授权 MCP 回读，严格确认 `record.reference === 完整 orderNo` 且 `record.id === event.objectId`；已有 receipt 时再核 UUID。不得按 GW- 前缀、读执行 trace、label 相似或不同来源 action 抑制事件。

仅抑制明确回声 event revision；同次读取发现更高 R，仍按普通变化处理。P5 正例只能是明确标注的合法持久 action fixture 加真实消费者检查；当前 Kivo producer 仍仅 human 变更，不能声称真实机器创建回声已通过。

P6 必须新增并真实验证：机器 MCP 创建维修单→事务内审计/业务事件 producer→回声匹配；丢 webhook 时写后回读 revision 与 action 关联。此边界不提前开放机器写入，也不免除 P6 验收。

## 8. 来源配置与备份生命周期

普通备份只增加固定非秘密 `event-sources.json` entry，不读取 secret root。signingSecretRef 纳入独立 secret pack refs。读取秘密前后及发布备份前比较来源配置 snapshot hash；有 sources 的 secret manifest v2 同时绑定 stateSha256 和 sourcesSha256。旧 v1 仅兼容无 sources 包。

恢复先验证全部摘要、refs 和路径，再将来源配置写入目标 dataRoot 同名文件，强制 enabled=false；更换 GENEWAY_STATE 自然读取恢复后的禁用配置，不能转回旧 enabled 文件绕过。存在当前可恢复事件规则、pending 引用或实际 sources 文件却遗漏时，完整备份必须失败；仅 revoked 规则/永久终态历史不要求已退役来源配置永久存在。

必验：普通备份零 secret 读取、双摘要/refs 错配拒恢复、备份途中 sources 变化拒发布、恢复后原签名不受理、旧无 sources 包与仅退役历史仍可恢复。

## 9. 就绪任务、所有权与顺序

以下均已通过独立计划审查；**只执行依赖满足的任务**。Team Sol 实施，主代理是计划及验证总记录唯一写者。

| 任务 | 责任与路径 | 依赖与出门证据 |
| --- | --- | --- |
| K1-T0 真实生产者探针 | Kivo 隔离 fixture/验收脚本唯一 writer；必要测试就近，不改无关业务或 MCP 协议 | 计划通过；人类 HTTP 更新三类单据、事务 rollback、outbox、真实 worker、v2 原字节/HMAC、delivery/event 身份、可达 loopback 与 body 上限。失败先分析，不能用直接 POST 替代主链 |
| K1-T1 核心运行链 | Geneway core 单 writer：automation-service、store、work-service、execution-grant、server、runtime-config、state-transfer、窄 kivo event adapter 及就近测试 | T0 协议事实可用；严格来源/受理、激活/对账/claim、当前授权、恢复/备份、echo 消费者。复用 kivo-tpm 读链，不新造客户端 |
| K1-T2 成员入口 | Web 及 UI tests 唯一 writer；通知如需修改须明确移交该路径 owner | T1 API/类型稳定；三类单据定时/事件创建、启用、暂停、恢复、撤销、预算、原因、发生/工作关系、历史退休；权限隔离与可操作性 |
| K1-T3 独立回归 | 非实现者只读 review/verifier，验收脚本单独 owner | T0–T2 候选；下节安全/失败/重启/恢复、Kivo 及渠道回归，同一候选留证 |
| K1-T4 阶段交付 | 主代理统筹，独立阶段审查/视觉审查 | 冻结候选真实 UI 同对象全旅程；视频、离线说明、飞书逐条回读；用户最终验收后才进入 P6 |

并行仅用于明确不冲突的路径与依赖。共享核心不得双 writer。Control 若有必要变化，先独立意图提交；当前方案不改变 Kivo 生产协议和机器写权限。发现会改变业务目标、写动作或授权范围的问题，停在该分支问用户。

## 10. 验收矩阵与命令记录

主链必须是普通 UI 创建规则→真实 Kivo 人类 HTTP 改同一 synthetic 单据→事务/outbox→实际 mes-worker→签名 webhook→durable 入站→当前 MCP→DSH Flash→工作正文→模拟渠道回读。直接注入仅验证负例或确定性竞争，不能顶替主链。所有结果标注 synthetic / 渠道为模拟验收。

| 维度 | 必须观察的结果 |
| --- | --- |
| 生产者 | 三类单据支持字段提交产生真实事件；rollback 无事件；不支持字段更新由 60 秒对账发现 |
| 接收 | 错签名、重复 header、旧 timestamp、错 source/subscription、v1、body 超限拒绝；先 durable 后 <10 秒 2xx；MCP 延迟不阻塞 ACK |
| 身份与重放 | 同 delivery 同内容幂等、不同内容 409；同 event 不同 delivery 的展示差异可接受、业务冲突 409；后来启用规则不吃旧事件 |
| 激活与版本 | GET/CAS 间变化可捕获；只目标 revision；r<R 最多一个当前 R work，R<r pending；不倒退；事件与对账并发唯一工作/预算 |
| 规则编辑 | active 无 occurrence、已 ACK pending、paused 均拒绝改身份且原归属不变；同 activation 合法预算/通知编辑不吞 pending；草稿 GET 期间改目标使旧 CAS 失败；读取失败仍可修草稿；已有发生的每日规则可改 HH:mm，日期去重不变；不重置预算或复活终态/旧通知 |
| 补偿 | 丢投递、unknown、暂时断线、重启后只补最新状态；不伪造中间历史；terminal skips 不补跑 |
| 权限 | 禁用账号/轮换密钥/撤权与二跳/发送重试均当前复核；硬撤权 paused，软失败不耗预算；本人可读、他人和普通管理员不可读正文 |
| 生命周期 | 暂停/恢复新 baseline、旧 pending 终结；正常重启不重复；恢复配置 disabled/规则 paused/pending suppressed/sending unknown；旧签名不唤醒 |
| Echo | 精确 source/action/trace/完整单号/UUID/attempt；近似、异源、读 trace 不压制；更高版本照常处理；正例注明 fixture，P6 真写链未验证 |
| 定时与界面 | 真实每日到时、60 秒窗口/漏过/上海日期去重、1–10预算、并发2、120秒；停止/暂停/取消通知不同；关闭/重开无隐式写入 |
| 备份 | 第8节全部；旧 state 合法迁移且退休 GearJob 不复活；秘密不进模型、浏览器、正文或普通备份 |

首先检查并使用现有最小命令：`node scripts/test-p5-automation.mjs`、`node scripts/test-p5-execution.mjs --pure-only`，以及仓库现存 timer/notification/http-ui 的 harness-check 入口；确切文件/参数在执行前从 package.json 和脚本确认，不能把尚未存在命令写成已跑。补充本次 Kivo events/source loader/store/backup 语义测试以及 retired、Kivo grants、P6 action 保留行为回归。native/HTTP 用批准的隔离 launcher。

Kivo 数据库集成必须先证明独立 test 库身份，现有 PG suite 按 `FMS_TEST_DATABASE_URL=DATABASE_URL` 的测试约束运行，禁止把默认库伪装为 test 库。现有 pnpm 11 workspace 聚合前置失败不得为绕过而安装/改依赖；可按脚本展开验证并如实标明未通过聚合命令。已知 Kivo boundary 基线失败须比较新增，不把 exit 1 写成通过。

单一阶段验证记录沿用 workflow `20260919-006-geneway-dsh-greenfield` 的外 Git artifact，逐项记录候选、命令、退出码、环境身份、失败与跳过原因。源码、HTTP200、单测或截图不能单独证明完整业务链。执行前后核对安装/源码与测试残留，按明确拥有的 PID/process group 和 fixture 清理，不广扫杀进程或删除他人数据。

## 11. 冻结、交付与最终门

独立 reviewer 审核实现和完整证据后，仅当前任务路径逻辑提交，检查 staged diff 与 `git diff --cached --check`，记录两仓 commit；不以提交代替验收。冻结后的实录须绑定同一候选和同对象旅程。

每个有界面阶段提供真实操作视频和可离线查看说明，显著标“渠道为模拟验收”；完整解码、打开手册并完整观看审核视频后再交付。通过 lark-cli 发给用户并逐条回读。UI 后置决定不免除必要入口、权限、取消、失败说明和真实可操作性验收。

阶段报告区分实现、单元/集成、真实生产者与浏览器、模拟渠道、用户最终验收。2026-10-16 技术验收依据为 candidate04（SHA256 `74b15828ec42b67e175ec673a1f8088edb1b508d17ec11bfcbb4f1962df39bdf`）的 final03 完整 17/17，退出码 0；原 final01、final02 失败记录保留，不拼接为通过。独立整合审查无 Critical / Important 阻断，详见 workflow `20260919-006-geneway-dsh-greenfield` 的唯一验证记录 `p5-k1-verification.md`。

保留限制：`pnpm run test:p5:pure` 因禁止 Corepack 联网未执行；九条展开命令中八条成功，备份 fixture 适配后该单项成功，不称聚合通过。渠道为模拟验收，业务数据为本机 synthetic。精确 echo 正例为持久 action fixture，真实机器创建回声及 T0 的 HTTP 201 / 事务回滚异常仍是 P6 写成功判定门。P6 仅在 P5-K1 用户验收后，另以 Team Astra 在原 P6 计划重规划；P7 同样先规划后实施。全合同当前仍未完成。
