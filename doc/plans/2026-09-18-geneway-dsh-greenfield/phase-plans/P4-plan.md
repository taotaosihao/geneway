# P4 Agent、成员会话、Kivo TPM 与多渠道详细计划

> 合同 v4.4 原位重规划，形成时间：2026-10-15T10:32:00Z。本文替换旧 P4 的当前执行正文；旧提交和报告仅作历史，不恢复 GearJob 主链、企业微信 deferred、真人渠道或公网手机入口等已被新决定取代的门。依据为合同全文、clarification-notes.md §10/11、P1–P6 计划顶部注记，以及用户本轮最新目标。

状态：**Team Astra 原位规划、独立过度设计和计划正确性复审均通过；U0、S1-A、K0-A及C2有限协议探针具备实施条件，其余按依赖展开。P4产品尚未验收。** 用户已授权全量本地实施与本地提交。DSH版本规则与FMS专属机器锁定例外已获用户确认，见§8；K0-E按原计划内的窄化设计复核后实施，其余就绪任务继续。

## 1. 目标、当前事实与边界

本阶段交付：P4-S1 后台 Agent 与隔离的成员 Web 会话；P4-U0 DSH 最新版升级；P4-K0 Kivo TPM 只读主链；渠道会话、「我的渠道」、内置微信及既有飞书运行时的完整模拟验收。S1 单独先交付视频和离线说明，最终 P4 再在同一集成候选回归。P4 通过后才原位规划 P5-K1，再原位重规划 P6，最后规划 P7。每阶段继续采用两名独立 Astra planner、未参与规划的过度设计 reviewer和 Team Sol 实施，不提前实施下阶段。

覆盖 G1/G3/G4/G6/G9；J1/J4/J6 业务部分改为 Kivo，J2 及相关连续性回归，J7/J11/J12 的 Web/渠道路径；AC-02/05/14、AC-25 只读，Kivo 路径 AC-06/07/09/10/11/12，AC-16/17/23/24。DSH 升级同时回归受影响的来源无关能力。AC-25 写工具、两来源关联、维修单创建留在 P6；签名 webhook、对账补偿和回声识别留在 P5-K1。

### 1.1 已观察的基线

| 事实 | 证据与含义 |
|---|---|
| 主机、工作树与分支 | gewu-office 对应本机地址；`/home/gewu/.devspace/worktrees/geneway-f4222c66`，`rebuild/dsh-greenfield@4702ae20e7b0f26a1ccf3ed2186f370b0859f378`。SSH 只读身份检查曾因 host key verification 失败，未改信任设置；后续在已核对的本机路径操作。 |
| 工作树 | 规划开始时仅用户未跟踪的 `ui-sketches*`；全部不改、不暂存、不清理。 |
| DSH | 根清单三个直接 `@deepseek-ai/*` 仍为 `0.1.6-alpha.2`，不是已升级；飞书 SDK 已锁 `1.74.0`。升级目标以 U0 开始时 npm dsh latest 实际值为准。 |
| 产品事实源 | `src/store/file-store.mjs` 已 v8，临时文件 sync→rename→父目录 sync；没有成员对话集合。旧 `channelConversations` 是平台收发地址而非成员对话。 |
| Agent 与会话 | `work-service` 已有 employees 管理与成员 employeeIds 授权；缺独立指令/成员对话。`dsh-runner` 强制 work metadata 与一次预期业务工具，不能直接承担零 work 即时问答。 |
| 授权 | `work-service.updateMember` 对 employeeIds 修改提升 sessionVersion；`action-service` 旧批准摘要依赖它。取消强制登出前须补永久作废待执行批准，避免移出再加回复活。 |
| 渠道 | `channel-service` 仍按命令与 defaultDispatch 派发 GearJob；飞书已有持久收件、官方 EventDispatcher 注入、发送前 claim、failed/unknown，保留。自动通知仍指向 notificationConversationId。 |
| 恢复 | `scripts/state-transfer.mjs` 只收集 works 的 Session，需扩展对话谱系；普通备份不含秘密。 |
| 模型 | `runtime-config.mjs` 默认读 Claude settings，历史模型路由为 ZenMux。当前合法 Geneway secret ref、可用性未验证；不得扫描/搬运旧项目秘密。 |
| Kivo | 只读 `git show/ls-tree` 核对 `/home/gewu/work/kivo` 的 `deploy/dongguan-airui@26182fccf35d915982ea844ec71db58970a99c04`。尚未 clone、安装或启动。共享 platform-api/platform-db 已存在；agent-mcp 现有 stdio/单 token 方法快照工具；MES 为 Nest/Fastify。 |
| 历史验证 | P1/P2/P3/P5 与 P6-T1/T2/T3 证据只覆盖各自原候选和旧来源。保留代码可回归；不把历史 GearJob/Hive 证明换名为 Kivo。 |

规划阶段未运行产品、探针或测试，未读取秘密值。后文拟建入口均不是已通过证据。

### 1.2 权限与非目标

- Geneway 只在当前树实施；Kivo 从本地源仓库独立 clone 到 `/home/gewu/.devspace/worktrees/kivo-geneway-mcp`，新分支 `codex/geneway-kivo-mcp`。不得访问/修改 `~/.codex/worktrees/bd52/kivo`，不得对共享源仓库 fetch/prune/改写 refs，不修改其他仓库。
- 允许两个独立本机 MES 测试实例、synthetic 数据、开发测试 License、独立 JWT/通知秘密及 worker 身份；启动前证明 DB/Redis/端口隔离。实例和 Geneway 均只监听 loopback。
- 产品渠道仅本地 iLink 模拟器与飞书官方 SDK 事件注入；不向真实成员发送产品消息，不扫描真实联系人/群。`lark-cli` 向用户发送验收材料是单独已授权工程交付。
- 仅本地提交，禁止 push、PR、合入、部署、发布或网络暴露。管理员默认无成员会话/工作正文读取权。
- 不建第二 AgentLoop、每成员 Host、消息总线、通用队列、DSL、权限中心或 MCP 实现；不增加 PLC、设备控制、配置或报警处置工具。即时聊天不强造 work。
- 产品决策在团队讨论后由主代理落定；改变业务目标、写动作或授权范围必须询问用户，等待仅限依赖路径。用户负责阶段最终验收；内部技术通过与用户验收分别记录。

