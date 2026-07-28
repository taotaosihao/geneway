# Gate A 实施进度与暂停交接（2026-07-29）

## 1. 文档用途

本文记录用户在 2026-07-29 明确要求“暂停实施，写一个实施进度文档，并 commit 所有未提交的”时，`geneway` 当前 Goal 的真实实施、验证和阻塞状态。

本次暂停不是 Gate A 关闭、验收通过或 Goal 完成。暂停后不再启动新的产品实现、修复、测试、服务、finalizer、admission、aggregate 或 promotion 轮次；工作树按当前逻辑结果提交为本地 checkpoint，不 push、不建 PR、不部署、不发布。

当前 Goal 仍是：

> 按权威合同顺序完整实施、验证并交付 geneway Gate A0 Fast Chat 与 Gate A 真实材料分析/单工单只读查询；先关闭 Gate A0，再在所有 Gate A 进入条件真实满足后实施 Gate A，不伪造关闭证据、不绕过权限/数据/凭据边界。

## 2. 权威边界

当前实现继续受以下文件约束：

- Gate A authority brief：`/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp/brief.md`
- Gate A final contract：`doc/plans/atlas-workflow/20260723-008-geneway-gate-a-gearjob/implementation-contract.final.md`
- current execution admission：`/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp/current-execution-admission.json`
- controller resolution：`/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp/controller-resolution.json`

持续生效的边界：

- 状态仅为 `LOCAL_IMPLEMENTATION_ONLY`。
- public/customer 始终 `NOT_OPEN`。
- 不 push、不建 PR、不部署、不发布、不使用客户生产凭据或数据、不发送外部消息。
- GearJob 只允许 current admission 的 12-path boundary manifest；不得修改 `frappe`、`erpnext`、`hrms`、`print_designer` nested apps。
- 旧 preflight、served、aggregate、admission、promotion 证据均为非权威历史，不得续签、重命名或拼接为修订合同的完成证据。

## 3. 暂停点 Git 快照

编写本文前的仓库快照：

- branch：`main`
- HEAD：`189960ebff54b5061ce5286b96c309e2b38bc1ea`
- HEAD subject：`docs(gate-a): repair execution authority contract`
- 相对 `origin/main`：ahead 67
- staged：空
- dirty tracked paths：29
- untracked source/test/migration paths：66（已排除本轮 TypeScript 误生成的 4 个 `.js/.d.ts/.map` 派生物）
- tracked diff：2,506 insertions、105 deletions；大量 A.3/A.4 新文件尚未纳入该 tracked 统计
- `git diff --check`：通过

这些变更包含用户此前授权并保留的 A.3/A.4 产品纵切，以及合同修复恢复后对 5 个 controller open finding 的部分修复。它们不是一个已通过 fresh acceptance 的 release candidate。

## 4. 已存在的产品实现

暂停点已存在但尚未按修订合同重新完成验收的主要产品实现如下。

### 4.1 Gate A.3 单工单纵切

- Zod 4 工单 wire contract、QuerySpec、invocation token、Gateway receipt、WorkOrderStatusCard 与 Evidence projection。
- Control Plane Postgres 业务 source-of-truth：固定 Workflow、Approval、task/step、attempt/fence、connector snapshot、Evidence、结果与 terminal/recovery 状态。
- Connector Gateway 的最小 GearJob 单对象 read-only facade 调用边界。
- Model Gateway 的工单说明路由；模型不直接访问 GearJob，不执行 tool call。
- Worker 的独立 work-order lane、失败隔离与 command boundary。
- Control Plane API 与 Web 的显式“查询一个工单”入口；默认 `/conversations/new` 仍保持无材料 Fast Chat。
- A.3 runtime topology、loopback proxy、secret/egress、zero-write、recovery 和 served E2E harness 的已有实现骨架。

### 4.2 Gate A.4 验收与聚合骨架

- 两条 Capability 的 release isolation integration test。
- browser egress guard、LAN targeted regression、secret-egress scan、served task-state 与 stack lifecycle verifier。
- `verify:gate-a`、`verify:gate-a3`、GearJob preflight 和 E2E report gate 的已有脚本。

上述内容中的旧 served/aggregate/promotion 结果已经被修订合同明确废止；代码存在不等于 acceptance 已通过。

## 5. 合同修复恢复后已完成的局部修复

### 5.1 Strict authority 与 run-scoped admission

新增 `packages/contracts/src/gate-a3-acceptance-authority.ts` 和 `gate-a3-preflight.ts`，当前包含：

