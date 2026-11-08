# 协议比较决策台账：本地资格、完整角色与待决边界

状态：**现有材料可交 root 作下一步架构裁定；本文不选赢家，不授权 T03b，不宣称当前原型七门或所广告 Profile 已全部通过。** 比较对象始终是“A2A + Geneway 工作群”和“ANP + Geneway 任务语义”两份完整方案。协议条款失败、身份边界未证和运行成本未知分别保留，不能用加权分数、未来承诺或对方未知抵消。

依据为原附件 §4.3–4.7、已批准的 decision-ledger plan 和下列已接受证据。用户“自己模拟”的授权已冻结 Linux x64 / Node 26.5.0 的本机组合，不以尚无现场机器为本地架构决定的阻塞；现场硬件、双公网出口、采集影响和生产发布仍是独立未证范围。24 logical CPU、48778024 KiB RAM 是同宿主观察，不是资源隔离或网关配额。[附件][S]

## 证据索引与使用范围

| 索引 | 可复验原件 | 本文采用的事实与边界 |
| --- | --- | --- |
| N：正常标准业务 | `protocol-business-a2a-89z5HV` / `protocol-business-anp-z9BlCd`；[正常入口接受记录][N] | 独立获准 peer 首次创建唯一原 Work，Task/context 映原 root，稳定 Q、Input 2/3、当前 Work/root completed 后 Task-local Artifact 与授权下载；各 45 个原 model body/ledger、五 Session、22 候选页、13439 B 文件。四表业务内容等价，不要求不同 run 的 ZIP hash 相同。 |
| R：结果幂等与入口恢复 | `protocol-recovery-a2a-result-rRB3Pj` / `protocol-recovery-anp-result-final-wJ1JUo`；`protocol-recovery-a2a-service-G90xK5` / `protocol-recovery-anp-service-bGjygY`；[恢复接受记录][R] | 云已提交结果后原 Host 丢答，同 binding/key/fullpayload 重发回原 resultId；异文 409、单最终反馈。真 SIGKILL 后原身份/端点/映射，以新查询取同 Task/Q/root/revision；Work/Input/Attempt/模型账无重建。A2A 首 X07 缺父进程离线/恢复后独立 OS 采样，不能补成完整连续观测。 |
| C：取消到停稳 | `protocol-cancel-a2a-RPoLC7` / `protocol-cancel-anp-6fOEXB`；[取消接受记录][C] | 重开服务后独立 peer Cancel；父/worker 真 T 屏障中 Task working、Work stopping；原生产 stop/worker exit/Job no-published-output/exact stopped ACK/slot free 后才 canceled。保三份既有结果，不称撤销全部副作用。各 24 body/ledger 是该截止点，不硬比正常 45。 |
| W：共同企业权限 | HTTP/T20 `JDD8os` / `3oAxPG`、真实 OS Job `JFdw78`；[共同成员接受记录][W] | Work+稳定 employee 单向否决、原 Node/旧页/旧模型 token/新动作拒绝、来源 Work 与实际 reader 独立门；其他 Work 与未撤主体保；成果 owner 自身 ACL 不随生产者撤权级联。HTTP 附件组合屏障也有 manual pause，member-only 因果来自隔离组件；不混层归因。 |
| G：Work 群与校准 | `protocol-work-group-a2a-yrc16K` / `protocol-work-group-anp-RlDyLz`；续签 `K2inBo`；确认后新发布 `JMn1Xa` / `PEaoQQ`；[群接受记录][G] | B/A/G 私有群、原责任 Q 副本不二次 wake、product commit 未 enqueue 后真桥重启补扫；pending/unknown/confirmed、旧 opaque ACK 与当前正文权分开。移除确认后全新 B↔A 各一次并本人 Node 读新摘要，G 新读/新发拒。HostSim/loopback；模型账前后真实为空，不冒新原生模型推理。 |
| I：角色库存与小样本成本 | `role-inventory-sol-20261106/role-inventory.json`；`protocol-role-{baseline-final-DoAjva,a2a-UDbbXp,anp-tZc1In}`；[角色接受记录][I] | 固定声明/实际安装/许可正文引用分层，三路同 C→PC-A 小委派各 5 body/ledger、2 Session、单结果；双本地代理/有限短断/原身份恢复，候选 command 也经代理。只覆盖小 Message command relay，不是完整 Task+Group 成本。 |
| D：真实声明 | `protocol-profile-a2a-erfCYO` / `protocol-profile-anp-FtG1jx`；[发现接受记录][D] | 17 份原 HTTP body/headers、73 字段引用、官方 Card 重解、五 DID、live caps、源码挂载与历史 wire 分列；后读包信息不是 startup loaded trace。 |
| B：定向规范边界 | `protocol-boundary-a2a-EGHwCE` / `protocol-boundary-anp-WWvG7C`；[边界接受记录][B] | 原真实 Task/owner 正控，精确仅版本变化、新缺失 ID、非空已知 Task 下 List；ANP 双层签名负控与受权私有 roster 的原 HTTP 重放。采集器/oracle exit 0 不把下列协议差额改为 passed。旧 `sg2Eud` 的 Accept 对照缺口与失败日志保留。 |