## 2. 真实规划参与及最小方案

### 2.1 参与者和原始结果

- `/root/p4_product_planner`，`atlas-sdd-planner`，明确派发 `gpt-6-astra/high`：独立产品、会话、渠道、恢复与普通入口意见；已返回完整报告。
- `/root/p4_engineering_planner`，相同模型/角色：独立源码、升级、授权、Kivo边界和验证意见；已返回完整报告。
- 两人均收到同一合同/范围/限制，先独立阅读并报告，随后只讨论实质取舍。原始返回保留于本次协作消息，不复制正式报告包；工作流任务复用 `20260919-006-geneway-dsh-greenfield`。
- `/root/p4_overdesign_v44`，atlas-sdd-reviewer，gpt-6-astra/medium：未参与规划/实现，独立静态有界消融通过，并复核最终三处增量；无新增复杂度阻断。
- `/root/p4_plan_correctness_v44`，atlas-sdd-phase-reviewer，gpt-6-astra/medium：独立计划正确性/合同覆盖通过，无剩余问题；未代签复杂度或运行验收。主代理持原始返回确认两planner实际独立参与、先独立后讨论。
- 两审查覆盖的内容候选blob为`cf93325bd9cbde1c3d2061085e3e46b712f2ecaa`；其后仅将本节/状态/消融表的待审文字更新为真实结论，没有先行实施。
- 精确模型路由的工具接纳与有效只读结果已观察；未做计费级模型核实，不宣称已证明计费模型。

两份首轮及后续实质讨论均支持：现有 employees 和 members 授权唯一事实源；一种成员对话；保留 work 独立 Session/取消；身份与平台地址独立；通知指向 identity；重新绑定新 identity；微信仅协议文件复用；唯一 agent-mcp 与共享机器授权；U0/S1 核心文件单写者。未选择另建 Agent Preset、权限副本、dsh-im Host 或第二 MCP。

### 2.2 主代理产品裁决

1. 后台沿用员工入口，显示 Agent 配置与开放成员。开放关系只改 members[].employeeIds；不另存 Agent allowedMemberIds。默认 Agent 为一个产品配置引用，成员未选择渠道 Agent 时仅在其当前获准且启用时采用；不可用要求明确选择，不静默换人。
2. `conversations` 为唯一成员对话类型，Web/渠道仅来源不同；旧平台 `channelConversations` 保留名称和传输职责，避免无收益改名迁移。群地址不构成共享成员会话。
3. 同一对话仅一个活动回复；忙碌明确本次未应用，不增输入队列。关联 work 可各自执行，取消范围不合并。
4. 渠道轮换使旧对话成为历史；仍可由本人在 Web 查看和继续，不隐式停工作。已持久消息固定受理时 conversationId；新消息使用新指针。渠道不接入旧对话，引用旧对话工作引导 Web。本人从 Web 继续后仍可在当前身份/发送权限允许时显式回复原渠道，不重新激活旧对话。
5. 新绑定必须新 identityId 与新对话；有效绑定唯一，历史 tombstone 保留。普通会话轮换不提升身份授权 revision，不撤销合法工作投递或主动通知。
6. 私聊文本为当前渠道范围；非文本明确不支持，不抓 URL、不入知识。群 @ 输入只进入发送者本人渠道对话；群内固定引导，正文只发本人已验证私聊，不具备目标则留 Web。
7. 先做 S1 实际纯聊与隔离；自然语言交办通过 DSH 窄产品工具访问 work service。多个工作候选要求选择，不按“最近工作”猜。新工具不接受模型指定 owner、秘密、任意 URL 或原生 Session ID。
8. 手机适配用真实浏览器的 390×844 操作验收；不恢复已被用户替换的公网/真人渠道前置。未验证真实手机设备和平台账号则如实标未测，不因此把合法模拟渠道判为未完成。

### 2.3 独立有界消融与裁决

| 当前方案 | 最小删减变体 | 比较依据与独立裁决 |
|---|---|---|
| 一种 conversation + 独立 work | 每句话建 work，或复用平台地址为对话 | 合同 §3.2 零 work 即时问答、群地址与私有归属、工作级取消；独立审查核对runner强制workId及channel-service群地址调用点，保留conversation。 |
| 扩展既有授权与批准失效 | 新授权 epoch/权限表，或只删除 sessionVersion 变更 | 现有原子 store update 与 action 状态可失效批准；首选直接作废，不预建新权限层。 |
| 一个 runner 内明确 chat 分支 | 新独立执行框架/通用 RPC | 原生 SDK 与现有产品服务桥可复用；仅内聚性确实恶化才分文件，不复制循环。 |
| identity、平台端点、成员对话各自职责 | 合并其中任意两者 | 群/私聊地址、轮换、解绑、通知目标生命周期不同；保留最小必要关联。 |
| 同库 MCP + 共享 platform 授权 | MES/FMS 两套实现或独立代理服务 | 合同唯一实现与现有共享包；删除重复实现。 |
| dsh-im 协议文件 + 本地协议模拟器 | 整体 Host，或仅直接调 service 的测试 | 前者引入第二会话权威，后者绕过验收入口；保留实际通道及协议模拟。 |
| 现有备份扩展 + 独立受限秘密包 | token 塞入 state，或每成员加密/KMS | 合同凭据备份和正文隔离不要求加密平台；选择前者的最小安全扩展。 |
| 一份计划、一份验证记录、必要视频/离线说明 | A/C/D/E、receipt、attestation 链 | 合同 §2.6 与用户交付要求；删除重复过程包，不删视频/离线说明。 |

独立审查逐项依据合同与实际调用点确认表中最小方案，结论通过。具体证据包括runner metadata、action decision.invalidatedAt/原子store、channel identity查合法私聊、agent-mcp既有HTTP runner、飞书EventDispatcher测试及state-transfer仅收works谱系；未运行代码或消融安全门。正确性复审要求补首次模型实际外发核查、新插件实际卸载/重挂、P6夹具口径，均已纳入§4/6.4/7.4并复核。

