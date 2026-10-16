# P6 Kivo 关联分析与维修单创建详细计划

> 合同 v4.4 原位重规划，2026-10-16。本文替换旧 GearJob/Hive P6 方案；旧方案与运行证据保留在 Git 历史，不作为本阶段通过证据。当前合同、clarification-notes.md §10/11 及用户后续明确决定优先。

状态：**Team Astra 规划与独立计划审查先于实施完成；T0–T5 技术实施及同候选真实验收已通过，T6 视频、离线材料和飞书发送回读已完成。用户在收到完整材料后明确“开始p7”（2026-10-16 15:55 UTC），据此解除 P6→P7 阶段门，进入 P7 Team Astra 规划；不代表发布或现场验收。**

基线：Geneway `/home/gewu/.devspace/worktrees/geneway-f4222c66`，`rebuild/dsh-greenfield`，HEAD `6dd9db9abc216251c5869af7b16bf5e97c0ae405`（仅记录 P5 用户验收，产品源码同 `3794cbaca3181d9375eddc822dde179dd7772e15`）；Kivo 独立 clone `/home/gewu/.devspace/worktrees/kivo-geneway-mcp`，`codex/geneway-kivo-mcp`，HEAD `c429483ac0d423cc1092c1d9d6d517dc4c910e44`。P4 和 P5-K1 已由用户最终验收；2026-10-16 用户明确“P5 通过，开始 Team Astra 规划 P6”。

沿用 workflow `20260919-006-geneway-dsh-greenfield`。唯一阶段验证记录位于该 workflow 外 Git artifact 的 `p6-kivo-verification.md`，统一保存实际命令、退出码、失败、跳过、候选与运行证据；本文只记录权威方案和阶段状态，不创建平行方案或每任务一套认证包。

## 1. 目标、权限与完成边界

完成 G8、J9、AC-19、AC-20 和 AC-25 写工具部分：普通成员通过现有工作入口读取同一 Kivo 设备的 TPM 记录与设备监控，看到可核查的映射、来源时间、新鲜度和未知项；在工作详情核对维修单完整预览并批准或拒绝。确定性执行器经唯一 MCP 实现和既有维修 HTTP 入口，以机器账号创建 synthetic 设备维修单；持久记录、机器审计、创建事件和按完整单号回读闭合后才显示成功。

用户已决定创建维修单、机器账号、唯一 MCP、synthetic 范围、人工批准及阶段最终验收。原全量实施授权持续，计划独审通过后按就绪依赖实施，不重复询问这些决定。当前阶段只在上述两仓本地提交，不 push、PR、合入、部署或发布；不修改第三仓，不碰 `bd52/kivo`、共享仓库 refs 或用户原 `ui-sketches*`。只使用隔离本机 synthetic MES 数据库、Redis、端口与服务端秘密；不扫描/挪用旧秘密，不读取现场数据，不给真实成员发产品消息。阶段验收材料按已授权路径发到用户飞书并逐条回读。

两类来源固定为 Kivo TPM 与 Kivo 设备监控，Hive 仅作为 Kivo 监控的上游依赖，不成为 Geneway 第三来源或第三连接。唯一业务写入为维修单创建，不授派工、验收、报警处置、PLC/设备控制、批量写、自动批准或退出/删除权限。创建错误的业务记录由 Kivo 既有人类流程处理，不自动删除补偿。

完整完成条件是同一候选的真实 MCP/HTTP/数据库/producer/worker/Web 链、拒绝零写、撤权/幂等/unknown/恢复、桌面及 390px 操作、受影响回归、独立审查、实录视频和离线说明交付，再由用户最终验收。仅源码、fixture、HTTP 201 或预览不能关闭阶段。普通界面逻辑全面调整按用户决定后置，安全、权限、误操作和必需入口本期完成。

## 2. 规划过程与最小方案

两名 planner 使用 `atlas-sdd-planner`、`gpt-6-astra/high`、`fork_turns=none`，先收到相同目标、权威、边界和前序证据，独立读取合同全文、澄清 §10/11、P1–P6 及相关源码，首轮未互看意见：