所有 run 均为独立根，按各自原资格引用，不拼成一个“完整全矩阵 run”。N 两包旧 B revision 2 各有一个 SDK `UNKNOWN`；ANP 另有五个 complete/review `tool call aborted`，均对应唯一已提交命令，精确 HTTP 失败原因/abort 发起方未证。I 的 ANP child complete 工具为 ABORTED、turn aborted，但原结果与父消费成立。领域完成、传输回复、SDK 回合成功三层分开，不称零 SDK 错误。[N][I]

## 七个硬门：逐候选、逐实际角色

“有限实证”只覆盖表中角色与场景；决定性未证不按平均值涂绿。X10 的两条已失败错误/枚举语义另列，不与已知 Task 恢复或身份认证混为一门。[附件]

| 硬门 | A2A 完整方案当前事实 | ANP 完整方案当前事实 | 范围、决定性缺项与最小改变决定的依据 |
| --- | --- | --- | --- |
| 1. 目标平台可运行 | N 的 C/A/B/G/analysis 官方 DSH/Host 执行与 Node 26.5.0；Task/Message/应用群真实 factory 启动、独立 peer 互通。 | 同一 N 原业务；Home JS、独立 AWiki Host 的 Python 3.11.15 / ANP 1.0.6 实际运行，G 与 D 有真实角色启动。 | 冻结 Linux x64 本机组合有有限实证；逻辑共置、角色独立 PID、未来生产 service 布局分别说明。未证现场网关配额/完整离源码候选安装；不因此声称本地组合不能运行，也不假设完整角色峰值已测。[S][N][G][D] |
| 2. 身份可验证 | Card 与 HTTPS 私 CA、owner opaque Bearer、群 principal/context 与 Node/fullbinding 关联；D 的未知 bearer GetTask 401、G 的有效被撤身份新发拒。ROLE_USER 不授人权。 | Home/actor/Group DID 及 serviceDid/key 用途有原件；B 正控双签接纳，坏 HTTP/内合法与坏 origin/外合法分别 401，独立验签与表无效果。 | ANP **同一 HTTP proof 两次取得 1425 B 私有 policy/三 active 成员/state 5**，HTTP 抗重放拒绝未证；不是伪签接纳或被撤成员读。是否接受该有时效证明的重用边界、或要求不可绕过的 replay 边界，须 root 安全裁定。不能用 TLS、两条坏签拒或 P1 幂等代替。[B] |
| 3. 仅出站可达 | I 中 C 逻辑 cloud 角色经模拟出站 A、PC-A 经 B，现场 Host 采样无业务 listen；Message commands 也经各 `/protocol` 代理；receiver 云入口另列。 | 相同小样本路径；Home/固定 GroupHost 是云端有入站职责的角色，不能把云入站算成现场端失败。 | 两本机 proxy 不是双公网，X03 部署 Home 在本机仅模拟云。现必要 A/B/G 全角色在完整 Task+Group 下的仅出站接线、监听清单与弱网组合尚未统一采证。若静态部署要求现场额外入站才成立，该门不通过；否则最便宜是选定布局后一个无新模型的角色连接/方向核对，不重 D4。[I][G] |
| 4. 关键任务可恢复查询 | R 原业务入口无 bus 真 SIGKILL，原 CA/token/grant/mapping，新 GetTask 回同已知 Task/Q/root/rev；C 亦真实重开再 cancel；N 后取原 ready。 | R 真 Home/business child 重开、原 DID/key/Host/group 与映射保，新 request/op/message 得新签名答复；同 Task/Q/root/rev、后续 N 原 ready。 | 已知 ID 路径有有限实证，未把所有失联/未知效果组合或存储损坏判过。A2A List 的真实空结果是**发现/枚举缺口**，不改写已知 ID 恢复事实；若产品关键恢复依赖丢失全部 Task ID 后靠 List 找回，当前为阻项，不能赌未来薄接线。[R][C][B] |
| 5. 重复消息不触发已完成副作用 | R 原 Host 丢答、同 key/fullpayload 回原 resultId，异文 409，唯一命令/结果/最终反馈；N 创建的原受理 commandKey 与索引关联。 | 同层原结果重发；原 P4 精确 RPC/operation/message 重放回原 receipt，独立新 query 与业务结果查询分开。G 续签不变领域对象，旧 receipt/SQLite 计数不增，改 body 冲突。 | 结果动作的必要场景已证；不宣所有未知副作用可安全重做。G 的自动 result:null→append attempt→fetch 及再次崩溃只源码核对。HTTP proof 重放防护属于门 2，不能凭本门幂等抵消。[R][G] |
| 6. 跨权限访问拒绝 | N 原 owner 映射与授权取件；W/G 当前企业末门、无 source 权主体拒、移除直 Node/token/body 拒，另一 Work 合法；群管理员不变成人 owner。 | 同 W/G 企业权威；DID 成员资格不授 Resource/File；移除前全敏感 fanout 暂停，signed receipt + unsigned fresh roster + target backlog/最终 state 通知校准后才 confirmed。 | 共同产品控制与本轮群 reader 域有有限实证。单 owner 正控加未知 bearer 401 **不是两合法 owner 跨 Task 隔离实测**。现原型单 principal 的 Task index 范围、真实当前 owner API 门可源码核；若选择支持多主体同一 receiver，最小新增证据是两已有合法主体对同一已知 Task 的 Get/List/Cancel/文件只读或拒绝对照，不再跑业务整旅。不可把该未测项宣 passed 或用群 roster 代企业权限。[N][W][G][B] |
| 7. 可固定许可与依赖 | 固定 JS SDK 1.3.0，规范 1.0.1 / wire 1.0 分开；包、lock、SRI/SHA、实际安装与许可正文引用有 I/D 原件。普通 SDK runtime 声明图含 SDK+jose 两位置。 | 固定 TS SDK 0.9.5、规范集 1.2、AWiki 09d38fd8…；真实 frozen uv.lock / ANP Python 1.0.6 / runtime43+dev8、key/source/许可引用分层。 | 可复算固定性已有事实，不是法律意见或生产最小发行许可结论。`jcs` 元数据声明 Apache-2.0、单独正文未定位，保 unknown，不自动推“无法固定”。SDK optional peer、平台库和部署 closure 要按真实采用条件核，不能以普通 deps2/7 冒完整安装体积。[I][D] |