## 3. S1：后台 Agent 与成员会话

### 3.1 数据与管理

扩展 employees 的职责、执行指令、模型引用、技能/工具/连接绑定、启用状态；使用现有配置 API 和管理 UI。Agent 侧开放成员编辑在同一次 store update 中修改成员授权，并用既有 expected-revision 风格拒绝并发覆盖，不建版本平台。

`conversations` 保存 id、ownerMemberId、employeeId、标题、来源、必要 channelIdentityId、归档/轮换时间以及 DSH Session 谱系/turn 引用。产品保存归属、幂等、渲染与恢复必需投影，不镜像完整模型历史。浏览器仅持产品 conversationId；服务端解析原生 Session。work 增可空 conversationId，旧 work 不按时间猜测拼入对话。

成员可新建多个 Web 对话、重命名、归档并查看历史。新对话为空上下文；同一 Agent 下不同成员的 Session、确认信息与私有知识隔离。管理员配置能力不带正文访问；运维投影仅用量/耗时/错误/连接状态。成员主动分享指定结果使用既有或最小显式分享入口；不扩大到会话全文或管理员搜查。

### 3.2 执行和权限

保留 work runner 对预期能力/工具的严格校验；另有明确 chat 模式支持真实零工具问答，不放松所有业务模式。模型循环、Session 创建/继续/历史、原生事件、取消与委派均用 DSH。

每次新回复冻结该次 Agent 定义；名称/指令编辑影响以后回复，不能热改正在运行 prompt。停用、撤权、连接失效则在下一模型请求、工具 I/O、委派、批准及发送前立即阻断。干净 successor 仅注入当前获准事实，不复制已撤销整段上下文。

撤销员工授权或停用 Agent 时，在同一次产品事务中永久作废受影响未派发批准；unknown/已有 attempt 保留核对，不重新执行。然后才取消 employeeIds 编辑造成的登录 sessionVersion 提升；账号停用、角色变化与显式退出仍保留登录失效语义。验证移出→加回、停用→启用不会复活旧批准。

对话停止只取消本次回复；工作停止只取消本 work 及已有明确归属子工作。一个会话中 W1 停止不能影响 W2。恢复活动回复为 interrupted；已完成且原生历史缺失显示历史不可用，不改写成未完成。

### 3.3 S1 普通入口验收

admin 在后台创建两个 Agent，将其中一个只开放 A；A 实际登录后看到可用 Agent，B 不能通过 UI/API使用它。A/B 使用公共 Agent 各发不同 canary，并各新建第二对话验证干净上下文；实际模型给出回复。修改指令后新执行生效，进行中执行不偷换定义。A 未重登即可看到授权改变，撤权后新派发失败。admin/B 用已知 conversation/work/Session标识、历史/搜索/导出入口均不能取得 A 正文。A 在同一对话关联 W1/W2，停 W1 不停 W2；重启仍能查看对话谱系。桌面及 390×844 实际完成创建、消息、历史和停止。

S1 在同候选真实操作后录制独立 MP4，离线 HTML 带内联截图与相对视频链接，通过 lark-cli 发用户并回读；即使还未实现渠道，也注明“渠道为模拟验收；本视频覆盖 S1 Web”。不等待微信/Kivo 全部完成才发第一段。

## 4. U0：DSH 升级和有限探针

U0 开始前备份当前产品 store 和 DSH home，记录基线/校验值/恢复入口，秘密不进入普通报告。解析 npm `@deepseek-ai/dsh` latest 当时值，验证同发行DSH包/peer均存在并精确同版，独立发版的Cordis/Schemastery等按上游相容约束锁入lockfile（本次group精确1.0.4），不忽略peer mismatch；不分别取配套包各自 latest，不用 alpha 替代。

比对安装产物实际默认插件/工具与当前禁用清单；未知新增可用能力先判失败并裁决，不能只看配置文件。明确禁止模型文件/shell/任意网络等未授权能力。验证旧原生 Session 可读取或准确显示恢复不完整，新建/继续/干净 successor/取消/原生委派正常。保留 SDK profile patch 仅在仍有必要时更新，不为旧 patch 留无用适配。

S1/U0 的 runner、清单/lock、runtime-config、原生插件/桥及 state-transfer 由同一核心 writer 串行集成。若旧版本探针可支持 S1，可先交 S1；若不能，数据/API准备可继续，真实聊天依赖 U0。无论顺序如何，最终 S1 需在升级候选复验。

首个真实模型调用前，由U0核心owner核查新版本实际外发：模型输入、随请求附带的Session日志、遥测/反馈及其接收方，确认只有获准路由和必要数据、无秘密；检查安装产物和受控捕获，不能只据禁用清单推断。无法关闭或核实未知外发时先停真实模型调用。

本任务只回归来源无关的身份、授权、Session、委派、取消、恢复、节拍工具、知识撤销、定时路径以及已提交 P6 来源无关测试。J1/J4/J6业务改 Kivo验证；不启动旧 GearJob来凑升级通过。

本轮第一模型按用户更新改为 ZenMux `deepseek/deepseek-v4.1-flash`，当前运行配置、装配、固定路由校验与验收调用同步；旧阶段证据和历史Session不改名。此项是已授权路由内的明确模型替换，不新增模型管理框架；仍须先完成隔离与外发检查，再经DSH验证实际请求和结果。

模型仅从明确 Geneway 服务端秘密引用读取，移除默认扫描其他产品 settings。当前无合法可用引用时只阻塞真实模型验收，不能复制旧项目 secret、伪造真实调用或默换提供方。

## 5. K0：Kivo 唯一 MCP 与 TPM 主链

### 5.1 独立工作目录与部署单元

计划通过后 `git clone --no-hardlinks --no-checkout` 本地源到指定独立目录，再基于已复核 SHA 建 `codex/geneway-kivo-mcp`；源库只读，不 fetch。重读 clone 内 AGENTS/Control。Kivo 要求受控意图先于实现，先单独本地提交相关 Control、ai/project-map、docs/agent-mcp-method-snapshot 的授权调整，再做实现；不顺便改无关业务。

