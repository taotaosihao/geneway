# 微信 iLink 协议来源

来源为 npm [`@xmanrui/dsh-im@4.39.0`](https://www.npmjs.com/package/@xmanrui/dsh-im/v/4.39.0)，2026-10-15 经 `npm view @xmanrui/dsh-im version license dist.tarball dist.integrity repository --json` 核实当时 `latest` 为 `4.39.0`，许可 MIT。发布包在任务临时目录通过 `npm pack @xmanrui/dsh-im@4.39.0` 获取，未安装或运行上游 Host。

- 源仓库：<https://github.com/xmanrui/dsh-im>
- 发布包：<https://registry.npmjs.org/@xmanrui/dsh-im/-/dsh-im-4.39.0.tgz>
- npm integrity：`sha512-FsfOr/qCfSqeyIOuHGk9MEYlo7xioNDkV+wtAo//v+D0tTAm/B6x1a60LYGHAZdCrUBgI80wnEZHlDcGBBaOUA==`
- 原始 MIT 许可完整保存在相邻 `LICENSE`。

`weixin-api.mjs` 摘取并修改上游 `src/channels/weixin/weixin-api.mjs` 中的协议常量、请求头、`base_info`、二维码申请、扫码状态查询、`getUpdates`、`sendText`、`weixinMessageId` 和 `splitWeixinText`。`orderWeixinMessages` 来自上游 `src/channels/weixin/weixin-runtime.mjs`；同文件的轮询退避和停止语义由 `plugins/weixin.mjs` 采用。扫码字段及重定向处理对应上游 `src/channels/weixin/weixin-controller.mjs` 的 `#runProvisioning`，未引入该 controller。

必要修改：

1. 删除图片、文件、语音、CDN、输入状态、Host、Session、工作区、Agent Preset、模型配置和命令能力。`notifystart`/`notifystop` 未有收发必需性证据，未引入；不发心跳或遥测。
2. 地址覆盖只能由显式 `testMode: true` 配合本机 `http://127.0.0.1:<port>/` 或 `http://[::1]:<port>/` 启用，扫码返回地址必须保持同一 origin；正式地址仅接受官方微信域 HTTPS，凭据、非标准端口与 URL 查询覆盖被拒绝。HTTP 禁止重定向，避免 Bearer 泄漏。
3. 扫码确认只把原始 token 交给服务端 `onConfirmed` 秘密回调，返回值仅含状态、bot ID、owner ID、可信连接地址。取消/过期与最终 Web 确认由 C1 产品服务负责，回调必须检查当前扫码尝试仍有效，不能据此自动激活身份。
4. 低层 `getUpdates` 的原始响应只供本机服务端运行时使用，包含原始游标和发送上下文，不能作为 Web、日志或模型内容。运行时只通过 `secrets.read/write` 接触它们；`tokenRef/cursorRef/contextRef` 必须是三个不同的稳定秘密引用，引用的持久原子更新与 0600 存储由 C1 复用既有 secret resolver 实现。
5. 上游异步 `void bridge.accept` 改为逐条等待 `acceptInbound` 返回持久 `accepted/rejected`；全部完成后才更新秘密游标。写入失败不确认该批。运行时不存业务映射或队列；平台稳定 ID 去重由 C1 的唯一 inbox 承担。
6. 只将固定 owner 的私聊文本交给产品受理；非主人、回声、非文本和无效消息以安全拒绝码交给同一 durable inbox。本人私聊非文本的上下文仍以秘密引用保存，以便 C1 经既有 delivery 路径发送固定不支持提示；协议层不绕过权限自行回复。序号以无损十进制字符串保存并用 BigInt 比较；旧或重复序号不能替换上下文，时间独立拒绝回退，混合缺失字段时保留已有高水位，不能恢复精度的数字序号不更新上下文。
7. 每个 bot 使用现有 `acquireAutomationOwner`/`flock`，目录固定在 `/tmp/geneway-weixin-<uid>/<sha256(botId)>`，不随 data root 改变。目录须为当前用户所有、0700、非符号链接，锁文件沿用 0600。解绑或插件卸载须 `close()`；已关闭对象不能再次启动，重挂须创建新对象。凭据失效停止消费且不自动重连。
8. `sendText` 的 `client_id` 由持久 attempt ID 与分段序号派生，确认每段后等待 `recordSendProgress` 持久化，全部确认才 delivered。失败重试必须传入相同 attempt ID、原正文和已确认分段；unknown 不能重试。每段前 `beforeSend` 必须重新校验产品 claim 并精确返回 `true`，其他结果 blocked；C1 必须拒绝 unknown/delivered 的再次 claim，进度回调不得因一次被拒的调用改写这些终态。未知、取消、网络错误或无法解析的成功响应均不能推断 delivered。已确认部分不会重发；进度写入失败抛安全错误，C1 恢复时须将未完成 sending 视为 unknown。
9. 分段避免拆开 UTF-16 代理对。协议异常只保留固定安全错误码，不携带原始响应正文、URL、token、context 或 cursor。仅有效非零整数协议状态码表明拒发；null、布尔值、对象、非整数字符串等异常状态码按 invalid-response/unknown 处理，不能变成可重试的 failed。

对接点 `createWeixinRuntime({ bot, secrets, acceptInbound, onRuntime, beforeSend, recordSendProgress, api })` 是每个 bot 的有限传输生命周期。`bot.id` 是稳定平台 bot ID，`channelAppId` 为产品 app 引用，`ownerUserId` 是经本人 Web 确认后固定的 owner。`acceptInbound` 只接收文本、平台稳定 ID、时间、拒绝码与 `contextRef`；不能把拒绝消息升级为受理。`beforeSend` 和 `recordSendProgress` 均由同一产品 delivery 事实源实现。`createWeixinPlugin(runtime)` 将该实例的启动和关闭交给实际 Cordis Host 生命周期。

本目录及相邻协议测试只证明协议与传输行为，不证明成员绑定、会话隔离、Web 确认、业务执行或 P4 完整验收。后续同步上游时，应以该版本发布包逐项比较上述源文件并重跑 `node scripts/test-p4-weixin.mjs`，保留这些受理、权限、秘密和 unknown 边界。`node scripts/test-p4-weixin.mjs --protocol-only` 仅跳过 SDK/Cordis 生命周期检查，默认命令仍完整运行；跳过时不形成同 Host 生命周期结论。
