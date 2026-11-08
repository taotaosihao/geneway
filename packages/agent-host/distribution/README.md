# Geneway 内部 Linux x64 G Host 包

仅支持 Linux x64、Node.js 24 或以上，依赖系统 `sh`、`flock`。本包包含固定已安装的官方 DSH 与必要传递依赖，不包含 Node.js。只支持 `officeEnabled:false` 的内部 G 使用组合；保留当前代码静态所需的 Office 校验依赖，不宣称 Office 执行已验收。

解压到独立目录。将仅保存在本机的 JSON profile 放在包外，设置 `root` 为独立、可写的绝对目录，`origin` 为获准 API 地址，`officeEnabled:false`，初次配对时附带 API 签发的 `pairing`。运行 `bin/host /absolute/profile.json`。数据根包含私有配对身份和会话，不可公开；同数据根重启保留身份。启动器清除 NODE_PATH/NODE_OPTIONS，不安装全局服务。

`bin/diagnostics /absolute/data-root /absolute/diagnostics.json` 导出本地白名单计数；缺失或无法读取的事实保留 unknown，不导出凭据、profile、正文、原始日志或业务文件，不上传。基础启动器不主动排空或注册系统服务，不把 SIGTERM 退出称为 drain。成对离线更新见下文。

## 本机离线更新与成对代码回退

新增维护入口只支持已验证的 Linux x64、Node.js **26.5.0**、DSH **0.2.0-rc.2**、Journal v3 和当前 DSH Session v4，`officeEnabled:false`。原内部包 A 不修改；B 以 A 的实际内容为基线，仅增加维护代码、入口和文档。安装目录与业务 dataRoot 分开，安装只绑定一个绝对 dataRoot。此流程不迁移数据、不回退云端或现实动作，也不注册系统服务。

从解压后的 B 运行以下命令（目录均为绝对路径，`INSTALL` 必须尚不存在）：

```sh
B/bin/update prepare INSTALL DATA_ROOT A B
# 输出 previous 与 next，分别是两份包实际内容的 buildId。
B/bin/update launch INSTALL /absolute/profile.json
B/bin/update activate INSTALL EXPECTED_BUILD_ID TARGET_BUILD_ID
```

两版均须经 B 的 `update launch` 启动，它在解析 current 前取得安装选择锁，选择锁由实际 Host 继承并持有，直到原版 Host 进程退出才释放；管理父进程意外退出也不会提前释放。实际 Host 和 runtime-worker 仍来自所选 release 的原启动器与模块。`activate` 使用相同安装锁和原 dataRoot owner 锁：Host 仍在运行（即使空闲）、存在 unknown、待执行 Inbox、未 ACK Outbox、未停止 Job、未发布 capture、残留 worker 或不支持的格式时返回 `DEFER`（退出码 75），不向 Host 发信号、不替用户停止任务、不修改 current。先由原业务 owner 自然收束或明确停止任务，取得真实停止回执、释放 slot 且 ACK 后，再正常退出 Host 并重试切换。`EXPECTED_BUILD_ID` 不匹配也延后，防止覆盖另一操作。

成功切换只原子更新安装目录的 `current`；身份、Journal、Session、手动控制和已发生效果的记录均保留。回退使用同一命令交换两个 buildId，再经同一维护入口实际启动 A；这仅支持记录的 A/B 成对代码，不能外推任意旧版本或其他平台兼容。撤权后的原身份仍按原权限进入 cleanup-only 或被拒绝新业务，不自动重新配对。
