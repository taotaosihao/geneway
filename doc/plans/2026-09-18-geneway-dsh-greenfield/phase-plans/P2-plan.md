# P2 员工产品、连续性与实例独立详细实施计划

版本：v2

日期：2026-09-19

状态：Team Astra 重规划、交换与独立计划门禁均已通过；Team Sol 只实施明确就绪任务。当前 v4 store/auth 与旧 service 仍处于不兼容的集成中间态，禁止启动到有价值状态或声明 T1 完成

上游产品候选：`2df5d15`

上游证据提交：`63d18af`
阶段边界：只覆盖 P2；不表示 P3–P7、部署、发布或客户验收

## 1. 阶段结果与通过口径

P2 把 P1 的单操作者、单员工、单连接真实查询切片扩展为可用的基础数字员工产品：两名可登录的人类成员，两名数字员工，一份 GearJob 插件的两个连接实例，一个新增的原生节拍换算能力，持久待补充工作，确认信息增改删，管理员配置入口，以及与这些事实一起扩展的停机备份恢复。

只有以下结果在同一冻结候选中全部成立，P2 才可记录技术验收完成：

- G1、G2、G3 的 P2 当前路径成立；
- J2、J3、J4、J5、J11 基础身份/配置旅程完整驱动；
- AC-03–AC-13 的 P2 适用项通过，P1 的 J1 和 AC-01/02/10/11/12 相关路径无回归；
- 管理员和普通成员两个本地验收账号可以登录，正反权限由服务端而非前端隐藏保证；
- 两员工、两连接交错查询相同编号不串目标、凭据、Session、结果或确认信息；
- `3,600 秒 / 60 件` 由原生节拍工具得到 `60 秒/件`，非法输入明确失败；
- 插件在同一实际 Host/Context 内卸载后贡献不可用、无关入口可用，重挂不重复，历史结果仍可读；
- `waiting_input` 工作经过刷新、正常重启、补充和显式继续仍是同一 Geneway work；
- 确认信息修改或撤销后，后续上下文不再注入旧 revision，必要时使用干净 successor Session；
- W1 停止不影响 W2，活动 continue 不重复派发，历史 execution 不阻止后续显式继续；
- 390×844 视口实际完成关键写操作，不只验证布局；
- 扩展备份恢复、秘密扫描、真实浏览器验收、MP4、封面、离线手册和 `lark-cli` 回执完整。

合格声明仅为：

> P2 在本地单企业、GearJob 外部测试 A 与团队生成模拟数据模式下，完成基础数字员工产品、工作连续性和实例独立的技术验收。若 B 使用受控补充分支，则它只证明多连接隔离，并明确记录为 Frappe-compatible 受控 B，不构成第二真实 GearJob 来源。

不得推导为生产部署、正式发布、客户接受，亦不得推导 P3 协作/知识、P4 渠道、P5 主动任务、P6 真实写入或 P7 全量交付已经完成。

## 2. Planner Team 参与与裁决

### 2.1 实际规划者

| 规划者 | 运行身份 | 独立关注点 | 关键结论 |
|---|---|---|---|
| `/root/p2_product_plan` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high` | J2–J5/J11、产品对象、权限、桌面/手机旅程、失败态、视频 | 采用固定 admin/member、本地账号、owner 私有工作、两员工两连接、本人+指定员工确认信息；设计稿只复用信息层级，不显示未实现能力。 |
| `/root/p2_engineering_plan` | `atlas-sdd-planner`，`gpt-5.6-sol`，`high` | v3→v4、认证、统一 capability、DSH/grant、多连接、生命周期、测试与恢复 | 沿用 Node 标准库、单 JSON、单文件 UI 和 DSH；增加请求级 actor、静态可信 capability catalog、execution connection snapshot 和 Session owner metadata；先做同 Host 生命周期有限探针。 |

稳定返回引用与读取边界：

| 规划者 | 初始结果 | 交换结果 | 实际读取与限制 |
|---|---|---|---|
| 产品规划者 | `team-result:/root/p2_product_plan#initial` | `team-result:/root/p2_product_plan#exchange` | 实际读取合同、P1 计划、当前产品代码/API 和 WorkBuddy 设计稿；未运行产品、模型、GearJob、浏览器或外部发送，未读取秘密值。 |
| 工程规划者 | `team-result:/root/p2_engineering_plan#initial` | `team-result:/root/p2_engineering_plan#exchange` | 实际读取合同、P1 计划、当前源码/测试/状态迁移和已安装 DSH ToolRuntime 生命周期实现；未修改文件，未调用模型/业务系统/外部发送，未读取秘密值。 |

初始独立意见返回后，主代理把工程方案中的 v4 typed result、auth/CSRF、capability/grant、Session metadata 和 lifecycle 方案交给产品规划者，把产品方案中的 owner 私有边界、waiting/continue、confirmation 撤销、受控 B、attention hierarchy、390px 和视频旅程交给工程规划者。双方在交换结果中均确认没有阻塞性分歧，并共同要求补充：登录只豁免“已认证 CSRF token”而不豁免同源校验；增加最小成员管理 API/UI；受控 B 在结构化结果、UI、视频、手册和 Lark 全链路单独标识；v4 `results` 是唯一持久结果事实源，旧 P1 observations/follow-ups 只作只读派生兼容。

主代理未采纳产品规划中“最后一个 active admin 保护可仅写恢复手册”的较弱选项，选择服务端直接禁止禁用/降级最后一个 enabled admin；未采纳任何动态 registry、通用 schema renderer 或第二事实源。两位规划者的其余建议无实质冲突。主代理作以下裁决：

1. P2 使用本地单企业账号，不等待 SSO；保持 loopback，不授权远程暴露。
2. 固定两个角色 `admin` / `member`，不建设通用 RBAC；管理员配置权不自动获得其他成员私有工作的读取权。
3. 产品事实仍使用单个 JSON 文件与原子 rename；不引入数据库、ORM、队列、事件总线或双写。
4. 增加只有两项实现的可信 capability catalog，不建设插件市场、Workflow DSL 或 schema UI 平台。
5. 确认信息范围固定为“当前成员 + 指定员工”；不是 P3 企业知识库。
6. 第二 GearJob 目标优先在现有隔离 Frappe bench 建第二 site；若无法无源码修改安全建立，使用合同允许且明确标注的 Frappe-compatible 受控 B 补充 J4，同时保留 P1 真实 GearJob A 回归。
7. 插件生命周期只使用 DSH/Cordis 现有 Host/Context 的注册释放语义；有限探针失败即暂停 AC-09，不开发 Geneway 自有安装协议。
8. P1 两个非阻塞 Minor 在 P2-T0/P2 验收闭合，不倒改 P1 冻结结论。

