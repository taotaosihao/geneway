# geneway 选定方向

## 决定

正式产品身份统一为小写 `geneway`；先把当前大写 `GeneWay` Paperclip fork 做成可验证归档，再创建 `taotaosihao/geneway` 和 `/home/gewu/work/geneway`，作为独立 greenfield 制造业平台。客户入口只显示“小纬”，用户可让小纬自动安排或指定专家/专家团，后台执行不形成第二个客户身份。先定义 v19 合同，再以复用优先方式选择性移植已验证实现。对象存储采用 Hive/Sharp Cell 的 VersityGW + S3 API 路线，不使用 MinIO；MVP 先用 GearJob 单 Work Order 只读接口。

## 接受的架构

```text
Capability-first Control Plane
→ Xiaowei single customer facade
→ explicit ExpertTarget (auto / expert / team)
→ restricted WorkflowVersion
→ React Flow projection + graph Diff
→ fixed Interpreter on Hatchet
→ replaceable Agent Runtime
→ mandatory Model / Tool / Connector Gateway
→ GearJob single Work Order read-only first
→ deterministic exception inbox + daily report later
→ Context Graph + Claim–Evidence–Lineage
→ VersityGW-backed ObjectStorage
```

## 拒绝的路线

- 旧 implementation 分支原地重构；
- Paperclip core 内新增第二套制造业业务内核；
- 整包迁移 Adapter/Channel 插件；
- 全部重写并丢弃已验证机制；
- 先做 AgentTeams/A2A/外部联邦；
- LLM 生成 Workflow 执行代码；
- 多个专家 Agent 直接面向客户聊天；
- 指定专家或专家团即可扩大权限；
- 将共享 Codex 订阅用于生产、客户 VPC 或远程多租户运行；
- 使用 Codex CLI/app-server/ACP 替换旧分支的 OpenAI Agents OAuth 测试车道；
- 只用文字描述 Workflow；
- 把 Hive/Sharp Cell/GearJob UI 直接定为 `geneway` 视觉基线；
- 直连或写回 GearJob 数据库。

## 历史决定

旧 Paperclip Builder 的产品模型和 portable model plane 只保留为历史 Spike 记录；其中 OpenAI Agents worker、Provider conformance、共享订阅开发车道、渠道可靠投递和事件恢复可迁移，“不建 Model Gateway”等结论不再适用。共享订阅仅用于可信本机 MVP 测试，正式环境使用 API/企业凭据。
