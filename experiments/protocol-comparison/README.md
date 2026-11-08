# ANP / A2A 隔离比较实验

本目录实现 T03a 实验入口，不是 T03b 生产协议接入。生产 Bridge、根依赖和已有 M1b 状态均保持原样。当前已按相同正常业务验证两候选的应用命令路径，并补齐独立有权 peer 首次创建业务 Task、同 Task 输入、主动查询与原文件取件。没有选出协议。下文新增的 X05 结果答复丢失和 X07 业务入口进程恢复仅按各自实测范围成立，完整规范、其他恢复组合与成本项保持未测。

## 已固定的环境

- 实际 Node `26.5.0`，Linux x86_64；三路相同解释器。
- `@a2a-js/sdk` **1.3.0**，wire **1.0**，规范源 **1.0.1**。
- `@awiki/anp-typescript-sdk` **0.9.5**，规范集 **1.2**，群 Profile `anp.group.base.v2`。
- 独立 AWiki peer 固定提交 `09d38fd8afc803c16ab61cd629c0c8ea3747edc6`，实际 Python **3.11.15**，原 `uv.lock` 的 `anp==1.0.6`。TS 包与源码分别固定，包 registry 不提供 `gitHead`。
- NPM `package-lock.json` 属于本目录，安装只落本目录 `node_modules`。固定源码、下载包、私钥、数据库、原始 wire 和运行结果落外 Git 的独立实验根。

`preflight.mjs` 校验两个包的实际 SHA256、registry SRI、已装版本和本目录 lock，下载四份固定官方源码并记录许可证；AWiki 的独立 checkout、原 lock 和实际解释器由 `peers/anp` 另记。安装目录是两 SDK 的共同实验环境，不能把组合依赖体积当作每个生产方案的最小包体积。

## 重现入口

在仓库根目录执行；需要当前已装的原 DSH/ExcelJS、Playwright、`zstd`、OpenSSL。没有全局安装、托管账号注册或系统服务操作。

```sh
npm install --prefix experiments/protocol-comparison --workspaces=false --ignore-scripts --no-audit --no-fund
node experiments/protocol-comparison/preflight.mjs /ABSOLUTE/EXPERIMENT-SOURCES
node experiments/protocol-comparison/preflight-bidirectional.mjs
node experiments/protocol-comparison/preflight-anp.mjs
node experiments/protocol-comparison/normal-flow.mjs baseline /ABSOLUTE/UNIQUE-BASELINE-ROOT
node experiments/protocol-comparison/normal-flow.mjs a2a /ABSOLUTE/UNIQUE-A2A-ROOT
node experiments/protocol-comparison/normal-flow.mjs anp /ABSOLUTE/UNIQUE-ANP-ROOT
node experiments/protocol-comparison/business-flow.mjs a2a /ABSOLUTE/UNIQUE-A2A-BUSINESS-ROOT
node experiments/protocol-comparison/business-flow.mjs anp /ABSOLUTE/UNIQUE-ANP-BUSINESS-ROOT
```

ANP peer 需先按 [peer 入口](peers/anp/run.mjs) 指定的 checkout 路径检出固定 AWiki 提交，并用其原 `uv.lock` 在 checkout `.venv` 内 `uv sync --frozen --python /home/gewu/.local/bin/python3.11 --group dev`。不得改 lock、全局关闭 TLS 或使用真实账号。该实际测试环境含 dev 依赖；生产最小依赖打包没有在此完成资格认定。

每个正常流程独立数据根、端口、凭据与 PID。运行中的句柄应持续等待到实际退出；结果文件存在不等于进程已退出。脚本 finally 收自己的 API、五个 Host、浏览器和附加 peer。

## 正常流程如何接入

`normal-flow.mjs` 复用原 `scripts/probe-spreadsheet-collaboration.mjs`：生产 API、五个官方 DSH Host、同一受控 provider 与 20 条历史/20 条现场事件、照片上传、稳定问题跨浏览器回答、真实 XLSX worker 忙时修订为 Input 3、协调员工读完四表候选、唯一 ready、Root settle 和手机下载。

`common/register.mjs` 仅在实验运行时对两个精确模块应用具名转换，保存转换后的原文：原验收脚本的 fork/数据根，以及原 Node client 的 `/internal/agent/commands` fetch。仓库原文件不被修改。原 Bridge 下行、模型、Evidence、文件与最终授权事务继续使用生产路径。

- **baseline**：应用命令走原 Bridge。
- **A2A**：Node 应用命令经官方 `SendMessage` / Message 回复，`A2A-Version: 1.0`，实验私有 CA 的 HTTPS；生产端仍验证原 Node 凭据、完整 binding 和当前执行权限。此入口明确为 Message-only，不宣称正常流程已运行完整 A2A Task 生命周期。
- **ANP**：独立固定 AWiki GroupHost 真实接纳与投递请求/结果关联。Home 从原生产权限校验绑定 caller 与本次 pending，再由固定 actor DID 签名。群中仅有 opaque request/response ref、actor 和 digest；命令参数、Evidence 正文、文件能力、Node 凭据保留于原授权请求的私域。真实签名 `group.incoming` 精确命中原 pending 后才返回原 TLS 调用者。Group 成员资格不授业务或文件权限。此实验的 Home↔AWiki 使用明确的本地 resolver-map HTTP 测试传输，不能外推公共 TLS、公共 DID 解析或公网两出口资格。

以上第一阶段验证标准协议应用命令往返接入同一正常业务，保留原 Bridge 的任务/结果通道。第二阶段 `business-flow.mjs` 补充下面的真实正常业务入口；两阶段都不是可部署的生产替换 adapter。

## 已有实际结果

三个正常业务根，均实际退出 0，并已逐 PID 读回不存在：

