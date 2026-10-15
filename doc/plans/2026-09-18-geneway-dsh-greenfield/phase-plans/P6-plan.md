# P6 制造业务关联与有限真实写入详细计划

> **合同 v4.3 注记（2026-10-15）**：T3 已在 `e8522e3` 实施并有真实证据（`/home/gewu/.codex/workflow/artifacts/20260919-006-geneway-dsh-greenfield/p6-t3-live-evidence.md`），状态应为 T3 PASS；按合同 v4.3 §9，P4 通过前暂停 T4–T6 新实施，升级导致的已提交代码修复归入 P4-U0。恢复时须在派发前复核中补充 Agent 停用与成员开放范围检查；当前批准绑定 `owner.sessionVersion` 依赖“开放范围变更即递增登录会话版本”，该检查是 P4 取消此递增的前置条件。

> **合同 v4.4 注记（2026-10-15）**：业务系统由 GearJob 改为 Kivo TPM。GearJob Work Order + Hive 的来源选择、生产跟进 Comment 写动作及相关证据转为历史，与来源无关的已实施部分（如 T1）由重规划逐项判断保留并回归；恢复 P6 前以 Kivo TPM 与 Kivo 设备监控原位重规划，写动作已由用户决定为经 MCP 写工具、以 Kivo 机器账号创建 synthetic 设备的维修单，Kivo 侧补按单号幂等（合同 §5.6）。

状态：**`T0 + PRODUCT DESIGN + T1 + T2 + T3 PASS / T4–T6 按合同 v4.3 暂停`**。P5 已在 `9808772` 技术 PASS，`P5 → P6` 顺序门已关闭。两名原 Team Astra planner 及 P5 后产品/工程复算均收敛为 GearJob Work Order + 隔离 Hive tenant integration API，以及仅限本地 synthetic Work Order 的纯文本、未发布、无 mention 生产跟进 Comment。现行 `user-message:geneway-goal-delegated-product-decisions` 已将中间产品决策委托给 Team planner 共识与正式 reviewer，用户仅做阶段最终验收；T0 已通过真实 Hive API、GearJob 映射、窄 Comment 合同、绕过防护、同键并发和回读证明，当前 A/C/D/E 已重算、由独立 Sol reviewer PASS 并绑定。T1 已完成 state v8、单一 file-store durable commit 和保守恢复；T2 已完成固定双来源 typed correlation、逐 GET 复权、mapping Session 失效和真实三 GET 回读。授权不延伸到非 synthetic/生产对象、真实客户数据外发、权限提升、部署或发布。

基线：Geneway `280ff5ca645437ceec64416bdebc43f6c09c1e7e`；GearJob `2e89415c2a189d3bd985d9022630cee1da84b6d2`；Hive `7dd2dfc9d381bbee8158fb5de0c06a4b7a6fc2e5`。用户已授权仅限 GearJob synthetic 对象的最小上游窄契约依赖修改；Hive 不改源码，Kivo 不使用。P6 Product Design 已通过并准入 Geneway 本地 synthetic 产品实现。本计划不授权非 synthetic/生产数据、权限提升、公网暴露、部署或发布。

## 1. 目标、关键旅程与完成边界

P6 交付 G8、J9、AC-19 和 AC-20：成员从现有工作详情核对一张明确工单及其明确关联设备的两类真实来源事实，得到具有来源、时间、新鲜度和未知项的结构化关联结果；随后查看一项精确上游业务动作的完整预览，在认证 Web 中批准或拒绝。批准后由确定性服务复核当前权限和前置条件，执行一次有稳定业务身份的真实写入，并从上游回读同一记录后才显示成功。

当前唯一方向为 **GearJob Work Order + 隔离 Hive `records:read` 设备遥测**，不引入 Kivo 第三来源。唯一写动作为向获准 synthetic GearJob Work Order 追加一条纯文本、未发布、无 mention 的生产跟进 Comment。T0 必须证明真实实例、唯一对象映射、时间语义、Comment 可见范围与已知 `_comments`/realtime 副作用、最小权限、幂等身份、绕过防护和唯一回读；不满足时保持阻塞，不自动换成 ToDo、报警确认或其他“容易调用”的接口。

