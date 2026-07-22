# V-6 投递与恢复摘要

结论：通过。

- 命令：`pnpm test:recovery`。
- run ID：`gate0.2a-recovery-1784681094787-35b75ddb`。
- Playwright exact-membership：预期 13、观测 13、通过 13；`missingCaseIds=[]`、`duplicateCaseIds=[]`、`untriggeredCaseIds=[]`。
- 13 个 required fault case 均记录 `fault_triggered=true`：
  - `after_intent_commit_before_s3_put`
  - `after_s3_put_before_db_finalize`
  - `put_response_lost`
  - `after_outbox_commit_before_worker_claim`
  - `after_inbox_insert_before_step_execution`
  - `after_step_side_effect_before_completion`
  - `complete_step_ack_lost`
  - `after_report_put_before_db_publish`
  - `stale_attempt_completion`
  - `cancel_vs_publish`
  - `sse_snapshot_subscribe_gap`
  - `control_plane_restart`
  - `worker_restart`
- `complete_step_ack_lost` 在 Control Plane 已提交 receipt 后销毁响应；Worker 以同一 idempotency key 重试，最终 receipt=1、step event=1、failure event=0，task completed，Claim 与报告各 1。
- 取消与旧 attempt 竞争时，晚到 publish 返回冲突；最终 task canceled、published Claim=0、report Artifact=0。
- 实际 Worker/Control Plane PID 和 generation receipts 证明发生了进程替换；最终所有进程退出，UDS/token 和 Docker 测试资源清理完成。

原始证据：

- `/tmp/geneway-runs/gate0.2a-recovery-1784681094787-35b75ddb/recovery/recovery-summary.json`
- `/tmp/geneway-runs/gate0.2a-recovery-1784681094787-35b75ddb/e2e-report-gate.json`
