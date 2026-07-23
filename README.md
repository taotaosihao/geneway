# geneway

`geneway` 是面向制造业的通用数字员工平台。客户只与“小纬”交互，也可以指定一个专家或专家团；后台 Agent、Workflow、工具和模型都受统一权限、审批、证据与审计约束。

当前仓库是独立于旧 Paperclip fork 的全新产品代码基地。Gate R、Gate 0.1、Gate 0.2A 和 Gate 0.2B.1 Task / Workflow 产品路由纵切已关闭；Gate 0.2B.2–0.2B.3 已从当前关键路径延期且仍未关闭。当前正在实施 **Gate A0 Fast Chat：无材料真实基础聊天**，A0.1 首问和 A0.2 上下文、取消与失败语义已经进入代码，A0.3 正在完成 LAN 与回归加固。

## 局域网开发验收环境

运行下面一条命令，会启动当前已验收的临时开发栈：

```bash
pnpm dev-up
```

该命令会自动启动 PostgreSQL、VersityGW、存储适配器与 reconciler、Control Plane、loopback Model Gateway、独立 UDS Worker 和 Vite Web。Web 会同时监听本机活动网卡上实际存在的 `192.168/16` 与 `10/8` 地址（默认端口 `3200`），无需指定地址环境变量；不会监听 `0.0.0.0`，也会排除 Tailscale、Docker bridge、libvirt 和 VMware 地址。Control Plane 默认监听 `127.0.0.1:3100`，Model Gateway 默认监听 `127.0.0.1:3150`。默认端口在任一入口被占用时会为全部入口一起向后寻找空闲端口并打印最终地址，显式指定的端口被占用时则安全失败。例如：

```text
局域网入口（本机同样使用）：
  http://192.168.0.104:3200/conversations/new
  http://10.0.0.8:3200/conversations/new
```

只会为当前主机实际拥有且处于活动状态的地址创建入口；终端会逐行打印最终可用地址。其他设备能否跨子网访问仍取决于主机防火墙、WireGuard `AllowedIPs`、VLAN ACL 和路由设置。

也可以覆盖端口：

```bash
GENEWAY_WEB_PORT=4200 GENEWAY_CONTROL_PLANE_PORT=4100 pnpm dev-up
```

安全边界保持不变：只有 Web 精确监听自动发现的 `192.168/16` 与 `10/8` 地址；Control Plane 和 Model Gateway 仍只监听 `127.0.0.1`，disposable release helper 也只使用自动选择的 loopback 端口，PostgreSQL、VersityGW 和存储适配器使用随机 loopback 端口，Worker 只使用本机 `0600` token 和 Unix-domain socket。Control Plane 只接受本机地址和本次打印的局域网 Origin，不接受任意跨域写请求。provider auth-file 只投影给 Model Gateway 和验证本次 disposable candidate 的 release helper，不进入 Web、Control Plane 或 Worker 环境。

该环境采用单用户、共享会话的 trusted-local LAN 模式：所有能够访问本次 `dev-up` 所打印 192/10 地址的设备都视为同一个 `tenant_local/user_local`，共享 Conversation、上下文与取消能力，不提供配对、注册、登录或 LAN 设备之间的隐私隔离。Origin 和私网监听只用于限制暴露面，不是用户认证；因此只能在明确可信的局域网中使用。正式身份与多用户隔离属于后续独立身份切片，不属于 Gate A0。

按 `Ctrl+C` 会按 Web → Worker → Control Plane/release helper → Model Gateway 的顺序停止进程，并删除本次临时数据库、对象存储卷、网络和临时凭据。该环境只用于开发与验收；停止后数据不会保留，也不会启动 ERP/MES Connector 或生产写操作。同时提供已授权的 `GENEWAY_CODEX_SUBSCRIPTION_AUTH_FILE` 与尚未过期的 `GENEWAY_MODEL_GATEWAY_CONFORMANCE_FILE` 时，脚本会为同一 run 创建最长 15 分钟且不超过 conformance 到期时间的 disposable `internal` candidate，并在它真正就绪后才启动 Web；没有完整有效的 provider 前置条件时真实聊天保持 fail closed。

如果其他局域网设备无法访问，检查主机防火墙是否允许所选 Web TCP 端口；不要开放随机 PostgreSQL、S3、存储适配器端口或 Worker socket。

## 当前执行权威

- [Gate A0 Fast Chat 最终实施合同](doc/plans/atlas-workflow/20260723-002-geneway-fast-chat/implementation-contract.final.md)是当前唯一可执行范围权威；它只覆盖无材料真实聊天，不自动授权产品代码实施。
- [Gate 0.2B 最终实施合同](doc/plans/atlas-workflow/20260722-009-geneway-gate-0-2b-task-exception-projection/implementation-contract.final.md)保留为延期工作的范围权威；Gate 0.2B.1 已关闭，0.2B.2–0.2B.3 未完成、未开放，Gate A0 关闭后再恢复。
- [Gate A 最终实施合同](doc/plans/atlas-workflow/20260723-008-geneway-gate-a-gearjob/implementation-contract.final.md)已提前锁定真实材料分析与 GearJob 单工单只读查询的后续范围；它必须等待 Gate A0 和恢复后的 Gate 0.2B.2–0.2B.3 关闭，也不授权当前产品代码或跨仓 GearJob 修改。
- [Gate 0.2A 最终实施合同](doc/plans/atlas-workflow/20260722-003-geneway-gate-0-2a-artifact-evidence/implementation-contract.final.md)保留为已关闭基线。

支持材料不授予新范围：

- [技术附录](doc/plans/2026-07-18-geneway-v19-technical-appendix.md)
- [界面设计 ADR](doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/ui-design.md)
- [非执行路线图](doc/plans/2026-07-18-geneway-v19-reimplementation.md)
- [Gate R 验收记录](doc/migrations/gate-r-verification.md)

## 实施顺序

```text
Gate R（已关闭）
→ Gate 0.1（已关闭：小纬安全模拟纵切）
→ Gate 0.2A（已关闭：Artifact / Evidence）
→ Gate 0.2B.1（已关闭：Task / Workflow 产品路由）
→ Gate A0（当前合同就绪：无材料真实基础聊天）
→ Gate 0.2B.2–0.2B.3（延期：异常 fixture 投影与加固）
→ Gate A（真实文档分析 + GearJob 单工单只读查询）
→ Gate B–G（长任务、动态 Workflow、异常/日报、多渠道和多 Runtime）
```

Gate A0 的默认公开入口现在是无 capability query、无需材料的 `/conversations/new`；显式“分析材料”仍由页面入口进入既有 `solution.analysis.v1` 材料门。Gate A0 是否关闭仍以聚合门和两个真实 LAN 浏览器的共享 Conversation、上下文与取消验收为准，不能仅凭脚本或单测声明完成。Gate 0.2B.2–0.2B.3 延期不等于完成或取消，恢复时仍必须遵守其原合同。Gate A 已有未来合同，但在进入条件关闭和另行实施授权前不是当前执行范围；Gate B 及以后仍只是路线图。新代码必须遵守当前实施合同；旧仓库只作为可恢复历史和文件级迁移来源，不得从 dirty worktree 直接复制，不得整包合并、rebase 或 cherry-pick，也不得引入 `@paperclipai/*` 运行依赖。