P6 不实现：模型自动批准、定时/事件自动写入、通用 Workflow/DSL、审批中心、动作队列、事件总线、分布式事务、任意第三方写适配、生产数量/状态/库存/财务变更、设备控制、批量跨工单写入或自动删除上游记录补偿。

阶段完成需要同一候选完成：两类真实来源、可靠映射与时间语义、结构化关联、认证 Web 预览和批准、真实上游唯一记录、回读、拒绝零副作用、撤权/重复/unknown/恢复、桌面和 390px 操作、受影响 P1–P5 回归、独立正确性/过度设计/Design Review、MP4/report/Lark 回读。只做预览、本地记录或 HTTP 200 不算完成。

## 2. Team Astra 规划、分歧与唯一裁决

### 2.1 独立规划者

- 产品/业务：`/root/p6_astra_product_retry`，`gpt-6-astra/high`，只读。
- 工程/安全：`/root/p6_astra_engineering_retry`，`gpt-6-astra/high`，只读。

两者先独立检查合同、P1–P5 计划、checkpoint、当前代码和候选上游源码，再只交换实质分歧。

### 2.2 收敛结论

1. 首轮的 Comment “推荐核验候选”状态已由 §6.1 实况 T0 和有效中间决策委托取代；当前固定为 synthetic Work Order 的窄 Comment 合同，HMAC、guard、幂等、冲突、回读和真实并发均已通过，GearJob `2e89415c` 是当前 P6 产品依赖基线。
2. 首条旅程使用一个固定双来源原生工具。它在一次 DSH 工具调用内部执行两个真实来源的三个固定白名单 GET（GearJob mapping、Hive devices list、Hive latest）和确定性映射/新鲜度计算，并在每个 GET 紧邻发出前重新核对同一当前授权；不放宽普通 runner 的恰好一次工具约束，也不为本场景强制创建两个 P3 协作子工作。若实际权限证明没有一名员工可合法同时读取两源，再重规划为协作方案。
3. 两条连接、映射 revision 和对象范围必须进入执行授权、每次真实读取前复权及 Session 上下文失效判断；不能把第二连接藏入可变全局配置。
4. 模型只解释结构化关联结果并提出建议。预览、批准、claim、上游写入和回读由确定性 action service 所有；渠道或自动规则只能产生待批准提案并引导到 Web。
5. 三项时间约束独立冻结：Hive sample freshness 为 120 秒并允许最多 5 秒未来偏差；preview TTL 为 10 分钟；批准可靠保存后 15 秒内必须开始首次 GearJob 写请求。任何一项都不能替代派发前复权和必要前置校验。
6. 真实写 I/O 前必须可靠持久化动作身份、批准绑定和 attempt。当前 `writeFile → rename` 不足以证明掉电后不会遗失防重事实；最小方向是在唯一 file-store 内完成临时文件 sync、rename 和父目录 sync，并用故障注入证明失败时写 I/O 为 0。不增加第二日志或数据库。
7. 必要的 compare-and-write 只保护该动作真正依赖的业务前置条件，不机械绑定整个工单 `modified`。若上游无原子前置校验，Geneway 的先读后写不能冒充原子保护。
8. P5 已 PASS，`P5 → P6` 顺序前置已关闭。P4 企业微信/真人验收 deferred 不阻塞 P6 独立 Web 技术路径，但 P6 不得据此宣称 P4 或完整合同 PASS。

首轮收敛状态为 `CONSENSUS_WITH_LIMITED_RESERVATION`；其中第二源、动作类型、synthetic 对象和中间授权现已由 §6.1 取代。GearJob 窄合同运行证据、A/C/D/E 新身份绑定和正式 reviewer 已全部 PASS。

### 2.3 独立 Astra 过度设计审查与有界消融

独立 reviewer `/root/p6_astra_overdesign_review` 使用 `gpt-6-astra`，未参与双 planner 或主控写作。审查结论 **PASS**，选择的最简完整变体为：一个具体双来源原生工具 + 现有 `work/results` + 内嵌 `work.actions` + 同进程窄 action service + 一个获准上游 adapter + 原 file-store 的可靠提交与恢复扩展。