| 路径 | 正常业务根 | 实际模型 body / ledger | 协调员工候选页 |
|---|---|---:|---:|
| 原 Bridge | `protocol-normal-baseline-XaPHmr/business-Afdh2i` | 45 / 45 | 22 |
| A2A | `protocol-normal-a2a-HxKBac/business-oKujmV` | 47 / 47 | 22 |
| ANP | `protocol-normal-anp-mO7M8c/business-ZcbzOJ` | 46 / 46 | 22 |

根目录均位于 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`。三次原只读 `verify-spreadsheet-collaboration-result.mjs <业务根>` 实际为 0，验证实际下载的四表、原源字节、manifest、20 行/20 事件、独立分析、当前 Input 3、五个 Session 的实际消费以及完整页进入 provider。每次新 Work 的 ID、时间及 manifest 引用不同，不能要求跨 run XLSX 的 SHA 相同。

受控 provider 在实际异步调度下产生 45/47/46 次请求；同一源码和业务并不意味着完全相同请求次数。这里没有 CPU/RSS、网关容量、单次耗时优劣或协议分数结论。

最小独立互通另有两根：`protocol-bidirectional-qlGPTH`（A2A 私有 CA HTTPS、独立 peer Task/真实 OS executor 与反向独立 client）和 `protocol-anp-3pxSWM`（TS 双签请求、独立 AWiki 群与实际反向 incoming）。原始预检失败也保留，没有回填修改。

## 独立 peer 的真实正常业务入口

`business-flow.mjs` 在同一 D4 运行中改变首次创建与补充的入口：合法 owner 先上传本次照片；独立协议 peer 的第一个业务请求才创建唯一原 Work，浏览器没有先建 Work 后交给协议认领。验收浏览器的 create/input 请求被专用测试 route 接到独立 peer CLI，页面只使用该次真实生产 API 回复。原业务 source 和事务不改。

- A2A：官方独立 client 真正 `SendMessage(returnImmediately:true)` 收到 receiver 新生成的 Task ID；`GetTask` 实时投影原 Work 问题为 `INPUT_REQUIRED`；两次正式输入使用同 Task/context；最终真实原 Work/Root 完成、当前 revision 的 Artifact ready 才投影 `COMPLETED`。Task-local Artifact 映射原全局 ref，peer 用自身 opaque Bearer 与私有 CA HTTPS 下载原字节。
- ANP：独立 owner 成员向 `private` / `admin-add` / 上限 2 成员的单独业务群发送应用 `task.create/input/get`。只有明确预绑定的 owner DID 和 Home 在该私密域；旧五角色开放群仍只承载无正文 ref。Host 接纳和 Home 业务回复分别记录；peer 从独立 Host 持久消息主动取回复并再次 get，不依赖 Home 本次 pending Map。Task 是 Geneway 应用语义，不称 ANP 原生对象。最终 peer 用自身 DID 的真实 HTTP 签名取件，Home 再走原 owner 当前成果下载权限。

`common/business-tasks.mjs` 仅保存 `(receiver, principal, protocolTaskId) → 原 workId/rootDelegationId/rootAttemptId`、原创建命令键和摘要等关联 metadata。原稳定 `clientRequestId` 保障映射补齐不创建第二个 Work。Task 状态每次读取原 committed Work/Attempt/ready；SDK save 是投影确认，不写业务状态、不制造停止或完成事实。没有跨两份存储的原子事务承诺。协议身份事前明确映射到隔离测试 owner，每次业务 API 仍重新鉴权；`ROLE_USER`、DID 或群成员本身都不授真人答题或文件权限。

实际两根均 owner 退出 0，相关 API/五 Host/peer/独立 CLI 的最终 `/proc` 读回均不存在：

| 候选 | 业务根 | 模型 body / ledger | 独立 peer 本次下载 |
|---|---|---:|---|
| A2A | `protocol-business-a2a-89z5HV/business-s45udG` | 45 / 45 | 13439 B，SHA256 `570285bcfbb4907af526f8d92c84ebb2071d66aa6db1158b33ad5b81bc600b24` |
| ANP | `protocol-business-anp-z9BlCd/business-5d5xSI` | 45 / 45 | 13439 B，SHA256 `d5c9da37d5d4dc4aa97d22c4895c5819d30734ac5102abeaeebea321fd1e0e6a` |

两根原四表只读 verifier 均实际 0；每根 peer / browser / cloud 三份 XLSX 原字节相同，只有一个原 Work、五个原执行 Session、Input 3、22 页候选及唯一 ready。`business-oracle-input.json` 导航原始 Task wire、独立 peer 回复、映射、生产状态、签名下载和原 D4 文件。正常成功不代替服务器重启、取消停稳或所有规范条款验收。

### 原始 SDK 日志边界

正常交付不表示全部 SDK 回合或工具回包成功。两包原 Session 各保留一个旧 B revision 2 的 `UNKNOWN / 节点请求无法完成`：

- A2A：turn 5、seq 99，`2026-11-06T13:38:35.073Z`；位于 Input 3 受理 `13:38:34.873Z` 与同 Session 新 User seq 104 `13:38:35.193Z`、云端摄入 `13:38:35.304Z` 之间。
- ANP：turn 5、seq 101，`2026-11-06T13:43:43.747Z`；位于 Input 3 受理 `13:43:43.618Z` 与同 Session 新 User seq 106 `13:43:44.283Z`、云端摄入 `13:43:44.320Z` 之间。

两处此前的 `get_spreadsheet_job` 工具结果均成功。原包没有对应这两个 `UNKNOWN` 的精确 HTTP 失败响应，不能据修订交界时序断言具体鉴权或其它根因，也不能归为最终清理错误；之后原 Session 实际摄入 Input 3 并完成本次交付。

ANP 另有以下 5 个 `tool/result` 标记 `isError:true`、`AbortError/ABORTED`，正文为 `Error: tool call aborted`：

| 角色 | 原业务操作 / clientRequestId | 唯一原 Store 提交时间 | SDK 错误结果 |
|---|---|---|---|
| A | `complete_delegation` / `complete` | 2026-11-06T13:43:16.959Z | seq 20 / 2026-11-06T13:43:19.266Z |
| G | `complete_delegation` / `complete` | 2026-11-06T13:43:28.046Z | seq 33 / 2026-11-06T13:43:29.221Z |
| analysis | `complete_delegation` / `complete` | 2026-11-06T13:43:33.628Z | seq 27 / 2026-11-06T13:43:35.825Z |
| B | `complete_delegation` / `candidate-3` | 2026-11-06T13:43:50.250Z | seq 137 / 2026-11-06T13:43:51.435Z |
| C | `review_spreadsheet_candidate` / `review-3` | 2026-11-06T13:44:42.228Z | seq 131 / 2026-11-06T13:44:43.380Z |

每项均以同 issuer、完整 `{operation, parameters}` 摘要和稳定命令键，匹配到恰好一次已提交原命令；relay 原件也保留对应 `200` 与相同业务回复。它们不表示命令未提交。`application-wire.jsonl.at` 是请求开始时间，不能当成回复到达时间；仅凭提交、错误结果与 settle 的顺序也不能确定 abort 发起方，具体原因保留 unknown。

可重算的只读诊断脚本及结果位于 `geneway-evidence/protocol-comparison-final-checks-20261106/sdk-log-disclosure/`，关联原 Session seq、command key/digest、提交与 settle 时间，并核原包字节未变；没有重跑业务或回填原日志。

已知非阻断边界：ANP 私群中 Home 自己发出的业务响应也回送给 Home；owner-only 业务 listener 首投拒绝该自发响应，Host 重试后按已记录通知去重返回 204。原件保留 5 条相关 warning，合法 owner 的实际业务回复与下载均已完成。按本次仅修 P0/P1 的优先级登记后置，不写整包零错误。

## 已处理的正常主链阻断

1. 固定 TS SDK 的 `generateRfc9421OriginProof` 默认内部重复生成 nonce，会使签名基和返回头不一致。实验调用官方 API 时为每个独立 operation 提供本次安全随机 nonce 与同次时间；没有 fork SDK 或降低验签要求。首次真实 `group.join` 401 及原包自身验签失败保留于 `protocol-anp-bQdCgS`。
2. Group Appendix B 的原 receipt 是 `z` base58btc；SDK 通用 W3C verifier 的签名字节入口采用 base64url。实验只在验证副本中转换同一 64 字节签名，严格验证 Group DID 的 `assertionMethod`、原 protected receipt 与全部 proof options，原 wire/receipt 不变。这是适用 API 的编码接缝，不把通用 helper 的限制扩大成整个规范或 SDK 的缺陷。

完整 X01–X10、Profile 逐 MUST/MUST NOT、取消停稳/未知副作用、其他重启与丢响应组合和成本评分仍须各按实际证据判定。正常结果不替代这些项目，也不授权 T03b。


## X05 / X07 有界恢复验证

仅实验层新增 `recovery-flow.mjs` 与 `common/business-{process,child,recovery}.mjs`，复用原生产五角色、模型与文件入口。生产 Bridge、授权事务、调度、文件读者和根依赖没有为恢复验收改变。每个候选、每个子证独立新数据根并串行运行。

```sh
node experiments/protocol-comparison/recovery-flow.mjs a2a result-reply /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/recovery-flow.mjs anp result-reply /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/recovery-flow.mjs a2a task-service /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/recovery-flow.mjs anp task-service /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/oracle/recovery.mjs /ABSOLUTE/COMPLETED-ROOT
```

实际原件位于 `/home/gewu/.codex/task-checkpoints/geneway-evidence/`：

| 子证 | 有效独立根 | 原业务目录 | 原模型 body / ledger | 原 XLSX 字节 |
| --- | --- | --- | --- | --- |
| A2A X05 | `protocol-recovery-a2a-result-rRB3Pj` | `business-sGo57b` | 45 / 45 | 13442 |
| ANP X05 | `protocol-recovery-anp-result-final-wJ1JUo` | `business-ChJnOA` | 45 / 45 | 13450 |
| A2A X07 | `protocol-recovery-a2a-service-G90xK5` | `business-sHwuqI` | 46 / 46 | 13441 |
| ANP X07 | `protocol-recovery-anp-service-bGjygY` | `business-VofTYr` | 48 / 48 | 13440 |

四根实际退出均为 0，原 D4 四表 verifier 均为 0；原 Work 在 revision 3 完成、唯一 ready、原五角色消费和手机及协议 peer 取件保持原验收。不同根的 ZIP 字节与模型总数没有被要求相同，也不据此做性能结论。各根 `owner-process-readback.json` 保存实际退出后的 PID 读回；`recovery-oracle-input.json` 和原 `business-oracle-input.json` 导航各层原件。

### X05：原结果已经提交，原调用端没有收到答复

故障只命中真实 desktop-data 的 `complete_delegation / clientRequestId=complete`。原生产 API 返回 200 并已持久 command/result 后，relay 才断开答复；原 Host 真实出现 `ECONNRESET`，原 Node instance、hostRun、完整 binding、operation、parameters 和 key 物理第二次发送，取得原 resultId。随后同一 Host 的独立检查仅在 summary 末尾增加一个字，实际收到 `409 IDEMPOTENCY_CONFLICT`。原 command/result 各一条，原发送者模型集合不因重发增加；故障时依赖反馈尚未产生则记录 0，后续正常业务只产生一个引用该 resultId 的反馈。

ANP 三个层次分开存证：原已封 P4 RPC 的 operationId/messageId/origin proof/body 精确重投；GroupHost 返回原 acceptance/receipt，附 `idempotent_replay` 说明，不假称再次投递；另外用新 requestId、operationId、messageId 发合法结果查询，目标 Home 按本次已认证 sender、原请求关联与 command digest 调原生产 receipt 分支，接收新签名回复后才答原调用端。群内仍只有 opaque request/ref/digest，不含 Node 凭据、业务正文或下载能力。终态原 receipt 的查询不绕过原生产 current Node/grant/fullbinding 授权与异文冲突门。

`relay/recovery-{committed,replayed,conflict}.json`、`caller-attempts.jsonl`、`recovery-events.jsonl` 和原 application wire 保存提交、调用失败、重发、409 与 P4/新查询的区别。ANP 初根 `protocol-recovery-anp-result-U2cRJs` 保留为部分支持：云端已实际冲突，但诊断检查沿用原调用的 8 秒 signal，原 Host 未收齐该 409。最终根只给独立异文检查新 20 秒 signal，原业务重试机制未改；旧根不倒补为完整通过。

### X07：业务 Task 服务是真进程退出与原身份重开

独立有权 peer 首次创建 Task 到真实原问题等待点。A2A 旧业务进程 `3765428` 实际 SIGKILL 后退出，新进程 `3766110` 复用原 `https://127.0.0.1:34057`、CA/key/token/principal grant 和映射。离线时独立 GetTask 实际连接失败；重开后官方 client 新查询返回同 Task/context/Q/root/revision。

