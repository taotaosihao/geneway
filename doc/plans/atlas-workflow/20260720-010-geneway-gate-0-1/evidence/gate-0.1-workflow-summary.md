# Gate 0.1 Workflow 摘要

- 固定 TS 对象模板只生成 plain `WorkflowDraft`；Zod 4 是唯一结构 Schema；
- Compiler 校验固定拓扑、Registry、引用与不安全值，输出 RFC8785/JCS canonical JSON 和 SHA-256；
- 真实纵切使用 `workflow_be038895345cb58a8f6080bb`；
- hash 为 `be038895345cb58a8f6080bb023b076613379403881eac6ea0f1763e8bd0eca4`；
- React Flow、Approval subject、Control Plane 快照与普通 Interpreter 使用同一 id/hash；
- 页面以只读 React Flow 呈现七节点，不以聊天文字替代 Workflow。

Workflow/contract suites 包含 canonical golden vector、跨进程稳定 hash、非法输入和存储版本完整性测试，并已包含在 `pnpm verify:gate0.1`。
