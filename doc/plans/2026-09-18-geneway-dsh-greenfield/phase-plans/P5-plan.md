# P5 定时、事件与主动持续工作详细计划

状态：**Team Astra 规划已收敛；Product Design 待用户绑定；实施准入等待 P4 顺序限制的用户决定。P5 尚未实施。**

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
7. P4 计划 §10 的“不提前进入 P5 实施”是更具体的现行限制。用户的“企业微信验证先跳过”和“不参与中间测试”没有明确改变该顺序；因此本计划、Product Design 和只读发现可完成，T0 外部探针和 Team Sol 写入必须等用户单独确认。

双 Astra 对业务场景、真实事件、单 store、无队列、发送复权、恢复和 UI 层级已收敛。产品 planner 最终主张每日重置 1–10 次，工程 planner 最终主张累计 1–10 次，两者不构成预算共识。主控依合同的“有界自动任务”和 Ponytail 最小实现选择累计预算：它提供整个授权周期的硬上限，不引入每日重置与跨日竞态。收敛结论为 `CONSENSUS_WITH_RESERVATIONS`；唯一需用户决定的保留项是 P5 实施顺序。

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

## 4. v7 唯一事实模型

P5 将 state v6 升为 v7，只增加：

- `automationRules[]`：`id`、`ownerMemberId`、revision、`draft|active|paused|revoked`、`employeeId`、`skillId`、`connectionId`、精确 `workOrderId`、封闭 trigger、可选本人私聊目标、`maxRuns`、effectiveFrom/eventAcceptAfter 和必要时间戳。capability 从当前 Skill 解析，模型从 employee 解析，不在 rule 复制；已用次数从具有 workId 的 occurrence 计算，下次时间从唯一每日 trigger/effectiveFrom/已发生日期计算，均不持久第二份权威。
- `automationOccurrences[]`：稳定 occurrenceKey、ruleId/ruleRevision、定时日期或事件 source/revision/digest/时间，以及二选一的原子受理结果：`workId`，或终态 `skipped|blocked + reason`；至多保存一个单向 `deliveryId`。owner、输入、execution 和运行状态分别从保留的 rule tombstone、work 和 delivery 读取，不复制。

occurrence 是唯一的触发→work 单向关联；work 不反向保存 occurrenceId。原子更新前没有 occurrence 事实，更新成功后 occurrence 已有 workId；不建 `reserved/accepted/interrupted` 发生状态机。工作/执行状态、业务结果和通知状态继续从现有 work/execution/result/delivery 派生。

v7 backup/restore 明确保留 v4/v5/v6/v7 读入；恢复时仅 `active→paused`，`draft`/`paused` 保持原状态，`revoked` tombstone 必须仍为 `revoked` 且不可恢复；事件入口和外发禁用、`sending→unknown`，不补跑/不补发。回退到旧代码时只在独立数据根恢复实施前 v6 备份，不删除 v7 集合降版。

## 5. 职责、运行 owner 与可靠性

- `src/automation-service.mjs`：规则管理、时间计算、发生身份、重叠/容量/预算、work 原子关联、通知意图；同一文件内保留最小 timer owner，不拆调度平台。
- `plugins/gearjob-events.mjs`：对原始字节验签、封闭字段解析和窄 HTTP 回调；不运行模型。
- work service/runner/execution grant 继续拥有受理、模型、工具 I/O 和取消。
- channel service/Feishu runtime 继续拥有通知创建、当前授权、claim、平台 I/O 和结果。自动通知调用现有 `createDelivery`，不伪造入站渠道消息。

同一 data root 只能有一个触发 owner。优先用 `/usr/bin/flock` 覆盖产品服务整个生命周期，在 work/channel/触发恢复和连接前取锁。不新建租约、选主表或分布式锁。第二实例必须在任何外部副作用前明确失败。