ANP 杀的是 Home 与业务订阅进程 `3780101`，独立 GroupHost、生产云与原五个 DSH Host 保持运行；新进程 `3785848` 复用原 Home `http://127.0.0.1:43329`、DID/key、原私密 admin-add/max-members=2 群与 owner grant。重开实际签名查询原群 policy/member list，不创建第二个群或新身份。离线查询即使已被 Host 接纳，也没有 Home Task 回复；重开后的独立 peer 用新 correlation 主动再次查询，取得新签名回复及当时原 Work 投影，不拿旧群历史当本次业务答复。离线旧消息的后续重投与新查询各保原事实。

`business-entry/recovery/` 保留 before/offline/after 原生产状态、映射、独立 peer 查询和身份文件 SHA256，前后原 key/token/CA/grant 字节保持不变，未重建 Work/Attempt/Session 或增加该恢复窗的模型请求。随后继续原问题的合法 Input 2、真实 worker 忙时 Input 3、原 ready 与文件下载。ANP 还保存 offline/after 的原 API/五 Host/GroupHost 实际 `/proc` PID/startTicks 读回。A2A 首根在运行中执行了相同父进程身份检查，但没有另存这两次 OS 原件，独立 oracle 对该项保 `not-run`；不为此重做业务或补造历史观测。

