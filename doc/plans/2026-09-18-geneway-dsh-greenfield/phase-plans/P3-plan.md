# P3 动态协作与长期知识详细实施计划

> 状态：设计与工程计划草案已完成，等待当前 Product Design C/D 明确批准后才可实施。
> 权威范围：`implementation-contract.md` 的 P3、§5.2、§5.3、J6、AC-14、AC-15；回归 J2/J3/J4。
> 当前基线：P2 产品候选 `5441188`，P2 证据提交 `00dda1c`，formal phase review 为 PASS。
> 工作流任务：`20260919-006-geneway-dsh-greenfield`。

## 1. 阶段目标与不扩展边界

P3 交付一条真实、可恢复、可追溯的 J6：普通成员用两名获准员工核对真实 GearJob 测试工单进度、用户明确提供的剩余可用时间和获准文本知识；员工 A 读取工单，员工 B 检索知识并计算所需平均节拍，负责人汇总。产品持久保存计划、子工作、实际执行员工、交接、来源、知识版本和最终结果。

本阶段同时交付：

- 尚未开始计划项可查看、调整并做 revision 冲突恢复；
- 工作缺输入或局部失败后保留已有结果并在同一工作继续；
- 停止根工作传播到它的未完成子工作，不影响独立 W2；
- UTF-8 文本/Markdown 文本知识导入、更新、显式共享、检索与引用；
- 员工私有、成员与员工确认信息、显式共享知识三类范围保持独立；
- 更新、撤销、删除使新的检索、交接、派生摘要、汇总、follow-up 与 successor 不再带入失效内容；
- 知识插件停用后，公共权限判断、撤销与删除仍可用；
- v4→v5、备份恢复、390px 实际操作、视频/离线手册和 Lark 回读。

P3 不实现 Hive/设备、事件/定时、飞书/微信产品通道、制造多来源关联、业务写入、审批、通用 Workflow DSL、自写 AgentLoop、向量库、任意 URL 抓取、附件平台、生产部署或发布认证。

## 2. Team Astra 规划与正式产品设计门

### 2.1 独立规划者

- 工程 planner：`/root/p3_astra_engineering_plan`，`gpt-6-astra` / high，只读；检查合同、P2 实现、DSH 原生 subagent、grant、Session、store、backup 和 UI。
- 产品 planner：`/root/p3_astra_product_plan`，`gpt-6-astra` / high，只读；检查合同、P2 产品、WorkBuddy 稿、关键场景、可见状态、390px 和操作资料。

两者第一轮独立，不互看结论。随后主代理只交换实质差异：原生 fresh child 与 grant 边界、J6 任务选择、知识 ACL、撤销后的历史投影、计划编辑轮询冲突、停止范围。工程 planner 接纳产品关键场景与 UI 约束；产品 planner 接纳原生身份探针和保守 ACL，收敛结论为 `CONSENSUS`。

### 2.2 Product Design

正式产品草案位于：

- `workflow/artifacts/20260919-006-geneway-dsh-greenfield/product-design/A-product-context.md`
- `.../C-critical-scenario.md`
- `.../D-flow-design.md`
- `.../E-design-handoff.md`

A 的目标是 `product_increment`；C/D 当前为 draft，E 为 non-executable。必须取得当前用户对完整 C/D 及以下四项保守规则的明确批准，才可写入两个独立 approval binding 并进入 Team Sol：

1. 员工私有知识不因“其他成员也能使用该员工”而隐式跨成员传播；默认是导入成员 × 指定员工交集。
2. 显式共享分别选择 memberIds 和 employeeIds；共享知识不分享工作、连接、Skill 或其他员工权限。
3. 失权用户历史 API/UI 不返回正文、snippet 或依赖它的派生摘要；维护者只看到必要 tombstone/范围状态。
4. 删除立即移除活动正文并阻断未来读取/再注入；既有 DSH 日志和离线备份没有安全物理清理路径时显示“已停止访问，清理待完成”，不宣称彻底删除。