## X10：原型差额与架构资格分别决定

| 实际条款/角色 | 已观察结果 | 对本次架构裁定的含义 |
| --- | --- | --- |
| A2A owner Task unsupported version | B 中同 Task、同 owner、相同 body 与其余 headers，`9.9` 返回 HTTP400 / `error.code="INVALID_REQUEST"`；规范要求 `VersionNotSupported -32009`。**failed**。 | 当前端不能宣该条符合。源边界是实验 HTTP catch 未保规范 RPC 错误；未证其造成越权、重复结果或已知 ID 恢复失败。可以评估为选中后显式错误映射工作，不能先写成已修复。 |
| A2A owner Task List | 同 owner Get 真原 Task 200；一次无过滤 List 200、`tasks=[]`。**failed**。缺失 Task 正控实际为 `-32001`，该条通过。 | 当前 `store.list` 固定空，不能用“空库”通过。只有现 principal/receiver/Task 索引加当前授权投影足够、且关键恢复不依赖未证的新发现权威，才可将它列为 T03b 明确工作；否则现在就是关键能力阻项。 |
| ANP Home→固定 Host 身份层 | 两层错签按各自错误拒绝、无新 message/event/operation/delivery；原合法 HTTP 签名对需认证 `group.get_info` 精确重放，两次均读到实时私有 roster/policy，非 mutation 缓存。**HTTP 防重放拒绝未证**。 | 没有据此推“坏签接受”“撤权后仍读”或“写副作用重跑”。若冻结目标要求同 HTTP proof 不得再次取得私有数据，该能力当前不能当已满足；拟议补层必须进入可信边界与运行成本，不得靠 Home 缓存宣保护公开 Host。 |