有界消融结果：优先复用上游可靠映射，只在上游无可核验关系且业务确需时创建最小 `sourceMappings`；该通用分支已由 §6.1 真实映射证据关闭，当前候选不创建 `sourceMappings`。不建独立动作表、数据库、审批中心、队列、P3 子工作或后台 TTL 调度；预览到期只在预览/批准/派发时按事实判断；T0–T6 是依赖检查点，不生成七套材料链，测试随实现落地并复用一个最终验收包。保留三类不同防重身份、批准绑定、派发前复权、reliable attempt、unknown、上游回读和恢复零自动写入，因为删除任一项都会破坏 AC-19/20、安全或数据完整性。

## 3. 产品旅程与界面语义

主用户是负责测试工单跟进、并对该对象具有明确批准权限的普通成员。自然入口复用“全部工作 → 工作详情”，不新增审批中心或底部导航。

1. 成员创建“核对工单及关联设备”的工作，选择本人获准的关联分析 Skill、GearJob 连接和第二来源连接。
2. 页面显示两源事实、对象映射依据、源时间、查询时间、覆盖/新鲜度及未知项；没有映射、多映射、过期或部分失败时不猜设备、不制造联合结论。
3. 模型解释同一结构化结果。页面将“分析工作完成”与“业务动作待批准”分开。
4. 服务器根据当前结果生成不可变动作预览。成员可编辑正文；任何影响目标、内容或前置条件的修改都会产生新 preview digest，旧批准失效。
5. 预览一次显示目标实例/工单、完整内容、引用事实与时间、上游可见性和已核验副作用。动作未通过 T0 时只显示“真实写入尚未配置”，不显示可用批准按钮。
6. 成员选择“批准并写入”或“拒绝”。批准仅绑定当前目标、内容、前置条件、digest、批准人和有效期；管理员配置权不自动等于私有工作的业务批准权。
7. 派发前再次核对成员、员工、Skill、两连接、对象、映射、批准和源前提。真实写入后只以唯一上游回读匹配批准内容为成功。
8. 结果未知显示“上游结果待核对”，唯一默认动作是只读核对，绝不显示“再写一次”。停止工作、撤销写许可、暂停未来规则和取消通知仍是不同操作。

390×844 必须能实际查看来源和完整预览、批准或拒绝、处理版本冲突/unknown 并查看回读结果；关键按钮不得被固定导航或软键盘遮挡。真实手机 HTTPS 仍是独立验收边界，移动视口不替代它。

## 4. 两类来源、映射与新鲜度

### 4.1 当前固定来源：GearJob + Hive

已验证映射链：GearJob instance → `WO-26-00096` → `GW-P6-OP-01` / `GW-P6-WS-01` → enabled `MES Unit GW-P6-CNC-01` → `hive_unit_id/device_code GW-P6-CNC-01` → Hive tenant `0561b9fa-...` / device UUID `bc392c8f-...`。运行时必须逐跳重新读取并要求唯一，不得用同名、最近记录、IP 或模型推断补齐。

完整对象身份包含 source system、instance/environment/tenant、object type 和 object ID。不同实例同名工单、同名设备或同 IP 均不是同一对象。当前候选只接受上述唯一工序/设备；若真实证据使该映射失效，重新规划与复审，不在本计划中自动切换 Kivo 或增加映射权威。

### 4.2 时间与未知语义

- 分开保存业务记录修改时间、设备采样时间、平台接收时间和查询时间。Hive 当前公开 API 不提供平台接收时间时保存 `platformReceivedAt: null` 并记录 unknown，不得用查询时间冒充。
- Work Order `modified` 不是设备采集时间；新查询时间不证明旧采样新鲜。
- Hive sample 以 Geneway 服务端 UTC 判断 120 秒 freshness，并允许最多 5 秒未来偏差；缺时间、latest 为空、超时或未来异常均阻止生成/批准动作。
- 缺采样时间、未来时间、分页不完整、零映射、多映射或来源明确返回坏质量时 fail closed。Hive 当前公开 API 不提供独立质量字段时保存 `quality: null` 并记录 unknown，不得用 `status` 冒充；字段不可得本身不阻断只读关联或人工动作资格。
- “离线”不等于“停机”，“没有返回报警”不等于“没有报警”。没有计划基线和覆盖一致的时间证据，不声称设备导致进度落后。

## 5. 最小事实模型与可靠写入

P6 拟将 state v7 升为 v8，仍使用唯一 `state.json`：

