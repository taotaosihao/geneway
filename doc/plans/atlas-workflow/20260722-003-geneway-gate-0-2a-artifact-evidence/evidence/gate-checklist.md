# Gate 0.2A 验收清单

最终结论：**PASS**。本清单只汇总可复现门禁，不替代原始 runner 证据。

| 验收域 | 状态 | 关键证明 |
| --- | --- | --- |
| Product | PASS | 真实 served 小纬页面完成上传、快照、专家路由、Workflow 审批、独立 Worker、模拟结果、Evidence 和双 Artifact；取消分支无 Claim/报告 |
| Authority | PASS | Postgres 单一权威；S3 只存不可变字节；Worker 只走 UDS command port；terminal publish 使用 attempt/fence/CAS |
| Evidence | PASS | published Claim 必须有有效 supports link；原始 byte range/hash 由 Control Plane 重验；报告 lineage 可回溯到 snapshot/workflow/attempt/template |
| Storage | PASS | 固定 digest 的真实 VersityGW，create-only、hash、幂等、双向 inventory 和 reconciler 20/20 |
| Safety | PASS | multipart/XSS、双 principal/tenant、expiry/retention、下载重授权、secret 隔离和 fail-closed 21/21 |
| Delivery | PASS | Outbox/Inbox、lease、attempt、step fencing、candidate、single terminal publish；fire-and-forget 已移除 |
| Recovery | PASS | 13 个 required fault cases 全触发、无缺失/重复/未触发；进程替换和清理 receipt 完整 |
| Backup/Restore | PASS | 成功恢复后 scanner clean；缺对象和 manifest 篡改均以非零阻断；source/target 与角色网络真实隔离 |
| Served UI | PASS | success 4/4、negative 2/2、Gate 0.1 regression 4/4，全部 exact-membership report gate 通过 |
| Aggregate | PASS | `pnpm verify:gate0.2a` 从零运行退出 0，结束后无 Gate Docker/UDS/token 残留 |

范围边界仍有效：产品路径继续使用服务端 fake Runtime，`simulation=true`、`runtimeMode=fake`、`businessDecisionAllowed=false`；没有把 GearJob、真实 ERP/MES、真实模型、Hatchet、MinIO 或外部 Agent 伪装成本 Gate 能力。
