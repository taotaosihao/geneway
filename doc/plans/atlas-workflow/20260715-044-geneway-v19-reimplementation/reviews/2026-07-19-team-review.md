# 2026-07-19 实施合同 Team Review

任务：`20260715-044-paperclip-agent-mvp`

## 结论

三条只读审查线分别检查合同可执行性、架构安全和产品/UI 门禁。revision 6 聚焦审查结论为 `NO-GO`：没有 P0，但仍有会造成安全顺序冲突、动态 Harness 缺失和真实性验收不可机器关闭的 P1。主审形成 revision 7 并完成两轮聚焦修复后，三条审查线最终均为 `GO`，剩余 P0/P1 为 0。该结论只表示合同可进入实施授权阶段，不代表已授权创建/改名 GitHub 仓库、移动目录或实施代码。

## revision 6 已保留的修复

1. Atlas 语义版本从不支持的 `4` 改为 `1`，另设 `contract_revision: 5`；收敛 First-code 字段并通过 strict lint。
2. 明确 Gate 0.1/0.2，真实 API + served UI 必须先出现，合同、scanner 和 fixture 不能替代产品代码。
3. ApprovalVersion 和 Authorization/Casbin 前移到 Gate 0；Gate C 只增加动态 Patch 的 supersede、Diff 和重新审批。
4. Gate D 只依赖 Gate A，可与 Gate B/C 并行，不让动态 Workflow 阻塞异常助理和生产日报。
5. 验收表增加所属门禁，并为 Gate 0–G 规定稳定聚合验证命令。
6. `codex_subscription_dev` auth-file 只挂载在本机 Model Gateway provider plugin；Runtime 无 provider 直连例外。
7. 新增 BusinessTask append-only 事件账本、step lease/fencing、Approval kind/subject 与决策时重新授权。
8. GearJob 单工单在 Gate A 前完成 endpoint/auth/权限 preflight；若需修改 GearJob facade，必须单独授权和独立提交。
9. UI 增加统一空/错/权限/离线状态矩阵、768×1024 Drawer 门禁、服务端导出边界、异常动作矩阵和“小纬唯一消息作者”断言。
10. 对象下载明确 key/prefix 不是权限边界；联合恢复增加 DB LSN/checkpoint 与对象 manifest/hash 对账。

## revision 7 针对本轮 NO-GO 的修复

1. Gate 0.1 前移 tenant isolation、最小 Authorization/delegated capability、Zod/Compiler/hash、固定 HarnessVersion 和 ApprovalVersion，先形成安全纵切；Gate 0.2 才补完整 Evidence/Artifact、VersityGW、Schema parity/property tests 和四路由。
2. 增加不可变 HarnessVersion；Gate 0/A 只选已登记版本，Gate C 才允许 HarnessDraft/Patch 与 WorkflowDraft/Patch，且动态 Harness + Workflow 成为内部平台完成条件。
3. ApprovalVersion 明确绑定 kind、subject/version、Workflow hash、输入/工具参数、资源/受众、预算和有效期；执行相关变化必须新建版本并 supersede 旧批准。
4. 将跨 Gate 的 Runtime、UI、Security、Storage、Recovery AC 拆开，避免一个 Required 条目在早期门禁不可完成。
5. Gate A 改用 Atlas 现有 dual-goal 业务验收 JSON schema/helper/validator，显式登记两个 owner ref；`conditionally_accepted` 不得关闭 Gate A。
6. GearJob 主成功场景必须使用存在、可读、字段足够的真实工单走到 completed；not_found/forbidden/data_incomplete 只作负向测试。
7. 文档分析增加四个必填结果区、重要事实引用抽查、推断标记、来源不变和人类可用性判断。
8. 修正共享订阅 token 边界：只有 trusted-local Model Gateway provider plugin 可读取 auth-file；其他服务与持久化/日志链路均不得接触。

## 聚焦复审检查项

- Gate 0.1 是否已经满足 Product/UI gate 的最小安全前置；
- HarnessVersion、动态 Harness/Workflow 与 ApprovalVersion 是否形成完整、不可提权的版本链；
- Gate A 标准业务证据包、owner、真实成功路径和 UI 证据能否被现有 Atlas validator 机器关闭；
- 合同、规格、主计划和技术附录是否一致且没有重新膨胀为字段级实现手册。

## 最终复审结论

| 审查线 | 结论 | 关闭的最后阻断 |
| --- | --- | --- |
| 合同可执行性 | GO | Gate 0.1 增加最小 Evidence publish guard 与 `verify:gate0.1`；当前 Atlas strict lint 0/0 |
| 架构与安全 | GO | 完成定义补入 Gate C；有效权限公式补入 HarnessVersion 交集 |
| 产品/UI 与真实性 | GO | Atlas verdict/Artifact 路径对齐；Gate 0.1 产品与安全同门；Gate A 真实 dual-goal 可机器关闭 |

revision 7 合同为 196 行，较修订前减少字段级重复；新增条款只用于关闭 Gate 0 安全顺序、Harness、审批和业务真实性阻断，不形成第二套实施附录。

## 保留但不阻塞当前实施的后续项

- A2A、AgentTeams、DeerFlow、AgentScope 和 LangBot 继续后置。
- Gate I 前内部 Runtime contract 已保留版本、事件 schema、ArtifactRef 和 typed interruption 边界，但不引入 A2A 运行依赖。
- C2 文档和 Artifact 的客户 VPC/正式身份策略在真实数据进入前仍需业务与安全批准。

## 复核命令

```bash
node "$ATLAS_WORKFLOW_PLUGIN_ROOT/scripts/codex-implementation-contract-lint" \
  --strict \
  --file doc/plans/atlas-workflow/20260715-044-geneway-v19-reimplementation/implementation-contract.final.md

~/.codex/workflow/bin/codex-workflow ready \
  20260715-044-paperclip-agent-mvp \
  --require context,spec,decision
```