- 5-role strict `ActorRegistry`，固定 implementer/reviewer/verifier/controller/signer，并要求 actor/session/key/public key 两两不同。
- 4-role strict owner registry，固定 deployment/credential/API authorization/data-test-object owner。
- exact expected/observed source manifest，要求排序、唯一 path 和逐项完全相等。
- owner approval 对 exact candidate/source/actor registry/owner registry/credential version/test object 的绑定。
- shadow-only、不可续签、最长 8 小时的 run-scoped acceptance admission。
- `declaredMaximumRunDuration + maxInvocationTokenTTL + shutdownGrace` runway inequality。
- signed pre-launch topology receipt、shadow-only Control Plane authority envelope 和 V1–V7 fresh aggregate schema。
- strict preflight 对 endpoint/method、credentialVersion、单对象授权、field mask、错误语义、timeout/retry/rate/audit/allowed side effects、runtime 和 named test object 的 required locks。

`scripts/gate-a3-preflight-verifier.ts` 已实现 registry/source digest、独立 owner Ed25519 signature、nonce 与有效期的机械验证。

### 5.2 Control Plane Docker/Codex authority 解耦（部分）

修订后的 `apps/control-plane/src/main.ts` 已改为：

- 只读取一个 run-scoped、0600、owned、non-symlink、非 Codex workflow 路径的 exact raw-bytes bundle。
- 只从独立签名的 pre-launch receipt 获取 runtime private IPv4。
- 不再在修订入口读取三个 canonical Codex authority artifact。
- 不再在修订入口执行 Docker inspect/exec 或连接 Docker socket。
- route/mutation authority 只重新验证签名、digest、candidate/source、credential/runtime tuple 与有效期。

新增 `scripts/business-process-sandbox.mjs`，用 bubblewrap 为 Web、Control Plane、Worker、Runtime、Model Gateway、Connector Gateway 构建统一 namespace boundary：

- 保留现有网络模型。
- 遮罩 Codex authority、GearJob tree、Docker socket 和 Docker CLI。
- 清除 Docker/Compose/BuildKit/container-host 环境变量。
- 仅 Connector Gateway 可精确只读回挂 GearJob credential。
- 仅 Model Gateway 可精确只读回挂 provider credential。

该 sandbox 尚未接入 `dev-up`/E2E 的全部业务进程，也未取得真实 PID `/proc/<pid>/environ`、`mountinfo`、FD、`stat/open/exec` 负向证据。

### 5.3 Durable acceptance 与 promotion（部分）

新增 `migrations/0018_gate_a3_acceptance_authority.sql`，设计为保存原始 actor registry、acceptance admission、pre-launch receipt、authority bundle、actor receipts、fresh aggregate 与 single-CAS promotion receipt，不再新增调用方可自报的 `externalSignatureVerified=true` 结论。

`GateA3WorkOrderRepository` 的修订路径已开始：

- corrected authority 必须携带 exact Control Plane bundle。
- seed 时持久化原始 bundle 与 signer/verifier receipt。
- consume 时从 DB 重新读取并重验 raw bundle，而非只信任布尔值。
- immutable shadow candidate 可通过 run-scoped overlay 为具名 local principal 与具名单对象提供 acceptance-only route。
- `shadow → internal` 在 corrected authority 下必须提供本 run、同 source/credential/runtime 的 fresh V1–V7 aggregate；第二次 internal promotion 会失败。
- `scripts/e2e/start-gate-a3-release.ts` 已停止在 served 之前执行 internal promotion，只推进到 shadow acceptance overlay。

该部分仍处于未完成的 integration 状态；migration 0018、fresh DB re-verification、shadow overlay、aggregate insert 与 single-CAS 尚未在 fresh Postgres 上完成真实 integration test。

## 6. 已运行且通过的局部检查

暂停前最近通过的检查：

- `pnpm --filter @geneway/contracts typecheck`
- `pnpm --filter @geneway/control-plane typecheck`
- `pnpm exec tsc -p scripts/tsconfig.json --noEmit --pretty false`
- `pnpm exec vitest run packages/contracts/src/gate-a3-preflight.test.ts`：20 tests passed
- `pnpm exec vitest run apps/control-plane/src/gate-a3-prelaunch-authority.test.ts`：6 tests passed
- `pnpm exec vitest run scripts/business-process-sandbox.test.ts`：8 tests passed
- `git diff --check`

这些只是局部结构和单元检查，不能替代合同 V1–V8、fresh Postgres/ObjectStorage integration、served UI/API/DB/provider/connector/recovery/egress、PID isolation 或真实 owner/credential acceptance。

暂停后未再运行新的测试或服务。

## 7. 5 个 controller finding 的真实状态