- 不增加 `sourceMappings[]`。每个历史联合结果只保存解释当次关联所需的两连接、精确对象、operation/workstation/MES Unit/hive unit/device UUID 和各源 revision/time 最小快照。
- 联合观察继续存入现有 `work.results[]`：两源身份/revision/time/query/coverage、mapping identity、确定性结论与未知项，以及模型 explanation。
- 每个 work 可有最小 `actions[]`：intent、不可变 preview、批准/拒绝/撤销/过期决定、attempt 和 receipt。owner 从 work 继承，不复制第二份 owner/work 状态。

UI 状态由上述事实派生为待批准、已拒绝、已撤销、已过期、提交中、效果待核对、已写入；不持久第二套运行状态机。内容或目标变化建立新 preview，旧许可显式关闭。恢复时旧批准全部失去执行效力，in-flight attempt 转 unknown；恢复绝不自动写入。

业务动作边界：

1. `proposalKey` 防同一依据重复提案，HTTP `clientRequestId` 防请求重投，`actionId`/upstream key 防真实业务重复；三者不能互相替代。
   一旦建立 attempt，其目标、payload 与上游动作身份不可变。同一 work、业务目标和作用对象下仍有 in-flight/unknown 意图时，编辑、重新提案、更换 `proposalKey` 或新建 `actionId` 都不得形成替代写入。只有按原动作身份可靠回读出明确结果，或经过有证据的人工处置证明可解除后，才允许新的相关意图；“暂未查询到”不足以解除。该限制只约束相关未决意图，不阻塞其他对象和工作。
2. 批准 API 只接受 action ID、expected revision、preview digest 与请求身份；目标、payload、批准人来自服务端事实和认证会话。
3. 真实 I/O 前可靠提交 attempt；持久化任一步失败则外部写请求为 0。
4. adapter 固定方法/路径/字段/对象 allowlist，使用单独获准写凭据并关闭隐式重试。
5. 超时、断连、可能已提交的 5xx、成功响应后 receipt 落盘失败均进入 unknown；默认仅按同一 action key 查询。
6. HTTP 200 或 record ID 不等于成功。必须 GET 同一目标并核对已批准字段；只有上游明确证明提交前拒绝或未创建，才可记为确定无效果失败。
7. 通知失败只重试 delivery，不重新写业务动作。

## 6. T0 只读发现与真实授权门

T0 在任何 Geneway P6 产品实现前核验。GearJob 最小窄契约的实现与 synthetic runtime probe 属于已单独授权的 T0 依赖工作，不代表 C/D/E、T1–T6 或 Geneway 产品代码获准。T0 要求：

1. 第二来源精确实例、tenant/org、只读身份、对象集合、API 版本、稳定 ID、时间、质量码、分页/覆盖和模型外发范围。
2. 工单到设备的真实映射依据及一对多语义；两个 API 是否确为独立事实。
3. 已选 Comment 的业务用途、DocType/字段、纯文本边界、权限、realtime/mention/follow/通知/钩子副作用。
4. 上游唯一动作身份、相同 key 不同 payload 行为、保留期、按 key 唯一查询、读取一致性和 unknown 判定。
5. 动作真正依赖的业务前置条件能否由上游原子校验。

当前授权覆盖获准源码/环境核验、隔离本地 Hive synthetic tenant/device/telemetry/`records:read` 凭据、GearJob synthetic 对象和经多 agent 共识绑定的窄 Comment 验收写入。真实客户/生产 Hive/Kivo/GearJob 数据、非 synthetic 对象、真实制造数据外发、权限提升、公网暴露、部署和发布仍需要各自现行授权。若已有 API 不满足身份、对象限制、幂等和回读，只实现一个具体动作的上游窄 API；不得直写数据库、注入运行时补丁或开放通用写入。

### 6.1 P5 后 T0 实况与冻结方向

2026-09-21 以独立 Compose project `geneway-p6-hive` 启动本机 Hive backend/PostgreSQL/TDengine/Redis/NATS/EMQX，所有业务数据使用新 volume 和专用 `geneway-p6` tenant；backend 仅绑 `127.0.0.1:18000`，未复用现场 tenant、旧凭据或客户数据。Hive 代码未修改；已有未跟踪工作保留。

