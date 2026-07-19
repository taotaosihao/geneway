# geneway 证据索引

- [2026-07-19 Team Review](../reviews/2026-07-19-team-review.md)：三条只读审查线的去重结论、已接纳修订和复核命令。
- `implementation-contract.final.md` revision 7：修复 Gate 0 安全顺序、动态 Harness、审批快照绑定和 Atlas 标准业务验收包；三条聚焦 Team Review 均为 `GO`，剩余 P0/P1 为 0。

## 已审查来源

- v19 方案附件：Capability-first、Control Plane、Workflow Interpreter、ApprovalVersion、Model Gateway、Context Graph、Claim–Evidence–Lineage、能力门和推荐代码结构。
- `doc/GOAL.md`、`doc/PRODUCT.md`、`doc/SPEC-implementation.md`：Paperclip autonomous-company、task/comment、not-a-chatbot 和 external runtime 产品边界。
- `doc/DEVELOPING.md`、`doc/DATABASE.md`：当前仓库开发、数据库和迁移约束。
- 旧 `codex/longtask-agent-mvp` 计划分支。
- 旧 `codex/longtask-agent-mvp-implementation` 实现分支及文件清单。
- Atlas workflow `analysis.md`、`context.md`、`decision.md` 和 `spec.md`。
- `/home/gewu/work/hive/docker-compose.yml`、`backend/app/services/object_storage.py`、`backend/app/core/config.py`：VersityGW POSIX backend、S3 endpoint/path-style、boto3、tenant prefix/hash 和对象存储配置。
- `/home/gewu/work/sharp-cell/docker-compose.yml`、`apps/fms-api/src/modules/object-storage/`：固定 `versitygw:v1.5.0`、`@aws-sdk/client-s3`、bucket ensure、put/get/head/delete 和 `s3://` URI 合同。
- `/home/gewu/work/gearjob/PRODUCT.md`、`README.md`、`DESIGN.md`：GearJob 的 ERP/MES 产品边界、制造业对象和现有 Frappe UI；仅作业务语境参考，不作为 `geneway` 正式视觉。
- `/home/gewu/work/gearjob/gearjob/mes/bigscreen_api.py`：Work Order 进度、告警、设备、停机和 KPI 的现有聚合逻辑。
- `/home/gewu/work/gearjob/gearjob/mes/schedule_api.py`：MES Schedule 延期、工作中心负荷和排程时间窗口逻辑。
- [React Flow 官方文档](https://reactflow.dev/) 与 [xyflow GitHub](https://github.com/xyflow/xyflow)：Workflow 节点图基础组件及 MIT 开源核心；不采用 Pro 模板。

Hive/Sharp Cell 的 UI 均未正式对外定稿，本轮只确认其 VersityGW/S3 实现和个别现场交互可供参考，不能作为 `geneway` 设计验收证据。

## 仓库证据

- 本轮修订前计划基线：`d18bddec5225932d3bf6744df6b98efe1b493f1a`；检查时工作树干净。
- 当前旧 origin 为 `git@github.com:taotaosihao/GeneWay.git`，upstream 为 Paperclip；新 `taotaosihao/geneway` 必须在归档验证后以干净历史创建且不保留 Paperclip upstream。
- 旧 implementation：`c2f6d8b978017753447cd416db1d67f8ae8db53d`。
- 旧 implementation 相对 master：255 个文件、26,274 行新增、244 行删除。
- 旧 worktree 检查时存在未跟踪 `workflow/`，计划明确禁止清理或覆盖。

## 已运行验证

```text
pnpm --filter @paperclipai/adapter-openai-agents test
结果：18 test files / 107 tests passed

pnpm --filter @paperclipai/plugin-channel-gateway test
结果：9 test files / 41 tests passed
```

这些结果只证明旧底层机制可作为迁移来源，不证明旧产品架构符合 v19。