当前没有必须先由用户决定的产品歧义；企业 SSO、跨成员共享、远程部署和第二模型提供方均不静默扩入 P2。

### 2.2 用户更新后的 Team Astra 重规划

用户在 P2 实施过程中把流程更新为“实施由 Team Sol 推进，每个大阶段先由 Team Astra 多代理详细规划”。原 §2.1 Sol 规划、门禁和当时已完成提交保留为真实历史，不补签或改写成 Astra 先行；新流程生效后的 P2 集成从本轮 Astra 门禁继续。

| Astra 规划者 | 运行身份 | 初始结果 | 交换结果 | 实际读取与限制 |
|---|---|---|---|---|
| `/root/p2_astra_product_replan` | `atlas-sdd-planner`，`gpt-6-astra`，`high` | `team-result:/root/p2_astra_product_replan#initial` | `team-result:/root/p2_astra_product_replan#exchange` | 阅读合同、P2 计划、设计稿、Git、当前源码和已提交成果；未修改文件，未运行产品/测试/模型/业务系统/浏览器/外部发送，未读取秘密。 |
| `/root/p2_astra_engineering_replan` | `atlas-sdd-planner`，`gpt-6-astra`，`high` | `team-result:/root/p2_astra_engineering_replan#initial` | `team-result:/root/p2_astra_engineering_replan#exchange` | 阅读合同、P2 计划、Git 状态、源码/测试、DSH/插件/迁移/恢复实现和设计稿；未修改文件，未运行产品探针/测试/模型/业务系统/外部发送，未读取秘密。 |

两份 Astra 初始意见独立形成后，主代理把工程 planner 的 v4/service 集成、初始化覆盖、损坏数据、工具 I/O 前撤权、timeout、来源 metadata、grant 清理和恢复安全问题交给产品 planner；把产品 planner 的 attention 层级、历史不重算、confirmation 上下文白名单、waiting/continue、节拍零值、bootstrap/recovery 分离、实际组合 lifecycle 和 390px 旅程交给工程 planner。双方全部采纳，并确认 `CONSENSUS`、无阻塞性分歧、无需用户新增决定。

本轮 Astra 裁决覆盖后续实施：

1. v4 store/auth、请求级 actor、唯一 typed results 写读和兼容投影必须作为一个集成门闭合；当前未提交 store/auth 只是可复用在制品，不能单独启动或记为 T1 完成。
2. 初始化分成首次 bootstrap 与已有成员的凭据重新供应；凭据恢复不得覆盖 members、role、enabled、sessionVersion、employeeIds 或额外成员。
3. reservation/模型前检查不替代真实工具 I/O 前的当前授权复核；已经发出的上游请求按真实状态结算，不伪称撤回。
4. confirmation 撤销后的 successor 只装配当前有效确认、白名单结构化业务事实和本次明确输入，不复制旧 explanation、旧 follow-up、摘要或完整 observation/Session。
5. T0 诊断工具 42 探针只证明同 Host 原生机制可行；AC-09 仍须验证实际 GearJob+cycle 组合、历史结果和无关 Web 入口。
6. 后续需重大重规划时返回 Team Astra 多代理；Team Sol 只负责计划内实施、修复与验证。

## 3. 已观察事实

### 3.1 P1 可复用基线

- DSH 包集锁定为 `0.1.6-alpha.2`；真实 ZenMux `openai-completions` 路由和 `deepseek/deepseek-v4-pro` 已通过模型探针。
- GearJob 外部测试实例、专用只读身份、对象 allowlist、原生工具、一次性 grant、严格 tool event/result 解析和来源观察均已存在。
- 产品已有 work、execution、不可变 observation、follow-up、结果引用、DSH Session lineage、精确取消和停机备份恢复。
- 单一 JSON 状态以临时文件和原子 rename 写入；当前单进程、loopback 使用范围内没有迁移数据库的证据。
- Web 已有 WorkBuddy 绿色视觉、首页、需要关注、工作详情、员工只读列表、桌面/390px 响应式基础。
- GearJob 数据必须持续显示“外部测试 / 团队生成模拟数据 / 非生产”。

### 3.2 当前根缺口

- 状态 v3 只有固定 `operator`；API 没有登录、请求级 actor、角色或 owner 过滤，知道 work ID 即可能读取。
- reservation 使用全局 operator；`ensureDefaultBinding()` 和 `authorizedBinding()` 固定为一个员工、连接和 GearJob Skill。
- 工单号为空直接失败，不能创建 `waiting_input`；活动 execution 时 continue 语义只是 `BUSY`，不返回同一 execution。
- runtime 与工具从进程全局环境读取唯一 GearJob URL/凭据/allowlist，不能安全表达两个连接。
- runner 只按 Session ID 复用，没有同时校验 member、employee、connection、skill、model route 和确认信息 revision。
- 工具解析硬编码 GearJob，尚无第二原生能力和通用结果 envelope。
- 没有确认信息对象、上下文 revision 引用、修改/撤销传播或 successor 规则。
- 员工页只读；没有连接测试/禁用、员工/Skill/连接/成员绑定或模型路由选择的授权入口。
- 手机规则隐藏唯一侧栏，没有独立手机导航。
- 当前插件注册虽处于 Cordis fiber effect，但还没有同一 Host 的 dispose/remount 运行证据。

### 3.3 P1 审查遗留的两个 Minor

1. `scripts/test-shutdown.mjs` 只在子进程退出后验证端口拒绝，不能捕获“`service.close()` 仍挂起且进程仍活着时是否已停止 intake”的原竞态。
2. `accept:p1` 在桌面完成操作后才切 390px，只证明移动布局和结果可见，没有在手机视口实际写入或继续工作。

### 3.4 Astra 重规划时的实际工作树

- HEAD 已包含 T0 停机/lifecycle 门禁、T0 证据、受控 B 和节拍纯函数/插件；`src/work-service.mjs` 已确认恢复为 HEAD，无中断代理留下的删除或半重写。
- 未提交的 v4 store/auth/init/tests 是在制品：store 读取会移除 `operator/observations/followUps`，而 HEAD work-service 仍读取 `state.operator.id` 并写 legacy 字段。当前组合一旦 bootstrap/recover 落盘 v4，后续创建会失败，禁止对有价值状态启动。
- T0 lifecycle 使用诊断工具而非实际两个业务插件；cycle 尚未进入 runtime patch、capability dispatch、expected-tool grant、typed result 或真实模型链路。
- 受控 B 已有 loopback 标准兼容端点和独立凭据；当前 GearJob normalizer 仍硬编码 `GearJob/external-test/synthetic`，接入前必须由可信 connection snapshot 决定 A/B 来源性质。
- `package.json` 尚未聚合 P2 新增检查；P1 验收仍是匿名入口，不能通过增加匿名绕过来冒充 P2 回归。

