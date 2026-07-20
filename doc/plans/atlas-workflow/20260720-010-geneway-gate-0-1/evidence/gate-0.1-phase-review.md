# Gate 0.1 实施方阶段复核

实施方在独立审查修复后重新执行统一门禁 `pnpm verify:gate0.1`，于 2026-07-21 退出 0：V-2 至 V-6 全部通过。最新 raw run 为 `/tmp/geneway-runs/gate-0.1-1784576455020-2373368/`；该结论仍需主任务接纳，才成为团队最终 Gate 结论。

本次实现边界：

- 已交付真实小纬 WebChat、auto/expert/team 三种专家路线、固定 Workflow 图、审批、异步 accepted 执行、可观察的 server fake Runtime 进度、Claim–Evidence、cursor 增量恢复和 API/DB 关联；
- 只显示小纬，不显示专家为消息作者；
- 未接真实模型、Codex 订阅、GearJob、Connector、Hatchet、异常中心、上传、下载、生产日报或第二 Runtime；
- 设备异常与产能落后仅为明确禁用的后续入口；
- Evidence 绑定批准时的固定 fixture ref/version/source/content hash，重新计算其他文本的自洽 hash 也会被拒绝；
- E2E authenticity scanner 覆盖 Playwright config、全部 specs/helpers/fixtures/global setup 和本地 import 闭包；
- raw logs/trace/video/report 按唯一 run id 留在 `/tmp/geneway-runs/`。

已知非阻断项：主 JS bundle 可在后续通过 lazy-load React Flow/assistant-ui 优化；Gate 0.1 不需要表格或更复杂路由。Hatchet 仍未引入，当前异步 fake 执行只有 Control Plane 一个权威状态源。
