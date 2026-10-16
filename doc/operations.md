# Geneway 安装与运维

本说明适用于本机 Linux x64 的独立 Geneway 实例。产品使用一个 Node 主进程及其自有 DSH/SDK 子进程，入口是 `node src/server.mjs`，仅监听 loopback。源码、依赖安装、产品数据、服务端秘密和登录认证分别存放。安装或恢复到本机测试根不代表已部署、发布或完成用户验收。

## 安装与目录

运行环境要求 Node ≥24，包管理器按 `package.json` 固定为 pnpm 11.8.0。当前验证环境的 Node 为 26.5.0。使用已有 Corepack/pnpm 入口，在一个空的安装目录解开指定提交的 tracked 源码及 lockfile；不带入原 `.git`、`node_modules`、`var`、未跟踪文件或凭据。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

三个 DSH 直接包同为 `0.2.0-rc.2`，MCP client 为 `2.3.1`，飞书 SDK 为 `1.74.0`。Cordis 等独立发版依赖由 lockfile 锁定。不要分别追各包 latest 或修改安装时的依赖版本。

仓库的 `pnpm-workspace.yaml` 对五项精确版本 lifecycle 设置 `allowBuilds: false`。当前 Linux x64 包集已带所需平台预编译产物，Google hook 为 no-op，protobufjs hook 只做版本提示；DSH 的 spawn-helper 修正仅影响具有该文件的平台。此策略不使用全局 ignore-scripts 或关闭严格构建检查。锁包变化后，新的未审脚本会使安装明确失败；缺少所需预编译包或 ABI 不相容时须停止并定位，不自动构建或添加跨平台 fallback。

建议将以下目录放在一个由运维独占的实例根，且将 `private`、`secrets`、`config` 和备份根设为 0700：

```text
实例根/
  app/                         冻结源码与安装依赖
  data/state.json              唯一产品事实源
  data/dsh/                    本实例的 DSH home 与关联 Session
  data/event-sources.json       固定 Kivo 事件来源配置
  private/auth.json            登录口令校验与 cookie 签名材料，0600
  secrets/                     服务端凭据文件，各 0600
  config/runtime.env           固定非秘密启动配置，0600
  config/connection-catalog.json 可信连接目标目录，0600
```

应用安装目录可替换；数据、秘密及认证路径均由当前实例的启动配置明确绑定，不依赖旧安装目录或验收临时路径。

## 配置责任

| 配置 | 所有者与语义 |
| --- | --- |
| `GENEWAY_STATE` | 主机运维指定的产品 state 绝对路径。产品服务通过 file-store 维护，不能在运行中手改。 |
| `GENEWAY_DSH_HOME` | 本实例独占 DSH home。服务启动时将 `DSH_HOME` 绑定到同一路径；工作、协作与会话共用这一实例边界。 |
| `GENEWAY_SECRET_ROOT` | 主机运维维护的独立 0700 秘密目录；被引用的凭据是常规 0600 文件。 |
| `GENEWAY_MODEL_CREDENTIAL_REF` | 实际模型 key 文件的简单文件名引用，两条获准 ZenMux 路由共用。不是路径，也不是 key 正文。 |
| `GENEWAY_AUTH_FILE` | 仓库外认证文件绝对路径，由停机维护 CLI 供应；不进入普通备份。 |
| `GENEWAY_CONNECTION_CATALOG` | 仓库外可信目录绝对路径，必须为常规 0600 文件。产品后台只能在该目录登记的精确目标上配置连接。 |
| `GENEWAY_HOST` / `GENEWAY_PORT` | 主机运维指定监听位置；host 只能为 `127.0.0.1`、`::1` 或 `localhost`，port 默认 3471。 |
| `GENEWAY_TRUSTED_ORIGIN` | 浏览器实际入口的准确 HTTP origin；与当前 loopback host/port 保持一致，用于写请求的 Origin 校验。 |
| `data/event-sources.json` | 运维按真实 Kivo subscription、resource、sourceInstance 和 signingSecretRef 设置；路径固定属于当前 data root。秘密正文只在 secrets 中。 |

