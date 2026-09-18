# Geneway 全新重建：本轮澄清记录

日期：2026-09-18。范围正文见 [实施合同](implementation-contract.md)。本文件仅记录来源、工程取舍与检查事实，不新增实施义务，不构成执行或发布批准。

## 1. 当前请求与既定决定

当前请求为：读取 `clarify` skill，结合 subagent 完成实施合同澄清，并写入 `geneway` 项目。

用户此前明确要求“完全重构，不要历史包袱”，并已将第一性原理审查落实为 v3 方案。主代理完整读取本轮附件 `geneway_dsh_greenfield_plan_v3_2026-09-18.md`；原文件 SHA-256：`7181474e32295cab8a36a61131db94fc382f4dfe859bca87a8d4f77795e3bb23`。

合同承接真实工作、持续负责、实例与插件独立性三个目标。本轮不重开“是否全新重建”的选择，不恢复旧兼容、迁移或 Gate 流程。

## 2. 技能实际读取情况

主代理成功读取的 Clarify 来源：

`/home/gewu/work/atlas-forge/plugins/atlas-workflow/skills/clarify/SKILL.md`

源码 checkout：`65db2c19791efba96982a0ff6dc9339b754bf209`；该 skill 文件 SHA-256：`6153f2e3cfff4835a081d9867bca47341aba22851162662ae28a399bd65c1383`。

安装位置 `/home/gewu/.codex/plugins/atlas-workflow/skills/clarify/SKILL.md` 的直接读取被 DevSpace 拒绝：`Path is outside allowed roots`。随后通过合法打开的 Atlas Forge workspace 读取源码副本，没有修改访问控制、安装态或配置，也不声称源码副本与当前安装副本完全一致。

同时完整读取：Clarify 的 collaboration、contract-authoring，decision-supersession，Business Acceptance，Product Design method-adapter，以及轻量 clarify 模板；读取 Team 中与本轮派发相关的规划、只读协作和模型路由条款。

DevSpace subagents skill 成功读取自：

`/home/linuxbrew/.linuxbrew/lib/node_modules/@waishnav/devspace/skills/subagents/SKILL.md`

## 3. 本轮采用的流程

使用 Clarify 的单一轻量范围交接路径，正文包含 Locked Boundaries、Accepted Assumptions、Acceptance Criteria、Verification Plan、Durable Handoff Summary，并补足本次业务所需的对象归属和完整旅程。

未选择 Atlas semantics-v5/v6 机器合同、正式设计 E 交接、Team Execute 或发布认证；不建立 A/C/D/E、authority、admission 或多层收据文件。没有相应绑定也不声称 machine-ready。子代理协作本身不推导出这些材料的必要性。

已检查 workflow 的现有任务清单，未将旧 Geneway Gate/DSH 试验任务当作本轮全新范围。本次使用仓库合同作为唯一范围载体，不修改外部任务状态，也不虚构新的 workflow task ID。

模型策略只读检查在 Atlas Forge 源码 workspace 执行：

`workflow/bin/atlas-agent-model-policy check`

结果：`atlas-agent-model-policy: ok family=6.0 mode=planning-review roles=5`。它仅验证本地策略投影，不证明模型服务商计费身份或新产品集成。

## 4. 子代理参与与限制

通过已发现的 `codex` provider 使用 DevSpace CLI 派发；两条通道都显式请求 `gpt-6-astra`、`high`。DevSpace 使用自包含 brief，不接收父会话完整历史。本轮不是 Atlas 原生 `spawn_agent` 的 exact-profile 准入，未声称绑定 `atlas-sdd-phase-reviewer` 或产生正式 `REVIEW_VERDICT_JSON`。

| 子代理 | 只读视角 | 实际参与 |
|---|---|---|
| `agt_19be2c53` | 当前交付、普通入口与验收可达性 | 独立提出方案；收到另一视角的实质意见后，对收敛条款给出复核与必要补句；CLI 返回 completed。 |
| `agt_f469c9aa` | 插件复用、实例映射与维护边界 | 独立提出方案；对上下文撤销、结果引用、派发重试及状态归属复核；CLI 返回 completed。 |