用户批准不是实现验收。P3 实施后仍须 Design Review、真实 J6 和独立 phase review。

## 3. 已确认复用点与风险

- `state.json` v4 是唯一产品事实源；继续使用单进程串行 update 与原子 rename，不让 DSH 子进程创建第二 store。
- P2 的 member/employee/skill/connection/modelRoute/work/execution/result/confirmation/reservation 和 owner-only 权限继续有效。
- `src/dsh-runner.mjs` 对普通 capability 保持恰好一次预期工具；P3 不放宽 P1/P2 runner 来容纳任意工具链。
- 已安装原生 spawn provider 创建 fresh Session、零父上下文，支持 `outputSchema`、`maxDepth`、`toolFilter`、`persona`、signal/dispose；源码可见不等于组合已验证。
- 当前一次性 execution grant 绑定一个 work/execution/employee/capability，不能由父子共享或靠环境变量轮换“当前员工”。
- `publicWork` 当前会克隆完整 work；P3 必须先在服务端按当前 ACL 与知识依赖投影，不能把正文传浏览器再隐藏。
- Web 每 1.2 秒重绘工作详情；新增计划编辑时必须保存本地草稿，避免轮询覆盖。
- P2 backup 只递归收集 work 中 Session refs；P3 根/子执行都要进入同一关联扫描。

最高风险是知识经交接、摘要、explanation、历史结果或 successor 间接泄漏；其次是原生 Agent 身份无法可信映射到产品 employee/execution；第三是根取消、继续代次与迟到回调竞态。

## 4. 产品数据与 v5 单一事实源

在一个 v5 state 中增加最少事实：

### 4.1 工作与协作

- 根 work：沿用 `works[]`，增加 collaboration mode、目标、负责人、plan revision、预算窗口、cancel generation、子 work IDs。
- 子 work：仍是 `works[]` 中有 `parentWorkId/rootWorkId` 的 owner-only 工作，记录实际 employee、capability/connection、输入、executions、results 和 Session。
- plan：根 work 内保存 revision、子项 ID、目标、承担 employee、状态和必要依赖引用；状态事实来自子 work，不复制结果。
- handoff：发送/接收 employee、子 work、结果 refs、knowledge refs、revision 和状态；只保存必要交接，不复制整段 Session。
- 派生 result：仍写入现有 `results[]`，增加生成 employee、handoff refs 和完整 knowledge dependency refs；不建第二结果库。

### 4.2 知识

- material：id、ownerMemberId、employeeIds、sharedMemberIds、sharedEmployeeIds、title、body、format、sourceLabel、authorizationBasis、revision、status、createdAt/updatedAt。
- citation/ref：`knowledgeId + revision + segmentId`；segmentId 由稳定段落位置派生。
- tombstone：删除后不保留活动正文，只保留 ID、owner、最后 revision、状态、时间和必要依赖定位。
- 检索切片/词项/评分为可重建派生值，不是第二事实源，不持久化缓存正文。

### 4.3 迁移

- v4→v5 纯迁移一次完成；旧 work 没有 parent/plan/knowledge refs，现有 ID、owner、results、reservations、Session 和 confirmation 原样保留。
- v3 仍先走既有 v3→v4，再进入 v5。
- 未来版本、损坏引用、parent 环、无 owner 或非法 ACL 明确拒绝；不修成“尽量启动”。
- store/schema/result validator/service/backup 必须作为同一兼容集成点通过后，才启动实际有价值状态。

## 5. 原生协作与权限方案

### 5.1 P3-T0 探针

实施第一项是拟建 `scripts/probe-p3-delegation.mjs`，仅在当前锁定包和窄 Profile 中启用 subagent + spawn provider：

