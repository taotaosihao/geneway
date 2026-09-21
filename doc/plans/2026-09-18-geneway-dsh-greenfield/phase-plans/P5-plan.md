# P5 定时、事件与主动持续工作详细计划

状态：**P5-T0 探针代码与受控真实拓扑已通过独立复核，但未修补 GearJob 常态事件 runtime 为 `BLOCKED_EXTERNAL_RUNTIME`；双 Astra 已收敛为 `READY_PARTIAL`，当前 D 已依据用户对中间产品决策的多 agent 委托完成 Flow Approval 绑定。可继续 v7、权限/预算、每日定时和对应 UI；真实事件启用及完整 P5 完成门保持阻塞。**

基线：`283771c5240799360f9c0d5f0d439e440fdaa4ad`（P4 飞书 runtime 切片）。P4 企业微信、真实手机 HTTPS 和阶段末真人验收仍为 deferred，P4 不是 PASS。

本计划是 P5 唯一有效计划。它不授权修改 GearJob/Frappe 产品源码、新增网络暴露、生产写入、部署或发布。

## 1. 目标、关键旅程与非目标

P5 交付 G7、J8 和 AC-18：已授权成员为明确 GearJob 测试工单创建一条每日定时规则和一条真实工单更新事件规则。每次合法发生经既有 work service 读取、分析并保存结果，Web 始终可回读，可选通知只发本人已验证飞书私聊。

两条规则针对同一工单时仍产生两个独立工作，不按工单号合并。事件只说明“为什么触发”；业务结果必须由 DSH 工具重新读取当前源事实，页面分开显示事件时间与查询时间。

P5 不实现：通用 Workflow/DSL、事件总线、第二任务队列、模型轮询、任意 cron/时区、群发、跨成员自动共享、无人批准写入、通用补偿平台或 P6 业务动作。

## 2. Team Astra 规划、分歧与唯一裁决

### 2.1 独立规划者

- 产品/UX：`/root/p5_astra_product_plan`，`gpt-6-astra` / high，只读。
- 工程/安全：`/root/p5_astra_engineering_plan`，`gpt-6-astra` / high，只读。

两者先独立检查合同、P1–P4 代码/计划、store/work/channel/runtime/backup 和本机 Frappe Webhook，再交换关于定时语义、预算、真实事件、恢复与 P4 顺序限制的实质分歧。

### 2.2 主控裁决

1. 定时规则只支持“每天 `HH:mm`，`Asia/Shanghai`”。不实现一次性、固定间隔、cron、其他时区或 DST 解释器。定时发生身份为 `ruleId + 上海当地日期`，同日修改/恢复/重启不会再自动执行。
   timer 醒来后重读墙钟和规则；在计划时刻后 60 秒内可受理为正常调度延迟，超过 60 秒则记 `skipped: missed-window`。进程停机、睡眠或时钟前跳跨过窗口均不补跑，直接计算下一个未来日期。
2. 每条规则的自动执行预算是**累计 1–10 次**，默认 10；成功原子预约新工作即消耗，失败/停止/中断不返还，重投/重叠跳过/纯通知重试不消耗。不增加每日重置任务或跨日竞态；界面明确“累计最多 N 次”。
3. 单次自动工作 120 秒硬截止，全局自动并发上限 2；不根据价格做伪精确预算。
4. 同规则上一工作活动时，新发生记为 `skipped: overlap`；容量满时记 `skipped: capacity`。不排队、不合并、不延后暗中执行。
5. 漏定时默认不补跑；恢复后只计算下一个未来时刻。成员可显式“现在核对一次”，它读当前事实、消耗一次预算，不冒充历史快照。
6. 暂停规则阻止未实际派发的模型/工具步骤和待发自动通知，不伪称撤回已发请求。停止本次工作、暂停未来规则和取消待发通知是三个独立动作。
7. P4 计划 §10 原“不提前进入 P5 实施”顺序限制已由 `user-message:2026-09-20-approve-p5-docker-bridge-callback` 明确取代：P4 企业微信/真实手机/最终验收保持 deferred且 P4 仍不 PASS，但可先实施 P5 独立路径。该决定不改写 P4 完成条件。