## 4. 产品对象与唯一事实源

### 4.1 状态 v4

使用一个纯迁移函数把 v3 升级为 v4；业务路径不散落旧版本兼容判断。

```text
members[]
  id, loginName, displayName, role, enabled,
  authRef, sessionVersion, employeeIds[], createdAt, updatedAt

modelRoutes[]
  id, provider, model, displayName, enabled, credentialRef

employees[]
  id, name, description, enabled, modelRouteId,
  connectionIds[], skillIds[]

connections[]
  id, name, kind, targetIdentity, baseUrl, hostHeader,
  credentialRef, allowedObjectIds[], enabled, status,
  skillIds[], revision, lastTest?

skills[]
  id, name, capabilityId, enabled

confirmations[]
  id, ownerMemberId, employeeId, label, value,
  revision, status, createdAt, updatedAt, revokedAt?

works[]
  id, ownerMemberId, employeeId, skillId, capabilityId,
  connectionId?, goal, input, requiredInputs[], status,
  results[], executions[]

reservations{}
  ownerMemberId + work/create scope + operation + clientRequestId
```

Skill 的 action、toolName、输入合同和连接要求只来自可信代码 catalog；浏览器不能把数据字段改写成权限来源。

`works[].results` 是 v4 后唯一持久结果事实源。结果使用固定 typed kinds 的小型判别联合，不接受任意 schema-less JSON 或把模型返回当业务事实；初始 kinds 只有 `gearjob.work-order.observation`、`manufacturing.takt` 和 `assistant.follow-up`，各自 payload 由确定性代码校验。共享 envelope 为：

```text
result:
  id, kind, capabilityId, skillId, schemaVersion,
  input, payload, explanation?, source?, createdAt,
  toolName?, pluginId?, pluginVersion?,
  dshSessionRef, continuedFromDshSessionRef?,
  contextConfirmationRefs[]
```

`gearjob.work-order.observation` 与 `manufacturing.takt` 必须保存真实 toolName/pluginId/pluginVersion provenance；`assistant.follow-up` 不调用工具，这些字段缺省且不得伪造。P1 observation 的 ID、来源、数量、时间、比例、Session 和 execution 引用必须保留；v3 follow-up 迁移为保留原稳定 ID、文本、说明、时间和 Session lineage 的 `assistant.follow-up` typed result。API 可从 typed results 派生旧 `observations`/`followUps` 响应字段，但旧字段不再持久写入，不能形成两份结果真相源；历史读取不得以新插件规则重算当时含义。

### 4.2 v3→v4 迁移约束

- v3 `operator` 映射为明确的 bootstrap 本地管理员成员；旧 `operatorId` 映射为 `ownerMemberId`。
- P1 员工、连接、Skill、work、observation、follow-up、execution result refs 和 Session lineage 保持原意和稳定 ID。
- 旧 GearJob Skill 映射到 `gearjob-work-order-read` capability。
- 旧连接只补非秘密目标 metadata 和 credential ref；凭据内容不写产品状态。
- 只有合同明确允许缺省的旧字段才按固定规则补齐；必需集合存在但类型损坏时拒绝迁移，保留原文件，不能用空数组静默吞掉损坏历史。
- 历史未记录的 pluginVersion 保持未知；不填当前版本伪造 provenance。旧结果展示只读原 payload，不通过新业务函数重新计算当时含义。
- 迁移对 v4 幂等；未来未知版本拒绝启动，不降级覆盖。
- 迁移失败时旧状态文件不变；实施前先以现有 P1 backup 保存冻结数据。
- 删除隐式 `ensureDefaultBinding()` bootstrap；P2 初始化和管理员修改均写同一事实源。
- 首次 bootstrap 可以创建固定 admin/member 和外置 auth；已有/恢复状态的凭据重新供应只能更新 auth 文件中既有 memberId 的 verifier/HMAC，不改产品 members、角色、启用状态、sessionVersion 或员工授权，不删除额外成员。

## 5. 身份、认证和权限

### 5.1 最小认证

增加 `src/auth.mjs`，只使用 Node 标准库：

- 仓库外 `0600` auth 文件只保存 memberId 对应的密码 scrypt verifier/salt 和 Session HMAC secret；产品状态保存 `authRef`，并唯一拥有 displayName、role、enabled、sessionVersion 和员工授权，auth 文件不得成为第二份权限配置。
- 登录成功签发有期限的 HMAC-SHA256 HttpOnly Cookie，至少绑定 `memberId`、`sessionVersion` 和 `expiresAt`。
- `SameSite=Strict; Path=/`；P2 无 TLS/远程暴露，不虚假宣称生产 Cookie 安全。
- 当前 CSRF token 由认证会话派生，经 `/api/session` 返回给已登录页面。`POST /api/session` 是唯一未认证状态创建例外：校验固定同源 `Origin`、允许的 JSON `Content-Type`、封闭请求字段和统一登录错误，但不要求尚不存在的已认证 CSRF token；其余已认证写 API 同时校验 Origin、有效 Cookie 与 `x-csrf-token`。
- 每次请求重新读取 member 的 enabled、role、sessionVersion；禁用账号或递增版本立即使旧会话失效。
- 未登录只能访问静态登录页面、登录/登出接口和 favicon；不能读取 bootstrap、成员、员工、连接或 work。

### 5.2 角色与访问

| 角色 | 允许 | 禁止 |
|---|---|---|
| `admin` | 登录；配置成员启用、员工、连接、model route 选择、Skill 与成员可用员工范围；测试/禁用连接；在自身业务范围创建工作 | 不因管理员身份读取其他成员私有 work/confirmation；不能通过 Web 安装 Host 代码 |
| `member` | 使用获准员工/连接；创建、查看、补充、继续、刷新、追问、停止自己的工作；管理自己的确认信息 | 不能修改员工、连接、模型、Skill、成员或 Host 插件；不能读取他人 work/confirmation |

- 每项工作创建时固定 `ownerMemberId`；P2 默认只有 owner 可读写。
- 未获准 work ID 返回不泄漏对象存在性的 404；安全日志可保留内部诊断码。
- 客户端/模型提交的 `memberId`、`operatorId`、URL、凭据路径、Host header 或 tool 名都不能扩大权限。
- 成员/员工/连接/Skill 禁用后，新派发、新重试和实际 dispatch 都拒绝；旧 Session 不是通行证。
- 配置变化不静默重归属旧工作，不自动换员工、连接、Skill 或 provider。

