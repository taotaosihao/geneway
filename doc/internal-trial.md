# Geneway 本机模拟内用手册

本页用于开发工作区内的有限模拟试用与问题判断，不是客户部署、正式发布或现场验收。正常旅程使用固定资料、合成照片和模拟模型 Provider；五个角色运行真实本机 native DSH，文件、认证、TLS、消息摄入、Job 与下载走实际实现。当前各片实施范围见[实施状态索引](implementation/multisite-status-2026-11-05.md)，安装、备份与维护见[运维手册](operations.md)。

## 操作者：一次正常旅程

在 `/home/gewu/work/geneway` 执行。当前入口明确要求 **Linux x64、Node.js 26.5.0**；使用仓库现有 `node_modules`（DSH `0.2.0-rc.2`、A2A SDK `1.3.0`）及已安装的 Chromium。`PATH` 中需有 `zstd`、`openssl`，TLS helper 还直接调用 `/usr/bin/certutil`。操作者需能读取本机 `/proc`、控制本次自有 worker，并能写入 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`。脚本会暂挂及恢复本次自有生成 worker，不应在另一个相同验收 producer 仍运行时重开一轮。

```bash
cd /home/gewu/work/geneway
GENEWAY_PLAYWRIGHT_MODULE=/home/gewu/work/kivo/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs \
  node scripts/probe-a2a-collaboration.mjs
