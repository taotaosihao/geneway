# geneway 文件级迁移清单

Gate R 只建立迁移边界，不把旧 Paperclip 代码整体带入新仓库。

| 来源 | 目标 | Gate R 处理 | 后续规则 |
| --- | --- | --- | --- |
| v19 主计划、技术附录、最终实施合同、UI ADR | 新 `geneway` 文档 | 复制并保留来源 commit | 作为新仓库实施权威 |
| OpenAI Agents Runtime/provider conformance | 新 Runtime/Model Gateway | 仅登记来源 | Gate A 按文件提取并重写合同 |
| SSE cursor、outbox/inbox、Evidence、channel 可靠性测试 | 新 testkit/contracts | 仅登记来源 | Gate 0/A 逐项迁移并补新合同测试 |
| Paperclip Issue/Pipeline/Interaction/Company | 无 | 禁止迁移 | 不得伪装成 Tenant/BusinessTask |
| Builder roles/schema、内容闭环和插件状态 | 无 | 禁止迁移 | 不属于首批制造业 Capability |

每个后续迁移提交必须记录：

```text
source_repo
source_branch
source_commit
source_paths
target_paths
behavior_reused
domain_coupling_removed
license/NOTICE result
new_contract_tests
negative tests
```

禁止整包 merge、rebase 或 cherry-pick 旧 longtask 分支进入新产品历史；禁止新产品运行依赖 `@paperclipai/*`。