## 6. Capability、员工、连接和模型边界

### 6.1 两项可信 capability

新增一个静态 `src/capabilities.mjs`，仅含：

1. `gearjob-work-order-read`
   - 工具 `geneway_gearjob_read_work_order`；
   - 必填输入 `workOrderId`；
   - 要求 `gearjob-rest` connection；
   - 严格 prompt、tool call/result 解析与 GearJob 结果 schema。
2. `cycle-time-calculate`
   - 工具 `geneway_calculate_cycle_time`；
   - 输入 `availableSeconds`、`quantity`；
   - 不需要连接；
   - `3600 / 60 = 60 seconds/unit`；
   - `availableSeconds=0` 且 quantity>0 合法，结果为 0；quantity `<=0`、时间 `<0`、非数字/非有限/字段缺失，以及有限输入相除得到非有限结果时均返回稳定原因码。

`work-service` 的公共流程只做 actor、work、capability、binding、reservation、当前确认信息、runner 派发和原子结算；业务输入、prompt 和 result parser 放在对应 capability。`dsh-runner` 只负责 Harness、Session、取消、grant、事件和 continuity，不出现 GearJob/节拍业务分支。

统一 DSH profile 可以装两个工具，但每次 grant 的 `expectedTool` 精确约束本次能力；零次、多次、错工具、空/错 callId、错参数、错 schema 或未配对 result 全部失败。两个工具都返回严格 JSON tool-result；中文展示从同一 typed payload 生成，不从 render 文本反解析业务事实。

### 6.2 员工和 Session

- 员工 A：GearJob Skill + connection A。
- 员工 B：GearJob Skill + connection B，并额外绑定节拍 Skill。
- P2 两者可使用同一个已验证 ZenMux DeepSeek V4 Pro 路由；不提前验收第二 provider。
- 普通成员只看到管理员授予的员工。
- 存活 Harness metadata 至少绑定 member、employee、connection/null、skill/capability、modelRoute、confirmation revision fingerprint。
- 上述任一项变化、确认信息修改/撤销、进程重启或 runtime 取消/关闭，都创建 successor Session；Session 永不跨成员或员工复用。

### 6.3 两个 GearJob 连接与秘密

连接 A/B 必须具有不同的稳定目标身份、独立凭据和相同编号不同结果。验收对象固定为 `GENEWAY-P2-SAME-001`，建议 A 为 2/10、B 为 7/10；更新 A 到 4/10 后 B 保持 7/10。

- 优先在现有隔离 GearJob bench 创建第二 site，无需改 GearJob 产品源码。
- 若不可安全建立，B 使用明确标注的 Frappe-compatible 受控服务；这只补充 J4，不冒充第二真实业务来源，也不替代真实 GearJob A/P1 回归。
- B 若使用受控分支，连接名称、result envelope、`sourceInstance`、`sourceEnvironment`、`dataMode`、UI、视频、离线手册和审查报告均逐连接显示“Frappe-compatible 受控 B”；不得使用统一“两 GearJob 测试实例”文案。
- credential ref 只允许 secret root 下简单标识；解析后路径仍须在 root 内且文件为 `0600`。
- 产品状态、模型、浏览器、日志、备份和视频不得出现凭据内容或真实 secret path。
- 目标实例变化必须创建新 connection ID；同目标凭据轮换可保留 ID 并递增 revision。
- 禁用 A 或撤销 A binding 不得自动回退到 B。

每次真正 dispatch 前重新读取当前 member/employee/skill/connection/model route 和对象范围，再生成不可变 connection snapshot grant。grant 至少绑定 executionId、memberId、employeeId、skillId、expected tool、operation、精确 input、connection ID/revision、目标 identity/URL/Host、credential ref、source instance/environment/data/evidence mode。两工具共享一个窄 grant 消费/校验边界。插件先原子消费 grant，再在实际业务 I/O 前从唯一产品状态复核当前 member/employee/skill/connection/object policy；不再把进程全局 GearJob 配置作为派发依据。错误首次调用同样消耗 grant；内部自动重试若不能重新取得当前授权则关闭，用户显式 retry 创建新的 snapshot。grant 发出且上游请求已开始后的禁用不伪称撤回，按真实状态结算；成功、失败和取消路径均删除当次 grant。复用 Harness 的失败若无法证明上下文干净则关闭 Harness，下次使用 successor；grant 不进入 Session 备份。

### 6.4 当前容量、超时与预算口径

- P2 的最低并发目标是同时接受两个独立 work（W1/W2），每个活动 execution 使用独立 Harness/取消作用域；同一 work 仍最多一个活动 execution，不宣称无限容量或多进程扩展。
- 沿用 P1 已验证的 DSH 初始化 15 秒、单次模型请求 120 秒上限；GearJob 读取和连接测试使用 15 秒有限超时。用户取消 signal 与 timeout signal 必须合并，覆盖请求建立、响应头和 body 读取；准确区分 CANCELLED 与 UPSTREAM_TIMEOUT，不允许 DSH signal 使来源 timeout 失效。
- P2 不新增自动模型重试或 provider fallback；用户显式重试形成新的受控 execution，并重新检查授权。
- P2 只验证两个同时活动 work 和本阶段旅程所需调用量；更高并发、模型预算和容量基线在 P7 结合部署目标实测。

## 7. 工作连续性、停止和确认信息

### 7.1 `waiting_input` 与 continue

状态沿用现有集合，并增加 `waiting_input`：

```text
waiting_input
accepted → running → completed
                   → failed
                   → cancel_requested → cancelled
                   → interrupted
```

- 用户选定员工、Skill、必要连接但缺 capability 必填输入时，持久化 `waiting_input` work；不创建 execution、不调用模型、不读取来源。
- `requiredInputs` 只由可信 capability catalog 产生。
- 缔约字段确实缺失才进入 waiting；字段已提供但类型/范围非法时返回稳定校验错误，不把非法输入伪装成缺失，数值 0 不得用 truthiness 判为缺失。
- 刷新、重新登录和正常重启后仍可按深链找到同一 work。
- 多个待补充 work 按 ID、目标、员工明确列出，不使用“最近一条”猜测。
- `POST /api/works/:id/continue` 只合并 capability 允许的输入，再完整重检 actor/binding/object/model route。
- 输入仍不足时保持 waiting；输入完整且没有活动 execution 时，原子创建一个 execution 后再异步派发。
- work 已有活动 execution 时，任意重复 continue 都返回同一 execution 状态，不再次派发，也不合并或改变该执行已冻结的 input；相同 `clientRequestId` 继续保持幂等。
- failed/interrupted/cancelled 或其他已结束 execution 不阻止用户显式继续产生新 execution。
- completed work 的依据问题继续使用明确 follow-up，不把 continue 变成含糊的通用操作。

