# 同场比较测量接点

此目录只读取实际进程和磁盘，不启动协议服务。`collector.mjs`导出：

- `measureProcess(pid, {expectedStartTicks})`：两次核`/proc/PID/stat`身份，保原CPU ticks、实际OS CLK_TCK、RSS/HWM、进程I/O计数。退出、读失败或PID复用保原因，不补零。
- `processDelta(before, after)`：仅同PID/startTicks与有效时间间隔计算CPU及I/O差值。CPU百分比以单核100%为基准。
- `snapshotTree(root)`：计唯一普通文件inode的逻辑与allocated bytes，保每文件明细；不忽略依赖或sidecar目录，不追symlink。外部symlink目标另列，runner须将其真实依赖根计入，不能因此漏成本。并发文件变化不是原子快照。
- `collectSnapshot({phase, processes, roots})`：phase取`cold-start/ready/idle/busy/after-fault/stopped`；processes为`{id,role,pid,startTicks}`，roots含各候选全部自建代码、依赖及运行数据目录。库存由runner实际记录，collector不能从缺失列表推断“没有额外进程”。
- `coldStart({spawnedAt,readyAt})`：实际spawn和真实ready屏障时间差；ready不得以spawn成功或固定sleep代替。
- `countWire(rows)`：每条`{id,requestBytes,responseBytes}`必须来自真实序列化传输计数；缺失、重复和负数报告不完整，不按对象数量估算。协议接纳、Host ACK、模型消费和业务完成另记。

三候选用相同runtime/fixture/身份修订/故障序列。sample phase与持续时间、observer本身开销、采样误差、external roots和未观测I/O权限必须随结果披露。最初的collector自进程自查保原范围；当前另有role-flow三路小委派样本及独立oracle，原根与限制见上级README，不把它们当完整Task服务或现场资源资格。


`snapshotRoots(roots,{externalRoots})` 对所有根的普通文件按全局 dev/ino 去重，保每根明细和未显式覆盖的外链，不能直接把各 `snapshotTree` 总数相加。运行后补外部根的 current inventory 与原 startup snapshot 分开，不回填历史；symlink 元数据/系统库/未声明根不自动算作完整物理占用。

`role-inventory.mjs` 只产生安装声明与许可事实；`role-loaded.mjs` 是实际模块 URL trace，未覆盖的 DSH worker/Python import 保 not-run。`role-flow.mjs` 的样本目录、资源窗口、短进程 unknown、角色 PID、wire payload 与 disk attribution 见上级 README 和外 Git `protocol-role-checks-20261106/metrics.json`。没有评分或winner。
