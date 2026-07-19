# geneway

`geneway` 是面向制造业的通用数字员工平台。客户只与“小纬”交互，也可以指定一个专家或专家团；后台 Agent、Workflow、工具和模型都受统一权限、审批、证据与审计约束。

当前仓库是独立于旧 Paperclip fork 的全新产品代码基地。Gate R 已完成技术迁移，下一步从 **Gate 0.1：最小可运行纵切** 开始实现。

## 权威文档

- [实施合同](doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/implementation-contract.final.md)
- [实施规格](doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/spec.md)
- [技术附录](doc/plans/2026-07-18-geneway-v19-technical-appendix.md)
- [界面设计](doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/ui-design.md)
- [Gate R 验收记录](doc/migrations/gate-r-verification.md)

## 实施顺序

```text
Gate R（归档与新基地）
→ Gate 0.1（小纬最小纵切与安全硬门）
→ Gate 0.2（异常中心与 fixture）
→ Gate A（真实文档分析 + GearJob 单工单只读查询）
→ Gate B–G（长任务、动态 Workflow、异常/日报、多渠道和多 Runtime）
```

新代码必须遵守实施合同。旧仓库只作为可恢复历史和文件级迁移来源，不得整包合并、rebase 或 cherry-pick，也不得引入 `@paperclipai/*` 运行依赖。