1. 父/子使用现有 ZenMux `deepseek/deepseek-v4-pro`；子为 fresh Session，父 canary 不进入子 request。
2. 在首个子模型请求和工具 I/O 前建立原生 Agent identity → product root/child work → execution → employee 映射。
3. A/B 有不同工具/连接范围；错员工、错子 work、父 grant、伪造 Agent ID 都在 I/O 前拒绝，捕获服务器零请求。
4. 子 Session、usage、结果与交接可从产品状态回读；父汇总只能引用已持久化子结果。
5. 覆盖派发前、模型中、工具 I/O 中的根取消，验证 W1 子树停止而独立 W2 完成。
6. 在下一次模型调用前执行预算、成员/员工/连接和知识有效性检查。

失败条件：需要 fork、共享可变全局 grant、子进程并发写产品 JSON、自写 AgentLoop，或无法在派发前绑定身份/预算。任一发生即停止受影响实现并返回 Astra。

### 5.2 最小运行结构

- 新 `plugins/collaboration.mjs` 只贡献少量产品工具：更新已登记计划、委派已登记子 work、提交引用已持久化结果的汇总。
- 原生 `ctx.subagents.start('spawn', …)` 负责 Agent/Session/工具循环/取消；Geneway service 负责身份、权限、状态和结果。
- 不使用 fork，不复制父历史，不让模型参数中的 employeeId 成为权威。
- 若原生子进程需调用唯一产品 service，使用固定窄操作的同机 Unix socket；每次根 execution 随机凭据，绑定 root/execution、防重放，不进入模型参数/Session/浏览器。只有 Unix socket 不可用时才评估等价 loopback 窄桥。
- `startContinuable` 不进入 P3；补充继续使用同一 child work 的新 execution/successor，避免 pending inbox/descendants 恢复面。

### 5.3 取消、继续与预算

- 根取消先在一个 store update 内关闭 root cancel generation 和所有明确归属的未完成子 work 后续派发，再调用原生 cancel/dispose。
- completed 结果保留；旧 generation 的迟到回调不能写成 completed。W2 由独立 root 标识，W1 取消不能影响 W2。
- 继续创建新的 execution generation，重新检查当前成员、员工、连接、知识、计划 revision 和预算；不自动重放。
- 初始安全上限：深度 1、每根最多 4 个子工作、最多 2 个子执行并行、每次明确执行窗口最多 12 次模型 request、单次输出上限 4,096 tokens、根窗口 360 秒、子窗口 120 秒。T0 若揭示 SDK 真实限制，只能收紧或在 Astra 复核后调整。
- request 在派发前预约；usage 使用原生回执。费用或输入 token 不可得时显示未知，不伪报。耗尽保留已有依据并等待用户明确继续，不能无限自动追加。

## 6. 知识检索、ACL 与撤销

### 6.1 有界文本能力

- 支持直接粘贴、`.txt` 和 `.md` UTF-8；Markdown 只作文本，不执行 HTML、脚本、远程资源。
- 上限 100 份、单份 32 KiB、总正文 3.2 MiB；按段落切片，过长段约 800 字符，少量重叠。
- 只在当前获准材料内做确定性词项/中文片段匹配，标题加权、稳定 ID 同分排序；最多 6 段，总注入字符有上限。
- 不用 embedding、向量库、外部索引、任意路径或 URL。容量实测不足时再局部重规划。
- 引用必须匹配本次实际检索 refs；模型伪造知识 ID/revision/segment 拒绝。

### 6.2 单一当前授权判断

所有下列路径调用同一知识授权/有效性判断：列表、直接读取、搜索、模型请求前、子交接前、父汇总前、follow-up/continue 装配、history/bootstrap/mobile 投影、backup restore 回读。

