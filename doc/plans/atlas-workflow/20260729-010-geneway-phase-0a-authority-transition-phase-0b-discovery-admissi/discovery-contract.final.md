# geneway Phase 0B 只读 Discovery Contract

task_id: `20260729-010-geneway-phase-0a-authority-transition-phase-0b-discovery-admissi`
version: `1.0.0`
status: `DISCOVERY_L1_ONLY / NO_PRODUCT_IMPLEMENTATION`
created: `2026-07-29`

## 1. Authority 与目的

用户在批准 `20260729-009-geneway` 的 Connector/Capability-first 规划和 Team Review 后回复“继续”。本合同只承接该规划明确给出的下一步：

1. Phase 0A 将旧 Gate A 设置为 `SUSPENDED_NO_IMPLICIT_RESUME`；
2. Phase 0B 先做可撤销、只读、非生产的 discovery；
3. 未经新的 implementation contract/admission，不进入 Connector、Capability、Skill、MCP 或产品代码实施。

当前 authority 的唯一入口是本任务 workflow artifact 中的 `current-authority.json`。该 pointer 未存在、未激活或任一 digest 不匹配时，所有 discovery 与 product route 均为 `NOT_OPEN`。

## 2. Goal refs

| Goal ref | 目标 | L1 完成信号 |
| --- | --- | --- |
| `DISC-AUTHORITY` | 旧 Gate A 不再有隐式恢复路径 | canonical transition、admission、pointer 与 `AGENTS.md` 指向一致 |
| `DISC-PERSONA` | 收敛一个目标岗位、一个决策和人工基线 | discovery preflight 给出候选、待用户/SME确认项和不可假定项 |
| `DISC-HIVE` | 从本地 Hive 源码/文档识别设备状态与报警能力 | 形成 source-grounded operation feasibility，不读取 secret、不调用远端 |
| `DISC-GEARJOB` | 盘点现有单工单能力可复用事实 | 只读检查现有合同/源码/测试，不启动 GearJob、不修改任何文件 |
| `DISC-WORKBUDDY` | 把真实 MCP smoke 的前置条件变成可执行清单 | 明确测试 tenant、认证、网络、撤销、数据等级和 owner 缺口；L1 不登录或配置外部 tenant |
| `DISC-D0` | 明确进入 5-case L2 所需的最小授权 | 给出 `READY_FOR_L2` 或具体 blocker；不能在 L1 伪造 BRIEF_GO/RISK_GO |

## 3. Discovery 分级

### 3.1 L1：本合同当前允许的范围

- 只读检查 `/home/gewu/work/geneway`、`/home/gewu/work/gearjob`、`/home/gewu/work/hive` 的源码、测试、schema、公开文档与 Git 元数据；
- 只读检查既有 workflow artifacts、contracts、receipts 与暂停 checkpoint；
- 使用 `rg`、`sed`、`jq`、`git status/log/show/diff` 等非变更命令；
- 查询公开官方文档，但不登录、不创建 connector、不修改外部 tenant；
- 在本任务 workflow artifact 下编写 discovery 记录；
- 在本合同目录和 `AGENTS.md` 内修正本 authority 本身，按 path-precise commit 提交；
- 只使用合成、脱敏或已经明确获准的 fixture；禁止把 secret 或未批准业务数据写入 artifact、prompt、日志或 Git。

### 3.2 L2：当前未激活

以下动作只有新的 L2 overlay admission 绑定具名 owner、tenant、endpoint、数据等级、resource selector、credential handle/version、TTL、撤销路径和 exact allowed action 后才允许：

- 读取或调用真实 GearJob/Hive 非生产 API；
- 启动、重启或配置 GearJob/Hive/geneway 服务；
- 创建、安装、更新或删除 WorkBuddy MCP connector；
- 登录或操作 WorkBuddy tenant；
- 使用真实历史/现场 5-case 数据；
- 签发、刷新或读取任何 API key、token、password、cookie、OAuth grant 或其他 credential；
- 进行真实网络 smoke、egress、tenant mapping 或 connector binding。

L1 产物不能自行激活 L2。

## 4. 明确禁止

- 修改 geneway 产品代码、schema、migration、测试、runtime、gateway、UI 或业务配置；
- 修改 GearJob 或 Hive 的任何文件、服务、数据库、配置、设备、integration 或 tenant；
- 运行可能产生业务/数据库/容器/远端状态变更的测试或命令；
- 读取生产/客户凭据、数据、环境、route 或未批准的本机 credential store；
- push、PR、部署、发布、tag、外部消息、客户操作或任何生产写；
- 恢复旧 Gate A implementation、修复其五个 controller finding、生成新 promotion/aggregate 或把 checkpoint 宣称为 closure；
- 建设 Connector/Capability registry、Workflow、Skill、MCP endpoint 或第二 Runtime；
- 以源码存在、public docs 或 synthetic fixture 代替真实 owner/tenant/data/API 证明。

## 5. L1 输出

L1 只允许形成一个 canonical `discovery-preflight.md`，至少包含：

1. 目标岗位/决策/人工基线候选及需用户确认项；
2. GearJob `production.work_order.get.v1` 可复用输入/输出/错误/来源语义；
3. Hive `machine_status`、`alarm_history` 的真实本地 source evidence、缺失语义和不可假定项；
4. WorkBuddy L2 smoke 的具名 owner/tenant/auth/network/revocation/data prerequisites；
5. 5-case 数据选择、脱敏、标签/SME rubric 与 ground truth 所需 owner；
6. legacy disposition 和 historical receipt dependency-impact 的 L1 测量结果；
7. `READY_FOR_L2` 或 blockers。L1 不得给出 `BRIEF_GO`、`RISK_GO` 或 `BUSINESS_GO`。

## 6. 验收与验证

| ID | Acceptance | Verification |
| --- | --- | --- |
| `D-AC-01` | 唯一 current authority pointer 绑定 transition、admission、contract、`AGENTS.md` 与 repo commit | raw SHA-256、commit、regular non-symlink file 检查 |
| `D-AC-02` | 旧 Gate A 是 `SUSPENDED_NO_IMPLICIT_RESUME` 且不能授权 executable action | pointer precedence、旧 admission rejection、AGENTS current authority 检查 |
| `D-AC-03` | L1 只做本地/公开只读检查 | command log 审查；无 service/API/login/credential/external mutation |
| `D-AC-04` | GearJob/Hive 结论有源码路径与字段/语义证据 | `discovery-preflight.md` 的 source references；不写 secret/value dump |
| `D-AC-05` | WorkBuddy 与 5-case 的未知项不被伪装为完成 | L2 prerequisites 完整；状态只能 `READY_FOR_L2|BLOCKED_FOR_L2` |
| `D-AC-06` | 没有产品代码或跨仓修改 | 三仓 Git status/diff 检查；仅 geneway authority docs 可有当前任务 commit |

## 7. 停止与返回条件

任一 authority path/digest/commit/source 漂移、需要读取 credential/真实业务数据、需要启动服务/调用 API/配置 WorkBuddy、发现仓库存在未知用户改动、或需要修改产品代码时立即停止对应动作。

L1 完成后返回用户：已确认的本地事实、仍需具名 owner/tenant/data 的 L2 决策包，以及是否建议继续 5-case preflight。未经新的明确授权，不得从 L1 自动进入 L2 或 Phase 1 实施。
