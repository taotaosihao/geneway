# geneway 执行澄清

## 原始请求

旧 `longtask-agent-mvp` 分支按此前方案实现，当前 fork 已不适合；按照 v19 重新制定实施计划。新产品代码、GitHub 仓库和本地目录统一使用小写 `geneway`；旧大写 `GeneWay` 在安全归档后冻结。对象存储沿用 Hive/Sharp Cell 的实现，不使用 MinIO。产品只显示“小纬”一个通用数字员工，用户既可让小纬自动安排，也可直接指定专家或专家团；首个真实 ERP/MES 使用 `/home/gewu/work/gearjob` 的一个简单只读任务；MVP 像旧分支一样共享 Codex 订阅测试；必须有异常待办和可视 Workflow。

## 重述需求

把旧 Paperclip Builder 方案从“待继续实现的产品分支”降级为“历史 Spike 和选择性迁移来源”，以正式产品身份 `geneway` 重建干净的 Capability-first 内核，并给出安全归档、新仓库创建、首个用户纵切到内部 Capability Graduation 的完整顺序、验收和停止条件。

## 关键反馈

- 旧模型与 v19 的权威对象不同，原地改造会形成双权威。
- 旧分支已有通过测试的底层机制，全部丢弃不合理。
- 最小可靠路线是“新合同 + 新内核 + 复用优先的选择性移植”。
- 首个 Gate 必须包含真实 API 和真实 served UI，不能连续只做脚手架和合同。
- 同名仓库重建必须先验证 Git bundle/bare mirror 和旧分支恢复；不能用直接删除或覆盖代替归档。
- Hive/Sharp Cell 均以 VersityGW POSIX backend 暴露 S3 API；`geneway` 复用该路线及 ObjectStorage adapter 合同。
- Hive/Sharp Cell UI 均未正式对外定稿，只作弱参考；`geneway` 需要独立的视觉设计门禁。
- GearJob 已有 Work Order、Job Card、MES Schedule、Alarm、Downtime、KPI、Quality 等真实制造业对象。Gate A 先只读一个指定 Work Order；Gate D 再扩展异常规则和日报。
- Workflow 不能只用文字确认，必须从权威 DSL 生成节点图、节点详情和版本 Diff。
- 旧分支的共享订阅不是 Codex CLI，而是 OpenAI Agents SDK 经官方 `aisdk()` 接缝调用精确固定、经过 conformance 的 OAuth provider；MVP 复用该测试车道，但只限可信本机、单账号、单 active run，不进入生产或客户 VPC。
- 专家选择是执行路由，不是权限授予；小纬仍是唯一客户对话身份。

## Tiny escape 决定

本工作为 non-tiny；改变代码基地、数据模型、权限、Workflow、审批、模型出口和客户界面，编码前必须使用最终实施合同。

## 已锁定边界

- 新 `geneway` Git 历史独立；Paperclip 不进入运行依赖，旧大写仓库保存在日期化归档中。
- GitHub canonical repo 为 `taotaosihao/geneway`，本地 canonical path 为 `/home/gewu/work/geneway`；旧源是 `taotaosihao/GeneWay` 和 `/home/gewu/work/GeneWay`。
- VersityGW 是默认本地/VPC 对象存储，云部署可替换为通过同一 conformance suite 的 S3 服务；不使用 MinIO。
- Capability-first，Agent 仅为实现。
- 小纬是唯一客户身份；用户可选择 `auto`、一个专家或一个专家团，专家 Agent 仅为后台实现，选择结果写入任务/Workflow hash 且不扩大权限。
- Control Plane 单一权威。
- React Flow 图是 Workflow 的交互投影，不是第二份流程权威。
- Gate 0–G 为当前主路线；Gate H/I 后置。
- 首个真实 Connector 为 GearJob 单 Work Order read-only；先交付 `production.work-order-status.v1`，异常与日报后置；动作上限 A1。
- MVP 复用旧 OpenAI Agents Runtime 和共享订阅开发车道；正式环境始终经 Model Gateway 使用 API/企业凭据。
- Model Gateway、ApprovalVersion、Evidence、Authorization、outbox/inbox 不得后补。
- Gate 0 分为 0.1 真实产品纵切和 0.2 内核补强；Gate D 只依赖 Gate A，可与 Gate B/C 并行。
- 共享订阅凭据只存在于 trusted-local Model Gateway plugin；GearJob 若需新增只读 facade，必须独立授权和提交。

## 文档权威

最终实施合同是下一轮代码执行的直接权威；主实施计划提供完整背景、分阶段路线和迁移矩阵。