- `/root/p6_kivo_product_planner`：产品旅程、批准、终态、范围和交付。
- `/root/p6_kivo_engineering_planner`：事务、协议、幂等、来源和验证。

两份首轮均已交付真实只读工具核查结果，随后就15秒窗口、跨工作未决意图和Hive权限停止点形成共识，分别落实于§5/§7/§10。主代理唯一写入本计划。模型 policy check/resolve exit 0，实际任务传输和只读工具环已完成；不宣称 billing 层模型验证。

最小完整方案：**一个 Kivo 连接、一个固定关联只读能力、一个具体维修创建动作、现有 work/results/actions、唯一 file-store、现有 MCP/可信事务/审计/outbox。** 不建第二 MCP、两连接映射表、通用 adapter registry、第二动作表、审批中心、动作队列、事件总线、独立 trace 表或补偿平台。

未参与规划的 Astra 过度设计审查者应独立比较删除上述候选复杂度后的方案；不得删除事务复权、不可变批准、稳定单号、可靠 attempt、unknown、回读、真实创建 producer 与精确 echo。争议复杂度做有界方案消融，不以移除必要权限/数据完整性来制造简化结果。正式 phase reviewer 独立审本计划和权威材料，输出 `REVIEW_VERDICT_JSON`；两审首轮不得预先提供另一审查结论或预设通过。审查完成前禁止本阶段升级、探针和代码实施。

## 3. 当前事实与探针义务

以下为源码观察，尚非 P6 运行通过：

| 现有事实 | 本期处理 |
|---|---|
| `packages/agent-mcp` 已是唯一 HTTP MCP，MES 挂载目前只注入 GET | 在原实现窄加维修 POST 和监控 GET；不直接私有 service/DB |
| 维修 controller `writeAuthority` 只认人类 Session；`TrustedWriteContext` 的 machine 当前是 worker identity | 为 OAuth 机器账号增加独立受控分支，不能伪装人类或 worker |
| 维修 `report` 已在可信事务内写记录/事件/审计，但没有按单号回放 | 在既有业务权威补齐幂等及并发唯一冲突判定 |
| 监控 `current` 依赖 Hive binding，投影 `freshnessMs=null`、`receivedAt=now` | T0 确认真实上游、UUID、采样和覆盖；投影时间不能冒充源接收时间 |
| business audit producer 只认 human；repair report 无 create action；before=null 不触发字段变化 | 窄加合法维修创建事件，包含真实机器 actor 与 before:null |
| Geneway codec 要求更新 before/after 字段对称；echo 仅在已有规则 target 后判断 | 窄加创建分支，并从 action/inbox 关联零规则创建回声 |
| action-service 硬编码 GearJob Comment 和两连接 | 替换具体绑定；不能称整个旧服务可直接复用 |
| file-store 已是 v11，已有 durable commit 与 work.actions 事实 | 保留/回归，若需 schema 迁移从当前版本单调升级，不重做 v7→v8 |

P5 留存的 HTTP 201／事务 rollback 现象内部原因未证，必须先最窄观察，不先归因或全面改事务层。P5 action fixture echo 只证明协议分支；本期必须真实机器创建→提交审计→producer→签名 sender→消费者。运行中成功记录必须在独立请求/连接可见，rollback 不得产生成功审计或可投递业务事件。若仍不能可靠证明提交或出现错误外发，阻断写验收，不把状态码当成功。

## 4. 成员旅程与可见状态