实例 A/B 使用各自 MES数据库、Redis、端口、JWT_SECRET、通知主密钥、worker身份、synthetic组织/设备/账号和记录。配置在服务端受限位置；若使用 Compose 则独立 project，端口选用前检查占用。开发测试 License 含 mes.tpm；P6 的 mes.monitor 不提前冒充已测。两个实例放相同单号、不同事实，证明连接隔离。启动前记录实际 DB/Redis身份的去敏证明，禁止使用现场数据。

### 5.2 唯一职责

| 位置 | 职责 |
|---|---|
| `packages/agent-mcp` | 唯一 MCP 2026-07-28 协议、固定工具/schema登记、OAuth资源校验接口、内部主体注入接口、HTTP路由调用；不引 DB/私有业务服务。 |
| `packages/platform-contracts` | 必要机器主体、管理 DTO、权限与资源契约。 |
| `packages/platform-db` 及既有迁移 | 独立机器账号、公钥/轮换/停用、组织/角色范围、断言 jti 防重放；复用事务与审计。 |
| `packages/platform-api` | MES/FMS 共用唯一机器账号加载器、管理与 OAuth 实现、内部机器主体上下文。 |
| MES/FMS API 挂载 | 薄挂载同库；MES TPM 标 `@ProductModule('mes.tpm')`；FMS 接原方法快照。实际业务通过产品 HTTP 路由。 |
| Geneway `plugins/kivo-tpm.mjs` 及窄客户端/规范化 | MCP客户端、固定白名单、TPM规范化及DSH工具，复用当前授权与连接，不将远端MCP直接给模型。 |

授权服务器实现和权威机器账号只一套；每个部署明确 issuer/token endpoint，MES/FMS 资源分别校验 audience，不各自新建账号系统。基于真实安装的 Nest/Fastify 路由注入证明内部主体可传递，候选为进程内 AsyncLocalStorage 或等价不可伪造机制；外部 header 不能创建主体。JwtAuthGuard/PermissionGuard照常检查模块、权限和组织范围；直接 OAuth 调业务路由、人类 JWT 调 MCP、伪内部 header 均拒绝。不能安全挂载则暂停重规划，禁止独立进程转发令牌或直接调service。

### 5.3 协议与账号

开工时核实并精确锁 `@modelcontextprotocol/server` / `client` 2.x latest；同时锁 ext-auth 仓库的实际提交与授权扩展文本。仅启用 2026-07-28、server/discover、单一POST、MCP-Protocol-Version/Mcp-Method/Mcp-Name；拒绝 initialize/旧握手，验证 Origin。SDK 文档支持 pinned version与server legacy reject，但必须以安装产物探针证明，不把文档当运行通过。

OAuth只实现client_credentials + private_key_jwt；issuer、token认证算法元数据、RFC9728资源元数据、RFC8707 resource audience、短时token。校验JWT断言sub/aud/exp/iat/算法/签名/jti，拒重放，License受限不签发。每个MCP请求复核账号和密钥当前状态；401带WWW-Authenticate/资源元数据，scope不足返回insufficient_scope。不做授权码/PKCE/动态注册/refresh token/共享口令。

机器账号独立于人类和runtime_worker_instance；管理API可创建/停用/轮换公钥，按现有管理权限保护。Geneway每连接对应一个实例/机器账号；P4只授合同五项TPM/设备读取权限，不给管理员或维修派工/验收/豁免权限。Kivo只存公钥，Geneway秘密存储保存私钥；token/私钥不入模型/浏览器/日志。Geneway TPM 的维修单写断言/事务复核另按P6计划实现，P4不提前开放该写动作；专属FMS账号仅按§5.5的用户已准迁移例外执行原快照锁定。

### 5.4 TPM工具、结果和历史

固定有限目录：维修/保养/点检及异常的列表和按单号/明确ID详情、保养计划列表/详情、设备详情。实际工具名和输入输出schema由现有DTO与真实API输出确定，探针后冻结；列表仅有固定过滤、分页上限，不提供任意path/query。无组织范围明确scope_empty，与正常零结果区分且不透露范围外对象。

Geneway固定工具名+输入/输出schema指纹allowlist；未知/新增/漂移工具不暴露并使连接测试明确失败，不信readOnlyHint。写工具不进入模型清单。工具实际I/O前重新核对成员、Agent、技能、连接、对象范围；传x-trace-id。

结果保留单号、类型、原始及规范状态、设备、负责人、计划/到期/开始/完成、来源时间和查询时间。程序负责规范化与逾期判断；无基线不判断，未知状态/时区不猜。latest查询形成新观察，不覆盖旧结果。

K0退出GearJob的新产品装配、创建和事件/Comment执行路径，保留旧typed结果、来源/时间、Session、动作事实只读及必要测试。不能把GearJob历史用TPM映射重算。J6调整为A读设备TPM工单/计划，B检索获准维护标准核对缺项，负责人引用汇总；复用动态委派、计划调整、等待/取消，不把产量/节拍硬套TPM。

### 5.5 FMS收尾

窄化规划于2026-10-15T11:48:38Z收敛，实施前由原两名Astra独立规划（p4_product_planner、p4_engineering_planner），root合成；独立p4_overdesign_v44完成六项静态消融并通过，受审正文blob为48b689e2b27d6a9ecd47ed4a0bb66c0d204ad733。只收敛用户已准的专属FMS机器锁定例外，不重开P4或提前开放TPM创建维修单；本节现已具备按依赖实施条件。共享/MES只读候选先完成审查和独立本地提交，避免修改仍在复审的公共接口。

**目标与现有事实。** 原 `manufacturing.method_snapshot.get/lock` 迁入fms-api挂载的唯一MCP库，复用真实HTTP controller、`fms.manufacturing`模块、read/execute权限和既有业务service。FMS快照范围是businessEntityId/siteId，不是MES organizationUnitIds；当前GET-only内部主体也不能直接放宽成任意POST。原lock在事务外判断状态、上下文固定human，须补机器分支及并发幂等。源码未发现lockedBy/audit actorId的人类FK，不能预设删除FK迁移；实际新库仍须核对约束。此收尾不阻塞TPM只读验收，但在恢复P6前必须完成，不能长期保留双MCP。

