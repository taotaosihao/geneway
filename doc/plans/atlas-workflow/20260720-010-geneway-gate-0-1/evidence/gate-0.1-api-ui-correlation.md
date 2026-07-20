# Gate 0.1 Browser / API / DB 关联

2026-07-21 通过 Playwright 浏览器外探针和 PostgreSQL 直查关联同一条成功纵切：

| 实体 | 值 |
| --- | --- |
| BusinessTask | `task_459ae0a6-6249-4f89-9894-642f9ea51088` |
| Conversation | `conversation_a090d6e8-75ab-4eee-8a1a-4f1fe209e8ed` |
| WorkflowVersion | `workflow_be038895345cb58a8f6080bb` |
| Workflow hash | `be038895345cb58a8f6080bb023b076613379403881eac6ea0f1763e8bd0eca4` |
| ApprovalVersion | `approval_8f9d5cb9-0061-4c0d-a5ee-5ca47427254c` |
| Approval status | `approved` |
| event watermark / UI SSE cursor | `19` |
| published / rejected Claim | `1 / 1` |
| Evidence | `1` |

断言同时覆盖：页面 DOM data 属性、Control Plane Task snapshot、Workflow API、Approval API、Events API、PostgreSQL 行以及刷新后的 UI。全部指向相同 task、workflow id/hash、approval 和 cursor，且 simulation envelope 一致。

Conversation 消息没有浏览器侧副本：`assistant-ui` 使用 `useExternalStoreRuntime` 投影 Control Plane Conversation；测试按作者和顺序逐条比较 API 与 DOM。执行接口先返回 `accepted`，页面再以 snapshot + cursor 增量轮询观察中间进度，完成后刷新仍恢复到 cursor `19`。