1. 管理员在既有后台为 Agent 配置具体关联能力及一个 Kivo 连接；连接绑定一个实例和一个机器账号，只在 synthetic 范围增 `mes.monitor.read`、`tpm.repair.report`。管理员配置权不获得成员正文权。
2. 成员从普通工作入口选择员工/Skill、连接和明确 TPM 单据，读取单据、同设备台账、当前监控。工作详情展示 TPM 状态/计划缺失、设备连接/运行/报警事实、来源时间/查询时间/采样龄/覆盖和未知项。
3. 模型只解释程序形成的同一结构化结果。不猜设备，不把离线说成停机，不把无字段说成无报警，不在缺基线时推断设备造成逾期。
4. 成员在现有详情创建维修单预览；服务端生成稳定 action ID 与 `GW-` 完整单号，目标来自已验证设备。显示实例、设备、单号、原因、描述、依据与时间，以及创建会进入 Kivo 正常维修/通知流程但不自动派工或控制设备。
5. 原因/描述可编辑并重新生成预览，目标或内容变化永久作废旧批准；“批准并创建”“拒绝”“关闭”分开，关闭/刷新/切换工作/取消编辑不能批准。
6. 只有 work owner 可在认证 Web 批准；批准 API 仅收 action ID、expected revision、preview digest、请求幂等身份，目标/payload/批准人由服务端取事实。可靠保存 attempt 后才调用写工具。
7. 匹配的上游回读及 receipt 落盘后显示“维修单已创建”、完整单号、UUID、当前状态和回读时间。幂等回放显示已有记录及可能已流转，不能表现为本次新增第二张。
8. 拒绝、过期、撤销、发前撤权和条件变化均不写。unknown 显示“创建结果待核对”，默认只读“再次核对”；持续404转人工核对，不宣称无效果、不换单号重发。
9. 渠道或规则最多产生待批准提案并引导 Web。模拟渠道经过现有真实通道代码；当前接收权限失效不发。通知失败只重试通知，不重写维修单。
10. 1440×900、390×844 均能查看完整预览、批准/拒绝、冲突和核对；轮询不能覆盖编辑草稿，固定导航不能挡关键按钮。移动视口不冒充真人手机硬件验证。

## 5. 两类来源、时间与执行授权

一个固定关联能力在一次 DSH 工具调用中执行固定的 TPM detail→device ledger→monitor current 读取，复用现有 Kivo MCP client；不把任意 toolName/URL/query 交给模型，不放宽普通 runner 一次预期业务工具约束。每次真实外发前复核当前成员、Agent 启用/开放范围、Skill、连接及对象；返回前核对归属。

关联身份为 Kivo resource/sourceInstance + TPM type/ID + device UUID。设备 code 仅是路由参数，来自本次授权台账读取；监控 GET 使用既有 `x-mes-ledger-device-id` 约束或等价 UUID 限定，结果再次校验 UUID，避免改码/复用竞态。不同实例同号不是同一对象。不新增映射表，零/多映射均不猜。

结果存入现有 `work.results[]`，保存两类来源身份/revision、设备 UUID/code、映射依据、源更新时间/采样时间/各次查询时间、最小当前状态与报警事实、覆盖/质量/未知项及程序结论。模型和 UI 消费同一结果，不携带上游原始大对象或秘密。

本期明确政策：采样最大年龄120秒，最多未来偏差5秒；这是新 Kivo 路径待验证政策，不沿用旧 PASS。缺采样时间、陈旧、未来异常、来源不完整或明确坏质量时可呈现不完整分析，但不能批准依赖这些事实的动作。质量/平台接收时间无字段时保留 unknown，不伪造；投影 receivedAt/snapshotAt 只标投影时间，不能当 Hive 接收时间。纯 queriedAt/投影 now 不进入变化冲突摘要；真正相关的目标、映射、依据和业务条件变化必须使旧批准失效。

预览有效期10分钟；批准后首次写派发窗口15秒，从批准事实可靠持久化的decision.decidedAt起算，到Geneway完成最终授权、取消及期限检查后调用真实传输函数、发送唯一的tools/call(tpm.repair.create) MCP HTTP POST为止。metadata/OAuth/来源复读及attempt持久化均不重置计时。该窗口不是Kivo内部业务POST或事务提交期限；开始外发后按在途、当前事务权限及真实回读结果处理，不能因跨窗宣称撤回或无效果。写前仍须重新复权与验证必要事实；过窗禁止首次POST，须新预览批准，已持久attempt但可证明尚未发送时记确定no-effect，否则保留unknown。已有unknown只读核对不受此窗限制。过期按请求检查，不建TTL调度。批准后成员移出再加入、Agent 停用再启用不能复活旧批准；连接身份改变不迁移旧动作。只读核对也复权，不因未知结果而绕过权限。

