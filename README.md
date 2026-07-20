# geneway

`geneway` 是面向制造业的通用数字员工平台。客户只与“小纬”交互，也可以指定一个专家或专家团；后台 Agent、Workflow、工具和模型都受统一权限、审批、证据与审计约束。

当前仓库是独立于旧 Paperclip fork 的全新产品代码基地。Gate R 已关闭；下一项可授权工作是 **Gate 0.1：安全产品纵切**，当前尚未授权产品代码实施。

## 当前执行权威

- [Gate 0.1 最终实施合同](doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/implementation-contract.final.md)是唯一可执行范围权威。

支持材料不授予新范围：

- [技术附录](doc/plans/2026-07-18-geneway-v19-technical-appendix.md)
- [界面设计 ADR](doc/plans/atlas-workflow/20260720-010-geneway-gate-0-1/ui-design.md)
- [非执行路线图](doc/plans/2026-07-18-geneway-v19-reimplementation.md)
- [Gate R 验收记录](doc/migrations/gate-r-verification.md)

## 实施顺序

```text
Gate R（已关闭）
→ Gate 0.1（当前合同：小纬安全模拟纵切）
→ Gate 0.2（异常中心与 fixture）
→ Gate A（真实文档分析 + GearJob 单工单只读查询）
→ Gate B–G（长任务、动态 Workflow、异常/日报、多渠道和多 Runtime）
```

Gate 0.2 及后续步骤只是路线图，必须另行授权和建立 authority slice。新代码必须遵守当前实施合同；旧仓库只作为可恢复历史和文件级迁移来源，不得从 dirty worktree 直接复制，不得整包合并、rebase 或 cherry-pick，也不得引入 `@paperclipai/*` 运行依赖。
