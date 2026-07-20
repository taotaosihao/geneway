# geneway Gate 0.1 证据索引

更新时间：2026-07-21（Asia/Shanghai）

本目录只保存可复核的精简摘要。最新整门运行的 Playwright JSON 和原始制品位于 `/tmp/geneway-runs/gate-0.1-1784576455020-2373368/`，不进入 Git。每次 E2E 都使用唯一 `GENEWAY_RUN_ID`；失败时截图、视频和 trace 也写入对应 run 目录。

- `gate-0.1-contract.txt`：合同与 authority slice 对齐摘要。
- `gate-0.1-quality-summary.md`：lint、类型、单测和构建。
- `gate-0.1-safety-summary.md`：真实 Postgres、安全和 simulation 门禁。
- `gate-0.1-workflow-summary.md`：Schema、Compiler、canonical hash 和七节点图。
- `gate-0.1-ui-summary.md`：真实 served UI 与 Playwright 用户流。
- `gate-0.1-api-ui-correlation.md`：Browser/API/Postgres 实体关联。
- `gate-0.1-phase-review.md`：统一门禁结论和剩余边界。

前置 Gate R 证据仍位于 [`../../../../migrations/gate-r-verification.md`](../../../../migrations/gate-r-verification.md)。