G90xK5 原 recovery 导航误把一个同前缀 JSON 文件选作业务目录，原业务及独立 oracle 使用的 `business-oracle-input.json` 仍准确；原错误导航保留，`recovery-oracle-input-readback.json` 明确按原 driver 导航纠正。未来入口只增加目录类型筛选；该运行后元数据修正不被当作启动时已执行的代码。

### 本片保留边界

四根原 SDK 日志仍有非成功记录：每根各有一个 B 的 `UNKNOWN` turn/end；A2A X05 另有一个 error tool/result，ANP 两根各有五个 `tool call aborted`，A2A X07 无 error tool/result。原 body/ledger、唯一 ready 与取件均按上述原件验证，不能据此称全部 SDK 回合零错误或从时序猜定错误发起方。逐 seq 的运行后读回见 `protocol-recovery-readback-20261106/readback.json`。ANP 原 self-response 拒绝与 GroupHost outbox 重试 warning 也保留，不为非阻断日志扩大修复。

本片只证明原受权 Host 的这个结果重发，以及仅业务入口/Home 服务的 SIGKILL 恢复；不证明云/GroupHost 同时重启、完整 X07、取消停稳、每类撤权/跨主体、所有 MUST、公网出口或真实网关。单 principal 入口没有被未知 bearer 的认证失败冒充多 principal 业务权限验收。其他七硬门仍按原计划逐项保留 unknown，未选 winner、未实施 T03b。


## X06：协议取消受理与生产执行停稳

新增 `cancel-flow.mjs` 和专用取消 driver/oracle，原生产取消事务、Host 的 Job/runtime stop 及文件权限保持原样。取消由独立协议 peer 发起，浏览器的原 cancel 路由在此实验中被拒，不能把 UI 取消代称为协议取消。

```sh
node experiments/protocol-comparison/cancel-flow.mjs a2a /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/cancel-flow.mjs anp /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/oracle/cancel.mjs /ABSOLUTE/COMPLETED-ROOT
```

共同 `tasks.cancel` 只以已绑定 principal/Task 找原 Work，经当前 owner API 权限，以由 principal+Task 派生的稳定 `clientRequestId` 调原 `/api/works/:id/multisite/cancel`。映射不保存并行取消状态。新运行的原始 grant 显式列 `cancel-own-task`；默认入口没有该资格，`openExisting` 必须与旧 grant 完整匹配，不能重开时默默扩权。

A2A 定向替换官方 transport 实际调用的 `handler.cancelTask` 整条方法。固定 SDK 1.3.0 无 event bus 时会由 ResultManager 强写 CANCELED，末尾还要求最终 CANCELED，所以仅修改 executor 无效。本入口不调用该分支或假装 TaskStore 已停，取消后只返回原 Work 的当前投影；工作仍 stopping 时合法返回 WORKING。ANP 使用原两成员私群的签名应用 `cancel` 请求及新的 `get` 查询，群接纳回执不等于业务取消，Task 仍是 Geneway 应用语义。