发生受理、预算消耗和 occurrence→work 单向关联在同一 `store.update` 中完成。权限在规则保存/启用、发生受理、work 原子受理、每次原生 `agent/request`模型请求、真实工具 I/O、通知创建、发送和重试前均使用当前事实复核。工具返回后的后续模型请求也必须经该原生门；`requestTimeoutMs=120000` 不等于整次 120 秒硬截止。规则历史不是永久凭证。

## 6. 界面与可见语义

复用现有工作空间，在“工作”中增加“自动工作”分区，不增加底部导航项或运维控制台。界面包含列表、创建/修改和规则详情：

1. 先显示需本人处理的授权、来源、预算、中断或通知异常；正常等待/执行/完成留在常规动态。
2. 规则卡显示目标、触发、下次时间/事件等待、状态、累计已用/上限、最近结果和通知状态。
3. 创建时选本人当前获准员工、Skill、GearJob 连接和工单，选“每日上海时间”或“GearJob 工单更新”，设 1–10 次累计预算，通知只可选 Web 或本人已验证私聊。
4. 保存后先为草稿，用明确“启用规则”开始接受发生。
5. 详情区分“停止本次运行”“暂停未来触发”“取消待发通知”和“撤销规则”，并说明各自范围。
6. 发生历史分开计划时间/事件时间、接收时间、真实查询时间、work/result 和 delivery；高频跳过在 UI 聚合计数，底层去重事实保留。

`failed` 通知允许明确重试，但不重跑工作；`unknown` 不盲重发；`blocked` 显示当前撤权原因。修正 P4 UI 中固定写死的“真实渠道尚未启用”，按 exact app runtime 和当前权限显示，不开发第二套通知页面。

## 7. 实施任务、依赖与唯一写入

| 任务 | 产物 | 依赖 / 通过条件 |
|---|---|---|
| P5-T0 触发探针 | `scripts/probe-p5-trigger.mjs`；真 Frappe Webhook 和定时 owner 边界 | 用户解除顺序门；after-commit、raw HMAC、稳定 revision、重投、网络、锁先于副作用 |
| P5-T1 v7 与时间纯策略 | store、`automation-service` 纯管理/发生部分、迁移测试 | T0 接口结论；唯一性、owner、revision、日期、预算、闭图 |
| P5-T2 原子 work 与权限 | work-service、execution-grant、runner 必要原生 guard | T1；occurrence 原子产生 workId，模型 `agent/request`/工具前撤权，整次 120s 与并发 2 |
| P5-T3 timer + GearJob 入站 | automation runtime、`plugins/gearjob-events.mjs`、server 窄入口 | T0–T2；持久后 ACK、无队列、重投/重叠/漏触发/关闭 |
| P5-T4 通知 | channel service 最小自动来源关联、既有飞书 send | T2–T3；本人私聊、幂等、发送前复权、unknown 不重发 |
| P5-T5 API/UI | server、`web/index.html` | A/C/D/E；创建/修改/启用/暂停/恢复/撤销/发生/停止/通知恢复 |
| P5-T6 恢复与回归 | state-transfer、`test:p5`、P1–P4 受影响回归 | v4–v7、restore paused、零补跑/外发、秘密零泄漏 |
| P5-T7 真实验收 | `accept:p5`、Design Review、MP4 + 去敏 report + Lark 回读 | 同候选的真时钟、真 GearJob 事件、真模型、真通知；独立正确性/复杂度复审 |

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

P5 已完成独立过度设计审查；实施当前还需同一次用户回复闭合两个绑定：**批准当前 P5 C/D 产品设计，并允许在 P4 企业微信/真实手机/最终验收保持 deferred、P4 仍不 PASS 的前提下，先实施 P5 独立路径。**

获得该决定后，按 T0→T1→T2→T3→T4/T5→T6→T7 执行；未获得时，停在本计划、Product Design 和只读发现，不启动外部探针、不改代码。

P5 只有在真定时、真 GearJob 事件、真模型/工具、真通知、Web/移动操作、权限/预算/重投/恢复、P1–P4 回归、Design Review、独立正确性/复杂度复审和 MP4/report/Lark 回读均通过后才能 PASS。P5 技术完成不会关闭 P4 缺口。