**范围与账号。** 同一MachineAccount/Store/Authority保留唯一公钥、OAuth和管理逻辑；增加严格的可空FMS范围 `{businessEntityId,siteId}`，本次仅单一明确站点。FMS管理适配验证站点与企业归属、有效状态，空/失效/MES范围均拒绝。MES组织字段保留原义，不把siteId塞入其中。现有namespace是客户标签（geneway/synthetic-test及namespace:name显示），不可改写。新增同表服务端拥有的不可变productNamespace（mes/fms），Authority固定产品与resource；历史仅MES账号迁移为mes，新create必须显式赋值，客户端create/update提交该字段拒绝，未知/缺失归属不作运行时fallback。管理list/load/update/rotate、token签发/校验/revalidate、Store事务consumeAssertion和写前复权均按产品过滤；跨产品管理ID统一not-found，在角色/凭据变更前复核，audience仍逐请求检查。FMS orgIds为空且有严格fmsScope，MES fmsScope为空，不混用。该准确化由两原Astra独立核对并共识、独立overdesign比较改写标签/仅resource/显式字段后通过；不增加归属表或新账号系统。FMS专属账号仅read/execute，无create/update/reset/管理员权限；Geneway TPM账号不得获取FMS资源令牌或权限，FMS账号也不能借MES audience访问TPM。Geneway模型清单不登记lock。

**确认与工具语义。** 保留workOrderId/reason/dryRun/confirmToken；dry-run仍只GET并返回当前快照、计划POST、权限与trace，不发业务写入。模型外的受控人工调用者检查预览、明确确认后发起lock；缺失/过短确认标记在POST前拒绝。confirmToken只在MCP输入边界消费，业务请求仅`{reason}`，不进入日志/审计/模型。现有标记只有最短长度检查，不证明审批人身份、不绑定对象版本、没有一次性消费保证；验收和文档如实表述，不新增签发服务、审批表或确认账本。get/dry-run需read，lock需execute，专属账号配置两项。

**可信写入与事务。** 现有进程内上下文只窄增`manufacturing.method_snapshot.lock`：绑定机器账号、credential、授权revision、产品resource、固定POST目标、workOrderId、reason和trace，由已认证MCP注入边界创建，外部header/body不能制造。FMS controller识别内部主体并构造动作断言；人类请求继续既有JWT/权限/DTO。TPM路径保持GET-only；未知动作及create/update/reset都拒绝。不复制MES worker的TrustedWriteExecution，不冒充worker，也不抽象新通用写框架。

实际业务事务使用同一transaction client，固定锁顺序完成当前账号/凭据/revision/角色权限依赖和目标快照的复权及状态读取，检查有效站点归属、当前License、动作/请求/目标匹配。账号管理与角色权限变化采用相容锁/并发策略；不得将事务外全局Prisma revalidate调用算事务复核。复权后才允许已locked幂等返回，不能通过快速返回绕过撤权。draft→locked只发生一次、version只加一、成功业务审计只一条，重复返回不覆盖原时间/操作者/reason。lock与原edit/reset对同一快照的竞争须保持锁后不可改，必要修改限事务状态检查。审计失败与业务写入同事务回滚，取消后不新造unlock/补偿动作。

**机器审计。** 机器actor明确区别于human和MES worker，lockedBy、业务audit actorId和行写入上下文采用同一可解码引用，updatedBy沿现有trigger写入；人类历史保持原语义。已有业务audit补传既有traceId字段（不新增列），访问audit关联accountId/credentialId/resource/result，不记录私钥/token/确认原文。两planner共识采用现有合法`{kind:system,domain:service,id:machine-account:<accountId>}`，编码为`a1:["system","service","machine-account:<accountId>"]`，不新增actor域或全库SQL枚举迁移。引用只由已验证内部主体生成；读端先解码，不当裸人类ID查询；若已有展示位置需要名称，用现有systemDisplayName接缝显示机器账号，不新建页面。当前mapSnapshot未暴露lockedBy，不为本次迁移扩展示。FMS范围字段的必要迁移仍保留。

**唯一库与入口。** 复用createAgentMcpHandler/官方SDK/认证层，工具定义增加必要的权限、mutates和固定执行回调，不能把lock标为readOnly；旧runner改为注入的窄HTTP接口，不依赖KivoApiClient的人类bearer。FMS只挂get/lock目录，MES只挂TPM目录，不暴露任意path/query/body。新路径成功及负例通过后删除旧stdio/CLI、bin别名、KIVO_TOKEN/SHARP_CELL_*读取及旧smoke入口，迁移有价值的参数/确认不转发/错误测试，更新有效exports/品牌清单。同步Control、project-map和方法快照文档，旧历史计划不作机械改写。

**实施顺序与文件面。** 先同步Kivo `control/agent-mcp-access.md`、index、project-map和方法快照文档的已准例外并提交意图；再改platform-contracts机器scope、platform-db同账号schema增量迁移/事务复权、platform-api产品策略/窄POST；然后FMS机器账号/MCP薄挂载、正式bootstrap/JWT guard、快照controller/service及审计适配；最后唯一库工具迁移与旧入口删除。不增第二OAuth、批准平台、policy DSL或全库actor框架。

**本地synthetic验收。** 使用独立FMS DB/Redis/端口/License，不接现场数据或设备；两个站点、范围内外快照、专属FMS账号、只读/越权账号及原人类操作者即可。所有结果经正式FMS bootstrap、官方SDK 2.3.1、2026-07-28、真实guards和PG读取：

| 检查 | 通过条件 |
|---|---|
| get→dry-run→人工确认→lock→get | 最终locked、version一次增量、机器actor和trace可回读；dry-run只有GET无业务写/成功lock审计。 |
| 缺确认、非法确认、派发前取消 | 无POST；确认标记没有到业务DTO/日志。派发后取消不声称回滚，先回读。 |
| no execute/module/License、空/错站点、跨产品audience/namespace | 拒绝，不泄漏范围外事实；Geneway TPM账号无法lock。 |
| human token→MCP、OAuth→业务REST、伪header/body、未知写动作 | 均无机器写旁路。 |
| 预览/确认后停用、撤/轮换凭据、撤权限、缩范围 | 用可控事务前屏障证明写入被拒；已locked也不能绕过复权返回。 |
| 顺序/并发lock、提交后响应丢失→回读→重试 | 一次状态转换/版本增量/成功audit，不覆盖原锁定事实。 |
| lock与edit/reset竞争、审计失败 | 锁后内容不被修改；审计失败全事务回滚；无连接池actor泄漏。 |
| 人类原入口与MES回归、旧入口检查 | 人类语义/历史兼容，MES仍只读，旧stdio/bin/单令牌不可执行，模型无lock。 |