| 候选 | 原件根 / 原业务目录 | 真实 B 父进程 | 真实原 worker | body / ledger |
| --- | --- | --- | --- | --- |
| A2A | `protocol-cancel-a2a-RPoLC7 / business-foGjQB` | `3919047` | `3921228 / startTicks 12332107` | 24 / 24 |
| ANP | `protocol-cancel-anp-6fOEXB / business-FWWA6v` | `3936919` | `3944869 / startTicks 12350602` | 24 / 24 |

两根都从独立有权 peer 首次创建 Task，经原问题与合法 Input 2 到真实 B running Job。在问题点先真 SIGKILL/reopen 业务服务，复用原端点、身份和映射，以新进程验证 A2A 没有旧 event bus。实际 worker 已 SIGSTOP，再短时 SIGSTOP 同一个 B Host 父进程；云与协议入口不停。独立 CancelTask / 签名应用 cancel 后，原 Work 是 stopping、已有原 durable cancel 命令，两个独立协议响应均仍 working；父进程与 worker 的 PID/startTicks 保持相同并实际为 T，B 尚无 stopped receipt，Task 没有 Artifact。

实验随后仅 SIGCONT 原 B 父进程并解除原 provider 检查点，原生产流程负责停止 Job/runtime，测试没有杀 worker 冒充生产停止。原 worker 的最终 `/proc` 查询确为 ENOENT；Job `stopEvidence.workerExit=exit_confirmed`、`output=no_published_output`。原 root 和 B 两个未完成执行的 sealed stopped 事件、云 exact ACK、本地 acknowledged 与 slotHeld=false 全部吻合；其他三个已完成执行保持 completed。原 Work 和同 Task 才成为 cancelled/canceled，另一次独立新查询确认终态。A/G/analysis 的三份旧 result 及 Evidence 原样保留，没有 ready/Artifact，不声称取消撤销了已经发生的副作用。

`cancel-oracle-input.json` 导航真实 before/barrier/stopping/release/final、五份 Host Journal、worker 原始退出错误、peer 请求/响应和原 SDK `cancel-sessions.json`；同一 `oracle/cancel.mjs` 对两根实际执行均为 0。两个 owner 进程实际退出 0，原 busy-stop 的终止断言通过，记录 PID 均已退出；没有要求空闲官方 DSH 宿主先消失才允许 Work 停稳。此旅没有产正常四表文件，所以不套原 ready 下载或 45 次模型断言。

本次也修正实验投影把 `Work.interrupted` 误写为 failed 的接缝：现在保非终态 working，并明确原 executionUnknown / unavailableReason；实际未确认模型请求 ID 单独保留，不把 reserve unknown 当进程死亡，也不把当前执行停稳解释为旧未知副作用已撤销。运行后组件对照使用真实 `budget-parent-death-dSD7eb/after-restart.json.state` 原 interrupted/unknown 事实及旧/新 projection 源码，结果 failed→working、`RUNTIME_PROCESS_DIED` 保留；仅有 index fixture 和 stub 授权 GET，不冒正常旅中新制造了故障或完成 HTTP 权限验证。脚本、stdout 与明确边界在 `protocol-cancel-final-checks-20261106/unknown-projection*`，原归档字节未改。

SDK 日志仍保原事实：两根各有一个 error turn/end；A2A 有一个 error tool/result，ANP 有四个，其中包含 `tool call aborted`，不能写全回合零错误或凭时序猜定发起方。两根最终原模型账都是 24 completed，与 24 份实际 body 一致；ANP self-response/outbox 重试 warning 也保留。运行后逐帧读回见 `protocol-cancel-final-checks-20261106/run-readback.json`。

这仅证明本地受权 peer、这两个运行中的原 Job 与单次业务服务重开后的取消停稳；不代表完整 X06 的未知副作用、撤权/所有并发/故障组合、全 MUST、目标网关或完整七硬门通过。未选 winner，T03b 未实施。


## 角色库存与本机出站小任务

库存入口为 `measurement/role-inventory.mjs`，只读当前 lock、实际安装元数据与固定源文件，不安装。原件在 `role-inventory-sol-20261106/role-inventory.json`：历史来源 manifest 的 lock SHA 与当前 lock SHA 分列；76 个已锁 JS 位置的版本、integrity、许可声明和安装 name/version 实际一致，不覆盖旧来源记录。最小运行时**声明闭包**复算为 A2A SDK 2 个位置、独立 Express peer 70 个位置、ANP Home 7 个位置；AWiki 当前平台 Python runtime 43、额外 dev 8、已装共 51。它们不是进程实际加载数或每个 edge 的生产安装体积。

许可声明、package.json/METADATA 原文件和定位到的 LICENSE/NOTICE 正文路径及 SHA 分列，固定源码来源继续引用原锁定 commit/archive。`jcs==0.2.1` 声明 Apache-2.0，但已装产物未定位独立许可正文，正文仍为 unknown；这不是法律结论。JS 的 `optionalDeclarations` 只列 `optionalDependencies`，不把空数组解释为没有 optional peer：SDK 另有 optional peer 声明，未安装或加载不能写成已用。第一段的 actualLoaded 保 not-run；第二段有新实际模块 URL trace，另按进程说明覆盖范围。

```sh
node experiments/protocol-comparison/measurement/role-inventory.mjs /ABSOLUTE/INVENTORY-ROOT
node experiments/protocol-comparison/role-flow.mjs baseline /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/role-flow.mjs a2a /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/role-flow.mjs anp /ABSOLUTE/UNIQUE-ROOT
node experiments/protocol-comparison/oracle/role-flow.mjs /ABSOLUTE/COMPLETED-ROOT
```

