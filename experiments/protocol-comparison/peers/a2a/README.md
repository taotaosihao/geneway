# 独立 A2A 官方 SDK 对端

此目录是协议比较用的独立对端，仅依赖固定的官方 `@a2a-js/sdk@1.3.0`、Express 和 Node 标准库。它不导入被测 adapter、Geneway 领域执行器或共同 fixture，不写 Geneway 状态。SDK 包版本、协议基线和实际 wire 版本分别记录：本对端广告并使用 JSON-RPC wire `1.0`；这不等于完整规范 v1.0.1 conformance。

## Server

在实验目录依赖已安装后运行：

```sh
node peers/a2a/run.mjs --config /absolute/path/peer-config.json
```

配置示例：

```json
{"root":"/absolute/path/isolated-peer","host":"127.0.0.1","port":0}
```

标准输出仅发布 `event:"ready"` JSON，包含 `origin`、`pid`、`protocol`、`versions`、`root` 和 `tokenFile` 路径；日志写 stderr。导出入口为 `startA2aPeer(config)`，返回同样的身份、地址及 `close()`。

- AgentCard：公开 `GET /.well-known/agent-card.json`。
- 唯一业务 transport：`POST /a2a`，官方 JSON-RPC handler 和 SSE。
- 认证：`Authorization: Bearer ...`，独立随机凭据持久保存在 root 的 `client-token`，文件权限 0600。不输出凭据正文。`ROLE_USER` 只是协议消息角色，不授予任何真人或 Geneway 权限。
- HTTPS：配置 `tls:{keyFile,certFile}`；证书必须覆盖 127.0.0.1。客户端使用显式 `caFile` 信任私有 CA，保留 TLS 验证，不修改全局环境。

## 官方独立 client

```sh
node peers/a2a/client.mjs --config /absolute/path/client-config.json
```

配置字段：`origin`、可选 `tokenFile`、`caFile`、`cardPath`、`operation`、`request` 或 `requestFile`、可选 `outputFile`、`timeoutMs`。操作为 `discover`、`sendMessage`、`stream`、`getTask`、`cancelTask`、`listTasks`。它可以直接指向被测 adapter 的 endpoint。

模块导出 `createA2aClient(config)`，返回 `{client,card}`。`client` 是官方 SDK Client，只配置 JSON-RPC factory，未做跨 origin 凭据转发。下例是内部 SDK 的 v1 对象；CLI 的 request JSON 也使用这一形状：

```js
const request = {
  message: {
    messageId: crypto.randomUUID(),
    role: Role.ROLE_USER,
    parts: [{content: {$case: 'text', value: '独立执行回声'}, mediaType: 'text/plain'}],
    metadata: {peerExecution: {mode: 'finite', steps: 3, intervalMs: 25}}
  }
}
await client.sendMessage(request)
await client.getTask({id: taskId})
await client.cancelTask({id: taskId})
await client.listTasks({status: TaskState.TASK_STATE_UNSPECIFIED, includeArtifacts: true})
```

有限执行默认 3 次文件副作用。`peerExecution.mode:"busy"` 表示持续执行，用于真实取消；获取进行中 Task 需设置顶层 `configuration:{returnImmediately:true}`。没有实现的 existing-Task follow-up 在执行前返回官方 unsupported 错误，不将其伪装为业务修订或让 SDK 的执行失败分支覆盖仍活跃的 Task。

首次实际预检发现：在固定版本中将缺少 `status` 的裸对象传给 `listTasks`，client 会序列化成服务端拒绝的 `-1`。预检修正为显式枚举 0。这只记录当前 API/wire 实测，不推导规范对缺省字段的结论。

## 持久与停止证据

`tasks.json` 是独立、按认证 owner/tenant 分隔的 TaskStore。`executions/<taskId>/` 保留原输入摘要、真实 worker PID/startTicks、逐次 `effects.jsonl`、进程生成的 `result.json` 和实际退出后生成的 `cancel-proof.json`。server 重启保留 Task 与原 worker，不重造执行；这不是对断电或任意存储故障的声明。

正常 `close()` 停止本 root 的 worker；测试 server 重启时可使用 `close({preserveExecutors:true})`，CLI 对应 `preserveExecutorsOnClose:true`，之后必须通过真实 CancelTask 或本 root 的清理结束 worker。

固定官方 handler 在重启失去 event bus 后会直接写 canceled。因此本对端有两处明确自建成本：取消前先停止并核验原 worker 退出；TaskStore 拒绝没有退出证明的 canceled 保存。Task 状态由官方 handler/ResultManager 写入，副作用与退出由独立 OS 进程和文件 oracle 核对，不声称原 SDK 自带该保证。相关官方源码见 [DefaultRequestHandler](https://github.com/a2aproject/a2a-js/blob/29417a5bb4038f804f310ce4fffd267a9375aa90/src/server/request_handler/default_request_handler.ts)。

```sh
node peers/a2a/preflight.mjs
```

预检通过真实 HTTP wire 检查发现、Task、SSE、持久查询、API 重启而 worker 继续、取消后进程实际退出、未认证拒绝，以及不支持的 follow-up 不改变活 Task。产物在外 Git `geneway-evidence/protocol-a2a-peer-*`，所有自有进程均收尾。HTTP 预检不代表 HTTPS 验链、与主 adapter 的双向互通、全 X01–X10 或最终协议选择；这些以各自后续实际证据为准。