若 root 在架构决定中选择 A2A，T03b 至少显式包含以下差额，仍需另授权实施与验收：

- 在现传输边界保 JSON-RPC id、规定数值码和错误结构，按固定规范映射 unsupported version；原 `Get1.0→9.9` 反例要变为规范 `-32009`，missing 继续 `-32001`，原受权查询行为保。
- 由现 `common/business-tasks.mjs` 的 receiver/principal/Task 关联索引取候选，逐项走原当前 Work/owner 授权与原 Task 投影；按规范 `status.timestamp` 降序、cursor/末页 token、默认 Artifact 可见性做 List。**不新增 Task 状态权威，不从群或自由消息猜结果。** 验收至少包含当前已知可见 Task 的非空 List、最小分页/顺序与两个合法主体的权限对照；不能把模型/Job 再执行当补枚举。
- 现 no-event-bus Cancel handler override、unknown 非终态、已知 Task 重开、群 journal/fanout/当前 Node 数据门继续为必须保留的自建责任。上述两条薄差额不替这些既有能力，也不证明所有 A2A MUST 已过。[B][C][R][G]

ANP 如需额外 replay 防护，先由 root 决定安全目标与范围。拟议方案至少须明确：验证哪个 HTTP service DID/key 与内层 actor；覆盖哪个真实 endpoint/target/method；proof/nonce 的有界或持久 replay 责任、重启时处理、过期清理、失败可用性；所有 direct Host 入口是否不可绕过；operator 谁维护其状态和升级。当前公开 Host 仍可绕过 Home，**只在 Home 增 cache 不具备这一保护**。新的不可绕过 ingress/认证状态是未证的新可信边界及成本，不是已经实现的薄接口；本片不设计或部署它，不改 AWiki、不另造第二 GroupHost，也不承诺未来 T03b 自动补过硬门。[B]

### 所采用 Profile 的逐角色执行库存