MCP 版本、OAuth resource/private_key_jwt 和唯一共享机器账号权威沿用 P4 已锁定依赖，不无故升级。同步插件固定输入/输出 schema 指纹目录：新增已知 monitor/read 与 repair/create，写工具只供确定性执行器，不登记到 DSH、模型列表或 prompt。未知/schema漂移仍失败，不为新增已知工具破坏原 TPM 查询。实际工具列表/模型输入验收无写工具和秘密。

## 6. 机器创建、事务与幂等

复用 `POST mes/tpm/repairs`。业务输入仅稳定 `GW-` 单号、设备、原因、描述，固定来源由受控路径决定，不传指派人/附件/控制字段；机器路径拒绝未声明字段。`x-trace-id` 绑定 action ID。工具只通过进程内 HTTP 路由注入，保留 `@ProductModule('mes.tpm')`、License、权限/组织/设备检查。

受信任断言由内部机器主体产生并绑定账号、credential、authorization revision、resource、固定 action/method/path、单号/payload/trace；外部 header/body 不能生成。控制器从目标设备解析组织与设备范围。OAuth 机器账号与 worker 类型/加载器分开，进入同一 TrustedWriteContext 权威；不复制可信写服务。事务内按既有锁序重新验证账号、密钥、角色权限、scope/namespace、License 与有效设备，正常授权先于任何幂等回放。

实例内单号唯一。首次、重投和并发撞唯一约束必须使用同判定：同机器创建、调用方当前可读范围、设备/原因/描述/来源一致，才返回原单当前状态并标 replay；其余统一409，不含已有单详情。创建者由不可伪造的创建审计/写入元数据证明，不能相信可填字段。优先复用现有事务 replay/锁和唯一约束；不得在已 aborted 事务里查回，冲突后用新有效事务复权判定。不预建幂等表；如详情缺创建归属，仅增加按权限裁剪的最小创建来源投影，不开放通用审计读取。

机器身份贯穿 reporter/history、audit、行写上下文与事件；修复本次路径上把 actorId 当人类 user 的假设，验证现有 Kivo 展示可识别机器创建者。成功记录、审计、创建事件必须同事务提交；rollback 不得残留业务效果。上游回读明确区分创建版本与当前版本，不通过已流转记录覆盖原批准事实。

Kivo Control 中阶段性 TPM GET-only 由用户已确认的本期动作推进：先原位更新 `control/agent-mcp-access.md`、`control/index.yaml` 中 `agent-controlled-actions` 条目及必要权威引用，独立本地文档提交后再实施依赖；不扩大其他写动作，不改 FMS 专属快照授权。

## 7. 动作事实、未知结果与恢复

仍只有 `work.actions[]`：不可变 preview、批准/拒绝/撤销/过期事实、attempt、receipt；owner 继承 work，不复制第二套状态。UI 从事实派生。保留 proposalKey（同依据提案）、clientRequestId（HTTP 重投）、action ID/GW单号（业务身份）三类作用，不能互替。

外部写 I/O 前 temp write→file sync→rename→parent dir sync 可靠保存批准/attempt，任一步失败外部写为零。adapter 固定工具及字段，禁隐式业务重试。超时、断连、可能已提交5xx、201后无法读回或receipt落盘失败均为 unknown；仅可证明提交前拒绝无效果时记 no-effect。

默认未知恢复采用合同允许的只读核对后转人工分支，不新增自动重提。404允许有限延迟后继续同单号回读，仍404不能解除未决身份。未决意图scope固定为ownerMemberId + trusted Kivo resource/sourceInstance + action kind + 原始TPM(recordType,stable recordId) + device UUID，全部来自服务端授权关联结果，缺稳定来源ID拒绝预览。在既有works[].actions[]跨工作检查同scope的attempt且无receipt/noEffect；生成预览及原子认领首次attempt两处检查，防并发双提案。work/action/proposal/result ID、源revision、GW号、正文、connection/client ID均不进入scope，因此改文案、重建工作、换单号/账号不能绕过。同设备不同原始TPM单据是不同明确依据，其他成员是不同主体，不全设备锁死、不跨成员泄漏；不用文本相似度或模型判断意图。原attempt固定原机器身份，新账号不能代认旧效果。