`config/runtime.env` 只保存上述非秘密值和路径引用，不保存密码、模型 key、私钥、渠道 token、游标或发送上下文。后台连接里的 `credentialRef` 必须与可信 catalog 一致。Kivo 连接的 resource 为准确 `/api/v1/mes/mcp` 地址，issuer 是同 origin，clientId 是获准机器账号身份。

产品模型路由中的 `credentialRef: ZENMUX_API_KEY` 是执行时的环境键。真正要备份的文件由 `GENEWAY_MODEL_CREDENTIAL_REF` 指定；不能把环境键自动当成文件名，也不为第二路由复制一份凭据。

## 停机供应成员与认证

使用 `scripts/init-p2-auth.mjs`，它与产品共用 data root 的 owner 锁；目标实例尚在运行时拒绝维护。操作前正常停止产品。所有维护模式都会生成新 cookie 签名材料，成员完成维护后重新登录。

显式名单为 JSON 数组。首次供应和增补新成员使用完整事实；新成员的角色、启用状态和员工范围均须明确提供：

```json
[
  {
    "id": "member-admin",
    "authRef": "member-admin",
    "loginName": "admin",
    "displayName": "管理员",
    "role": "admin",
    "enabled": true,
    "employeeIds": []
  },
  {
    "id": "member-user",
    "authRef": "member-user",
    "loginName": "member",
    "displayName": "成员",
    "role": "member",
    "enabled": true,
    "employeeIds": []
  }
]
```

由本机受控秘密输入向子进程提供 `GENEWAY_MEMBER_PASSWORDS` JSON 对象，键为名单中的 authRef，值为 8 至 4096 字符的口令。不要把正文写进命令参数、shell 历史、名单文件或日志；脚本结果只输出供应的引用。映射须精确覆盖本次名单，不接受额外身份。

```sh
node scripts/init-p2-auth.mjs --mode bootstrap \
  --state "$GENEWAY_STATE" --auth "$GENEWAY_AUTH_FILE" \
  --members "$GENEWAY_MEMBERS_FILE"
```

`bootstrap` 用于首次供应。至少保留一个已启用管理员；已有兼容的迁移成员保持原 facts。产品 facts 写入成功而认证创建失败时，保持停机，修复输出路径或文件权限，再运行原名单与原命令；同身份 facts 不会重复创建。认证文件已经成功创建后，再次 bootstrap 会明确拒绝，此时使用所需的 add 或 rekey。

```sh
node scripts/init-p2-auth.mjs --mode add \
  --state "$GENEWAY_STATE" --auth "$GENEWAY_AUTH_FILE" \
  --members "$GENEWAY_MEMBERS_FILE"
```

`add` 只增补名单中的新成员。已存在的成员须匹配原 id/loginName/authRef；其角色、启用状态、员工范围和会话版本保持当前 facts，未列成员及其认证记录保留。重复运行不重复创建，也不将停用成员启用。更改已有角色或开放范围使用普通后台配置入口。

恢复后重新供应或轮换已有成员凭据使用 `rekey`。该模式的显式名单只含原 id/authRef：

```json
[
  { "id": "member-admin", "authRef": "member-admin" },
  { "id": "member-user", "authRef": "member-user" }
]
```

```sh
node scripts/init-p2-auth.mjs --mode rekey \
  --state "$GENEWAY_STATE" --auth "$GENEWAY_AUTH_FILE" \
  --members "$GENEWAY_MEMBERS_FILE"
```

rekey 不修改产品成员 facts。恢复到全新 auth 文件时，显式列出所有需要重新登录的成员；旧 cookie 不会被新签名材料接受。未提供 `--members` 的既有 bootstrap/rekey 仍保留 admin/member 两账号兼容入口，分别使用 `GENEWAY_ADMIN_PASSWORD` 和 `GENEWAY_MEMBER_PASSWORD`，不适合供应完整企业名单。

## 启动、配置与正常停止

由运维核对并加载本实例 `runtime.env` 后，在冻结应用目录运行：

```sh
node src/server.mjs
```