- 私有：ownerMemberId 与指定 employeeId 的交集；同员工的其他成员不自动获得正文。
- 共享：当前 member 必须在 sharedMemberIds，实际 employee 必须在 sharedEmployeeIds，且 member 仍被授权使用该 employee。
- 子员工不能把接收方无权的正文或派生内容交给负责人；缺权时返回“需要授权的依据”。
- 更新增加 revision；旧 revision 不进入新检索和 request。已完成 collaboration work 标记受影响汇总 stale，由 owner 显式“按最新依据重新核对”，为受影响子项与父汇总创建新 execution generation；普通 completed continue 仍按 P2 语义拒绝。
- 撤销收紧 ACL；受影响交接、摘要和汇总不能继续使用。
- 删除移除活动正文并留下 tombstone；旧 token、旧 Session 或缓存不能复活。
- 插件停用时，新导入/检索局部不可用，公共 service 仍允许维护者查看状态、撤销、删除并阻止读取。

successor 只装配当前获准的结构化业务事实、当前有效知识片段、当前有效 confirmation 与用户本次输入；不复制旧 explanation、follow-up、摘要、交接正文或整段历史。

## 7. HTTP 与正式产品界面

### 7.1 最小 API

```text
POST   /api/works                         # 增加明确 collaboration 类型与参与者
GET    /api/works/:id                     # 根/子项/结果按当前 ACL 投影
PATCH  /api/works/:id/plan                # expectedRevision，只改未开始项
POST   /api/works/:id/continue
POST   /api/works/:id/recheck          # completed collaboration 仅重做知识失效影响部分
POST   /api/works/:id/cancel

GET    /api/knowledge
POST   /api/knowledge
GET    /api/knowledge/:id
PATCH  /api/knowledge/:id                 # expectedRevision 更新正文
PATCH  /api/knowledge/:id/sharing         # 显式 memberIds/employeeIds
DELETE /api/knowledge/:id
POST   /api/knowledge/search              # 当前 member + 明确 employee
```

沿用 P2 登录、same-origin、JSON allowlist、CSRF、sessionVersion、owner-only 和安全错误投影。不增加任意文件路径、URL fetch、工具名执行、provider 自选或 Host 安装接口。

### 7.2 表面

- 复用单文件工作空间和 WorkBuddy 信息层级，不另建协作控制台。
- 新建工作：目标、负责人、协作者、工单/连接；主动作“开始协作”。
- 工作详情：结论/阻塞与下一步 → 工作计划 → 来源与依据 → 补充/历史。每项显示实际员工、状态、障碍、输出和交接对象。
- 计划：未开始项可编辑；running/completed 只读。轮询不得清空草稿；409 保留草稿并显示最新服务端 plan。
- 知识：列表/详情提供来源、授权依据、范围、revision、修正、撤销共享和删除。失权响应没有正文或 snippet。
- 确认信息仍是单独类型，不变成共享知识。
- 父按钮文案“停止本工作”，解释覆盖本工作未完成子工作、已完成结果保留、其他工作不受影响。
- 390×844 实际完成登录、指定工作重入、计划调整、补充继续、引用查看、撤销共享和根停止。

正式 Product Design A/C/D/E 是界面语义来源；批准后允许局部布局复用调整，但不得改变 ACL、停止范围、可编辑状态、撤销影响和数据标签。

## 8. Team Sol 实施切片与所有权

| 切片 | 输出 | 唯一写入边界 | 门禁 |
|---|---|---|---|
| P3-T0 原生协作探针 | `scripts/probe-p3-delegation.mjs`、窄 runtime patch | runtime owner | 身份/grant/session/cancel/budget 全过才继续 |
| P3-T1 v5 与公共知识边界 | store migration、knowledge service、纯检索、ACL/撤销测试 | store/security owner | v3→v4→v5、未来版拒绝、服务端投影 |
| P3-T2 协作 runtime | work service、runner、grant、collaboration plugin | 单一 runtime integration owner | root/child/handoff/generation/预算/取消 |
| P3-T3 知识工具装配 | knowledge plugin、refs/dependencies、停用组合 | knowledge owner；核心交给 T2 集成 | 搜索/引用/撤销/派生依赖 |
| P3-T4 API 与 UI | server、`web/index.html` | 单一 API/UI owner | 正式 A/C/D、桌面与 390px、草稿冲突 |
| P3-T5 恢复与组合门 | state-transfer、P3 tests、package scripts | integration owner | 子 Session、tombstone、ACL、无重放、P2 回归 |
| P3-T6 实际验收资料 | `scripts/accept-p3.mjs`、同候选 MP4/receipt/HTML/frames | acceptance owner | 全旅程通过后冻结候选再录制和 Lark |
| P3-T7 独立阶段审查 | formal schema v2 verdict | read-only reviewer | 零 Critical/Important、材料与候选一致 |