| 角色/适用范围 | live/历史已有事实 | 仅源码、not-run 或有据条件项 |
| --- | --- | --- |
| A2A relay、owner Task、应用群 | D 分别真实 Card/官方 resolver；均声明 JSONRPC1.0、streaming=false；N/R/C/G/B 各按自身入口执行。 | relay/应用群为 Message-only，不强套 Task store 测试；owner Task 仍有上述两 fail。未宣的业务 streaming/push/extended Card 正向功能按对应 Card 条件项，规定的 unsupported 错误仍未全核。 |
| 独立 A2A Express peer | streaming=true Card 与原独立 peer Task/stream/restart-cancel预检有各自原件。 | 这是 harness，不能为三个 streaming=false 业务入口或生产全标准符合背书。无并行流承诺不额外发明 MAY→MUST 矩阵。 |
| ANP-02 / P1：Home caller、Host receiver、Group assertion | B 两层签名分离负控、G/R 原 origin/receipt 幂等与当前 receipt 检验；签名 key 用途区分。 | HTTP 原 proof 再读差额保；所有目标/媒体/非法参数/错误语义及旧 DID 精确重放排序并未全跑。`rfc9421-origin.test.ts` 或 Host 源测试存在不等本轮执行。 |
| P2：Home、member、独立 Host、Group DID | D 五份真实 DID 的 ID/serviceEndpoint/serviceDid/key 引用和 live capabilities；G 原 group/roster 与成员身份关联。 | 无独立 AgentDescription 声明链接则未猜 URL；主动 AD 目录/身份迁移/成员 DID 更新等按实际采用条件另列 not-run，不能把整个 P2 写 N/A，也不能从 e1_ 字样推完整迁移通过。 |
| P3：Home caller/receiver 与 Host | Home 的 live 方法广告为 direct.incoming、group.incoming、group.state_changed；group 实际收发证据不当 direct 流程。 | direct.send→独立 incoming、三种 P3 必需载荷与其余幂等/错误义务未全验证，保 not-run；attachment-manifest 媒体不等 P7。 |
| P4 group.base.v2：独立 Host、管理 caller、member Home | G 的真实 owner-local create、admin add/send/remove/get_info、签 state/receipt、双序/版本、current reader 校准；Host 外域 create policy 不广告为支持远端 create。 | leave、更新 profile/policy、Host 协调成员 DID 更新、完整错误/权限与重放组合等仍在原 inventory。fresh roster 本身 unsigned；单域 receipt 的 MAY/SHOULD 与跨域依赖 MUST 不混。 |
| 固定 Host 额外 group.v1、attachment.v1、federation.relay.v1 | D service DID/live caps 原样广告；方法在 `/result/features/methods`，不是顶层 `methods`。 | vendor 角色 conformance 未全验。产品采用 group.base.v2、原授权文件应用 ref、单域流程，不给 Geneway 额外支持分；**不能把 Host 的 P7/P8 声明写 N/A**。P8 是 federation；P9 mentions 仅在无真实 mentions 标识/采用时按该条件 N/A，不与 federation 混号。 |

完整待核清单仍为原 [Profile inventory][P]。可只读索引上游 `test_did_discovery`、`test_identity_documents:304`、`test_direct_messages:332,374,638`、`test_group_v2:66,85,100` 和 TS proof 测试；这些名字只表示潜在最低成本的证据入口，不表示本轮跑过。只有结果会改变当前架构选择时，才建议 root 另授一个定向验证，不默认补全所有 vendor 功能。

## 完整必要角色、包图与状态提交域

下面是**逻辑部署闭包**，不是宣称所有角色已在一个 run 中独立进程或已按此生产共置。Task 正常、群撤权、命令 relay 分别有自己的实际根；能否共置及共置节省均未测。两个候选共同使用原 DSH/Host、FileStore/Bridge、model gateway、Evidence/Office/Artifact 服务：比较增量只计一次；每个实际节点的基线进程/安装仍需计入其本机总量，不能把“一次基线”解读为五个 Agent 共用一个执行进程。

```text
共同执行/数据面：C、PC-A、PC-B、G、analysis 的 Node/DSH/Inbox-Outbox
  -> 原 Bridge / Work FileStore / model gateway / Evidence / Office / Artifact

A2A 方案：私网 protocol client -> 云 Message relay -> 原 Agent command 事务
          授权 Task peer -> 云 Task server -> 关联索引 + 原 Work 当前投影
          群 principal -> 云应用群/fanout journal -> opaque locator
                     -> 原 Node/fullbinding 当前数据门

ANP 方案：现场出站入口 -> 云 Home / 每 actor DID -> 固定 GroupHost / SQLite / outbox
          Host -> Home receiver -> 私 Task应用映射或Work群 opaque locator
                                -> 原 Work / Node / Resource / 文件授权
```

