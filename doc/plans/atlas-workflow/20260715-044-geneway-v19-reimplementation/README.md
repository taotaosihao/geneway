# geneway 制造业数字员工平台 v19 重新实施工作流包

任务：`20260715-044-paperclip-agent-mvp`

本包把 v19 已选方向转成下一轮编码可直接执行的合同。完整路线见[主实施计划](../../2026-07-18-geneway-v19-reimplementation.md)。

## 目标

产品名、仓库名和新本地目录统一为小写 `geneway`。在验证归档后创建 greenfield Git 历史，实现 Capability-first 制造业数字员工内核，冻结旧 Paperclip Builder Spike，按新合同选择性迁移 Runtime、Tool 和 Channel 机制。

## 锁定方向

- 新建干净的 `taotaosihao/geneway` 和 `/home/gewu/work/geneway`，TypeScript-first；旧 `taotaosihao/GeneWay` 和 `/home/gewu/work/GeneWay` 先做可恢复归档。
- 对象存储复用 Hive/Sharp Cell 的 VersityGW + S3 API 路线，不使用 MinIO。
- 客户只看到一个通用数字员工“小纬”；用户可让小纬自动安排，也可指定一个专家或一个专家团，专家仍只在后台协作且不能扩大权限。
- Control Plane Postgres 是业务单一权威。
- Workflow 是受限、版本化数据；Hatchet 只执行固定 Interpreter。
- Workflow 必须用 React Flow 节点图展示、对比和审批，不能只用文字描述。
- Model Gateway 和 Tool/Connector Gateway 是强制出口。
- MVP Capability 为 `solution.analysis.v1` 和 `production.work-order-status.v1`；异常助理和生产日报后置。
- `/home/gewu/work/gearjob` 是首个真实只读 ERP/MES 联调系统；先查询一个指定 Work Order 的状态与进度，设备异常、产能落后和日报在后续 Gate 扩展。
- WebChat 先行，飞书为第一个正式 IM 渠道。
- OpenAI Runtime 先行，MVP 复用旧分支已验证的 OpenAI Agents SDK + `aisdk()` + OAuth provider 共享 Codex 订阅开发车道；它只用于可信本机测试，Claude 作为第二 Runtime 验证，生产改用正式 Model Gateway 凭据。
- 复用优先：迁移旧分支的 Runtime worker/provider conformance、结构化输出、取消/预算、故障测试、Evidence bridge、渠道签名/幂等/重试与 SSE 恢复；不迁移 Paperclip 业务模型。
- AgentTeams、A2A、DeerFlow、AgentScope、LangBot 后置且可选。

## 文件

- [执行澄清](clarify.md)
- [执行规格](spec.md)
- [合同索引](contract-index.md)
- [最终实施合同](implementation-contract.final.md)
- [界面设计说明](ui-design.md)
- [技术实施附录](../../2026-07-18-geneway-v19-technical-appendix.md)
- [方向决定](decisions/selected-direction.md)
- [责任说明](staffing.md)
- [证据索引](evidence/evidence-index.md)
- [2026-07-19 Team Review](reviews/2026-07-19-team-review.md)

## 下一步

Gate R 的技术迁移已经完成，详情见[验收记录](../../../migrations/gate-r-verification.md)。用户确认本仓库为后续唯一产品代码基地后，先实施 Gate 0.1 的小纬最小可运行纵切与同 run 安全硬门；Gate 0.2 再增加异常待办 fixture。Gate A 使用共享订阅完成文档分析，并以 GearJob 单 Work Order 只读查询完成第一个真实业务闭环，不先扩展复杂异常、日报、第二 Runtime或多渠道。
