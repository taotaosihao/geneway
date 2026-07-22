# V-3 Schema、Migration 与权威摘要

结论：通过。

- `pnpm test:contracts`：8 个测试文件、29 个测试全部通过。
- `pnpm test:integration`：3 个测试文件、21 个测试全部通过。
- 覆盖 public/resolved Zod contract、JSON Schema parity、Workflow/Approval 绑定和 attempt candidate contract。
- `0004_gate_0_2a_recovery.sql` 完成恢复表、约束和索引；migration roll-forward 与 legacy backfill 由真实 PostgreSQL 集成测试验证。
- Postgres 保持 BusinessTask、WorkflowVersion、ApprovalVersion、Artifact manifest、DocumentSnapshot、Claim/Evidence/Lineage、Outbox/Inbox、attempt/fence 和恢复状态的唯一权威。
- S3 只保存对象字节；Worker 只通过 UDS command port 提交 attempt-scoped candidate，不持有 DB/S3 权威或凭证。
- immutable trigger、terminal publish CAS、审批 subject digest、byte locator 与 Claim publish guard 均有集成测试覆盖。

原始聚合日志：`/tmp/geneway-gate0.2a-final.log`。