| 必需角色/归属 | 现有实现和包闭包 | 权威提交域、维护者与状态恢复 | 实际观察/未测成本 |
| --- | --- | --- | --- |
| 两边共同执行与数据面 | 原 Node/DSH、Bridge、Work/model/Evidence/Office/File；现本地 Linux/Node，DSH 上游固定组合。 | Geneway 产品维护；Work/Delegation/Attempt、模型 reserve、command receipt、ready 仅原产品事务提交。Host Journal 掌实际摄入/stop/slot，Artifact owner 自 ACL 独立。 | N/W/C 有实际五角色/Job；协议附加成本不再重复计整套基线。现场采集影响、完整机器峰值未知。 |
| 共同协议关联与企业解读 | `common/business-tasks.mjs` 的 Task metadata index；`work-group-domain/journal` 的 locator/Node 权限门；原授权接口。 | Geneway 维护。索引关联原受理 commandKey/digest/Work/root，不是第二 WorkStore；协议 journal 与云事务异步，不能假跨库原子。 | N/R/G 证明相应关联恢复与拒绝；完整掉电/损坏/多 receiver 组合未全测。 |
| A2A 私网 client | `common/protocol-client.mjs` 的 A2A 分支、官方 client；当前 SDK+jose 普通 runtime 声明闭包 2。 | Geneway 映射 Node/instance/role/current binding，SDK 维护 wire 编码；普通重试不得变成新执行。 | I 只采 C/PC-A 经双代理；完整 A/B/G Task+Group client 的加载/CPU/RSS未知。 |
| A2A 云 Message relay | `adapters/normal-relay.mjs` 的官方 JSONRPC Message 分支，原 Node 凭据最终授权。 | Geneway command 关联/错误处理；原 accepted receipt 回放不授新数据权。 | I receiver 有独立 PID；不得把 relay RSS 当 Task/group 总成本。 |
| A2A 云 Task server | `adapters/a2a/business-server.mjs` + 原 Work 投影 TaskStore/mapping，原 Node HTTPS，无生产 Express 需求。 | Geneway 维护 principal 授权、Task-local Artifact/ready、no-bus cancel override 与错误/List 差额；SDK save 不得造终态。 | N/R/C/B 有正常/恢复/取消/只读真实入口；完整部署峰值、生产包、跨合法 owner 对照仍未测。 |
| A2A 应用群管理与收件 | `adapters/a2a/work-group{,-wire}.mjs` + 共同 journal/domain；独立 principal/context/admin。 | Geneway 自建成员、fanout、delivery/opaque ACK、pending 校准和 current body 门，非 A2A 原生 group。 | G 有独立桥 PID、真重开/两实际 recipient；额外升级/运维责任必须计入，不因 SDK 包少就免费。 |
| ANP 现场出站入口 | `common/protocol-client` ANP 分支向云入口发送；设备 actor 与 human/group admin 分开。 | Geneway 维护设备原 credential→DID/current operation 关联，不让群资格代企业授权。 | I 的两 Host 模拟出站有证；完整现场角色部署/加载/弱网组合未全测。 |
| ANP 云 Home 与 actor DID | `adapters/anp/home.mjs`；TS SDK 0.9.5、bs58 等声明 runtime 图 7；DID proof/HTTP signature、解析映射、incoming 持久化。 | Geneway 维护 key 配置/轮换和 current recipient admission；fixture 固定 actor 配置与正式 registry 接线需在 T03b 明列。 | D/B/G 有真实 Home/签名/收件；本地 resolver-map 不冒公共 DID/TLS 部署资格。Home 可与应用服务拟共置，但未测节省。 |
| ANP 私 Task 应用层 | `adapters/anp/business-entry.mjs` + 共同 Task index；owner+Home 私群，只回合法 reader 域。 | Geneway Task schema、主动 get/request correlation、原 Work/Q/ready 投影和授权下载；不是 ANP 原生 Task。 | N/R/C 有真实创建/接续/恢复/取消；这些不是 Home 内 pendingMap 唯一权威，也不是 Host 业务 WorkStore。 |
| ANP Work 群管理与校准 | `adapters/anp/work-group.mjs`，**实际调用** `peers/anp/group-control.py`；管理员签名 helper 虽在 peer 目录，当前闭包不可漏掉。 | Geneway 持久 intent/protected op/认证 attempt、receipt/roster/target backlog 校准和补扫；新认证不换业务操作；自动 null/再崩溃分支仍仅源码检查。 | G/K2inBo有真实 Host 接纳及自然过期续签；未实现通用可靠群平台，不建第二 Host。 |
| ANP 固定 GroupHost / receiver | AWiki commit `09d38fd8afc803c16ab61cd629c0c8ea3747edc6`，Python3.11 / ANP1.0.6，frozen uv.lock runtime43；SQLite、keys、delivery outbox。 | 上游维护实现，采用方负责运行/补丁/备份/公钥与暴露面；Host 独掌成员/排序/协议 receipt。与 WorkStore、Home journal 不跨库原子。 | I/G/D/B 有独立 Python PID与 SQLite/真实通知。虽然起初叫独立 peer，**当前方案依赖的 Host 必须计作部署成本**，不能当免费测试设施；同一已部署 Host 的不同群不再重复计整套 Python 包。 |
| 纯测试/观察角色 | 独立 A2A Express peer 声明 closure70、Python devOnly8、D4 driver/独立 peer CLI、oracle、proxy、collector、load trace、故障屏障。 | 测试维护者，非业务状态权威；service/child wrapper 里的测试日志、故障 IPC 与正式运行接缝分别核。 | 不把 Express70或 dev8乘到所有 edge，也不偷偷从实际测试环境总盘扣除。当前联合安装76位置与候选所用 closure 分列。 |