当前三根有效样本：`protocol-role-baseline-final-DoAjva`、`protocol-role-a2a-UDbbXp`、`protocol-role-anp-tZc1In`，均位于原外 Git evidence 目录，实际退出 0。初根 `protocol-role-baseline-b6M2rE` 的业务已返回原结果，但新驱动 finally 把同步 proxy 方法误当 Promise，实际退出 1；原失败保留，7 个实际采到的 PID 后读回全 ENOENT，不升为完整通过。最终三根均保存原记录进程与端点的退出读回，不冒未观察到的短命进程也被逐 PID 实采。

三路直接使用原生产 HTTP/FileStore/Bridge/model gateway 与官方原生 DSH，固定输入及实际权限表可独立重算。C 的逻辑 placement 仍为 cloud，经模拟出站路径 A，委派 pc-a 上的 A 经路径 B；不称两台现场机器或覆盖 A/B/G 全角色。每根两条执行实际摄入 Input，子执行 complete_delegation 的唯一原 result 及反馈进入父执行的后续模型 body。每根 5 份真实 body 与 5 条 completed ledger 精确相等，三路 actual authority 与原 fixture 字节一致。此样本不读取现场业务数据，不生成 XLSX，也不重测已接纳的 D4。

三根原 `session.v4.jsonl.zstd` 与领域结果分层保留。ANP `tZc1In/pc-a` 的 child Session 在 complete tool/call seq12 后，tool/result seq13 是 `AbortError / ABORTED / Error: tool call aborted`，turn/end seq15 为 aborted(user)。原 complete 已形成唯一领域 result，且父模型实际消费；这不等于 child SDK 收到成功回包，不称 SDK 零错误，也不凭时序猜定 abort 发起方或重复提交。两其他根没有据此被混写为同一日志结果。

两个 edge Host 各经自己的固定目标 proxy 建立 Bridge SSE/POST，候选 Card/SendMessage 或 `/submit` 也经本 edge 的 `/protocol` 路径，不能绕到 receiver 原 URL。当前 receiver/Home 是独立 PID，ANP Python GroupHost 也是独立 PID；driver、provider 和两个 proxy 位于另一共享 observer PID，不混入 receiver RSS 归因。一个有界断窗只断 B 路径，保存真实未 ACK 子 launch 的 pending/serialized bytes；A 路径继续受理原 delegate/wait，B 以同 Node instance/hostRun 重连并只消费原命令，结果返回一次。OS socket FD/inode、PID/startTicks、listen/主动连接与 proxy 连接元数据均有原件。原模型通道和实际其他连接按 socket 记录解释；没有 OS 网络隔离，不宣称 NAT、两个公网出口或所有网络只能走这两条代理。

### 本次有限样本的直接量化

`protocol-role-checks-20261106/metrics.mjs` 从三个根的原数据产生 `metrics.json`，实际执行 0，可逐 PID 重算。窗口包含模块 trace、observer 开销与上述短断连；单个本机样本不用于 p95、SLO、吞吐量或选型分数。

| 原样本 | idle→任务结果窗口 ms | edge C/A 实际注册 ready ms | receiver 首次 ready ms（含一次性设置） | 业务目录 logical 增长 B |
| --- | ---: | --- | ---: | ---: |
| baseline | 1829 | 246 / 204 | 不启动候选 receiver | 95700 |
| A2A | 1740 | 245 / 245 | 107 | 120124 |
| ANP | 11205 | 244 / 206 | 1116 | 780813 |

receiver ready 包含实际证书生成和 ANP 群 bootstrap，没有把一次性工作扣掉。Python 自身冷启动没有单独分割，已包含在 ANP 总 bootstrap，不能写成 0；共同 API 的 spawn→ready 未单独归档，保 unknown。现有 ANP Home 仍复用原五 actor 的身份/成员准备，只有本样本两个 Node 参与业务，相关额外 bootstrap 和群投递开销包含在原样本中，不冒优化后的最小部署。

| 进程角色 | baseline：最大已采 RSS MiB / 窗口 CPU 秒 | A2A | ANP |
| --- | --- | --- | --- |
| edge C Host 父进程 | 105.2 / 0.09 | 110.4 / 0.11 | 114.2 / 0.41 |
| edge A Host 父进程 | 109.2 / 0.08 | 109.8 / 0.11 | 107.6 / 0.22 |
| 独立 receiver / Home | 不启动 | 85.4 / 0.05 | 106.3 / 0.22 |
| 独立 Python GroupHost | 不启动 | 不启动 | 72.8 / 0.22 |

RSS 是 idle/busy/after 三次实际采样的最大值，不是完整峰值；CPU 来自同 PID/startTicks 的 user/system ticks 与实际 `CLK_TCK=100`。逐角色原 executable、HWM、I/O、时间窗和 delta 在 `sample-*.json` / `process-deltas.json`。RSS 相加会重复计算共享页，不是物理总内存。C 的 native runtime-worker 有观测行，但 pc-a 短命 DSH worker 未命中这些 phase，其 lifetime CPU/RSS 是 unknown，不能从 Host 父进程推完整子执行成本。边缘父进程和 receiver 的实际 module load URL trace 已采；DSH worker 与 Python import trace 仍 not-run，这与未采到短进程资源是两个边界。

Wire 使用各 proxy 原 chunk 的 request/response payload bytes、请求数和状态，分 protocol / Bridge SSE / backend control-model。A2A 两 edge 的 protocol 请求为 3 / 2（含各自 Card GET，实际 SendMessage 为 2 / 1），ANP 为 2 / 1；不能拿这些不同协议包数直接评分。ANP 额外 cloud hop 另从 Python ASGI 原 UTF-8 body 和 Home 入站长度读取，实际无 U+FFFD；不把派生 JSON 重序列化长度当原 response wire，也不重复叠加同一 hop 两端。没有 TLS/IP 抓包，不能称总网络流量。