| Finding | 暂停状态 | 尚缺内容 |
|---|---|---|
| `CONTROL_PLANE_DOCKER_AUTHORITY_COUPLING` | 部分修复，未关闭 | 旧 dev-up/run-e2e/legacy authority 路径仍需完全退出 corrected product path；sandbox 尚未全面接入；缺独立 pre-launch verifier 的真实运行与全业务 PID 负向证据 |
| `PREFLIGHT_STRICT_SCHEMA_EXPECTED_SOURCE_GAP` | strict v2 schema/verifier 已实现，未关闭 | 尚未冻结修复后 exact expected manifest；旧 permissive artifact/generator 尚未从全部启动/验收入口移除；缺真实 owner-approved candidate 与独立 observed equality receipt |
| `ATTESTATION_IDENTITY_AND_DURABLE_AUTHORITY_COLLAPSE` | ActorRegistry、签名 schema 与 durable bundle migration 部分实现，未关闭 | 缺 fresh reviewer/verifier/controller/signer 独立进程/key 的完整 receipt chain；缺 fresh DB integration/replay negative；旧 finalizer/bootstrap boolean 路径尚未全部退役 |
| `CREDENTIAL_ISOLATION_AND_VERSION_BINDING_INCOMPLETE` | schema 与 bwrap 精确回挂部分实现，未关闭 | credentialVersionId 尚未贯穿 provider/connector conformance、readiness、token、receipt、release、lease 与 aggregate；缺 same-path rotation 和真实 PID/canary oracle |
| `VALIDATION_RUN_LEASE_AND_PROMOTION_CYCLE` | A.3 lease/aggregate/single-CAS 部分实现，未关闭 | A.1/A.2 仍需按修订合同纠正 pre-open→same-lease served/recovery/stability→per-capability aggregate→single CAS；缺 migration/repository integration、real aggregate 与 V8 no-second-promotion 证据 |

因此 controller 的 5 个 finding 在暂停点仍全部 open；任何关闭声明都不成立。

## 8. 当前不可伪造的外部事实/阻塞

即使代码修复完成，下列事实也不能由 workspace user、implementer、reviewer、verifier、controller 或 Codex 自任：

- exact candidate 的 GearJob deployment owner。
- GearJob credential owner 与 non-secret immutable `credentialVersionId`。
- GearJob API/authorization、Role/User Permission owner。
- data/test-object owner 与获准的本地脱敏单 Work Order。
- provider credential owner、provider `credentialVersionId` 和 version-bound fresh conformance。
- 相互独立的 reviewer/verifier/controller/signer actor/session/key holders。

缺少这些真实 owner/credential approval 时，A.3 必须保持 `NOT_OPEN`；A.1/A.2 只能按各自独立 provider authority 与 fresh aggregate 判断，不能被 A.3 替代或共同伪造。

## 9. 已知提交风险

- `services/connector-gateway/**` 在产品合同语义上属于 mandatory Connector Gateway，但 authority brief 的精确 owned-path 表未明确列出该目录；恢复前应以 current admission/用户 superseding authorization 明确记录这一 formal path authority。
- 新 workspace package `services/connector-gateway` 当前没有对应 `pnpm-lock.yaml` importer；暂停时不运行 install，因此 checkpoint 会如实保留该风险。
- 当前工作树紧密交织 A.3/A.4、合同修复和验收基础设施；本次 commit 是可恢复的本地暂停 checkpoint，不是可发布 release。
- 新 migration 0018 尚未在 fresh Postgres 上执行；恢复时不得改写已在任何共享 DB 应用过的 migration，应先审计 disposable DB 状态。

## 10. 恢复后的建议关键路径

恢复必须从本 checkpoint 继续，不从零开始，不复用修订前证据：

1. 重新读取 current admission 与本进度文档，确认 HEAD/worktree 与提交 checkpoint 一致。
2. 完成 corrected dev-up/pre-launch verifier 交接，彻底让业务进程退出 Docker/Codex authority 路径。
3. 把 bwrap boundary 接入全部六类业务进程并取得真实 PID isolation/credential negative receipt。
4. 退役旧 permissive preflight/finalizer/bootstrap boolean 路径；用真实预登记 owner/key 冻结 exact expected source candidate。
5. 在 fresh Postgres 验证 migration 0018、raw signature re-verification、nonce replay、lease expiry/runway、shadow overlay、aggregate 与 single CAS。
6. 将 credentialVersionId 贯穿 provider/connector 全链并运行 same-path rotation zero-request oracle。
7. 同步修复 A.1/A.2 的 shadow acceptance/promotion 顺序。
8. 冻结新的 exact source manifest；在同一 immutable lease 上运行合同 V1–V7、served/recovery/stability/egress，并为两个 Capability 各自产生 fresh aggregate 与唯一 promotion receipt。
9. V8 只验证，不二次 promotion；public/customer 始终 `NOT_OPEN`。

只有上述路径与所有 required acceptance 真实通过后，才可更新 Goal 为完成。

## 11. 本次暂停检查点提交

本次按路径与逻辑结果拆分并落下以下本地 Conventional Commits；它们只用于保存可恢复现场，不代表验收、promotion 或 Gate 关闭：

- `edd5f58 feat(gate-a): define single-work-order authority`
- `bdf261b feat(gate-a): persist single-work-order execution`
- `3dc0264 feat(gate-a): execute work orders through gateways`
- `ae0c58f feat(gate-a): serve single-work-order status`
- `7eae281 test(gate-a): enforce work-order and aggregate gates`

本文另以独立 `docs(gate-a)` 提交保存。所有提交均仅存在于本地；未 push、未建 PR、未部署、未发布。
