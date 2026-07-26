# Gate 0.2B 回归汇总

V7 三组回归全部 PASS：

- Gate 0.2A baseline：169 containers、20 networks、40 proxies、3 backup runs、104 boundary receipts；包含 13 个 recovery test keys、success/negative 与 Gate 0.1 served 纵切。
- Gate 0.2B.1 baseline：22 containers、6 networks、12 proxies；served task/workflow route 1/1 PASS。
- local A0 no-business-objects：8 containers、2 networks、4 proxies；默认 `/conversations/new` 显示 Fast Chat 和“无需上传材料”，只新增一个 Conversation，BusinessException、BusinessTask、ApprovalVersion、WorkflowVersion、Evidence、Artifact、model invocation 均为 0。

local A0 定向命令为 `pnpm test:e2e -- --project=gate0.2b-fast-chat-local`；未执行完整 Gate A0 live/LAN、未启动 Model Gateway、未调用 Responses/Chat Completions、未读取 provider credential。

共享 LAN 信任模型和默认无材料聊天入口未被本切片改变。