双 Astra 对业务场景、真实事件、单 store、无队列、发送复权、恢复和 UI 层级已收敛。产品 planner 最终主张每日重置 1–10 次，工程 planner 最终主张累计 1–10 次，两者不构成预算共识。主控依合同的“有界自动任务”和 Ponytail 最小实现选择累计预算：它提供整个授权周期的硬上限，不引入每日重置与跨日竞态。规划收敛结论为 `CONSENSUS_WITH_RESERVATIONS`；当时的顺序保留项已由上述用户决定闭合。

### 2.3 独立过度设计审查与有界消融

独立 reviewer：`/root/p4_overdesign_review`，只读，未参与 P5 双 Astra 规划、主控写作或正确性 phase review。首轮找到 rule 的 capability/泛化 input/usedRuns/nextDueAt 和 occurrence 的 owner/snapshot/execution/五态及 work 反向引用等重复权威。修订后最终结论 **PASS / Lean already. Ship.**

有界消融保留规则与 occurrence 两组合同必需事实，但把 capability/model/已用次数/下次时间/work 反向来源改为从现有 Skill/employee/occurrence/trigger 和单向 `occurrence.workId` 派生；occurrence 仅保留触发事实与 `workId` 或 `skipped|blocked + reason`，删除第二运行状态机。保留 `maxRuns`、120 秒、并发 2、60 秒到时窗口、event active-window、OS `flock`、恢复、MP4/report/Lark，因为删除任一项都会损害有界运行、去重、撤权、单 owner、数据完整或用户明确的验收材料要求。

## 3. 真实 GearJob 事件与 T0 停止门

事件源选用本机完整 GearJob/Frappe 测试实例的标准 `Webhook`，监听团队自建 `external-test / synthetic` Work Order 的 `on_update`。不修改 GearJob/Frappe 产品源码。

Webhook 仅携带固定来源、event kind、DocType、`name`、`modified`。使用 `X-Frappe-Webhook-Signature = base64(HMAC-SHA256(rawBody))`；必须对真实原始字节验签，不得 parse 后重序列化再验签。发生身份为 `ruleId + sourceId + eventKind + doctype + recordId + sourceRevision`，不含当前规则 revision，避免旧事件在编辑后重新执行。

规则每次首次启用、恢复或修改触发/对象时，服务端设置新的 `eventAcceptAfter`。Frappe `modified` 按已验证的源站点时区和精度转为唯一 instant；只接受 `modified >= eventAcceptAfter` 的新发生。暂停期间产生但恢复后才延迟到达的事件记为 `skipped: before-active-window`，不派发；时区、精度、时钟偏差或解析无法证明时 fail closed 为 `blocked: source-time-unverifiable`。不用接收时间冒充来源发生时间。

T0 必须证明：

1. 实际站点/容器/代码版本和可配置的标准 Webhook；
2. 普通 Frappe 文档保存提交后才入站，回滚事务不触发工作；
3. 真实 raw bytes、签名、`name + modified + event`和源日志与 occurrence 对应，并证明源站点时区、`modified` 精度及与 Geneway 时钟偏差可用于 active-window 判定；
4. 响应丢失/5xx 导致的源重投只命中同一 occurrence；同身份不同 payload digest 拒绝；
5. 连续合法修改产生不同稳定 `modified`；
6. GearJob 容器到 Geneway 窄接收入口的真实网络路径，不把两个 `localhost` 当成同一网络空间。

若需新增主机监听、反向代理、容器网络或防火墙变更，先停在对应授权门。after-commit、签名、稳定 revision 或网络任一失败，暂停事件分支并返回双 Astra，不以脚本直接 POST 代替真实事件。

### 3.1 T0 实测结论与事件分支阻塞

候选 `6cd2934` 的窄入口探针已通过独立正确性和 Ponytail 复核。2026-09-20 的真实受控运行使用标准 Frappe `Webhook`、真实 `long` worker 和 Docker bridge `172.20.0.5 → 172.20.0.1:39471`，取得以下条件性结论：