正常重启和备份恢复使未用批准失效、在途attempt变unknown，零自动业务写；receipt/历史/防重身份保留。恢复后来源、渠道、规则仍遵守P5保守关闭策略。停止当前执行、撤销许可、暂停规则、取消通知分别作用；在途只能说明待核对，不伪称撤回上游。无权核对则明确不可用，不换连接补读。

## 8. 真实创建事件与精确回声

沿 `enqueueMesBusinessAuditNotification → outbox → notification worker → generic_json v2 sender` 窄加维修 report/create：同步 business catalog、action validator、必要展示和测试；平台已有create类型，不建新总线。只在合法成功创建审计上产生真实actor/trace/revision/after，创建before为null；不能伪造before满足旧字段变化逻辑。机器actor放行限本动作，不泛化所有机器事件。

Geneway codec只对明确repair/create允许before:null，其他更新保持原对称校验与签名约束。仍先durable ACK、10秒内2xx，不能在ACK前等待MCP。创建前UUID未知，不能预先造非法active规则，也不新增按设备订阅全部单据来做演示。

用现有action/receipt与inbox事件派生精确关联：无active rule target的创建事件也可关联预先持久attempt，但不创建自动工作。只有受权回读核实source/resource、trace、完整单号、UUID、机器创建身份与创建版本后才记确定echo。先到事件等待动作回读/显式核对，后到事件复用可靠receipt；无第二trace表或状态机。

丢webhook时按单号写后回读仍闭合动作并保存创建/当前版本。不能把晚读到的更高revision全部当自己的创建回声；缺创建版本证据时保留未知，不压制变化。合法活动rule的发生判断复用精确关系，只抑制确定属于本次创建的revision；后续更高revision正常P5处理。原签名、防重、60秒对账、activation、规则身份和通知权限语义不变。

验收必须同时观察真实producer创建事件进入签名消费者并关联action、丢webhook时真实回读闭合。事后新规则baseline等于当前版本导致零occurrence不是echo因果证明；先/后到、重复、规则竞争和高revision用真实producer输出的定向测试补证，不用手写event替代主链。

## 9. 保留、替换与回归

| 既有部分 | 本期决定与检查 |
|---|---|
| file-store可靠提交、actions事实、保守恢复 | 保留，窄加Kivo事实；故障零写、unknown、恢复无重放 |
| work owner、Agent范围、当前grant、成员/管理员隔离 | 保留并覆盖关联/批准/派发/核对；移出再加回不复活 |
| Kivo MCP传输、OAuth、schema白名单 | 原库扩展只读监控与执行器写；模型无写、未知schema拒绝 |
| GearJob/Hive typed历史 | 只读保留原义、单位、时间和权限；不转换成Kivo |
| GearJob Comment adapter/两连接绑定 | 退出新执行；替换具体Kivo维修动作，不加通用registry |
| 旧correlation纯规则 | 选择性复用时间与确定性计算原则，Kivo字段重新验证 |
| P5签名inbox/对账/claim/通知/备份 | 保留，仅窄加创建语义/receipt关联；高revision与失权回归 |
| 工作详情/Web/渠道 | 扩展必要预览与核对，不新增审批中心，整体UI后置 |

## 10. 任务、依赖与单一所有权