浏览器访问配置中的 origin；管理员配置员工、开放成员、Skill、模型路由和可信连接，普通成员只在当前开放范围内执行。两条获准 ZenMux 模型为 `deepseek/deepseek-v4.1-flash` 与 `z-ai/glm-5.3-flash`，前者为默认。模型输出上限通过路由参数配置，范围 1 至 4096；省略时保留既有值，新路由默认 4096。路由不可用时明确失败，不自动切换模型。

成员在本人工作或会话详情查看实际执行结果、路由、耗时、用量和停止原因；缺失的 usage 或费用保持未知。管理员运维视图只展示调用量、耗时、错误码、路由与渠道连接等元数据，不能读取他人标题、目标、prompt、知识、正文、结果或 Session。排查业务内容由成员主动提供必要信息。

使用前台 Ctrl-C、SIGINT 或 SIGTERM 正常停止已核实身份的主进程，并等待其自有 SDK 和渠道资源关闭。记录主进程 PID、启动目录和实例配置；处理残留时只核实并处置本实例的自有进程，不按端口扫描并杀进程。

连接测试通过只证明当前目录/协议/认证可用，不证明机器账号组织范围非空或业务数据正确。`MODEL_NOT_CONFIGURED` 检查服务端 ref 和文件权限；`SOURCE_NOT_CONFIGURED` 检查可信连接与事件来源；`FORBIDDEN` 核当前成员、员工、连接、渠道身份和上游机器授权。未知效果先按稳定业务身份回读，不能通过重试假定第一次未成功。

## 成套备份

RPO 是最后一个完整停机快照。先正常停止当前实例并确认关闭；备份期间保持数据和配置不变。记录源码提交、lockfile、Node/pnpm 版本及固定启动配置。普通包与秘密包必须使用独立空目标，不能与数据、DSH 或秘密根重叠。

```sh
node scripts/state-transfer.mjs backup \
  --output "$GENEWAY_BACKUP_PRODUCT" \
  --secret-output "$GENEWAY_BACKUP_SECRETS" \
  --secret-root "$GENEWAY_SECRET_ROOT"
```

该命令继承已核实的 `GENEWAY_STATE`、`GENEWAY_DSH_HOME`、`GENEWAY_MODEL_CREDENTIAL_REF`，可通过非秘密 `GENEWAY_CANDIDATE` 记录候选。普通包收集 state、全部关联 Session 和固定 event-sources.json；秘密包按当前引用收集模型文件、连接私钥、渠道凭据/游标/上下文和事件签名文件。两路模型共用一个实际引用，只收一份。普通包不访问秘密根，未指定 secret 参数时不会备份秘密。

另在受限配置目录配套保存固定的 `runtime.env` 与可信 `connection-catalog.json`。这两份文件由主机运维维护，未由 state-transfer 自动收集。保存后核对 catalog 目标元组、模型实际 ref、事件来源及候选对应，不扩展为任意文件归档。认证文件与旧 cookie 签名材料不随包复制。

普通包和秘密包通过 state/event 摘要及准确引用集合绑定。若普通包成功而秘密包失败，保留失败结果，使用两个新空目标重新制作配对包；半包不能作为完整恢复点。秘密包目录保持 0700、文件 0600，并与普通访问材料分开保管。

## 恢复到新根

1. 在新空应用目录安装同一候选源码与锁包；准备互不重叠的空 data 和 secret 目标。
2. 从受限配置备份核对原实际模型 ref，并明确给恢复命令提供 `GENEWAY_MODEL_CREDENTIAL_REF`。ref 文件名保持匹配备份；新秘密根的绝对路径可改变。
3. 执行成对恢复：

```sh
node scripts/state-transfer.mjs restore \
  --input "$GENEWAY_BACKUP_PRODUCT" \
  --data-root "$GENEWAY_RESTORED_DATA" \
  --secret-input "$GENEWAY_BACKUP_SECRETS" \
  --secret-root "$GENEWAY_RESTORED_SECRETS"
```

4. 在新 `runtime.env` 中将 state 指向新 data/state.json、DSH home 指向新 data/dsh、secret root 指向新秘密根，auth 和 catalog 指向新仓库外路径；校验新 catalog 为常规 0600 文件，保留准确 resource/issuer/clientId 与目标绑定。
5. 用恢复后的原 member/authRef 名单执行 rekey，创建新认证与签名材料。保持成员 role/enabled/employeeIds；恢复快照之后发生的撤权、停用和解绑必须先复核，旧快照不是上游当前授权的权威。
6. 首次启动保持规则暂停、事件来源关闭、渠道关闭；由本人检查历史和关联，核对外部授权，需要时重新绑定渠道。先做新的获准只读操作，再明确开放所需功能。