两名子代理都尝试读取技能源码，但自身执行器在 sandbox 初始化时返回：

`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

因此它们的建议依据主代理提供的自包含共同目标与 v3 条款摘录，不包含独立本地文件或安装产物核验。主代理已经通过 DevSpace 实际读取 v3 与技能源。没有绕过 sandbox、修改运行权限，或把子代理意见写成独立源码验证。

子代理没有文件写权限或实现授权；本轮文件由主代理统一写入。两者的意见是工程讨论，不是用户批准、正式契约准入或新系统测试结果。

## 5. 取舍与落实

| 讨论点 | 主代理采用的决定 | 合同位置 |
|---|---|---|
| 任务结束与原生 idle | 业务结果满足任务条件、持久引用可读才呈现完成；运行状态取 DSH 投影，不复制调度器。 | §4.2、AC-02/10 |
| 普通入口的可达性 | 继续、信息管理、取消与连接禁用通过产品 UI 完成；现阶段 URL/命令列为实施依赖。 | §7、§11 |
| 插件代码与实例 | Session 不跨员工；多连接独立绑定；更换目标业务实例新建连接身份，不静默串库。 | §4、§5、AC-05/06 |
| 撤销后的实际重试 | 每次实际派发含适配器/DSH 内部重试检查当前授权，无法检查的路径关闭，不新增重试平台。 | §5、AC-06 |
| 删除信息与旧 Session | 检查实际上下文及原生继承；不能排除时新 Session 承接同一工作，历史显示保留，不承诺全历史清除。 | §6.2、AC-04 |
| 原生存储与嵌入式存储 | 用稳定记录、删除、寿命与备份能力作小范围选择；原生不满足才用一个本地后备，不双写。 | §8、DEP-STORE |
| 结果引用与恢复 | 不复制完整结果正文；恢复必须能够解析关联。已完成但历史丢失显示恢复不完整，不改写当时事实。 | §6.3、AC-12 |
| 第二能力 | 固定为按时长/目标件数换算所需平均节拍，输入要求有限正值、单位明确，不当成测得周期。零或负值给出输入错误，不另加能力范围。 | §3.3、AC-08 |
| 源数据不可用 | 不静默替换真实任务或恢复旧协议；只阻塞相关真实交付，独立受控工作可继续。 | §3.2、DEP-SOURCE |

未采纳额外业务结果镜像、完整持久化执行状态枚举、全量记忆清除、事务性热更新或新增独立网关。产品语义和必要可靠行为均局部实现。

## 6. 范围保护与验证

开始写文档前，Geneway HEAD 为 `7e9da8392a9e25cbdb1d0cac73a8ac5b9c0cefa2`；本轮文档目录尚不存在。

对除本次文档目录外、Git 跟踪及未忽略的文件作只读内容摘要：468 个文件，SHA-256 为 `5b4ac7c96e9ba4552ea366ebde7a79f33c9a97af14eb48ccc6dd326dd818ed28`。此摘要用于检查本次写入范围，不是新系统的执行身份或长期准入条件；不覆盖被 Git 忽略的文件与外部运行状态。

实际文档终检：

- `git diff --check` 无输出。
- 对两个新文件分别运行 `git diff --no-index --check /dev/null <file>`，均无空白错误。
- 只读文本检查通过：2 个文件、3 个目标、5 条完整旅程、12 条唯一验收编号；编号引用和相对文档链接有效，无模板占位符、尾随空格或乱码替换字符。
- 写入后再次计算范围外的 468 个非忽略文件，摘要与写入前完全一致；原有内容未变化。
- 实施合同内容 SHA-256：`1d0caf35f2418e435f04e2100257d3ea81f9be0c509efe5505b24e339a78f584`。它仅标识本次交付文本，不是运行授权。

当前没有运行新 Geneway、安装 DSH、调用产品模型/业务接口、执行业务端到端或生产检查；本轮只进行已授权的子代理推理和文档澄清。未创建新工程、修改业务代码、提交、推送或部署。