### 7.2 停止范围

“停止本次”只停止该 work 当前未完成 execution；不删除 work、历史结果、确认信息，不禁用员工/连接，也不影响未来规则。P2 同时建立 W1/W2，停止 W1 后 W2 必须正常完成；迟到结果不能覆盖 cancelled/interrupted。

正常重启时 waiting work 原样恢复，活动 execution 标 `interrupted` 且不自动重放；用户再次显式继续时，在同一 Geneway work 上创建 successor Session，旧 Session JSONL 和 execution 保留定位。

### 7.3 确认信息

P2 仅实现范围为 `ownerMemberId + employeeId` 的明确确认信息：文本 value、revision、active/revoked、时间。普通聊天或模型推断不自动保存。

- Web 提供查看、新建、修改、删除；新建/修改必须由用户明确提交。
- 修改递增 revision；删除形成 tombstone/revoked，并从未来可注入 value 中移除。
- execution 只保存 `{confirmationId, revision}` 引用，不复制一份可变真相。
- 每次实际派发重新读取当前 active revision。
- 修改/删除后，任何可能已隐式携带旧 revision 的 work 下一次继续/追问必须创建干净 successor Session，仅装配当前有效确认、当前仍获准观察和本次输入。
- successor 的上下文逐字段重建，只允许当前有效 confirmation refs、仍获准的结构化业务 payload 和本次明确输入；不得复制可能受旧 revision 影响的 explanation、旧 follow-up、摘要、整段 observation 或旧 Session 文本。历史结果仍按 owner 权限可读，但“可显示历史”不等于“可再次注入模型”。
- 另一成员或员工的确认信息不得进入 request、Session、result 或日志。
- 删除不承诺撤回已经发送给模型的数据，但必须阻止未来注入；不得用提示词“忽略旧值”冒充撤销。

验收不通过回答文风猜测，必须检查 execution 的 context confirmation refs、实际请求面和 DSH Session JSONL。

## 8. 插件生命周期

P2-T0 先在同一实际 DSH/Cordis Host/Context 运行有限探针：

1. 在同一实际 Host 挂载真正的 GearJob 与节拍插件；贡献各出现一次。
2. 调用节拍工具成功。
3. dispose/unmount 节拍插件；工具贡献立即不可用，插件自有资源清理。
4. GearJob 工具、普通 Web 和无关入口仍可用。
5. 已保存节拍结果通过通用 envelope 仍可读。
6. 同版本 remount；同名工具只有一个注册，再次调用成功。

T0 的 `p2_lifecycle_probe → 42` 只证明原生 Context/Fiber 机制可行，不是本节产品验收。本节是一项实际插件组合的 Host 运维验收，不对普通成员或管理员暴露安装代码 API。若当前官方 Host 语义无法在同一 Host 完成，或只能以 fresh Context 冒充，则暂停 AC-09 并返回 Team Astra 多代理重规划；不自建 install/activate/dispose 协议。

## 9. HTTP API 与服务边界

保持一个 Node HTTP 服务，不增加路由框架。

### 9.1 认证

```text
GET    /api/session
POST   /api/session
DELETE /api/session
```

### 9.2 当前成员工作

```text
GET    /api/bootstrap
POST   /api/works
GET    /api/works/:id
POST   /api/works/:id/continue
POST   /api/works/:id/refresh
POST   /api/works/:id/follow-up
POST   /api/works/:id/cancel
```

### 9.3 确认信息

```text
GET    /api/confirmations
POST   /api/confirmations
PATCH  /api/confirmations/:id
DELETE /api/confirmations/:id
```

### 9.4 管理配置

```text
GET            /api/admin/members
PATCH          /api/admin/members/:id
GET/POST/PATCH /api/admin/employees
GET/POST/PATCH /api/admin/connections
PATCH          /api/admin/skills/:id
PATCH          /api/admin/model-routes/:id
POST           /api/admin/connections/:id/test
```

成员管理只返回安全字段，只允许修改 displayName、role、enabled 和可使用 employee IDs；权限或启用变化由服务端递增 sessionVersion，浏览器不能指定版本值。不允许禁用或降级最后一个 enabled admin。管理员接口不能成为第二套成员事实源，只能绑定可信 catalog 中已装配的能力；不接受模块路径、包名、工具实现或 Host 命令。连接测试可直接调用只读 connector 验证目标/凭据，不产生伪 work/observation；真实业务 work 仍必须经过 DSH tool event。

## 10. Web 与 390px 界面

继续维护一个 `web/index.html`，使用设计稿的 WorkBuddy 信息层级和视觉语言，不引入前端框架或 CDN。

最小页面：登录；新建/首页；需要关注；工作详情；我的确认信息；员工；管理员员工/连接/绑定配置。

- 首页新建区选择员工、Skill、条件性连接和 capability 输入，允许先保存 waiting work。
- “需要关注”只优先显示 waiting、需要用户处理的 failed/interrupted、长时间未结束的 cancel_requested，以及其他有明确 blocker/风险/下一步的事项。普通 running 只是进度，默认进入可展开的“其他动态/工作”，详情仍显示进度和停止入口，不能仅按状态提升为需要本人介入。
- completed 和无需本人介入的历史默认收在“其他动态”，仍可展开。
- 工作详情显示 owner、员工、Skill、连接、缺失输入、结构化结果、来源、历史 observation/result、execution、follow-up、当前使用确认信息数量、继续/刷新/追问/停止及准确阻塞原因。
- 通用 result fallback 保证插件停用或无专用卡片时仍可读必要事实。
- 管理员可查看成员并启用/禁用、授予可使用员工；可真实保存员工名称/职责/enabled/model route/member/Skill/connection binding，创建/测试/禁用连接；目标 identity 不可原地换成另一实例。
- 普通成员看不到管理操作，直接调用仍由服务端 403。
- 390px 增加实际可用的顶部菜单或底部导航，不能隐藏唯一导航；保留 label、键盘焦点、`aria-live`、文字错误和无横向裁切。
- 不显示设计稿中未实现的 Hive 报警、协作计划、事件/定时规则、提醒偏好、动作草稿或写入按钮。

P2 手机验收固定在 390×844：普通成员登录，打开明确 waiting work，输入工单号并“补充并继续”，等待真实 DSH/GearJob 结果；随后至少再实际完成一次 follow-up 或 refresh。必须回读 execution/result refs，验证 `innerWidth=390`、`scrollWidth=390`、按钮可用且 console/runtime error 为 0。