```

上述 Playwright 路径是本机实测路径，其他工作区通过 `GENEWAY_PLAYWRIGHT_MODULE` 指向其可用的 `index.mjs`；它不是通用安装位置。本页不执行依赖安装。**正常入口不带 CLI 参数**，无需另起 API、Host、Provider 或浏览器，无需准备业务密钥、修改现有数据库或关闭 TLS 校验。

[正常入口](../scripts/probe-a2a-collaboration.mjs)会自动创建私有证据根、API、五个 native 角色、独立官方 SDK peer 和私有 CA/TLS 信任。手机尺寸浏览器实际选择并上传合成照片、查看与下载；标准 Task 的创建、追问答复和忙时修订由独立 peer 完成，不能称为全程手机 DOM 操作。随后实际读取 A/G 来源、执行分析、生成整改表、由协调者核对候选并下载。本轮 SHA 必须来自本轮源、云文件与下载字节，不能照抄历史 SHA。

退出后按 stdout 的 `directory` 查看本次证据，不能只看页面或某个文件存在：

- 进程实际 exit **0**，`result.json` 为 `passed`。
- 自动调用的[独立四表 oracle](../scripts/verify-spreadsheet-collaboration-result.mjs)输出 `independent-oracle.json` 为 `passed`；保留其原始 stdout、下载 XLSX、原来源、实际模型 body 与 Session 原件。它独立重开“整改明细、现场快照、分析结论、来源依据”，核逐格值、版本、引用及同版字节，不代替桌面 Excel 重算。
- `close.json` 中 `cleanupErrors` 为空、`sourceChanged:false`，所有 `closedPorts` 为已关闭；`native-processes.json` 中没有仍存活的本次原 PID 身份。记录操作者进程的真实退出码，不能把运行中当完成。
- 任一步失败，保留原 `failure.json`、截图、stdout、来源与清理记录；先定位最近失败步骤，不改旧结果、不盲重发或把失败根当新试用根。

## 本轮复现证据

独立模拟操作者按上段完成 `a2a-collaboration-native-Z730RW`（执行 `8883`）：实际 exit 0，`result.json` 与 `independent-oracle.json` 均为 `passed`。五个原生 Session 的原 Input 按实际投递各消费一次，当前 Work 为 rev3；下载件为 13,440 字节，SHA256 为 `40d59210b630705ae407e0a7f5f0fc06ddf2d58d4c35c447b423daf550429d1f`，与本轮云文件一致。四个端口均关闭，`cleanupErrors:[]`，`sourceChanged:false`。原 SDK 警告仍见本轮结果。本次操作者使用的原手册副本保存在 `final-m2-candidate-80djrw76/internal-trial-operator-copy.md`。

## Agent 角色与实际说明来源

| 本旅程角色 | 主要职责与可追溯工具范围 |
| --- | --- |
| C／coordinator | 分工、定向追问和等待子结果；以候选读取与核对工具确认当前版内容。 |
| B／desktop-office | 采用获准来源，启动并查询真实表格 Job；提交结构化候选，不能以口头 ready 代替文件核验。 |
| A／desktop-data | 捕获获准历史资料，读取及显式共享封存 Evidence。 |
| G／gateway | 读取获准现场模拟快照；未知时钟、连接与健康保持 unknown。 |
| analysis | 读取获准证据并提交符合 resultSchema 的分析与局限；不能把陈述当实际操作成果。 |

实际角色说明来自 [commands 的 executionContext](../packages/agent-orchestration/commands.mjs)、[runtime-worker 的 contentFor](../packages/agent-host/runtime-worker.mjs) 和 [DSH system prompt／注册工具](../packages/agent-host/dsh-runtime.mjs)：包含当前 goal、grant、`resultSchema`、`policyRevision`、用户 Input 与证据引用，具体工具仍受当前服务端权限约束。原 command、Session 与本次 `source-start.json` 可追溯其版本。资料不足通过原 waiting/question 通道追问，不自填期限；委派回执、消息 ACK、实际 Session 摄入、业务结果与 ready Artifact 分别核对。

[受管模拟规则工具](../packages/agent-host/site-rule-tool.mjs)另外只映射固定窗 `geneway_inspect_site` → `geneway_read_shared_evidence` → `geneway_submit_site_diagnosis`，服务端核验后形成内部草稿；采纳／丢弃只记录内部意见，不通知外部或改设备。当前配置的 `agent-instructions` 已禁用，**Agent 不会自动读取本 Markdown 作为角色规范**。

当前运行时注入[版本化角色说明](../packages/agent-host/operations-guide.mjs) `geneway.agent-operations/1`。同轮 `final-m2-candidate-80djrw76/root-normal-readback.json` 的 45 份实际模型请求均有对应 system 说明：协调者 18、受委派角色 27。沿用原工具与服务端权限，说明本身不增加授权。模拟规则专员的版本接入仅做了组件验证。

## 运维：模型中断或 unknown，只读定位

可用已接纳的 `bridge-recovery-Xyr1wd` 原件学习判断：位于上述证据父目录，入口与边界见[实施状态中的 Bridge 恢复记录](implementation/multisite-status-2026-11-05.md)。它证明第三次实际 forward 中断后重启未重发。本轮独立只读判断确认原停止回执已收敛，原推理账仍是 unknown；没有重跑该故障。只读查看该根 `before-api-shutdown.json`、`api/state.json`、`provider-bodies.json`、各 Host Journal／Session 与 `result.json`，不要为演示再启动故障脚本。

1. 从 Work 找当前 instruction revision、Delegation 与 Attempt，再按 `work_id / delegation_id / parent_delegation_id / attempt_id / execution_epoch / agent_id / node_id / launch_id / session_id` 对齐原命令、回执和 Session。旧 revision／旧 Attempt 的历史不能当本次完成。
2. 对齐模型账的请求 ID、body digest、outcome 与 `completedAt`，再查实际 Provider 记录和 Session 的原 user／tool／turn-end。`unknown` 既不证明未发送，也不证明已完成；普通真实在途与断流孤儿须结合原归属和结束证据判断，不能靠补 usage=0、改账或刷新页面消除。
3. 核原 stop／settle 的精确 binding、event ID／digest、云 receipt、Host acknowledged、真实 idle/flush 或退出证据与槽位释放。停止请求受理或 transport ACK 不等于已停稳；未确认的副作用仍保留 unknown。手停、撤权、预算和截止约束都不能借恢复绕过。
4. 不直接改 state／Journal，不复制新请求 ID 重发、不恢复未知模型推理。缺原结束／停止回执时，记录“待核对哪条原回执”，交给有权操作者沿原控制入口处理；没有新的明确授权不新建替代工作。只共享经授权裁剪的定位信息，不贴凭据或完整私有证据。

## 支持矩阵

| 层面 | 当前事实与边界 |
| --- | --- |
| 正常协作与标准 A2A | 本机五 native 角色、独立官方 peer、同源校验证书 TLS、真实手机上传／下载；当前候选仍以本次完整退出、oracle、源一致和清理记录判定。 |
| 表格与 Office | 源码路径实际 XLSX Job／独立四表核验；不代表现场 Office GUI／桌面 Excel 重算。G 包 `officeEnabled:false` 不能当作所有包都支持 Office。 |
| Host 持久与归档 | 仅复用已接纳的限定故障与格式证据。archive-aware Host 可读 v3/v4；旧 Host／updater 对 v4 应明确拒绝，不能删冷段、降版本或宣称任意回退。 |
| 监督与模拟规则 | T23 建议供人工核对，T24 规则草稿为明确本机模拟；不能推成模型判断准确率、现场告警识别或自动设备处置。规则页保留通用 T23 提示为已登记 P2 界面边界。 |
| 环境与真实供应商 | 当前组合为 Linux x64／Node 26.5.0；未证明跨 OS、多真实机器、现场网络、真实视觉模型或实际供应商计费。模拟费率不是报价或账单。 |
| R16／H14 | `r16-h14-final-approval.json` 有限接纳原 14 池，不覆盖整个 Store。`cloud-capacity-OMZHUz` 有实际 worker 停止与精确 ACK；`cloud-job-history-7S3FnI` 恢复两份原封存包，沿用原已登记 Job。前置量为合成，未验证多日吞吐或现场运行。 |
| T25 | 同一逻辑上下文 `f49d3f3e2f802abc`，A/B/C 每轮 Router 请求分别为 9/5/3，Worker 各 12；90 项中 1 项旧 revision 的 Q 被拒且未交付。`t25-final-80djrw76-summary.json` 为 `comparison:null`，摘要实际 exit 1，不得据此宣称效率收益。费用和缓存的未确认项保留 unknown，费率及负载为模拟。 |
| M3／M4 | 桌面 GUI 自动化、DS-Bot、签名、多租户、第二协议产品化及媒体能力不在本次有限内用支持范围。 |

本轮记录的是独立模拟操作者的正常复现和对既有 unknown 案例的只读判断。手机上传与下载是真实浏览器操作，协议步骤由 peer 完成；没有外部现场、部署、发布或真实账单验收。