所有 manifest、路径、文件类型、字节数、摘要、来源和状态迁移校验都在目标写入前完成。缺少模型 ref 或配对不符时明确拒绝。产品状态已恢复而秘密发布失败时，外部收发保持关闭；使用新空 data/secret 目标重新恢复完整配对，不能在半恢复根上假称完成。

恢复后的活动执行标为中断，历史保持当时来源、时间、单位和判定；未用批准失效，在途动作/发送保持 unknown；规则暂停，pending 来源目标 suppressed，事件来源 disabled；渠道应用 disabled，微信 rebind-required，已发送消息不重发。Geneway 不恢复或回滚 Kivo/Hive 数据库，已创建的维修单不因恢复而消失。按稳定 GW 单号与机器审计核对未知效果，不自动重放旧批准或业务写入。

## 升级、回退与兼容维护

升级前保存成套的 code、lock、data、DSH 和固定外置配置/配对秘密。DSH 同发行列车的包保持精确同版，独立版本依赖按上游相容约束锁定。核对默认插件/工具清单、Session 格式、历史读取、取消、恢复及当前批准能力；未知插件或工具不能直接放行。

回退顺序为停止候选、保留升级后数据，在新空根恢复升级前完整集合并验证。不能让旧二进制读取新格式，也不能覆盖升级后已发生的外部业务效果。出现不相容事实时先关闭外发、保留当前证据，评估修复前进或明确恢复；仅改版本字符串不构成回退。

U0 原始 v3 Session 与旧 package/lock 位于 `var/u0-upgrade-backup/20261015-0.1.6-alpha.2`。该历史素材当时没有默认 state，不能当成完整产品快照；在隔离根复制原 Session 验证解码和回退，原件保持只读，不重新调用退休业务来源。

微信复用来源和九项本地差异见 [iLink 来源说明](../vendor/dsh-im/weixin/SOURCES.md)。2026-10-16 的一次有界官方 registry 核对确认 latest 仍为 `@xmanrui/dsh-im@4.39.0`、MIT，实际下载包的 sha512 与来源记录一致，无新包需要同步。后续只比较已记录的协议/扫码源文件；保留 owner 校验、持久受理后游标、单消费者、秘密引用、分段确认、unknown 和禁止额外外发等边界。回归入口是：

```sh
node scripts/test-p4-weixin.mjs
```

`--protocol-only` 只覆盖协议，不能替代默认命令的 SDK/Cordis 同 Host 生命周期，也不能代替产品成员绑定和完整渠道旅程。

当前 Kivo 相容基线为独立仓库提交 `ae27a4e97ddfa5248d4461bd563d9e907489b81c`，唯一 `agent-mcp` 实现使用 SDK server/client 2.3.1、MCP 2026-07-28，client-credentials 扩展锁定 ext-auth `fb374c7db2b34f18ca9183882e0beecdf661892b`。MES 目录当前含 11 个 TPM 读取、监控读取和维修创建共 13 个工具；Geneway 模型仅注册产品的 record/list/correlation 三个只读工具，维修创建只供本人批准后的确定性执行器。

Kivo 分支、SDK 或规范变化时，先在获准独立 clone 比较协议、OAuth、输入/输出 schema 和权限；保留 `server/discover`、准确协议/方法/名称头、拒绝旧 initialize、资源受众和当前账号复权，不放宽固定工具/schema 允许清单。业务定位使用 trace、机器账号、准确 sourceInstance、业务单号和独立只读回执；不把外部 OAuth token 传给业务 API，不直连数据库或设备。

当前代码仅提供 loopback HTTP。未来网络部署需另行授权，并保持 TLS/私网、OAuth/MCP well-known 路径、Origin/resource/issuer 与反向代理一致；数据库、Redis 和服务端秘密不对公网暴露。本说明不执行或授权这些部署动作。
