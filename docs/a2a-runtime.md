# A2A 运行入口

Geneway 使用固定的 `@a2a-js/sdk@1.3.0`，提供 A2A 1.0 JSON-RPC 入口。Work、Delegation、Attempt、Node、模型额度、Job 和 Artifact 仍由原业务服务管理；协议 Task 只关联这些已提交事实。

## 服务配置

通过 `GENEWAY_A2A_CONFIG` 指定仓库外的私有 JSON 文件。配置文件和接收方凭据文件都必须是当前用户所有的普通文件，权限为 `0600`，路径必须为绝对路径。凭据是 43–128 个字符的 base64url 随机值，只在请求的 `Authorization: Bearer …` 中发送。

```json
{
  "version": 1,
  "nodeCommands": true,
  "workGroups": true,
  "receiver": {
    "receiverId": "owner-work",
    "workspaceId": "local",
    "memberId": "owner",
    "principalId": "managed-owner",
    "credentialFile": "/srv/geneway/secrets/a2a-owner.token"
  }
}
```

`memberId` 必须指向现有且启用的成员；其当前员工权限继续约束创建、输入、查询和文件读取。配置限定一个受管接收方。`receiverId` 和 `principalId` 标识该受管协议范围，消息中的 `ROLE_USER` 不会自行取得成员权限。接收方私有凭据不交给 Node 或浏览器。

只启用已配对 Node 命令时，可使用 `{"version":1,"nodeCommands":true,"workGroups":false}`。未配置 `GENEWAY_A2A_CONFIG` 时不发布 A2A 入口。Work 群依赖 Node 命令入口，且只为已关联协议 Task 的 Work 派生元数据。

发布入口与原服务共用 `GENEWAY_TRUSTED_ORIGIN`：

- `GET /.well-known/agent-card.json`：实际启用角色的公开 Card。
- `POST /a2a`：官方 JSON-RPC transport，每次请求使用 `A2A-Version: 1.0`。
- Task 返回的同源 Artifact URL：使用同一受管接收方身份读取原 ready 文件。

HTTPS 由部署环境的原 TLS 边界提供。运行包不包含测试 CA、证书生成器或测试私钥。

## 受管 Work Task

`SendMessage` 使用一个 `application/json` data Part。以下为 data 内容；`parameters` 沿用原多点协作创建接口的业务字段：

```json
{
  "schema": "geneway.a2a.task/1",
  "receiverId": "owner-work",
  "operation": "create",
  "clientRequestId": "incident-20261107-001",
  "rootEmployeeId": "coordinator",
  "parameters": {
    "employeeId": "coordinator",
    "goal": "整理已授权来源并交付整改表"
  }
}
```

创建多个 root 时，必须用 `rootEmployeeId` 明确本 Task 关联的 root；歧义会被拒绝。上传附件仍走原 owner 会话、Origin/CSRF 和附件接口，Task 只引用该成员有权使用的附件。相同受管范围、`clientRequestId` 和业务内容回放原 Task；同键异文拒绝。

输入使用 `operation:"input"`，并在标准 Message 的 `taskId`、`contextId` 中指定原 Task。业务 `parameters` 包括原 `expectedInstructionRevision`、`replyToQuestion` 和修订内容；不要在其中另传 `workId` 或 `clientRequestId`。问题和修订仍由原 Work 事务校验。

默认 `SendMessage` 等待 Task 到达终态、需要用户输入或需要认证的状态；`configuration.returnImmediately:true` 返回已持久受理的当前 Task。断开等待不会取消业务。Node 命令和群消息即时返回原业务答复或元数据 ACK，不等待子委派完成。

`GetTask` 和 `ListTasks` 每次投影当前可读的 Work。List 支持状态、context、状态时间及分页，默认不附 Artifact；游标绑定当前接收方、主体和筛选条件。使用固定 SDK 的 `client.listTasks()` 时，未筛选状态应显式传 `status:0`，避免该 SDK 将省略的枚举编码为 `UNRECOGNIZED`。

`CancelTask` 复用原 owner 取消事务。停止确认前保持非终态；原执行停止事实到达后才返回 canceled。仍有 owner 身份但已失去员工读取权限时，只允许原 Task 的局部清理，答复不附问题、历史正文或 Artifact。

Task 内 Artifact ID 与全局 Artifact ID 不同；`metadata.globalRef` 保留原文件引用，URL 每次继续检查当前 owner 和 ready 文件权限。SDK 的 Task 对象不能覆盖领域状态。Card 不声明 streaming、push notification 或 extended Card；流方法返回规范的 unsupported 错误。

## 已配对 Node 和应用 Work 群

Node profile 的 `transport` 默认为 `internal`。显式设置 `"transport":"a2a"` 后，原 `agentCommand` 使用官方 A2A client；失败不会回退或双发到旧命令接口。配对、Bridge 命令接收/ACK/resync/stop、模型、Evidence、Job 和文件通道继续使用原身份与授权。

应用 Work 群只传 opaque 定位符和收件元数据。Node 自己接收并持久保存元数据，再发送精确 metadata ACK，随后以本人当前 binding 读取有限正文。ACK 只证明定位符收件，不授予正文或工具权限，也不会再次唤醒 DSH。群轮询使用独立、有界通道，不阻塞原停止和 slot 清理。

Work 成员移除仍是原 Work 的单向否决。被移除者只能清理已有的精确元数据 ACK；新命令、旧 token 的新读取和群正文继续受当前权限约束。其他 Work 和 owner 已发布成果的独立权限保留。