## 11. 失败态与可见行为

| 场景 | 行为 |
|---|---|
| 未登录/登录失败 | 不返回业务 bootstrap；登录失败不泄露账号是否存在。 |
| 无获准员工/无工作 | 显示真实空态和下一步，不生成合成卡片。 |
| 缺工单号 | 保存 waiting work，明确缺失字段；不调用模型/来源。 |
| 多个待补充 work | 按稳定 ID/目标/员工列出，必须明确选择。 |
| 连接 offline/disabled | 保留 work；新派发局部拒绝，不自动换连接。 |
| 员工/Skill/model route disabled | 历史按当前访问权可读；新派发拒绝，不自动 fallback。 |
| 模型失败/来源超时 | 当前 execution failed；旧结果不覆盖，提供显式重试。 |
| 插件卸载 | 新调用不可用；历史通用结果和无关入口仍可用。 |
| 越权 work ID | 服务端 404，不靠 UI 隐藏。 |
| confirmation revoked | 后续 refs 不含旧 revision；受影响 work 使用 successor。 |
| 启动见活动 execution | 标 interrupted，不自动重放。 |
| 恢复后 secret 缺失 | 历史按权限读取；新执行明确 unavailable，不自动换绑。 |

## 12. 实施任务、所有权与依赖

### P2-T0：基线、P1 Minor 和原生探针

- 冻结 P1 产品/证据基线；完整复跑 P1 回归。
- 把 server 最小重构为可注入 service 的 factory；测试让 `service.close()` 可控挂起，确认进程仍活着、close 尚未释放时新 HTTP intake 已拒绝，再验证退出后仍拒绝。
- 运行同 Host 插件 mount/dispose/remount 探针。
- 建立两成员、两员工、两连接、同编号工单的验收数据命名；探针第二 GearJob site，必要时进入明确受控 B 分支。

### P2-T1：v4 状态、认证和 actor 权限

主要所有权：`src/store/file-store.mjs`、`src/auth.mjs`、初始化/迁移脚本及对应测试。

- v3→v4 原子迁移；bootstrap 与凭据重新供应分离；两个本地账号；admin/member；signed Cookie、登录同源 JSON 例外和已认证写请求 CSRF；owner-only work；管理 API 服务端角色门禁。store/auth、请求级 actor、唯一 typed-results 写读与兼容投影一次闭合后才能启动产品或记录 T1 完成。

### P2-T2：Capability、第二工具和连接实例化

主要所有权：`src/capabilities.mjs`、`src/dsh-runner.mjs`、`src/runtime-config.mjs`、runtime patch、GearJob 插件、节拍插件及 unit/controlled/lifecycle tests。

- 两个可信 capability；connection snapshot grant 与工具 I/O 前当前授权复核；合并取消/来源 timeout；多工具 JSON result fail-closed；Session owner metadata；节拍溢出检查；A/B 可信来源 metadata；实际双插件同 Host 生命周期；通用 result envelope。

### P2-T3：工作连续性与确认信息

主要所有权：`src/work-service.mjs` 及 service/controlled tests。

- waiting/非法输入区分；活动 continue 返回同 execution 且不改冻结 input；历史结束后继续；完整重新授权；confirmation CRUD/revision refs；撤销后以结构化事实白名单形成 successor；W1/W2 精确取消。

### P2-T4：管理员产品配置

主要所有权：由产品服务 owner 统一修改 `src/work-service.mjs`、`src/server.mjs` 和 admin API tests，避免第二套配置服务。

- 成员查看/启停/可用员工授权；员工、model route、Skill/connection/member binding；连接创建/测试/禁用；普通成员反例；禁用后旧 Cookie 失效和新派发拒绝；无 Host 安装接口。

### P2-T5：Web 与手机

主要所有权：`web/index.html`。

- 登录、attention hierarchy、waiting/continue、通用/GearJob result、确认信息、管理员配置、手机导航和真实 390px 操作。

### P2-T6：备份恢复

主要所有权：`scripts/state-transfer.mjs` 及 restore tests。

- v4 member/config/binding/work/result/confirmation tombstone、全部关联 DSH Session 和 hash manifest；独立恢复根；拒绝重复 entry、symlink 和路径逃逸；文件显式 `0600`、目录 `0700`；不自动执行；秘密不进入备份；重新供应 auth 不改恢复出的权限。

### P2-T7：组合验收、视频、手册与 Lark

主要所有权：验收脚本、必要的共享 CDP helper、`package.json` 脚本和 P2 证据记录。

- 保留 `accept:p1`；新增 `accept:p2`。只有出现实际共享时才抽 CDP helper。
- 非录制全旅程通过后冻结候选，再录 MP4、抽帧、生成 PNG/离线 HTML、秘密扫描、SHA-256、`lark-cli` 说明与视频发送。
- `package.json` 聚合 auth/store、cycle、controlled B、lifecycle、service/API、恢复和 browser checks；P1 J1 行为以认证、CSRF、typed-result 投影和显式授权初始化回归，禁止匿名兼容旁路。

依赖顺序：T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7。第二测试目标准备可与 T1 并行；节拍插件纯函数可与 T1 并行，但接入必须等统一 capability/binding；UI 等 API 冻结。`work-service.mjs` 与 `server.mjs` 只有一个写入 owner。

用户已有未跟踪设计稿及资源目录保持不动，不暂存、不提交。

## 13. 验证矩阵

### 13.1 Unit

- v3→v4、幂等、未来版本拒绝、P1 lineage 保全。
- scrypt/HMAC Cookie 过期、篡改、sessionVersion；同源 JSON 登录成功、跨源/非 JSON 登录拒绝；已认证写请求缺失/伪造 CSRF 拒绝。
- credential ref containment/0600、target identity 不可变。
- cycle `3600/60=60`、`0/正数=0`；quantity<=0、时间<0、NaN/Infinity、缺字段和有限输入导致非有限商均拒绝。
- capability parser、confirmation revision/revoke/fingerprint、状态转换和 reservation key。

### 13.2 Service/API

- 两账号登录；admin 成员启停/授权回读；member 管理 API 403；跨成员 work/confirmation 404；admin 不自动读私有 work；禁用成员后旧 Cookie 与新派发拒绝；最后一个 enabled admin 不可禁用/降级。
- waiting work 刷新/重启；多个 waiting 明确选择；输入不足仍 waiting；活动 continue 返回同 execution；结束后可继续。
- A/B 同编号不串；A 更新 B 不变；A 禁用后 A 拒绝、B 成功；未绑定 connection 在模型前拒绝。
- reservation 后、dispatch 前撤销 member/employee/skill/connection 时拒绝。
- Session 不跨 member/employee/connection/skill/model/confirmation fingerprint。
- confirmation 修改/删除后 successor；另一员工不注入。
- cycle 无 connection；插件禁用不破坏无关能力；历史结果仍可读。
- W1 cancel 不影响 W2；迟到结果不覆盖终态。

