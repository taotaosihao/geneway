# geneway Gate 0.1 执行澄清背景

本文件只保存非重复背景，不授予实施范围。唯一可执行权威是 [`implementation-contract.final.md`](implementation-contract.final.md)。

## 原始请求

旧 `longtask-agent-mvp` 分支按此前 Paperclip 方案实现，当前 fork 已不适合；按照 v19 重建小写 `geneway`。产品只显示“小纬”，但用户可让小纬自动安排或直接指定专家/专家团；Workflow 必须图形化；真实 ERP/MES 后续使用 `/home/gewu/work/gearjob` 的一个简单只读任务；对象存储沿用 Hive/Sharp Cell 的 S3 兼容路线，不使用 MinIO；能复用的机制应按文件迁移以加快开发。

## 关键反馈

- Gate R 已完成，当前只允许为 Gate 0.1 建立独立、安全、可操作的产品纵切。
- 旧 Paperclip Atlas 任务和旧分支只作历史来源，不能继续承担 `geneway` readiness。
- Gate 0.1 使用预置、已批准的只读脱敏输入和服务端 fake Runtime；任意上传、Artifact、真实模型和 GearJob 属于后续 Gate。
- fake 结果必须显著标记模拟，真实 served UI 必须由真实 Control Plane API/Postgres 驱动。
- 长期路线、技术细节和 UI 设计分别见非执行路线图、技术附录与 UI ADR，不在本文件重复 Goal、Acceptance 或 Stop Conditions。

## Tiny escape

`non-tiny`。下一次产品编码必须以 semantics v2 最终实施合同和 SDD authority slice 为边界。