数据盘前后只按全局 dev/inode 去重一次，含 Journal、SQLite/WAL 和 trace，且为非原子观测。原 `installation-disk.json` 是三路共同现装环境，19 个外链保 conservative pending；运行后另做 current readback，18 个现有 workspace 外部根实计，1 个 uv Python 别名归回已有 inode。各 `installation-external-disk-readback.json` 的当前共同 regular-file union 为 675562998 logical B、764809216 allocated B、33686 inode，明确不是启动时补采或每候选生产包大小。联合 JS/DSH、Python stdlib/dev、workspace 代码及共有 inode不重复分摊到每个 edge。editable AWiki 的实际 `src` 位于 venv 外，另在 `protocol-role-checks-20261106/code-footprints.json` 记录当前源码目录 regular-file union（1455172 logical B、1642496 allocated B），连同本实验自建代码、文档和 harness 文件字节清单单列，不把它们免费隐藏到依赖总数中；这不是 Python 实际 import trace。生产最小包和 OS 库闭包另需资格验证。

本片只给当前 Message/application-command relay 小任务的真实增量，不是完整标准 Task 服务成本。模型 usage 和实际外部费用仍 null，未用保守预算估计伪造账单。角色库存、三路正确结果、有限路径恢复与这些原始指标均不替代真实 F08 双公网出口、T02 现场网关资源/采集影响、完整七硬门或全 T03a；ADR 继续延期选型，T03b 未实施。

## 按 Work 绑定的三方私有群（X03 本地窗口）

当前新增路径在真实 Work 和 B/A/G 三条实际 Delegation/Attempt 成立后建群。每个协议 principal 由本次真实 Node credential、instance 与完整 binding 绑定，后续每次发布/解析仍读当前企业权限。Human owner、协议 group-admin 和设备 actor 分开；协议角色 USER、群成员资格与 opaque locator 都不授予人类答复、Evidence 或成果下载权限。主 Store 保持版本 27，原共同成员否决与成果自身 ACL 未改。

A2A 使用官方 Message/JSON-RPC、每 principal 独立 Bearer/contextId，加应用层成员、fanout、待办和收件校准 journal；这是 Geneway 自建应用群，不是 A2A 原生群。ANP 使用固定独立 AWiki Host 的域内 owner create/private/admin-add、实际 add/send/remove 和 fresh get_info；没有把受限的远端 create 冒充可用接口，也没有复制第二套 GroupHost。

群 wire 只有 server-owned opaque locator。私有 locator 映射原 Geneway message 与明确 recipient；定向问题只向原责任 recipient 解析，广播只向本 Work 合格参与者解析，底层 Evidence 仍由原 HTTP receipt/readers∩export 门读取。本 Work 的 Home 在落 incoming 前验证本群 schema、canonical locator 与实际 sender DID；原 direct/control/state_changed 和旧 Task Home 默认路径保持。旧 opaque transport ACK 与当前正文解读分开，移除后的正文请求拒绝不会阻塞 Host 后续 state_changed，也不增加原责任 Session 的 UserMessage。

产品 Work 详情 GET 可选接一个不导入 SDK 的只读状态 provider。provider 只改变 `protocolGroup` 的有限枚举，并匹配 workspace/Work/employee/current removal command；其 I/O 后再次读取企业事实。无配置才为 not_applicable，已配置不可达/元组不匹配为 unknown，未完成原 receipt/roster/recipient 校准为 pending。该 provider 不进入业务 mutation 响应，不更改 access/canRemove，不配置生产双 SDK；原详情页仅增加 pending/unknown/confirmed 文案与轮询。

两根同层完整本地原件：

- A2A：`geneway-evidence/protocol-work-group-a2a-yrc16K`，同根先正常收发，再 owner 实际页面移除 G、原旧页/模型 token/managed 操作拒绝，保存 product commit 但 control 尚未 enqueue，真 SIGKILL/reopen 原桥身份与 endpoint，补扫同 removal key，在原 remove 控制前屏障内仍拒 B/A fanout，释放后应用成员与待收件校准，B 对旧已接受 locator 的幂等重放仍可用、G 合法协议身份的新 publish 拒绝，同 Node G 在另一 Work 仍合法。独立官方 client CLI 留旧 offer/精确 opaque ACK 与移除后的新操作原件。
- ANP：`geneway-evidence/protocol-work-group-anp-RlDyLz`，相同业务路径；原桥死时固定 GroupHost 保持存活。remove 请求确实阻在转发 Host 前，恢复扫描的原 protected operation/body/proof 先持久。释放后取得原 signed remove receipt，随后 fresh authenticated **unsigned** roster 与 Host SQLite/recipient backlog 校准，最后目标 G 的 state_changed 真到达；最终本次版本/序号为 5/9。不是用 HTTP 200、旧列表或空总队列证明完成。

两包 `source-start.json`/`source-end.json` 各 35 份相关原字节相同。`normal-managed-facts.json` 的 `desktop-data`/`gateway` 两次 receive 与 body 观察对应同一原 B message；`question-consumed-state.json` 与 `question-session-no-second-wake.json` 保存原 B→G 问答消费及群副本不再 wake；移除前后 product snapshots 的 modelRequests 均为空且不新增模型调用。这是 HostSim 层真实 Node/HTTP/文件与协议收发，不冒新原生 SDK 推理或真实现场采集验证。