- Hive 真实 API：专用 tenant `0561b9fa-2b58-4831-a09f-45c1d1b1e082`，device code `GW-P6-CNC-01`，device UUID `bc392c8f-9214-4416-b7c0-5cef15cd8aee`。`records:read` API credential 只存于仓库外 `0600` 文件。`GET /tenant-integrations/devices` 精确回读 code/UUID，`GET /devices/{uuid}/latest` 回读 `ts/status/data/record_id/event_id`；source environment 为 `external-test`，data mode 为 `synthetic`。
- GearJob 真实映射：现有 synthetic `WO-26-00096` 经正常 Frappe 文档保存新增唯一 operation `GW-P6-OP-01` / workstation `GW-P6-WS-01`；唯一 enabled `MES Unit` 为 `GW-P6-CNC-01`，`hive_unit_id=GW-P6-CNC-01`。Work Order REST 回读唯一 operation/workstation；现有服务身份对通用 MES Unit REST 为 403，不得通过扩大通用权限解决。
- GearJob `2e89415c` 的窄 mapping facade 分别返回 MES Unit 稳定文档身份 `mesUnitId` 与外部 Hive 身份 `hiveUnitId`。运行中 HMAC HTTP GET 回读 200/unique；当前 synthetic fixture 两值恰好同为 `GW-P6-CNC-01`，但实现从独立字段读取且测试使用不同值证明不做推断。
- 第二来源因此冻结为 Hive tenant integration customer pull API，映射为 `Work Order operation row → workstation → exact enabled MES Unit → hive_unit_id/device_code → tenant-scoped Hive device UUID`。零/多 operation、零/多 enabled MES Unit、零/多 Hive device、latest 缺失/未来/过期均 fail closed；不新建 `sourceMappings[]`。
- 写动作冻结为向该 synthetic Work Order 写入一条纯文本、未发布、无 mention/附件/外链的生产跟进 Comment。已知业务后果仅为 Work Order 时间线/`_comments` 更新与正常 `docinfo_update` realtime；不改数量、状态、库存、计划或设备。
- 通用 Frappe `add_comment` 对拥有对象只读权的用户可直接 `ignore_permissions` 插入，是 P6 批准绕过。最小 GearJob 契约必须同时包含：复用现有 0600 secret/HMAC 的 P6 专用 audience/step；精确 Work Order 映射 GET；稳定 action key 的幂等 Comment POST 与 GET 回读；同 key/异 payload 409；以及精确服务用户的 Comment doc-event guard。不授予通用 Comment/MES Unit 权限，不加 DocType、迁移、UI、队列或通用写适配器。
- 中间产品决策授权复议结论为 `APPROVAL_DELEGATION_VALID`：当上述 GearJob 契约经两名独立 planner 收敛、实況 T0 验证和未参与实现的正式 reviewer PASS 后，可绑定当前 C/D 与 synthetic Comment 动作；用户仅做阶段最终验收。

## 7. 实施任务、依赖与唯一写入

| 任务 | 产物 | 依赖 / 通过条件 |
|---|---|---|
| P6-T0 决策与接口核验 | Hive synthetic 真实 API/映射证据 + GearJob 窄 Comment 合同及运行探针 | **PASS**：GearJob `2e89415c`；67 项 focused tests、真实 HMAC mapping 含独立 `mesUnitId`/`hiveUnitId`、guard/幂等/回读、同键并发 `201+200` 且数据库一条、两名独立 reviewer PASS |
| P6-T1 v8 与可靠提交 | store、state-transfer、迁移/故障测试 | **PASS**：`0997846`；v8 work.actions、temp file sync→rename→parent-dir sync、5 类故障、restart/restore unknown、完整 P1–P5 受影响回归、Sol correctness 与 Astra/Ponytail 双审 PASS |
| P6-T2 双来源关联 | 一个具体第二来源插件、固定关联工具、capability/binding/grant 窄扩展 | **PASS**：`e028d79` + `280ff5c`；固定 `connectionIds{gearJob,hive}`、三个 GET 逐次复权、mapping revision/identity Session 失效、strict UTC/120s/5s、六字段 machineFacts/raw 泄露 0；真实 API authorize=3、唯一 mapping/device、fresh age `0.304s`；Sol correctness 与 Astra/Ponytail 双审 PASS |
| P6-T3 动作服务 | 最小 action service + 已选上游窄 adapter | **PASS**：`e8522e3`；仅 `work.actions[]` + 具体 GearJob Comment adapter，三类防重身份、可靠 attempt、最多一次 POST、三个来源 GET 与 Comment GET 紧前复权、201/200 后 exact readback、noEffect/unknown/reconcile/recovery 零自动写；受控矩阵与完整 `pnpm test:p5` PASS，Sol correctness 与 Astra/Ponytail 终审 PASS；同候选真实 action service 对 synthetic `WO-26-00096` 写入并回读唯一 private Comment，重复批准数据库仍一条，证据 `p6-t3-live-evidence.md` |
| P6-T4 API/UI | server、现有工作详情、手机批准/恢复 | 正式 A/C/D/E、T2/T3 稳定；无第二导航/审批平台 |
| P6-T5 恢复与组合回归 | `test:p6`、v4–v8 transfer、P1–P5 affected regression | T1–T4；旧批准失效、in-flight unknown、零自动写入 |
| P6-T6 真实验收 | `accept:p6`、Design Review、MP4/report/Lark | 两真实来源与明确写授权；普通 UI、上游唯一记录/回读、拒绝/重复/unknown |