- 三次提交产生三个唯一且按微秒递增的 `modified`；首次在 occurrence `fsync` 后返回 503，Frappe 重投命中同一 occurrence；事务 rollback 后约 4 秒无新事件，随后提交再产生新 occurrence。
- Frappe `Webhook Request Log` 去敏汇总为四次请求：两次 accepted、一次 replayed、一次 retry；default 队列四个历史 job 逐 ID 前后不变，测试前为空的 `long` 队列最终为空。
- 探针、worker、Webhook、synthetic Work Order、Request Log、RQ 测试 job、secret 和容器临时文件均已清理；正式证据保存在 workflow artifact，不进入 Git。
- 源站 `modified` 为 6 位小数。Frappe 系统时区为 `Asia/Chongqing`，当前与宿主 `+08:00` 一致；实现必须按已验证源时区解析，不能因产品定时采用 `Asia/Shanghai` 就改写来源时区。

该运行仅在临时 console/worker 进程内恢复当前 redis-py `Pipeline.execute_command` 的原始分支语义后成立。当前 GearJob `read_only_cache.py` 先在 `redis.Redis` 保存同名属性，再用继承敏感的 `hasattr(Pipeline, ...)` 判断，导致 Pipeline 自身原方法未被保存；未修补环境会在入队或 RQ 清理时失败。现有授权明确不允许修改 GearJob/Frappe 产品源码，因此：

- T0 接口、HMAC、稳定 revision、bridge 和受控 Frappe 语义结论可供 T1/T2/定时分支使用；
- 无临时修补的真实事件能力为 `CANNOT_VERIFY`，事件 listener/adapter 不进入产品 runtime，事件 API/UI 不得创建或启用规则；
- 临时修补不得写入 Geneway runtime、启动脚本或默认验收路径；不得以轮询、直接 POST、同步 `frappe.in_test` 或新队列绕过；
- 外部有权维护者修复 GearJob 后，必须用正常新进程重跑 after-commit、rollback、HMAC、503 重投、RQ 正常清理、source clock 和零残留，独立通过后才解除事件分支阻塞。

### 3.2 实施前只读拓扑证据

2026-09-20 对当前测试环境只读核查：

- 实际站点是 `dev.localhost`，容器 `deploy-frappe-1` 在 `deploy_default` bridge 上的 IP 为 `172.20.0.5/16`，宿主 bridge gateway 为 `172.20.0.1`；容器与宿主 loopback 不是同一网络空间。
- 容器当前只运行 `bench serve --port 8100`；`bench doctor` 回读 `Workers online: 0`，`default` 队列已有 4 个历史 job。Frappe Webhook 是 after-commit 后 `frappe.enqueue`，因此不得在验收中用 `frappe.in_test` 同步例外或只启 Web 进程冒充真实 worker 消费。
- 经 `bench --site dev.localhost console` 只读查询，当前 `Webhook` 记录为空数组 `[]`；没有可直接复用的已有 Work Order 回调，T0 必须为团队 synthetic 工单新建明确专用配置。
- 容器无 `host.docker.internal`/`extra_hosts`，宿主 `172.20.0.1` 也没有已证明的 P5 回调 listener。宿主已发布的 GearJob 端口是宿主进入 GearJob，不是 GearJob 回调 Geneway 的路径。

因此 T0 不能直接启动 default worker：先审计/隔离现有积压，为 P5 Webhook 选专用测试队列并只启消费该队列的 worker。回调优先建立一个只绑 `172.20.0.1:<明确端口>`、只接受固定 P5 路径/方法、限定 GearJob 来源并强制 raw-body HMAC 的窄 listener；主认证 Web 继续 loopback。这一 bridge 监听是实施前需用户明确允许的本地网络边界，不由“测试环境”自动推导。

### 3.3 2026-09-21 正常 GearJob runtime 复验结论

用户批准 GearJob 最小修改后，GearJob 侧仅修正 `read_only_cache.py` 对 `redis.client.Pipeline` 原方法保存的继承判断，提交 `9ea23fc0`，未重构队列或 Frappe 行为。随后在无临时 patch 的全新进程中重跑 P5-T0：

- 证据根：`/home/gewu/.codex/workflow/artifacts/20260919-006-geneway-dsh-greenfield/p5-t0-live/gw-p5-t0-fixed-20260921-121346`。
- `RUNTIME_COMPATIBILITY_PATCH=false`，真实 Work Order `WO-26-00103`、真实 Frappe Webhook、真实 `long` worker、Docker bridge `172.20.0.5 -> 172.20.0.1:39471`。
- 首次持久化事件返回 503 后，同一身份重投命中 replay；3 个唯一 occurrence、4 次请求、3 次 accepted、1 次 replay；rollback 恢复后零事件；default 队列精确 job ID 不变，`long` 队列最终为空。
- source `modified` 六位小数严格递增；worker、receiver、listener、secret、Webhook、Work Order、Request Log 均已清理。