| 任务 | 输出与owner | ready条件 |
|---|---|---|
| T0 有限事实探针 | Kivo运行owner：实例身份、真实监控/Hive分支、201/rollback最窄诊断、审计/读回布局 | 本计划独立过设计与正式审查通过；仅已授权synthetic环境 |
| T1 Kivo受控读写 | Kivo单writer：Control先行、唯一MCP、MES controller/service、可信写/共享机器接口、监控读、幂等、创建producer及测试 | T0对应接口结论；Control意图独立提交早于代码 |
| T2 Geneway关联/动作 | Geneway core单writer：plugin/domain/capability/grant/work/store/action/server及tests | Kivo已冻结工具schema/事务与回读合同；纯实现可与T1后半并行 |
| T3 事件/恢复联动 | 同core owner或明确交接：kivo-events/automation/receipt/state-transfer及tests | 创建producer与action DTO稳定，不与T2共享文件并写 |
| T4 必需Web入口 | Web单writer：web/index.html与UI定向测试 | T2 API冻结后可并行，不修改core文件 |
| T5 同候选验证/独审 | 验收脚本单owner；非实现者review/verifier：真实MCP/PG/worker/Web、故障矩阵和回归 | T1–T4组合冻结，同候选完整主链 |
| T6 阶段交付 | root统筹：验证记录、本地逻辑commit、实录视频/离线包/飞书回读 | 无当前范围阻断，随后等待用户P6最终验收再开P7 |

最初ready frontier只有T0及其所需先行Control文档。只执行已就绪任务；对应未知不冻结无关纯逻辑，但绝不以局部就绪称阶段完成。每个共享文件同一时段一个writer，接手先证明原writer停止并保留diff。实施按已授权Team Sol，独立reviewer不审自己实现。

T0监控分支：核独立MES/Redis/端口、测试License mes.monitor、设备组织和Hive binding；优先复用明确归属且可合法读取的独立synthetic Hive服务。若不存在，只在已授权范围内准备本机独立Hive测试依赖、独立volume/tenant/凭据和loopback，Geneway仍只访问Kivo。不得从旧仓扫描秘密或修改第三仓；需要新仓访问、额外安装/新权限时先停止该分支并由controller按现有授权判断，不能将fixture client当最终AC-19。

T0写边界先读实际schema/actor/事务；201/rollback诊断采用单个owned synthetic fixture和最小commit观察，保存原错误，不盲重发未知写。真正机器MCP创建探针在T1对应实现完成后运行，不列为T0已存在工具。真实权限/License/来源不满足、必须绕过HTTP或伪装actor、幂等不能判同主体时，停受影响分支重规划；新增业务写动作、真实数据、第三仓修改、扩大组织或公网/部署须问用户。

## 11. 验收矩阵与命令策略

| 覆盖 | 实际验收 |
|---|---|
| J9/AC-19/AC-07 | 普通Web→真实TPM/ledger/monitor MCP→同UUID；来源时间、覆盖、新鲜度/未知与模型/UI一致；零/多映射、坏质量、缺/旧/未来时间、不同实例 |
| J9/AC-20 | 完整预览/编辑失效/拒绝零写/owner批准→机器MCP→持久维修+同事务审计/outbox→按完整单号独立回读→receipt |
| AC-20/25 幂等 | 同机同号同内容重投/并发只有一张；异机/异设备/原因/描述/来源或不可见均409无泄漏；流转后replay返回当前状态 |
| AC-06/25 撤权 | 批准后Agent范围/停用、成员/连接失效、机器停用/密钥轮换/角色或范围撤销、设备变范围；实际事务锁竞争与回放前复权 |
| AC-20/12 unknown | 201但rollback反例、响应丢失/可能提交5xx/404/receipt落盘失败/进程中断；不换身份重写；正常重启/新dataRoot恢复零自动写 |
| P5回归/AC-18 | 真创建producer→签名sender→durable消费者→精确action；零rule也可关联；丢事件回读、先后到/重复/更高revision不误抑制 |
| AC-10/17 | 停W1不伤W2；撤销许可/停规则/取消通知区分；模拟渠道重投不重建动作，通知重试不重写；失权后不发 |
| AC-09/11/23/25 | B和普通admin无A正文/批准权；CSRF/Origin/字段白名单；停插件拒新I/O但历史可读；实际模型tools/input无写工具/秘密 |
| J11/AC-13 | 桌面和390px真实预览、批准/拒绝、冲突/unknown核对；关闭/取消/重开/刷新/双击及轮询草稿无意外写 |
| AC-22/交付 | 计划与独审早于探针；命令/退出码/失败/跳过实录；视频完整decode/播放和明确抽帧范围、离线打开、模拟渠道标识、飞书发送回读、用户最终验收 |