执行受影响包typecheck、agent-mcp目标测试、快照service测试、FMS HTTP/PG集成、boundary同基线比较；真实库确认scope迁移及actor约束。路由/DTO变更用项目OpenAPI producer生成与diff；根脚本若会连接默认开发库，改用相同producer的显式隔离配置，不借本次授权触默认实例。旧PG套件若硬编码其他数据库身份，迁移其有价值断言到本次fixture，不能伪造环境或把skipped当PASS。失败/重试未知先GET回读，不盲写，不新增幂等账本。

停止点仅为无法安全做事务复权、无法正确解释FMS范围、必须伪装human或新增业务/审批动作才能迁移；已有专属账号锁定许可不重复询问。只暂停相关分支，不以TPM通过代签收尾。

## 6. 渠道会话、我的渠道、微信与恢复

### 6.1 产品服务和UI

保留channelApps、identities、平台端点、inbox/messages、deliveries、关联码；增加identity的activeConversationId/default employee引用。平台端点只保存收发地址/允许范围；活动指针由channel-service唯一维护。会话/工作正文由owner服务投影，admin不因维护app取得正文。

「我的渠道」为飞书/微信两张卡：未连接、待确认、已连接、暂不可用、已解绑；脱敏身份、默认Agent、打开本人会话、新会话、解绑。飞书沿用一次性关联码+Web最终确认；微信二维码→服务端登录→本人Web确认脱敏owner→激活身份/会话。确认前首条消息持久标未受理，提示确认后重发，不静默补跑；取消/过期后晚到登录结果不能激活。

自然文字由当前Agent会话处理，窄产品工具调用既有work服务创建/补充/继续/状态/停止。缺必要信息形成明确待补充；精确work引用与当前owner/会话授权不满足则询问或引导Web。Web可继续同work并投递获准回复；不能仅发链接。渠道不能列Session、绑定旧Session、切换他人对话。

P5规则通知改存notificationIdentityId，发送时解析当前合法私聊端点；会话轮换不影响通知。旧规则有可靠唯一映射才迁移，否则明确待选择，不猜。历史delivery保留实际目标与引用；对话回复/工作结果采用封闭来源引用，不复制整份业务结果。

### 6.2 iLink协议复用

按文件引入 `@xmanrui/dsh-im` MIT 的iLink协议/扫码/轮询/分段/重连，记录精确版本、来源文件、许可和改动；不运行Host，不带其工作区/AgentPreset/会话映射或/session等命令。入口建议 `plugins/weixin.mjs`，协议文件就近vendor，只有实际重复才抽公共函数。

实际通道在测试配置可指向本地iLink模拟器；生产配置拒绝该测试覆盖。模拟器实现扫码、长轮询、发送、重投/乱序、非主人、非文本、上下文过期、拒发与未知响应，不直接调用产品service。

owner稳定ID在确认时固定，只受理该owner私聊；同一bot同一时刻一个轮询实例，复用现有进程锁/必要的账号锁，跨data root也不能重复消费。停用/解绑/失效关闭轮询且不自动重连。

一批消息全部完成durable inbox或持久拒绝结果后才保存游标，store失败不推进；稳定平台ID去重，毒消息不永久堵后续。bot_token及发送上下文令牌仅在服务端秘密存储，state只存引用；游标同样只保存稳定秘密引用；顺序为inbox持久化后原子更新秘密存储游标，中间崩溃仅导致旧游标重投并由inbox去重，不新增逐轮秘密文件或引用切换。传输状态不能成为第二套业务事实。

分段只有全部确认才delivered；保留已确认分段进展，中途未知即unknown，不盲重发整条/已确认部分。上下文失效或拒发如实failed/待核对，不用心跳绕规则。

### 6.3 飞书与外发

保留现有官方SDK1.74.0及WSClient/EventDispatcher生命周期、app-scoped身份、echo/群@校验、固定attempt UUID、发送前claim。模拟连接/client从官方EventDispatcher.invoke进入实际plugin，持久受理后返回，捕获真实通道出站调用。

每次首次发送/重试/恢复处理紧邻I/O复核成员、Agent、app、identity、work/会话owner、接收范围、共享知识有效性与revision。撤权blocked且零网络发送；failed可显式重试且不重跑模型业务；unknown不盲重发。群内只有固定提示，无合法私聊留Web。delivered只显示“已发送至会话”，不声称已读。

### 6.4 备份恢复与可选能力

扩展现有state-transfer收集conversation/work/子工作所有Session谱系及身份/活动指针/扫码终态/游标/发送进展。普通state和manifest不含秘密；按准确引用制作独立受限秘密备份（目录0700/文件0600），不得进Git/模型/浏览器/视频/普通报告，不建每成员加密或KMS。

恢复默认关闭外部收发；活动执行interrupted，sending→unknown，delivered不重发，未处理inbox不暗中执行业务。恢复旧秘密不复活已解绑身份；不能确认当前owner/凭据有效性则要求重绑。历史缺失明确不完整。

未安装/停用渠道时Web、权限维护、解绑、历史仍可用；停知识能力后普通聊天/TPM仍能运行，撤销维护仍可阻止旧知识读取/注入/外发。只测实际有意义的最小装配，不穷举组合。K0-C及C2 owner还须在同一Host/同版本上实际卸载新增Kivo/微信插件，验证请求资源、轮询和注册已清理；再挂载验证没有重复工具/消费者且Web与历史维护仍可用。既有合成lifecycle probe不能代证这两种实际插件（AC-09）。

## 7. Team Sol执行责任、探针与验证

### 7.1 任务依赖和写入所有权