### 13.3 DSH/controlled

- 预期工具恰好一次；零/多/错 tool、callId、schema 全部失败。
- 错工具首次调用后 grant 已消费，正确工具不能再次使用。
- follow-up 禁止业务工具；GearJob direct-source bypass 保持为零。
- connection snapshot 与 work binding 一致；confirmation refs 精确。
- 受理后、Harness 初始化中、模型等待中和工具 I/O 前分别撤销 member/employee/skill/connection，尚未派发的业务 I/O 均拒绝；已发请求按真实状态结算。
- 取消与 15 秒来源 timeout 合并并覆盖 body；成功/失败/取消后 grant 均清理，污染风险 Harness 不复用。
- shutdown close 挂起时 intake 已停。

### 13.4 真实集成与浏览器

- ZenMux DeepSeek V4 Pro 实际执行 GearJob 和节拍两个 capability。
- A 始终使用真实 GearJob 外部测试标准 REST、独立 credential/object scope 并回归 P1 J1。B 若为第二 site，则验证第二 GearJob 测试实例；若走 fallback，则验证 Frappe-compatible 受控 B，并在 result/UI/证据中保留独立 `sourceInstance/sourceEnvironment/dataMode`，只计入 J4/G3 隔离证据。
- admin 配置保存回读、member 直调拒绝、登录/登出、confirmation CRUD、cycle 通用结果。
- 390px 从 waiting 补充继续并再 follow-up/refresh，实际点击、写入、回读；桌面/手机无阻断 pageerror/console/network failure。
- W1/W2 两标签精确停止；深链刷新、正常重启、独立恢复根后同 work 可读。

### 13.5 安全与恢复

- ZenMux token、GearJob key/secret、auth verifier 文件内容、Session HMAC secret 在 Git、状态、Session、日志、浏览器、备份和验收材料中命中为零。
- grant、secret root、auth file、Cookie、Lark token 不进入备份。
- state/backup 权限为 `0600`/`0700`；restore 每项 bytes/hash 一致。
- 重新供应 auth/credential refs 后可登录；secret 缺失时历史按权限可读且新执行失败；不自动重放。

## 14. 验收旅程

### J2 / AC-03、AC-10

member 创建缺工单号 work，execution 数为 0；刷新、正常重启、重新登录仍为同一 work；补充 `GENEWAY-P2-SAME-001` 后继续。并发重复 continue 只有一个 execution/模型/来源调用；历史结束后可显式继续。多个 waiting work 不串补充。并行 W1/W2，停止 W1、W2 完成。

### J3 / AC-04

成员为员工 A 新建 confirmation r1，新 work refs 只有 r1；修改为 r2，新 work 只有 r2；删除后新 work 与旧 work successor 均无 r1/r2，且 request/Session 不携带受旧 revision 影响的 explanation、follow-up 或摘要；员工 B 从未收到 A 的确认。以实际 refs/Session 证明，不以文风判定。

### J4 / AC-05、AC-06

A/B 两目标相同工单号、不同数量，A/B/A/B 交错读取始终对应各自 target/source；更新 A 不改变 B；禁用 A 后新派发在模型前拒绝，B 成功；员工 A 直请求 B、allowlist 外对象、旧 Session 绕过均拒绝。

### J5 / AC-08、AC-09

普通入口选择员工 B 和节拍 Skill，`3600 / 60` 得到 `60 秒/件`，`0 / 正数` 得到 0；非正 quantity、负时间、缺失、非有限和结果溢出明确失败且无虚假连接。同一实际 Host 的真实 cycle 插件卸载后新调用不可用、GearJob/Web 可用、历史 cycle result 可读；重挂后唯一注册并再次成功。T0 的诊断工具 42 仅为机制前置证据。

### J11 / AC-13

admin/member 均登录；admin 通过成员管理入口授权员工并禁用/重新启用验收成员，旧 Cookie 立即失效且重新启用不使旧 Cookie 复活；最后一个 enabled admin 受保护；admin 完成员工、连接、model/Skill binding 和 connection test；member 管理 UI 不可见且直调 403；member 创建/读取自身 work，另一成员直读 404；禁用成员后的新派发失败；不存在 Host 安装入口。

## 15. 备份恢复范围

包含 v4 产品状态、成员身份/角色与 auth refs、model route metadata/secret refs、employee/connection/Skill/binding、confirmation active/revoked、work、typed results（含 follow-up）、execution 和 DSH Session JSONL，以及路径/bytes/SHA-256 manifest。

不包含 password/verifier 文件、Session signing secret、ZenMux/GearJob secret、grant、Claude settings、浏览器 Cookie 或 Lark token。恢复到空目录，固定允许路径并拒绝重复 entry、symlink 和路径逃逸；复制后显式校验文件 `0600`、目录 `0700`。恢复本身不启动 HTTP、模型或来源。以不修改 members/role/enabled/sessionVersion/employeeIds 的模式重新供应外部 auth/secret refs 后才启动；cycle result、confirmation tombstone、两连接两员工和 Session lineage 均回读一致，未完成 execution 为 interrupted，撤销确认不再次注入。

## 16. 视频和飞书交付

同一冻结候选的 P2 主视频至少显示：

1. admin 登录，展示/管理两名成员、两员工、连接 A/B、两个 Skill 和真实状态；若 B 为 fallback，画面明确写“Frappe-compatible 受控 B”，不得称为第二 GearJob 实例；
2. member 访问管理入口被拒绝；
3. 桌面创建 waiting work，刷新/重启后仍为同一 work，再补充继续；
4. A/B 同编号不同来源/结果，禁用 A 不影响 B；逐连接展示 source instance/environment/data mode；
5. confirmation 新建、修改、删除，删除后 successor；
6. cycle `3600 / 60 = 60 秒/件` 和非法输入；
7. 390×844 实际登录、明确选择 waiting work、补充继续、查看结果/来源并 follow-up 或 refresh；确认信息关键操作和停止范围也从真实手机控件完成；
8. W1 停止、W2 完成；
9. admin 禁用 member 后旧会话和新派发被拒绝，再按验收步骤重新启用；恢复后同一 work、waiting/config/confirmation 状态可读。