独立 verifier 结论为 `P5_T0_live_event_source_gate: PASS`、`T7b_external_event_source_prerequisite: PASS`。这解除“外部 GearJob runtime 无法验证”的阻塞；但 P5-T3b/T7b 仍必须在 Geneway 产品事件路径中实现并跑完整业务旅程后，才可宣称事件分支或 P5 总体验收通过。

## 4. v7 唯一事实模型

P5 将 state v6 升为 v7，只增加：

- `automationRules[]`：`id`、`ownerMemberId`、revision、`draft|active|paused|revoked`、`employeeId`、`skillId`、`connectionId`、精确 `workOrderId`、封闭 trigger、可选本人私聊目标、`maxRuns`、effectiveFrom/eventAcceptAfter 和必要时间戳。capability 从当前 Skill 解析，模型从 employee 解析，不在 rule 复制；已用次数从具有 workId 的 occurrence 计算，下次时间从唯一每日 trigger/effectiveFrom/已发生日期计算，均不持久第二份权威。
- `automationOccurrences[]`：稳定 occurrenceKey、ruleId/ruleRevision、定时日期或事件 source/revision/digest/时间，以及二选一的原子受理结果：`workId`，或终态 `skipped|blocked + reason`；至多保存一个单向 `deliveryId`。owner、输入、execution 和运行状态分别从保留的 rule tombstone、work 和 delivery 读取，不复制。

occurrence 是唯一的触发→work 单向关联；work 不反向保存 occurrenceId。原子更新前没有 occurrence 事实，更新成功后 occurrence 已有 workId；不建 `reserved/accepted/interrupted` 发生状态机。工作/执行状态、业务结果和通知状态继续从现有 work/execution/result/delivery 派生。

v7 backup/restore 明确保留 v4/v5/v6/v7 读入；恢复时仅 `active→paused`，`draft`/`paused` 保持原状态，`revoked` tombstone 必须仍为 `revoked` 且不可恢复；事件入口和外发禁用、`sending→unknown`，不补跑/不补发。回退到旧代码时只在独立数据根恢复实施前 v6 备份，不删除 v7 集合降版。

## 5. 职责、运行 owner 与可靠性

- `src/automation-service.mjs`：规则管理、时间计算、发生身份、重叠/容量/预算、work 原子关联、通知意图；同一文件内保留最小 timer owner，不拆调度平台。
- `plugins/gearjob-events.mjs`：仅在外部 runtime 修复且 T0 无临时修补复验通过后实施；对原始字节验签、封闭字段解析和窄 HTTP 回调，不运行模型。当前产品 runtime 不注册该入口。
- work service/runner/execution grant 继续拥有受理、模型、工具 I/O 和取消。
- channel service/Feishu runtime 继续拥有通知创建、当前授权、claim、平台 I/O 和结果。自动通知调用现有 `createDelivery`，不伪造入站渠道消息。

同一 data root 只能有一个触发 owner。优先用 `/usr/bin/flock` 覆盖产品服务整个生命周期，在 work/channel/触发恢复和连接前取锁。不新建租约、选主表或分布式锁。第二实例必须在任何外部副作用前明确失败。

发生受理、预算消耗和 occurrence→work 单向关联在同一 `store.update` 中完成。权限在规则保存/启用、发生受理、work 原子受理、每次原生 `agent/request`模型请求、真实工具 I/O、通知创建、发送和重试前均使用当前事实复核。工具返回后的后续模型请求也必须经该原生门；`requestTimeoutMs=120000` 不等于整次 120 秒硬截止。规则历史不是永久凭证。

## 6. 界面与可见语义

复用现有工作空间，在“工作”中增加“自动工作”分区，不增加底部导航项或运维控制台。界面包含列表、创建/修改和规则详情：