ANP `bridge/group/control-wire.jsonl` 保原请求/响应与 Host 前屏障；`anp-work-group.json` 保稳定 intent、protected RPC、原 proof/receipt 和校准。`bridge/home/incoming.jsonl` 的本工作群安全 opaque 包另保存实际 method/URL/signature headers/body，独立 oracle 可重算 HTTP signature、sender origin proof 和 Group DID assertion receipt。`host-snapshots.jsonl` 来自真实只读 SQLite；fresh roster 与数据库观察本身不签名。最终确认只针对本次移除主体的资格、receipt、版本与目标 backlog；其他合法 recipient 的队列可以仍有 pending，不伪清全 Host outbox。

这两个窗口只覆盖上述本地生命周期。原短窗实现把一次 300 秒 origin proof 一起持久化，独立审查确认较长停机会卡在 signature_expired。当前修复保留原 prepared 与每次认证 attempt，只在领域 method/meta/profile/actor/target/operation/body/contentDigest 严格不变时更新过期认证 proof/HTTP 认证，再持久化后出网，不换领域操作。`anp-work-group-renewal-K2inBo` 在旧真实 Host 数据根的独立 clone 上实际观察自然过期原包拒绝、续签同 operation 返回原 signed receipt、版本/序号/领域计数不增、改 body 同 operation 冲突，原证据根未改。自动 result:null→expiry→append attempt→fetch 的调用链已做独立源码检查，但这个自动支路及其间再次崩溃未做 OS/HTTP 故障实跑；不把 helper 的真实 HTTP 结果冒称自动恢复实证。Host 自身 DID 还广告 `anp.attachment.v1`、`anp.federation.relay.v1` 等 profile，本片没有把这些声明记为不适用或已通过。

群增量代码与角色独立：共同 journal/domain/child/process/fixture、A2A group/fanout、ANP control/校准及独立 Host、GET-only provider/UI 都是新增实现与维护成本。旧 role 三路样本只测小 Message command relay，不是完整 Task/Group 的 CPU/RSS、依赖 closure、磁盘或网络成本；本片未重新测这些数值，未知不填 0，不评分、不选赢家。团队已选的 Linux x64/Node26.5 本机模拟目标可作为后续本地资格目标；物理设备/公网两出口/采集影响仍是独立未证范围，不能代替本地尚未完成的七硬门、实际广告 profile 核对、完整成本与 ADR 独审。

确认后全新发送另有最小同层补证，不能由旧 locator 重放推断：`protocol-work-group-a2a-JMn1Xa`、`protocol-work-group-anp-PEaoQQ` 各为独立新 Work，正常段后 owner 真移除并确认，再由 B、A 各提交全新原业务 messageId、注册新 locator、产生新协议 operation；A 与 B 分别实际 receive 并本人 Node 解对方新摘要，G 对新 locator 及有效协议身份新发送仍拒绝，modelRequests 前后均为实际空数组。`positive-before-new-publish.json` 与 `positive-new-publish.json` 保存新旧标识、原受理结果、实际收件/正文与 protocol receipt。两小根不重 UI/kill/D4；与旧 full 窗口按各自实际资格分列，不拼成一个不存在的 run。

补充原件导航：两个 positive 根的 `result.actualRecipients=[desktop-data,gateway]` 继承正常前半段字段，不能据此判确认后的新方向；新方向严格取 `positive-new-publish.json.fresh` 的 B→A、A→B、对应真实 wire/receipt/receive 与本人 Node body。旧 raw 字段保留，不倒改为另一个 run 的事实。

### 实际角色声明与发现原件

`node experiments/protocol-comparison/profile-discovery.mjs a2a` 与 `anp` 只启动真实发现入口，不启动产品 API、Work、Job、业务执行器或模型。原件根分别为 `geneway-evidence/protocol-profile-a2a-erfCYO`、`protocol-profile-anp-FtG1jx`；`manifest.json` 关联原 HTTP body bytes、实际响应头、字段 JSON Pointer、实现来源和历史 wire，`declaration-source-readback.json` 是明确标注的运行后只读源码挂载及声明解释，不是新的运行采样。独立读取命令为 `node experiments/protocol-comparison/oracle/profile-discovery.mjs <runroot>`。

| 实际角色 | 本次原件与限定 |
| --- | --- |
| A2A Message relay、owner Task、应用 Work group | 各公开 Card 的真实 HTTP 与官方 resolver 另次抓取；三者 wire 版本均声明 1.0/JSONRPC、streaming=false。只在 owner Task 做未知 Bearer GetTask 401，不当跨 owner 权限证明；合法业务行为引用各原结案 wire。 |
| 独立 A2A streaming peer | 另列 harness Card，streaming=true 只属于该独立 fixture，不替业务入口背书。 |
| ANP Home | 原 service/member DID 与匿名 capabilities：四个原 profile、三个 incoming/state notification 方法；出站 helper 不是另一份 Host 服务能力。 |
| 固定 AWiki Host | 隔离 clone 原 service、注册成员、真实群 DID；匿名 capabilities 保留七个原 profile，包含 group.v1、attachment.v1、federation.relay.v1（ANP-P8 federation）；额外声明的适用条款仍待核，不能因 Geneway 未采用就记为 N/A。真实方法声明位于 `result.features.methods`，顶层没有 `methods` 字段；P9 mentions 与 federation 分开，不凭编号推定广告。 |

两者没有广告独立 AgentDescription 链接，本次不猜 URL；不存在成员 DID 的真实 404 仅证明该有限查询未找到。Home/Host 的匿名 caps 成功不授身份权限。固定 Host 六个原业务表在 clone 启动前后深等，原 outbox 可以后台重试，未把重试元数据算成新业务；清单中的零 Work/Job/model 指本采集器未启动这些入口，不是全局运行监控。实际 HTTP/本地 DID 映射不外推公网解析、TLS 身份或现场成绩。声明、挂载、历史行为和产品采用分层；本片不是全部 MUST 合规、成本评分、协议赢家或 T03b。