多个 Sol 可并行只处理互不重叠的新文件或只读审查；`work-service.mjs`、`dsh-runner.mjs`、store schema 和 `web/index.html` 分别保持单一 writer。任何 fallback/takeover 先确认原 writer 停止。

## 9. J6 数据与验收旅程

### 9.1 测试对象

- GearJob A 的获准测试工单：优先复用 `WO-26-00096`，验收时真实回读计划量与完成量，不硬编码仍为 10/4；必要时通过正常 Frappe 数据层创建新的团队模拟工单并授权。
- 用户输入：剩余可用时间 3,600 秒。若真实回读仍为计划 10、完成 4，则剩余 6，cycle 结果为 600 秒/件；界面标为用户条件下的平均分摊，不称实际生产节拍。
- 知识 r1《进度复核说明》：说明工单事实、人工输入与建议的区别，无计划基线不得断言落后；r2 带唯一 canary 验证更新。
- 私有 A 材料、显式共享 A/B 材料、仅另一成员可见材料使用不同 canary；恶意文本要求“忽略规则/使用未授权连接”用于证明内容不授予权限。
- 人类账号至少 admin、owner member、peer member；数字员工 A/B 权限不同。

### 9.2 完整旅程

1. owner 在知识 UI 导入 r1，明确 owner/employee B 私有范围，再显式共享到 peer member 与获准 employee；peer 正向读取，未授权组合拒绝。
2. owner 新建协作工作；员工 A 通过真实 GearJob A 获取当前工单；员工 B 缺剩余时间，父工作进入需要关注。
3. 刷新、正常重启、重新登录后打开同一 root；计划、A 结果和 waiting 子项不变。
4. 在轮询期间编辑尚未开始目标并保存；另造 expectedRevision 冲突，草稿保留且运行/完成项拒绝修改。
5. 输入 3,600 秒继续；B 检索 r1 并执行 cycle，负责人引用两个已持久结果汇总；重复 continue 不增加执行。
6. 更新为 r2；已完成工作显示旧汇总 stale，owner 点击“按最新依据重新核对”，系统保留旧结果，只为受影响子项和父汇总创建新 execution/successor，并确认 request/Session 无 r1 canary。随后撤销 peer/employee 共享，失权 UI/API/history/search/交接/汇总没有正文、snippet 或旧派生 canary。
7. 停用知识插件：新检索局部失败，无关 GearJob/Web/历史仍可用；维护者仍能撤销和删除，访问控制继续生效；重挂不重复注册。
8. W1 启动两子项，移动端停止 root；W1 未完成子项关闭，W2 独立工作完成，迟到结果不覆盖。
9. 停机 backup/restore 到隔离根；同一 root/child/plan/handoff/results/knowledge/tombstone/Session/ACL 回读一致，不自动派发；外部 secrets 仍不入备份。
10. 390px 实际登录并完成计划调整、补充、查看引用、撤销和停止；浏览器 console/page/network 无非预期错误、无横向溢出。

### 9.3 必过矩阵