| 任务 | 输出/文件与owner职责 | 就绪条件/集成 |
|---|---|---|
| P4-U0 | 根清单/lock、runtime-config、runner/原生桥、升级probe与受影响测试；Geneway核心owner | 计划复审通过；备份先行。与S1共享文件串行。 |
| P4-S1-A | store、work/action服务、Agent配置API、授权/批准测试；核心owner | 计划复审通过；先批准失效再取消强制登出。 |
| P4-S1-B | conversation-service、runner chat、server API、state-transfer、会话测试；核心owner；Web由UI owner | A和原生Session探针；server同一时段仅一个owner。 |
| P4-S1-C | 实际浏览器/模型验收、单独视频离线说明及回读；验收owner | S1可运行候选；不等渠道/Kivo。 |
| P4-K0-A | 独立clone、Control文档提交、隔离实例准备；Kivo owner | 计划复审通过；不动源库/受保护树。 |
| P4-K0-B | shared机器/OAuth、唯一agent-mcp、MES挂载/guards、只读工具与测试；Kivo owner | A；SDK/路由注入有限探针后展开。 |
| P4-K0-C | Kivo插件、TPM规范化、capability/连接/授权接线、TPM协作；Geneway集成owner | 建议U0后；Kivo工具/资源契约冻结；共享文件移交后写。 |
| P4-K0-D | 两实例J1/J4/J6及Kivo回归、真实浏览器来源；验收owner | B/C及升级候选。 |
| P4-K0-E | FMS同库迁移、旧入口下线、文档测试；Kivo owner | B；用户已准专属FMS例外，§5.5窄化设计复审后实施lock路径。 |
| P4-C1 | channel-service/store/automation-service/API与身份迁移；核心owner | S1会话契约稳定。 |
| P4-C2 | 微信协议vendor/plugin与本地iLink模拟器；微信owner | 计划复审通过可先协议探针；接线依赖C1。 |
| P4-C3 | 飞书会话接入/SDK注入测试；通道owner | C1；保留已有transport。 |
| P4-C4 | 我的渠道/对话Web/移动交互；UI owner | API契约稳定；web/index.html唯一writer。 |
| P4-V | 同候选聚合、独立正确性/复杂度/设计核验、视频离线说明、验证记录和Lark回读 | S1/U0/K0只读/C1–C4完成；不能以局部通过代P4。 |

owner在实际派发时记具体agent；同文件不并发写。初始可执行边界仅核心U0/S1、独立Kivo、微信协议；UI等接口稳定后接入。实施采用用户指定Team Sol，路由预检后明确模型/权限/owned files；交接先确认前writer静止。reviewer不实现被审改动。

### 7.2 有限探针及失败分支

| 探针 | 成功证据 | 失败处置 |
|---|---|---|
| DSH包/能力 | 同版本实际安装、默认有效工具列表、旧历史/新Session/取消/委派 | 缺配套包或未知能力停止升级集成；窄patch后重测，不降级伪报。 |
| S1原生对话 | 真模型零work问答、新建空上下文、继续/重启读取、两个工作独立取消 | 旧版不足则S1运行依赖U0；新版仍不足重规划，不造循环。 |
| 模型秘密 | 明确合法server ref可载入并完成受控真实调用，无秘密入Session | 缺引用只停真实模型验收，向用户说明所需配置；不扫描搬运。 |
| MCP/OAuth | discover/精确版本/头/metadata/privateJWT全链、旧握手拒绝 | 同库窄配置适配可做；需换协议/人类token/代理则重规划。 |
| 内部主体 | 一个TPM GET经真实guards/模块/组织成功，外部伪主体与错误token拒绝 | 不能安全注入则停K0，不直调service。 |
| TPM DTO | 真实返回与严格输出一致，未知/时间/无范围可区分 | 缺字段标unknown；必要窄API修正限本接入，不补造。 |
| iLink | vendor实际通道连模拟协议，确认/owner/收发/游标/拒发 | 协议局部适配；需Host/第二会话权威/先游标则重规划。 |
| FMS迁移 | 同库下read/dryrun/确认/幂等与既有权限行为可验证 | 仅专属FMS账号按已准边界执行lock；未完成收尾不能恢复P6。 |

### 7.3 普通旅程与负例

至少admin、A/B、两个Agent、Kivo A/B同单号不同记录。顺序：

1. S1管理、真实聊天、多会话与管理员/成员隔离，见§3.3。
2. J1经实际Web→DSH→Geneway插件→MCP→Kivo路由读TPM及设备，来源/时间/状态与API回读一致；追问不偷刷新，查最新形成新观察；缺单号待补充，继续同work。J2保留等待/停止/重复继续和确认信息有效性。
3. J4两个独立实例相同单号，成员/Agent不同连接，交错执行/轮换凭据/停连接不串；不以同库两个组织代替。
4. J6真实TPM与获准维护知识动态委派/交接/计划调整/汇总，引用可回读；撤知识与停子工作后不泄漏、不误停独立work。
5. A/B各自飞书和微信经实际通道完成绑定、自然交办、正文反馈、精确补充，Web找到同work继续和回信；飞书官方SDK注入，微信本地协议服务器，模型/业务仍真实路由与synthetic数据。
6. 两渠道「新会话」和Web切默认Agent：新上下文干净、旧对话仅Web本人可进、A/B及飞书/微信不串；通知identity不随轮换失效；解绑后新identity，旧消息/旧delivery不复活。
7. 重投/乱序/冲突event、echo、非主人、非文本、确认前首条/取消扫码晚到、群@/陌生人/错reply、上下文过期/拒发/unknown；所有入口有持久结果，失败不重跑业务。
8. 生成后发送前撤成员/Agent/知识/identity权限，首次发送和重试零平台调用；恢复权限不复活旧批准；分段未知不重复已确认部分。
9. 正常重启与隔离根backup/restore：对话谱系/身份/游标/工作结果一致，无自动业务/重发，已解绑不复活；渠道缺失Web仍可用，旧GearJob历史不改义。
10. 桌面和390×844实际登录、聊天、交办、补充、来源、停止、绑定确认/解绑；无横溢/遮挡，键盘与错误提示可用。P4无维修写批准，留P6。