共享 `store/work-service/server/grant/runner` 同一时段只有一个 writer。第二来源插件内部与已冻结接口后的 UI可并行；任何 takeover 前证明旧 writer 停止。每个切片完成后返回原独立 reviewer。

## 8. 确定性验证与真实验收

`pnpm test:p6` 最少覆盖：

- 不同实例同名 ID、零/多映射、revision 变化、缺失/未来/过期时间、质量未知如实保留、显式坏质量阻断、分页不完整；
- 双连接在受理、模型请求、每次源 I/O 前当前授权；撤权/换目标时零受影响 I/O；
- preview digest、有效期、编辑失效、cross-member/admin越权、CSRF/Origin/字段白名单；
- 双击批准、并发标签页、HTTP 重投、同 key 不同 payload；
- 上游已提交但响应丢失后，编辑或重新提案并再次批准仍只有一次外部写入；相关 unknown 不能换 `actionId` 绕过，无关工作仍可继续；
- file write/sync/rename/dir sync 故障；attempt 已提交后崩溃；响应丢失、可能已提交5xx、receipt失败和重启核对；
- 拒绝零写、撤权零写、unknown 无 resend、W1停止不伤 W2；
- v4–v8 backup/restore，旧批准失效、in-flight unknown、零写重放、秘密 canary；
- 1440×900 与390×844真实预览、批准/拒绝、版本冲突、unknown核对，轮询不覆盖草稿。

真实 J9 使用同一候选、成员、测试工单和关联设备：普通 Web 发起工作；两个真实 API 分别回读；结构化结果和 UI 一致；成员批准一个明确获准动作；上游只产生一条记录并按 action identity 回读；拒绝为零写；重复提交仍只有一条记录。故障竞态可用受控 adapter 补充，不能替代真实主链。

## 9. Product Design 与实施准入

P6 Product Design 位于 workflow artifact `product-design-p6/`。P5 顺序、Hive synthetic 第二来源、精确映射、窄 Comment 业务方向及 GearJob HMAC/幂等/回读/guard 真实运行证据均已闭合。当前 A/C/D identities 为 `12e7ed13...` / `9c9904ce...` / `bad70914...`；独立 Sol reviewer `p6-product-design-revision6-quality-semantics-review` 已 PASS，C/D 由现行 `user-message:geneway-goal-delegated-product-decisions` 授权绑定 workflow decision revision 6，正式 validator 返回 approved/executable product_increment handoff。

只有以下条件同时成立才进入 P6 代码实施：

1. P5 PASS（已满足：`9808772`）；
2. 第二来源、对象、数据外发和只读 API 已获准（已满足：隔离 Hive `geneway-p6` synthetic tenant + `records:read`）；
3. 具体业务写动作、对象范围、批准人、写身份和真实验收已获准：当前 work owner + `WO-26-00096` + P6 专用服务身份 + 窄 Comment；
4. T0 已证明幂等、查询、已知副作用和必要前置条件可满足；
5. 当前 A/C/D/E identities 和批准绑定有效；
6. 独立过度设计 reviewer 完成有界消融且无阻塞项。

P6 的规划、局部工程或真实验收均不关闭 P4 企业微信、真实手机/真人最终验收或其他全合同缺口，不授权部署、发布、生产写入或客户接受。P5 external-test/synthetic 技术 PASS 保持有效。
