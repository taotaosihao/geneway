# V-7 Served UI 摘要

结论：通过。

## Success project

- run ID：`gate-0.1-1784681238617-201350`。
- exact-membership：预期 4、观测 4、通过 4。
- 真实 served UI 覆盖：上传/验证/下载、Claim–Evidence–Lineage 与报告、Worker kill 后 checkpoint reclaim、报告校验后取消与孤儿清理。
- 浏览器没有 route interception；同一 task/snapshot/artifact/workflow/approval ID 与 API、Postgres、VersityGW、Outbox/Inbox、attempt/fence 和 Worker process receipt 关联。

## Negative project

- run ID：`gate-0.1-1784681264793-208234`。
- exact-membership：预期 2、观测 2、通过 2。
- 显式白名单只验证“对象缺失后隐藏元数据并禁用执行”和“未注册 profile 只可存储/下载”；负例不贡献成功结论。

## Gate 0.1 regression

- run ID：`gate-0.1-1784681281144-212807`。
- exact-membership：预期 4、观测 4、通过 4。
- 小纬仍是唯一数字员工界面；用户可选 auto、专家或专家团，客户消息作者集合不出现专家身份。
- Workflow 用 React Flow 图展示 7 个真实步骤；测试专用 Worker 每步 40ms，仅用于稳定观测 served UI 中间进度，不改变生产 Worker 默认节奏。
- 设备异常待处理、产能进度落后入口可见但保持禁用，文案明确为尚未开放能力。

原始 report gates：

- `/tmp/geneway-runs/gate-0.1-1784681238617-201350/e2e-report-gate.json`
- `/tmp/geneway-runs/gate-0.1-1784681264793-208234/e2e-report-gate.json`
- `/tmp/geneway-runs/gate-0.1-1784681281144-212807/e2e-report-gate.json`