1. 先显示需本人处理的授权、来源、预算、中断或通知异常；正常等待/执行/完成留在常规动态。
2. 规则卡显示目标、触发、下次时间/事件等待、状态、累计已用/上限、最近结果和通知状态。
3. 当前创建时选本人获准员工、Skill、GearJob 连接和工单，只能选“每日上海时间”，设 1–10 次累计预算，通知只可选 Web 或本人已验证私聊。“GearJob 工单更新”显示“事件来源暂不可用”，不可创建或启用，服务端直接请求也拒绝。
4. 保存后先为草稿，用明确“启用规则”开始接受发生。
5. 详情区分“停止本次运行”“暂停未来触发”“取消待发通知”和“撤销规则”，并说明各自范围。
6. 发生历史分开计划时间/事件时间、接收时间、真实查询时间、work/result 和 delivery；高频跳过在 UI 聚合计数，底层去重事实保留。

事件来源恢复后仍需管理员完成无临时修补的 T0 复验，再开放创建；不会自动启用旧草稿、补跑故障期间事件或把受控 fixture 当成真实事件能力。

`failed` 通知允许明确重试，但不重跑工作；`unknown` 不盲重发；`blocked` 显示当前撤权原因。修正 P4 UI 中固定写死的“真实渠道尚未启用”，按 exact app runtime 和当前权限显示，不开发第二套通知页面。

## 7. 实施任务、依赖与唯一写入

| 任务 | 产物 | 依赖 / 通过条件 |
|---|---|---|
| P5-T0 触发探针 | `scripts/probe-p5-trigger.mjs`；真 Frappe Webhook 和定时 owner 边界 | 接口/拓扑条件性结论已取得；未修补事件 runtime 保持 `BLOCKED_EXTERNAL_RUNTIME` |
| P5-T1 v7 与时间纯策略 | store、`automation-service` 纯管理/发生部分、迁移测试 | 已确认的 T0 接口结论；唯一性、owner、revision、日期、预算、闭图；事件 schema 可校验但不可创建/启用 |
| P5-T2 原子 work 与权限 | work-service、execution-grant、runner 必要原生 guard | T1；occurrence 原子产生 workId，模型 `agent/request`/工具前撤权，整次 120s 与并发 2 |
| P5-T3a timer | automation runtime、每日 owner、关闭清理 | T1–T2；真实时钟、无产品队列、重叠/漏触发/关闭；首次真实读取前验证未修补环境的 GearJob REST |
| P5-T3b GearJob 入站 | `plugins/gearjob-events.mjs`、server 窄入口、事件启用 | 外部 GearJob 修复且 T0 无临时修补复验 PASS，再依赖 T1–T2；持久后 ACK、重投、关闭 |
| P5-T4 通知 | channel service 最小自动来源关联、既有飞书 send | 定时通知依赖 T2–T3a；事件通知另依赖解锁后的 T3b；本人私聊、幂等、发送前复权、unknown 不重发 |
| P5-T5 API/UI | server、`web/index.html` | A/C/D/E；创建/修改/启用/暂停/恢复/撤销/发生/停止/通知恢复 |
| P5-T6 恢复与回归 | state-transfer、`test:p5`、P1–P4 受影响回归 | v4–v7、restore paused、零补跑/外发、秘密零泄漏 |
| P5-T7 真实验收 | `accept:p5`、Design Review、MP4 + 去敏 report + Lark 回读 | T7a 定时主链和 T7b 无临时修补的真 GearJob 事件必须在同候选组合通过；真模型、真通知及独立复审不变 |

### 7.1 T7a 正式验收记录

T7a 每日定时主链已在候选 `9373dc88da42f76767e9c4ba9a68237f6f8d0225` 通过并交付材料：