### 7.4 检查和实际记录

优先复用现有聚合：`pnpm test:p5` 已覆盖前序p4/p3/p2链，按实际脚本确认后不重复整套；聚焦检查按影响面运行。保留以下已提交P6确定性测试，检查来源无关授权/持久语义及旧typed历史；其中action/correlation仍含GearJob/Hive受控夹具，按保留代码必要调整，不启动旧来源、不计为Kivo真实证据：

```text
node scripts/test-p6-state-store.mjs
node scripts/test-p6-action.mjs
TZ=Asia/Shanghai node scripts/test-p6-correlation.mjs
```

拟建并由相应任务落地：`scripts/test-p4-session.mjs`、`test-p4-kivo.mjs`、`test-p4-weixin.mjs`；`accept-p4-session.mjs`、`accept-p4-kivo.mjs`、`accept-p4.mjs`。名字可合并至已存在入口，不为每AC建脚本；当前不能记为已存在或通过。

Kivo在clone内读取package scripts后运行受影响包/API typecheck、目标单测/PG HTTP集成、`node scripts/check-boundaries.mjs`，必要OpenAPI/迁移检查；提交前Control lint按真实base。具体命令与退出码在唯一验证记录中落地，不预填不存在的filter脚本。

唯一验证记录用工作流外Git目录中一份 `p4-v44-verification.md`，逐步记候选/命令/退出码/失败/跳过/来源范围/实际入口/readback/审查引用；无需另建正式回执链。新逻辑用能发现缺陷的小测试，安全与恢复检查不能删除。命令失败先判代码、环境或未具备外部条件，不把重试次数当结束标准。

## 8. 未决事项、风险与停止点

**U0版本规则已由用户确认：**本轮npm latest为0.2.0-rc.2；用户确认DSH主包及同发行dsh-*依赖/peers精确同版，独立Cordis/Schemastery等按官方相容范围锁入lockfile，group精确1.0.4且不忽略peer mismatch。原字面all@同版冲突解除。模型凭据已获准从用户指定Paseo配置定点提取到Geneway服务端秘密引用。先闭合已发现home隔离遗漏及相关复审，再恢复原生SDK/Session/委派/外发验证；旧失败仍保留，未执行部分不得标PASS。

**K0 SDK 2.3.1 窄适配决定（2026-10-15 11:21 UTC）：**实际纯 client_credentials 授权服务器元数据被官方客户端 `OAuthMetadataSchema` 拒绝，原因是其无条件要求 `authorization_endpoint`。两名原独立 Astra planner 分别核对安装源码和本计划 §7.2：采用同一 issuer 下真实 `/api/v1/oauth/authorize` 拒绝端点属于已列同库窄适配，不增加授权方式。GET 端点仅返回 HTTP 400 JSON：缺失、空或重复 `response_type` 为 `invalid_request`，有效但不支持的类型为 `unsupported_response_type`；POST 可直接 405，无需增加 body 解析；不使用人类身份、不产生跳转、Cookie、会话、code 或 token。元数据仍只声明 `client_credentials`，`response_types_supported=[]`。不修改 SDK schema、不假造端点、不绕过发现。实施方须用官方 `PrivateKeyJwtProvider` 证明发现/取令牌/MCP成功且未请求该拒绝端点，并验证任意 `redirect_uri`、人类 token 与异常参数均拒绝且无 `Location`。若后续需宣称或启用交互授权能力则停止返回决策。此记录为现有探针分支内的兼容选择，不代表实际验收已通过。

**FMS写策略已由用户裁决：**允许专属FMS机器账号保留原制造方法快照锁定能力，沿用原权限、dry-run、人工确认、幂等和机器审计，仅在本地synthetic FMS实例验证；Geneway TPM账号不授该FMS权限，写工具不进入模型。此例外只用于既有工具迁移，不扩Geneway写动作。K0-E在§5.5按已确认边界补齐共享写入断言/事务复权的必要设计并复审，再实施；恢复P6前仍必须完成唯一MCP迁移收尾。

其余主要风险：DSH新API与历史、内部主体穿过真实guards、iLink先持久后游标、撤权后旧上下文/批准、身份恢复复活。各由§7.2探针与负例处理；变化超出已列分支则两Astra原位重规划受影响段，未知依赖不拖停无关就绪任务。

无合法模型秘密/开发License/独立实例时，不宣称真实旅程通过；不靠现场数据或他人库补齐。需要新业务写、外网、真实产品消息、push/合入/部署时先询问用户。秘密泄漏、越权正文、撤权后派发或恢复重放为当前交付阻断，修复后重新冻结受影响候选。

## 9. 交付、本地提交与关闭条件

S1与最终P4各交一套同候选真实操作MP4和离线HTML说明（内联截图、相对视频链接、操作步骤/可见结果/失败恢复），明确“渠道为模拟验收”、Kivo synthetic/本地非生产，以及实际模型路由。不得以动画/直调service/静态截图替代交互。HTML不含debug、placeholder或秘密。

独立正确性/设计核验查看实际浏览器、持久readback与视频；独立复杂度审查确认无重复系统或过程包。用已授权lark-cli发送说明、视频与必要验证材料，回读消息类型/ID/deleted状态；工程交付成功不等于产品渠道验收成功。

每个独立可理解、已验证的逻辑结果做适度本地Conventional Commit，检查 staged diff 与 `git diff --cached --check`；只含任务路径/hunk。Kivo受控意图提交先于实现。ui-sketches*永不stage。记录两个仓库commit分别状态，不push/合入。

P4技术完成须S1/U0/K0只读及渠道全旅程、来源无关与Kivo回归、权限/恢复、真实浏览器、独立审查、两次视频/离线说明/Lark回读齐全。用户最终阶段验收另列，不代签。FMS收尾允许晚于TPM只读验证，但必须在恢复P6前完成。局部通过、HTTP200、历史GearJob结果或材料已发送均不等于P4完成。

下一顺序保持P4→P5-K1（Astra原位计划）→P6 Kivo（Astra原位计划，先确认唯一MCP收尾）→P7（Astra计划）。本计划不替代后三阶段详细规划。