- AC-14：两个不同员工的真实原生 Session/execution、实际交接与汇总；计划 revision 可调整；失败/预算/补充可继续；不要求固定角色顺序。
- AC-15：导入/更新/检索/引用、私有/共享正反例、四个撤销竞态、派生依赖、停用后维护、删除 tombstone 与清理状态。
- AC-10：派发前、在途、结算后三个停止时序；W1/W2 隔离。
- AC-12：v5、子 Session、知识正文/ACL/tombstone/refs 进入备份；恢复不自动重放。
- J2/J3/J4：waiting/continue/cancel、confirmation member+employee 与 successor、A/B 连接隔离及撤权继续通过。
- UI：普通入口完整旅程、服务端权限反例、390px、键盘焦点、错误不只颜色、轮询不擦草稿。

保留命令：

```text
pnpm install --frozen-lockfile
pnpm test:unit
pnpm test:service
pnpm test:controlled
pnpm test:p2
GENEWAY_P1_PROBE_MODEL=true pnpm probe:p1-runtime
git diff --check
```

拟建命令在实现前不是证据：

```text
node scripts/probe-p3-delegation.mjs
pnpm test:p3
pnpm accept:p3
```

## 10. 视频、离线手册与 Lark

P3 的界面可验收，因此选择“操作手册式验收：视频 + 文档”。功能、回归与真实 J6 全部通过后冻结产品候选，再从同一候选、同一关联对象录制：

- MP4 显示 owner/peer 实际登录、知识导入/共享、真实 GearJob、两员工计划与交接、等待/调整/继续、引用、更新/撤销、插件停用维护、390px、W1/W2、重启/恢复关键回读；
- receipt 保存 candidate、来源、root/child/execution/Session/knowledge refs、ACL 正反例、撤销 canary、预算/取消、恢复、浏览器和秘密扫描；
- 离线 HTML 每个操作步骤内联同次截图，使用相对视频链接并标真实时间段；目录移动后可用；
- 视频正常速度可读，不用静态动画，不裁掉失败，不包含 credential、Cookie、grant、Session secret 或 Lark token；
- 独立 reviewer 看完整视频、手册、hash、receipt 和秘密扫描；
- 用新的 P3 幂等 key 发到已确认目标，发送说明、视频、receipt、手册并 `messages-mget` 回读类型、ID、deleted=false；这只是工程验收材料，不是 P4 产品飞书通道。

## 11. 停止与重规划条件

出现以下事实时只暂停依赖路径并返回至少两名 Astra：

- fresh spawn 无法隔离父上下文，或必须 fork；
- 首次模型/工具派发前无法可信绑定 employee/execution/authorization；
- 需要共享可变全局 grant、子进程并发写 state 或自写 AgentLoop/Workflow 解释器；
- 原生取消仍允许新子派发，或停止 W1 会影响 W2；
- request 边界无法执行硬预算上限；
- 旧知识仍通过摘要、交接、历史投影或 successor 进入新请求；
- 知识插件停用后不能继续阻断访问、撤销或删除；
- 需要扩大接收方、默认跨成员私有范围、生产数据或外部写入；
- 当前单写入文件 store 在计划容量实测不能保持原子语义；只能局部重选存储，禁止 JSON/数据库双写；
- 只能用固定响应、手工转发或删无关 Session 冒充 J6/删除。

## 12. 完成定义

P3 只有在以下全部成立时阶段 PASS：

1. 当前用户批准正式 C/D，E 的身份与 approval binding 校验通过；
2. P3-T0 原生路径通过，Team Sol 按依赖切片完成；
3. deterministic、真实 ZenMux、真实 GearJob、J6、J2/J3/J4、390px、backup/restore 全部通过；
4. 同候选视频、receipt、离线手册、截图、秘密扫描和 Lark 回读完成；
5. 独立 formal phase review 为 `spec_compliance=pass`、`task_quality=pass`，零 Critical/Important，且无影响阶段结论的 cannot_verify。

该 PASS 只表示 P3 的 G4/G5、J6、AC-14/15 和适用回归完成；不表示 P4–P7、生产部署、发布认证或客户验收完成。