当前源码按文件整份统计的可复算维护表面如下：共同 `business-tasks/work-group-domain/work-group-journal` 为 19247 B / 224 物理行；A2A `business-server/work-group/work-group-wire` 为 36615 B / 346 行；ANP `home/business-entry/work-group/group-control.py` 为 41196 B / 283 行；混合候选的 `normal-relay/protocol-client/wire` 为 21192 B / 169 行，不能整份同时摊给两边。数字包含注释/空行和长行，**不是新增 diff 行、总代码量、复杂度或工时分数**；上表进程配置/运行接缝、上游代码和纯测试另外列出，不能据此说 ANP 行少或 A2A 字节少就更简单。

库存 I 中 JS76原位置的 version/integrity/license 与实际 name/version一致；历史 lock SHA `c6aa…` 与当前 `305af988…` 来源分列，不覆盖旧 artifact。普通依赖与 optional peer 不混，SDK 的 optional peer 条件不能由 `optionalDependencies: []` 推“没有可选依赖”。许可元数据、真实 LICENSE/NOTICE/METADATA 路径与 SHA 可复算，`jcs` 单独正文 unknown 保留。包计数是声明闭包，不是实际加载或物理安装体积。[I]

I 的 CPU ticks/CLK_TCK、RSS/HWM、I/O、wire chunk bytes、启动屏障和盘 inode 只按实际采样窗口解释。PC-A 短命 DSH worker未命中 phase 采样，其资源 unknown；Python/DSH import trace未覆盖也保 unknown，这是两种不同缺口。跨根盘按全局 dev/ino 去重，19个外链后补为 current inventory，不回填 startup；RSS合计会重复共享页，JSON wire payload不是总IP/TLS流量。模型 usage/cost未给保 null。**没有完整 Task→Group→Get 角色峰值、共置节省、生产最小包或代表性网关运行成本数字。**

## 权重、退出条件与现在交给 root 的决定

原权重名称与数值不变；只在两完整方案具备所需资格后比较，不给当前 unknown 填分：

| 评价项 | 权重 |
| --- | ---: |
| 首条业务链与任务恢复的适配成本 | 25% |
| 群组和组内协作语义 | 25% |
| JS/DSH 接入与调试维护 | 15% |
| 私网接入与弱网处理 | 10% |
| 网关资源与打包成本 | 10% |
| 独立互通、升级与长期维护 | 10% |
| 许可和可追踪发布产物 | 5% |