同 Host lifecycle、直接 API 越权、重复请求、backup manifest 和秘密扫描由自动报告补充，不强行塞进 UI 视频。材料必须可完整解码，包含冻结 commit、SHA-256、封面、实际抽帧、相对路径离线手册，console/runtime error 为 0。`lark-cli` 使用明确现有目标和新的 P2 幂等 key，记录去敏 message ID、发送时间与文件 hash。视频持续显示 GearJob 外部测试、团队生成模拟数据、非生产。

## 17. 停止与重规划条件

出现以下任一事实，暂停受影响切片并返回 Team Astra 多代理重规划；Team Sol 不自行改变产品边界：

- 成员或管理员权限只能依赖客户端隐藏；多用户要求远程暴露但没有 TLS/可靠前置认证。
- v3→v4 不能保留 P1 observation/result/session lineage，或需要 JSON/数据库双写。
- 多连接仍必须依赖一组进程全局 URL/credential，或 B 只是同一目标别名。
- connection/grant secret 必须暴露给模型或浏览器。
- 多工具无法以 expected-tool grant 和严格结果校验 fail-closed。
- confirmation 修改/撤销后 successor 仍不能阻止旧值进入新上下文。
- 同 Host lifecycle 只能用 fresh Context 冒充，或解决方案要求自建生命周期协议。
- J1 真实 GearJob/ZenMux 回归失败；W1 cancel 影响 W2。
- JSON 单事实源在当前单进程范围无法安全原子更新；如果需求变成多进程，重新选择存储而不双写。
- 备份必须包含 secret 才能恢复，或恢复会自动重放未知效果。
- 手机只能渲染，不能实际提交关键操作。
- UI 继续展示未实现的协作、知识、渠道、事件规则、提醒、动作草稿或写入。
- 新方案要求数据库、队列、Workflow DSL、第二 AgentLoop、Session hydrator 或通用插件安装平台。
- `lark-cli` 目标身份不明确只暂停发送，不回滚本地技术成果。

## 18. 明确不做

- P3 多员工协作、子任务、计划调整、企业知识导入/共享；
- P4 飞书/微信产品通道；本阶段 Lark 只发送工程验收视频；
- P5 定时/事件规则、主动工作和提醒偏好；
- P6 第二真实业务来源关联、动作草稿、批准和任何上游写入；
- P7 第二真实模型路由、可重复生产部署、升级回退和全量容量认证；
- SSO、OAuth、自注册、找回密码、组织树、多租户 SaaS、远程发布；
- 通用 RBAC、插件市场、配置 schema renderer、知识库、消息总线、队列、Workflow DSL；
- 普通用户或管理员从浏览器安装 Host 代码；
- 修改 GearJob 产品源码、生产站点或客户数据来制造验收。

Ponytail 取舍：复用现有标准库、单事实源、DSH runner、原生插件、单文件 UI、备份与 CDP 旅程；只新增合同当前要求的 actor、capability、connection snapshot、waiting/confirmation 和第二工具边界。

## 19. 实施记录

### 19.1 计划门禁

- 两名 Team Sol planner 完成初始独立规划和交换轮；独立阶段计划审查在第三轮以 `spec_compliance=pass`、`task_quality=pass`、零 issue 通过。
- 唯一 P2 计划提交为 `3041b5c`；此前 P1 冻结产品候选仍为 `2df5d15`，P1 证据提交为 `63d18af`。

### 19.2 P2-T0 已完成项

- 提交 `6c66b35` 增加停机竞态回归和同 Host 生命周期探针。
- 停机测试把 `service.close()` 挂起，在事件循环仍存活、shutdown 尚未结算时确认新 HTTP intake 已拒绝；释放 gate 后正常退出，并保留进程退出后拒绝检查。`pnpm test:service` 通过。
- `scripts/probe-p2-lifecycle.mjs` 使用实际 `@deepseek-ai/cordis@4.0.2` Context/Fiber 和 DSH ToolRuntime：同一 Host mount 后唯一工具返回 42；dispose 后工具表为空、资源计时器停止、执行返回 `UNKNOWN_TOOL`；不创建新 Context 即 remount，工具仍唯一并再次返回 42。生命周期探针通过，AC-09 可继续实施，不需要自建协议。
- T0 后完整 `test:unit`、`test:service`、`test:controlled` 和 `git diff --check` 通过。

### 19.3 第二连接分支裁决

- 实际尝试在现有隔离 Frappe bench 创建 `geneway-p2-b.localhost`；数据库/site 创建进入 Frappe 安装阶段后，被 GearJob `read_only_cache` 对当前 redis client `Pipeline` 的兼容错误阻断：`AttributeError: 'Pipeline' object has no attribute '_single_connection_client'`。
- 失败发生于新 site 安装，不是 P1 GearJob A 的业务读取；未修改 GearJob 产品源码或现有 `dev.localhost`。团队核对 partial site 后使用 bench 精确 drop 新建目标，数据库和用户已删除，目录由 Frappe 可恢复地移到 `/workspace/development/frappe-bench/archived/sites/geneway-p2-b.localhost`。
- 依据 §2、§6.3 和 §17 的已批准有限分支，P2 选定“真实 GearJob 外部测试 A + Frappe-compatible 受控 B”。B 只证明一份插件的多连接、同编号、禁用和不串目标；所有结构化 metadata、UI、视频、手册和 Lark 说明持续标明受控性质，不计为第二真实业务来源。

### 19.4 Team Astra 流程更新与当前集成状态

- 用户在 `e931748` 后把阶段规划模型更新为 Team Astra、多代理，实施继续使用 Team Sol。两名 Astra planner 已完成独立复核和交换，结论为 `CONSENSUS`，其身份、读取限制、返回引用和裁决记录在 §2.2。
- 新流程生效时，v4 store/auth/init/tests 已产生未提交在制品，但 HEAD work-service 仍为 P1 legacy 写读；实测该组合会在 `state.operator.id` 失败。集成暂停是正确门禁，不是已完成 T1。中断代理造成的临时 `src/work-service.mjs` 删除已精确恢复为 HEAD，未覆盖用户或其他任务改动。
- 已提交 `e931748` 只完成节拍纯函数、原生工具和 ToolRuntime 自检；它尚未证明产品 capability dispatch、模型实际调用、typed result、授权或组合 lifecycle。
- Astra 重规划完成后的剩余实现者必须明确使用 Team Sol；在 v4/service 单一集成门、确定性检查和 auth-aware P1 回归通过前，不启动有价值状态、不录屏、不发送 Lark。
- 独立 Astra 阶段审查以 `spec_compliance=pass`、`task_quality=pass`、零 issue 通过 P2 v2；该结论只证明计划就绪，不证明任何待实现旅程或阶段验收。