优先扩展现有 `scripts/test-p6-state-store.mjs`、`test-p6-action.mjs`、`test-p6-correlation.mjs`，并执行受影响 `test-p4-kivo-grants.mjs`、`test-retired-capabilities.mjs`、`test-kivo-events.mjs`、`test-kivo-automation.mjs`、`test-kivo-state-transfer.mjs`及通知相关检查。Kivo执行包内相关Vitest/类型检查、HTTP/PG真实事务交错、边界规则基线比较；具体命令从当前package与现有harness核定后写验证记录。拟建完整accept-p6当前不是已运行命令。

沿用P5事实：pnpm聚合曾因Corepack下载前置失败而未执行测试；展开命令成功不能标成原聚合PASS。原失败/跳过必须保留，不拼接不同候选旅程称单轮通过。真实主链不能由mock替代；故障注入只是补证。不重跑退休GearJob服务或无关全仓套件。

## 12. 阶段门与当前结论

独立过设计 `/root/p6_kivo_overdesign_review` 与正式阶段审查 `/root/p6_kivo_plan_phase_review` 在实施前对方案候选 `082579222573f98d153abe533ac56848b5ecdec50f42d3b5fc2112cb53b1cb42` 分别给出 schema v2 PASS；两者未参与规划且首轮独立。主代理先以 `34a4f25` 本地提交本计划，再从 T0/先行 Control 开始按就绪依赖实施。规划与实施时间、命令、退出码、原始失败和修复证据保存在工作流 `20260919-006-geneway-dsh-greenfield` 的唯一记录 `p6-kivo-verification.md`；本节只更新实际阶段结果，不追补规划。

2026-10-16 的 `geneway-p6-t5-final16` 在候选 `479d80e959281bd889b1a2b68b41e2a0db6fb3b59e05185129823a7d56c0fb24` 上完成 13/13 真实旅程，启动器退出码 0，前后输入与安装闭包一致。覆盖双实例关联、390px 预览/拒绝/冲突/本人批准、真实维修创建及 producer/worker 回声、高版本跟进、缺事件回读、模拟渠道、撤权、unknown、正常重启和备份恢复。独立 T5 正式审查通过；23 次模型请求未提供写工具，记录的 121 个进程和 30 个进程组均已退出，无强制清理。此前失败运行保持失败，未拼接为本轮通过。

产品本地提交为 Geneway `700b1ec34584b047849470c2bf68c1097b9a67b3`、Kivo `ae27a4e97ddfa5248d4461bd563d9e907489b81c`；提交后 66 项 Geneway 和 301 项 Kivo 候选文件字节仍一致。Kivo 全仓边界检查的 634 项既有问题与基线相同，不称全仓检查通过。审计范围为所选 Node Host/SDK 路径，不是整机审计。

T6 交付目录为工作流产物 `p6-kivo-delivery-final16/`：视频 486.2 秒、51 张截图、离线 HTML 与 ZIP。视频完整解码、1 倍速离线播放至自然结束，无 seek/error/外部请求；播放前后字节相同，独立媒体审查通过。人工视觉检查为关键手机截图及抽帧，不宣称人工连续观看。首次离线浏览器启动失败的记录另行保留。视频、HTML、ZIP 和阶段说明已通过原 `geneway-product` 飞书入口发送，4 项 GET 回读均核对收件 chat、发送 app、类型、文件名/时长或正文；回执保存在交付目录 `receipts/summary.json`。材料明确标注“渠道为模拟验收”和 synthetic/external-test。

用户在 P6 完整材料交付后明确“开始p7”，已允许进入下一阶段。P7 仍须另行 Team Astra 规划并通过独立审查后实施；第二模型路由等 P7 义务不计入 P6 结果，也不宣称完整 v4.4 已经完成。