原 §4.7 条件继续适用：两边过门且 ANP 群优势成立、成本同量级才优先 ANP；若 ANP 需显著补建 Host/原生组件或目标网关无法可靠部署、而 A2A 过门，则记录原因后采用 A2A+Geneway群；若 A2A 群/Bridge补建明显更多且 ANP 有已验证组件满足流程，则采用 ANP；两边不过先缩有证运行组合或修共同阻塞，不引第三协议。原 3–4 人日实验、T03b 2–3 人日薄接入是估算，不把时间到当能力通过或任意停止完整 Goal。需要自建完整 GroupHost或大量 MUST补齐时列差额与退出条件，不无限补平台。最终只接一个主标准实现，另一个留 fixture/映射，不消息双发或运行时自动切协议。[附件]

**现证据足够讨论架构取舍，但不足以给当前两原型全部过门/规范符合或发布结论。** 已知 ID 恢复、结果幂等、真实取消、企业当前权限与私 Work 群有可复用事实；不必为“看起来完整”重跑 D4。现在最便宜且会改变选择的项按顺序为：

1. **root 先裁身份目标/暴露面。** ANP 的已签私有 get_info 可重复读取是已知事实。若该边界在冻结目标不可接受，先决定是否允许一个不可绕过、职责有限的新可信入口并计成本；不接受/固定组件无法安全满足，则按 §4.7 记 ANP 当前组合缺口或退出，不能靠 Home cache/未来承诺。若 root 裁定当前有时效证明重用边界可接受，并确认适用规范条件，也须明确受保护传输、当前权限检查与相应威胁范围；不能直接改写“HTTP 防重放已过”。本片不代 root 作此安全决定。
2. **只核会决定资格的最小读权限/发现边界。** A2A List现有真实缺口是否只需沿既有 principal/Task 索引作当前授权投影，可以由上述源链审查及最小两合法主体的已知 Task读/List对照决定，不需模型、Office Job或新状态引擎。若核心恢复需要超出此索引的新发现机制，立即列阻项，不先赌薄。ANP P1–P4 的剩余义务如有一条真实暴露面可能推翻现身份/群可用性，只提该具体条款/原上游测试，不默认一口气补完所有 vendor 特性。
3. **暂不建议为了评分新跑性能。** 当前决定性差别是可信边界与自建职责，未知不能用性能分补。只有前两项后双方均可行、且 root 写明一个具体成本阈值会翻排序时，才另授权一次同负载 Task→Group→Get 小测：同模型/工具路径、同部署角色/共置假设，计必要 Home/Host/Task/group完整 union。若 ANP 为安全满足要求必须新增持久服务而 A2A 仅沿现索引/SDK边界补接，先比较职责和固定闭包；若两者职责/部署负担已处同量级且群优势确认，则按原规则处理，不为凑分重复采样。没有现成全栈 RSS/CPU/磁盘/工时阈值，本文不编数值。

上述是交给 root 的可审决策依据及最小后续授权选择，不是获批的新实验/可信层/T03b 工作单。任何架构选择均须保留两条 A2A 实败、ANP 私有 roster 重放边界和未核 Profile清单；选中不等于该能力已实现或可发布。

[附件]: </home/gewu/.codex/attachments/07a5837b-ff01-4554-8c89-8455d4c05803/geneway-implementation-plan-2026-10-28 (1).md>
[S]: /home/gewu/.codex/task-checkpoints/geneway-evidence/simulation-target-freeze-20261107.json
[N]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-normal-business-final-approval.json
[R]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-recovery-final-approval.json
[C]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-cancel-final-approval.json
[W]: /home/gewu/.codex/task-checkpoints/geneway-evidence/work-member-removal-final-approval.json
[G]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-work-groups-final-approval.json
[I]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-role-cost-final-approval.json
[D]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-profile-discovery-final-approval.json
[B]: /home/gewu/.codex/task-checkpoints/geneway-evidence/protocol-profile-boundary-final-approval.json
[P]: /home/gewu/.codex/task-checkpoints/geneway-protocol-conformance-inventory.md
