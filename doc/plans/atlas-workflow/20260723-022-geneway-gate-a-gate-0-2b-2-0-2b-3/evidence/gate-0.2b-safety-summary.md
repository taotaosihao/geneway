# Gate 0.2B 安全汇总

## 网络与 listener

- 13/13 structural isolation receipts PASS，violations 为空。
- 13/13 process lifecycle receipts PASS；survivors、added unsafe endpoints、sample errors 均为 0。
- 14/14 cleanup receipts 在 processes、listeners、globalListeners、egress、containers、workerSockets 六类均 `added=[]`。
- unsafe listener、non-loopback egress、forbidden process 均为 0。
- ambient/ownerless listener 只能用 PID/fd/startTicks/socket inode/sk/cgroup/netns/executable/interface/network identity 的精确链路释放；descendant 来源不得被 transient proof 清除。

## subnet fail-closed

旧 V8-39 因 artifact-only network 可借用全局 internal subnet 被 fresh reviewer 判定 FAIL，明确不得用于关闭。修复后：

- 78/78 observed network occurrences 均有非空、非重复、合法 IPv4 CIDR。
- 13 个 artifact-only networks、26 个 proofs 的 network ID/name/project/subnets 精确一致；target IP 均属于 frozen CIDR。
- 109/109 container netns sockets 只使用同一 container exact attachments 映射的 subnet；8 组同 CIDR 多网络也未跨 attachment 授权。
- 空 subnet 且无 socket、借用另一 internal network CIDR、exact multi-attachment 三类负向测试全部通过。

## 权限与凭据

顶层及 13 个 child credential receipts 均 PASS、`valuesRead=false`；`authPathAccessed=false`；source/run-artifact secret scan findings 为空。没有真实 provider、Model Gateway runtime、GearJob、Hatchet、生产数据或外部 API 行为。FakeRuntime 只保留合同允许的模拟语义：`simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`。
