# V-8 联合备份恢复摘要

结论：通过。

- 命令：`pnpm test:backup-restore`；suite 最终 `outcome=passed`。
- 成功路径：`backup-restore-suite-success-1784681138732-d6c85d61`，exit 0，target integrity clean，source 在 target restore 前已销毁，target 在验证后已销毁。
- 缺对象负例：`backup-restore-suite-missing-object-1784681171778-2dc14e9a`，命令按合同非零，发现 `PG_OBJECT_MISSING_IN_S3`，restore gate 阻断开放。
- manifest 不一致负例：`backup-restore-suite-manifest-mismatch-1784681205078-295e5ef2`，命令按合同非零，发现 `DB_HASH_MISMATCH` 与 `OBJECT_HASH_MISMATCH`，restore gate 阻断开放。
- 每个 run 使用独立 source/target project、backup set、barrier/checkpoint/inventory；target 恢复前为空。
- backup/restore 角色只加入每个 stack 的 Compose data network，使用 `postgres:5432` 和 `versitygw:7070`，不能经 host 回连 Control Plane。
- 动态 source/target receipt 证明协调器观察到 Control Plane 在线，而 backup role 到 Control Plane 的路由失败；角色 secret 和数据凭证隔离。
- 恢复失败状态会阻断下载、审批、执行、claim 与 publish；双向 scanner 是最终完整性 oracle。
- 聚合结束后没有残留 `geneway-br-*` 容器、卷或网络。

原始证据分别位于 `/tmp/geneway-runs/<run-id>/backup-restore/`。