- 报告：`artifacts/p5-acceptance/p5-9373dc8-final.report.json`，SHA-256 `414d0edc613fd3ebf3daaac0e960874dd4433db58d9b586b328158181076ed7d`。
- 视频：`artifacts/p5-acceptance/p5-9373dc8-final.mp4`，H.264，1440×900，146.72 秒，SHA-256 `eeaee5fb29bef363f481ab51dd1d14b12ad87aee77d8b30c9055a51ed7278290`。
- 封面：`artifacts/p5-acceptance/p5-9373dc8-final.png`，SHA-256 `a56f620063263957bfa102baa7b853e6c04c17f3335e1f04c21bad726575ee48`。
- 离线手册：`artifacts/p5-acceptance/p5-9373dc8-final.html`，SHA-256 `3f0687698b32ac5c5abf720d783a6041d74919447dfe0ba32c881e466ff63e7b`。
- 飞书材料用 Geneway 产品 app `cli_aaae8b6cbdb89cc0` 发往已验证 p2p chat，并批量回读 4 条均 `deleted=false`：说明 `om_x100b643fe43568acb3c498727351298`，视频 `om_x100b643fe5b1d0a4b1c638d86ab13dc`，report `om_x100b643fe51494a0b3190dda7ab8f8e`，手册 `om_x100b643fe2fe90acb2c7cbea798425a`。

该记录只证明 T7a 每日 timer 主链；`p5` 仍为 `conditional`，T7b 事件主链未跑完，不得宣布 P5 PASS。

每个任务仅一个 Team Sol 写入者；store、work-service、server、channel-service 不允许重叠写入。每个切片修复后回原独立 reviewer 复审。

## 8. 确定性验证与真实验收

`pnpm test:p5` 必须覆盖：

- 上海日界、同日修改/恢复、时钟前跳/回拨、漏触发不枚举积压；暂停期间事件延迟到达不派发，不可验证的源时间 fail closed；
- 发生原子产生 workId、同身份重投、同 ID 不同 digest 冲突、两源隔离，不存在无 work 的中间 occurrence 状态；
- 重叠、容量 2、预算最后名额竞争、受理后失败不返还；
- 保存/发生/work reservation/模型/工具/结果/通知/claim 边界的撤权；
- W1 停止不影响 W2，暂停规则不删历史，未来发生不执行，取消通知不重跑业务；
- 伪签名/错源/错对象/过大 body/恶意文本拒绝，真实源重投不增工作；
- 结果完成后 delivery 创建崩溃间隙，平台成功后 outcome 失败为 unknown；
- v4/v5/v6/v7 备份恢复、悬空引用拒绝、`active→paused`、已撤销规则仍 revoked 且不可恢复、历史保留、零自动重放；
- 第二实例取锁失败时零 timer/WS/work 副作、关闭后零残留 timer；
- 1440×900 和 390×844 的真正创建/修改/暂停/打开发生/停止本次，轮询不覆盖草稿，错误有相邻恢复动作。

真实 J8 必须在同一候选、成员和 synthetic 工单上运行：

1. Web 创建每日规则，设下一分钟，真实时钟到达后工具读 GearJob、结果持久、飞书返回真实 message ID；
2. Web 创建事件规则，团队经 Frappe 正常文档保存更新测试工单，after-commit Webhook 验签受理、重新读源、分析、通知；
3. 重投、暂停、修改、停止 W1/W2、通知 failed/unknown/blocked、重启漏触发和隔离恢复按本计划回读。

fake 时钟/SDK、受控 POST 和受控模型只补故障路径，不代替真时钟、真 Frappe 事件、真模型和真飞书主链。用户只在候选冻结后做一次最终验收。

## 9. 实施准入与完成边界

2026-09-20 用户当前消息已同时批准 P5 C/D、允许 P4 仍非 PASS 时先实施 P5，并允许 T0 为 GearJob 容器建立只绑 Docker bridge `172.20.0.1` 的固定路径 HMAC 回调窄入口。这一授权不允许消费 default 队列历史 job、开放主 Web、修改 GearJob/Frappe 产品源码、生产写入、部署或发布。

当前依赖图为：T0 接口结论 → T1 → T2 → T3a 定时 → 对应 T4/T5/T6 → T7a；外部 GearJob 常态故障解除 → T0 无临时修补复验 → T3b 事件 → 对应 T4/T5/T6 → T7b。只有 T7a、T7b 和原有同候选组合门全部通过，才判断 P5 PASS。当前事件分支 blocked 不构成 T1/T2/定时的工程依赖，也不得降低最终完成条件。

P5 只有在真定时、真 GearJob 事件、真模型/工具、真通知、Web/移动操作、权限/预算/重投/恢复、P1–P4 回归、Design Review、独立正确性/复杂度复审和 MP4/report/Lark 回读均通过后才能 PASS。P5 技术完成不会关闭 P4 缺口。
