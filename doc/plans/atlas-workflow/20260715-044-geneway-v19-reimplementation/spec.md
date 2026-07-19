# geneway 执行规格摘要

## Goal

安全归档当前大写 `GeneWay` Paperclip fork 后，在小写 `geneway` GitHub 仓库和本地目录重建独立制造业数字员工内核。客户只与“小纬”交流，可让小纬自动安排或指定专家/专家团；MVP 复用旧分支共享 Codex 订阅开发车道完成 `solution.analysis.v1`，再以 GearJob 单 Work Order 只读数据完成 `production.work-order-status.v1`。`operations.exception-assist.v1` 和 `production.daily-report.v1` 后置，并按 Gate 0–G 建立可视 Workflow、审批、授权、证据、恢复、多渠道和多 Runtime 能力。

## Non-goals

- 不继续改造旧 longtask implementation 分支。
- 不把 Paperclip Issue/Pipeline/Interaction 作为新平台权威。
- 不生成动态 Hatchet 代码。
- 不开放生产写动作。
- 不展示多个可直接聊天的专家 Agent，不让 LLM 单独判定运营异常。
- 不把指定专家/专家团当作权限提升，也不把共享订阅车道用于生产、多租户、远程 sandbox 或客户 VPC。
- 不调用 Codex CLI/app-server/ACP，不自研 OAuth。
- 不直连或写回 GearJob，不复制 Hive/Sharp Cell/GearJob UI 作为正式视觉。
- 不提前加入 AgentTeams、A2A、DeerFlow、AgentScope 或 LangBot。

## Decision Boundaries

- TypeScript-first pnpm monorepo；Postgres、Drizzle、Fastify、React/Vite、React Flow、Hatchet、VersityGW + `@aws-sdk/client-s3`、OpenTelemetry。
- 产品名、仓库名和代码 slug 均为 `geneway`；canonical GitHub repo 为 `taotaosihao/geneway`，canonical local path 为 `/home/gewu/work/geneway`。
- OpenAI Runtime first；MVP 开发测试复用旧 OpenAI Agents SDK + 官方 `aisdk()` bridge + 经过固定版本和 conformance 的 OAuth provider；Claude second，生产使用正式 Model Gateway 凭据。
- WebChat first；飞书 first IM。
- Postgres resource scopes + Casbin 实现 MVP AuthorizationService。
- Gate 0.1 先交付带 tenant isolation、服务端身份、最小 Authorization/delegated capability、Zod/Compiler/hash、固定 HarnessVersion/ApprovalVersion、BusinessTaskEvent 和最小 Evidence publish guard 的安全真实 API + served UI；Gate 0.2 完成完整 Claim–Evidence–Lineage/outbox、VersityGW、异常 fixture、Schema parity/property tests 和四个完整路由。
- Gate D 只依赖 Gate A，可与 Gate B/C 并行；固定异常助理和日报不等待动态 Workflow。
- Gate 0/A 解析已登记且不可变的 HarnessVersion；Gate C 才允许 Agent 生成受限 HarnessDraft/Patch 与 WorkflowDraft/Patch，并且 Gate C 是内部平台完成条件。
- 共享订阅 auth-file 只在 trusted-local Model Gateway plugin；Hatchet 使用 lease/fencing；GearJob 在 Gate A 前完成 endpoint/auth/object permission preflight。
- 所有模型和工业系统访问经强制 Gateway。
- Workflow 图从不可变 DSL 单向生成；GearJob 单 Work Order 是首个真实 read-only Connector 任务。
- 迁移以复用为先：优先迁移 Runtime worker/provider conformance、结构化输出、取消/预算、故障测试、Evidence bridge、渠道可靠投递和事件恢复，不迁移 Paperclip 领域对象。

## Acceptance Criteria

1. 新 `geneway` 代码无 Paperclip 运行依赖，旧大写仓库可从已验证 bundle/mirror 恢复且旧分支保持冻结。
2. Capability/Workflow/Approval/Agent versions 不可变且可审计。
3. Control Plane 是唯一业务权威。
4. Runtime、Model、Tool、Connector、Channel 通过统一 conformance suites。
5. Claim–Evidence–Lineage 覆盖关键结论。
6. Hatchet 故障恢复不产生重复业务效果。
7. served UI 只显示小纬，支持自动、单专家、专家团三种路由，并完成文档分析、Workflow 节点图审批、专家进度、证据查看和报告下载；专家选择不扩大权限。
8. MVP 共享订阅车道只在可信本机、单账号、单 active run 下运行，OAuth refresh、配额耗尽和崩溃行为通过 conformance；生产 profile 明确拒绝该车道。
9. GearJob 单 Work Order 真实只读查询通过 DocType 权限、精确资源范围、字段白名单、确定性进度和 Evidence 验收；异常中心先显示设备异常和产能落后 fixture。
10. 后续 GearJob 真实只读异常助理与生产日报的确定性计算、去重、资源授权和数据质量均通过。
11. 飞书与 WebChat 共享同一 Conversation/BusinessTask，且受众过滤有效。
12. OpenAI/Claude 可替换而不改变 Capability 合同。
13. VersityGW 对象存储通过 put/get/head/delete、tenant key 隔离、重启持久化及 Postgres 联合恢复验证。
14. Workflow 图、版本 Diff、审批 hash 和实际 DSL 一致；Hive/Sharp Cell UI 不作为产品验收替代。
15. Gate A 使用 Atlas 现有 dual-goal 业务验收 JSON schema/validator；两个真实场景均为 `passed` 且 overall 为 `accepted`。
16. 至少一个受控动态 Harness + Workflow 场景通过 Gate C，才可宣称内部平台完成。

## Verification Plan

使用 lint、typecheck、unit、contract、integration、security、eval、Playwright e2e 和 build 全套命令；故障注入覆盖 worker/Hatchet/channel/VersityGW restart、重复/乱序事件、过期审批、cursor replay 及 Postgres/Artifact 联合恢复。原始运行证据写入 `/tmp/geneway-runs/<run-id>/`。

实施仓库还必须提供 `pnpm verify:gate0` 到 `pnpm verify:gate-g` 的稳定聚合命令；Gate A 无真实订阅 conformance 时不得用 fake 结果标记 MVP 通过。

## Stop Conditions

如果旧仓库归档无法验证、GitHub/本地重建未获授权、必须保留旧 Paperclip 权威、绕过 Model/Tool/Connector Gateway、让 Runtime/Hatchet/渠道保存第二份审批、要求把共享订阅用于生产、专家选择必须提权、GearJob 无法做精确资源只读授权，或 Gate 0 没有可操作产品纵切，则停止实施并返回决策层。
