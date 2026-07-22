# Gate 0.2A Evidence Index

本目录是 Gate 0.2A 唯一 Git evidence 目录。这里保存小型结论摘要；raw trace、日志、报告、数据库/S3/备份材料只留在 `/tmp/geneway-runs/`，不提交 Git。

| 文件 | 对应门禁 |
| --- | --- |
| `gate-0.2a-contract.txt` | V-1 SDD 与合同 |
| `gate-0.2a-quality-summary.md` | V-2 基础质量 |
| `gate-0.2a-authority-summary.md` | V-3 Schema、migration、authority |
| `gate-0.2a-storage-summary.md` | V-4 真实对象存储 |
| `gate-0.2a-safety-summary.md` | V-5 安全 |
| `gate-0.2a-recovery-summary.md` | V-6 投递与恢复 |
| `gate-0.2a-ui-summary.md` | V-7 Served UI |
| `gate-0.2a-backup-restore-summary.md` | V-8 联合备份恢复 |
| `phase-review.md` | V-9 总门禁与阶段结论 |
| `gate-checklist.md` | Acceptance Criteria 汇总 |
| `evidence-index.md` | 本索引与证据边界 |

关键 raw run：

- Recovery：`/tmp/geneway-runs/gate0.2a-recovery-1784681094787-35b75ddb/`
- Backup success：`/tmp/geneway-runs/backup-restore-suite-success-1784681138732-d6c85d61/`
- Backup missing object：`/tmp/geneway-runs/backup-restore-suite-missing-object-1784681171778-2dc14e9a/`
- Backup manifest mismatch：`/tmp/geneway-runs/backup-restore-suite-manifest-mismatch-1784681205078-295e5ef2/`
- Served UI success：`/tmp/geneway-runs/gate-0.1-1784681238617-201350/`
- Served UI negative：`/tmp/geneway-runs/gate-0.1-1784681264793-208234/`
- Gate 0.1 regression：`/tmp/geneway-runs/gate-0.1-1784681281144-212807/`
- Full aggregate log：`/tmp/geneway-gate0.2a-final.log`

截图、trace 或日志单独不能证明通过；阶段结论同时要求 API/Postgres/S3、权限、hash、Worker、恢复和备份证据成立。
