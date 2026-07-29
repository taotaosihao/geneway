# geneway Synthetic E2E MVP Slice 0–2 Canonical 实施合同

task_id: 20260730-001-geneway-synthetic-e2e-mvp-slice-0-2
title: 生产计划员工单设备简报 Synthetic E2E MVP
contract_status: final
current_authoritative_contract: ./implementation-contract.final.md
created: 2026-07-30
finalized: 2026-07-30
contract_semantics_version: 3
finding_scope_admission: controller_current_required_only
safe_fallback_authority: goal:GW-SAFE-01
work_type: implementation
first_code_guard: required
product_ui_gate: required

本合同只把 Team-reviewed canonical plan
`/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/clarify.md`
（SHA-256 `96a1b6ec4c62a254d1e6c76e701c71bd3183db57901b7a822563ad3cdbf01d79`）
编译为当前实施任务。它采用 `SELECTIVE_MIGRATION` 处置 `b18ade0` 原型，先交付
`SCN-NORMAL` 真实 localhost 纵切并等待用户 `CONTINUE | REVISE | STOP`；只有用户
`CONTINUE` 才补齐其余五个场景。它不授权 MCP、真实 GearJob/Hive、凭据、WorkBuddy、
外部网络、push、PR、部署、发布或生产动作。

## Execution Plan

```atlas-execution-plan+json
{
  "schema_version": 1,
  "size_policy": {"policy_id": "atlas-slice-size-v2"},
  "slices": [
    {
      "slice_id": "synthetic-production-brief",
      "objective": "以服务端唯一决策规则交付 Web 到 Control Plane、loopback Connector Gateway 与 GearJob/Hive synthetic adapters 的生产计划员工单设备简报；先完成 SCN-NORMAL 用户 checkpoint，获 CONTINUE 后在相同边界补齐六场景和安全降级。",
      "depends_on": [],
      "keeper_outputs": ["change:production-work-order-equipment-brief-synthetic-e2e"],
      "owned_paths": [
        "packages/contracts/src/production-work-order-equipment-brief.ts",
        "packages/contracts/src/production-work-order-equipment-brief.contract.test.ts",
        "packages/contracts/src/index.ts",
        "services/connector-gateway/src/synthetic-production-provider.ts",
        "services/connector-gateway/src/synthetic-production-provider.test.ts",
        "services/connector-gateway/src/synthetic-production-gateway.ts",
        "services/connector-gateway/src/synthetic-production-gateway.test.ts",
        "services/connector-gateway/src/synthetic-production-main.ts",
        "services/connector-gateway/package.json",
        "apps/control-plane/src/production-work-order-equipment-brief.ts",
        "apps/control-plane/src/production-work-order-equipment-brief.test.ts",
        "apps/control-plane/src/production-work-order-equipment-brief.integration.test.ts",
        "apps/control-plane/src/index.ts",
        "apps/control-plane/src/main.ts",
        "apps/web/src/api.ts",
        "apps/web/src/api.test.ts",
        "apps/web/src/production-brief-routes.tsx",
        "apps/web/src/production-brief-routes.test.tsx",
        "apps/web/src/production-brief-mock.ts",
        "apps/web/src/production-brief-mock.test.ts",
        "apps/web/src/production-brief-mock-routes.tsx",
        "apps/web/src/production-brief-mock-routes.test.tsx",
        "apps/web/src/router.tsx",
        "apps/web/src/styles.css",
        "apps/web/src/chat-app.tsx",
        "apps/web/src/product-routes.tsx",
        "apps/web/src/work-order-routes.test.tsx",
        "scripts/run-synthetic-production-brief.mjs",
        "scripts/run-synthetic-production-brief.test.ts",
        "scripts/e2e/synthetic-production-brief.spec.ts",
        "scripts/playwright.config.ts",
        "package.json"
      ],
      "forbidden_paths": [
        "apps/worker/**",
        "packages/runtime/**",
        "packages/workflow/**",
        "migrations/**",
        "apps/control-plane/src/gate-a3-work-order-repository.ts",
        "apps/control-plane/src/gate-a3-worker-command.ts",
        "apps/control-plane/src/worker-command-server.ts",
        "services/connector-gateway/src/main.ts",
        "services/connector-gateway/src/index.ts",
        "services/connector-gateway/src/gearjob-http.ts",
        "services/model-gateway/**",
        "pnpm-lock.yaml"
      ],
      "acceptance_refs": ["GW-MVP-01", "GW-CONN-01", "GW-CAP-01", "GW-SAFE-01", "GW-ACCEPT-01", "AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06", "AC-08", "AC-09"],
      "risk_class": "high",
      "failure_domain": "本地 synthetic 生产计划员纵切、唯一服务端决策、Connector 边界、served Web 与其测试；不触碰真实系统或旧异步执行链",
      "rollback_boundary": "两个本地逻辑提交：authority projection 与获用户 checkpoint 后的产品纵切；无数据库、凭据或外部状态回滚",
      "estimate": {
        "estimated_changed_files": 24,
        "estimated_net_loc": 2200,
        "target_p90_minutes": 180,
        "serial_dependency_depth": 0,
        "independent_vertical_count": 1
      },
      "budget": {
        "max_changed_files": 32,
        "max_loc": 3200,
        "max_wall_clock_minutes": 360,
        "max_required_checks": 5
      },
      "checks": [
        {
          "check_id": "production-brief-focused-tests",
          "gate_class": "integration",
          "command": "pnpm exec vitest run packages/contracts/src/production-work-order-equipment-brief.contract.test.ts services/connector-gateway/src/synthetic-production-provider.test.ts services/connector-gateway/src/synthetic-production-gateway.test.ts apps/control-plane/src/production-work-order-equipment-brief.test.ts apps/control-plane/src/production-work-order-equipment-brief.integration.test.ts apps/web/src/api.test.ts apps/web/src/production-brief-routes.test.tsx",
          "final_only": false,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-typecheck",
          "gate_class": "typecheck",
          "command": "pnpm typecheck",
          "final_only": false,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-lint",
          "gate_class": "lint",
          "command": "pnpm lint",
          "final_only": true,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-build",
          "gate_class": "build",
          "command": "pnpm build",
          "final_only": true,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-served-browser",
          "gate_class": "browser-flow",
          "command": "pnpm test:e2e -- --project=synthetic-production-brief synthetic-production-brief.spec.ts",
          "final_only": true,
          "cache_policy": "fresh-executed"
        }
      ]
    }
  ]
}
```

## Scope

- Goal: 实现 `production.work_order_equipment_brief.v1`，只通过四个内部 operation 从两个 synthetic Connector adapter 取得事实，并由 Control Plane 中唯一 rubric 得出 `NO_ACTION | FOLLOW_UP | ESCALATE | UNKNOWN`。
- Baseline: `b18ade08050566b6c0ecc54b200725e1ef832810` 上的 Web-only prototype 采用 `SELECTIVE_MIGRATION`；只保留 UI/样式/文案与 provider-shaped raw facts，浏览器端 fixture、decision、final copy、timer stage runner 与旧测试必须删除或重写。
- Non-goals: MCP、通用 registry、Runtime Router、Worker、Workflow、Hatchet、task/lease、migration、真实 Provider、真实 API/数据/凭据、WorkBuddy、外部网络、push、PR、部署、发布与生产。
- User-visible behavior: `/work-orders/mock` 仍是入口；浏览器只持有 scenario ref 与 presentation state，通过真实 `/api` HTTP 请求显示 trace、来源、`observedAt`、freshness、coverage、unknowns、reason 与下一步。

## First Code Slice Guard

- first_code_slice: `SCN-NORMAL` 必须修改真实产品行为，使浏览器通过 Control Plane API 与独立 synthetic Connector Gateway 得到服务端计算的 `NO_ACTION`。
- first_code_slice_kind: product
- first_code_owner: 单一 `atlas-sdd-implementer`，拥有本合同全部产品路径；主 Codex 只负责 authority、集成和验收。
- first_code_verification: focused tests + localhost browser 网络证据，必须看到 Web 请求 `/api/production/work-order-equipment-brief`，且浏览器不能直连 Gateway。
- allowed_contract_gate_only_until: 只允许作为该纵切内部准备，不得把合同或 fixture 单独宣称为 Slice 1 完成。
- stop_if_no_code_by_phase: 完成必要源码读取后直接进入 SCN-NORMAL 代码；若最小纵切必须触碰 forbidden path 则停止。
- gate_parallelization_or_deferral_plan: 先跑聚焦测试与模块 typecheck；served browser gate 在首个可操作流形成后执行。

## Product/UI Acceptance Gate

- first_operable_user_flow: 打开 `/work-orders/mock`，运行 `SCN-NORMAL`，看到四个能力步骤、`NO_ACTION`、来源/时间/覆盖与明确下一步。
- browser_entrypoint: http://127.0.0.1:3200/work-orders/mock
- served_ui_validation_action: Playwright must navigate to http://127.0.0.1:3200/work-orders/mock with page.goto, click the run button, wait for the real /api/production/work-order-equipment-brief response, and verify the server trace and NO_ACTION; the Vite HTTP server provides the document, JavaScript, and CSS.
- ui_data_mode: `SYNTHETIC_DEMO`，不含客户数据，不声称调用真实 GearJob/Hive。
- required_safety_gates: Web forbidden-import、浏览器不直连 Gateway、Gateway 固定 operation allowlist、无外部请求、无 secret/credential 环境继承。
- allowed_headless_only_until: contracts 和 Gateway/Control Plane focused tests 通过为止；之后必须形成 served flow。
- stop_if_no_ui_by_phase: SCN-NORMAL application/API path 完成后立即形成真实 served UI，否则停止扩展到其他场景。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
|---|---|---:|---|---|
| AC-01 | GearJob/Hive synthetic adapters 只通过四个 internal operation contract 被 use case 调用，Web 不引用 provider 私有结构 | yes | dependency/import inspection + contract/provider tests | goal:GW-CONN-01 |
| AC-02 | 一个 product-facing Application Capability 与四个 internal operation 使用唯一 Zod 4 schema，包含来源、时间、覆盖与 normalized error | yes | contract tests + schema serialization | goal:GW-CAP-01 |
| AC-03 | Web 请求真实跨 Vite、Control Plane API、Application Service、loopback Connector Gateway 和两个 adapters，且不进入 Worker/Runtime/task/lease | yes | browser network + API/Gateway trace + forbidden dependency assertion | goal:GW-MVP-01 |
| AC-04 | 0/N mapping、stale、unknown、upstream failure 与 partial/unavailable alarm 均 fail safe；0/N/stale/upstream 不调用不应调用的下游 operation | yes | independent degradation oracle + call-ledger assertions | goal:GW-SAFE-01 |
| AC-05 | 固定 `evaluationAsOf=2026-07-29T08:30:00.000Z` 时六场景依次产生 `NO_ACTION/FOLLOW_UP/ESCALATE/UNKNOWN/UNKNOWN/UNKNOWN`，且 fact-variant 证明不按 scenario ID 硬编码 | yes | test-only oracle + repeatability/fact-variant tests | goal:GW-ACCEPT-01 |
| AC-06 | 页面显示 synthetic 边界、source/revision、observedAt、freshness、coverage、unknowns、reason 与 next step，并在 390px 无横向溢出 | yes | served browser + accessibility/overflow assertions | goal:GW-ACCEPT-01 |
| AC-08 | 没有外部请求、真实凭据、客户值或业务写；旧 credentialed Connector Gateway 行为不变 | yes | network allowlist + secret scan + diff review | goal:GW-SAFE-01 |
| AC-09 | SCN-NORMAL 完成后由用户给出 `CONTINUE | REVISE | STOP`；全六场景后由用户给出产品 verdict | yes | 用户消息，自动化与 agent 不得代签 | goal:GW-ACCEPT-01 |

## Real Validation Plan

| Row | Target | Command or action | Expected result | Phase conclusion evidence |
|---|---|---|---|---|
| V-1 | contracts/Gateway/Control Plane/Web | focused Vitest command | SCN-NORMAL contracts、调用链与 forbidden imports 通过 | workflow verification log |
| V-2 | repo type safety | `pnpm typecheck` | touched graph 无 TypeScript 错误 | workflow verification log |
| V-3 | served SCN-NORMAL | localhost Vite + Control Plane + synthetic Gateway 后运行 Playwright | 真实 API 请求、四步 trace、`NO_ACTION`、无 Gateway 直连 | browser trace/screenshot outside Git |
| V-4 | Slice 1 user checkpoint | 用户查看 served flow | `CONTINUE | REVISE | STOP` | 当前任务用户消息 |
| V-5 | Slice 2（仅 CONTINUE 后） | 六场景 browser matrix + degradation tests + lint/build | AC-01..06、08 技术通过 | Team verifier/reviewer reports |

## Edge Cases

| Case | Expected behavior | Required | Admission |
|---|---|---:|---|
| required fact/source/revision/observedAt invalid | `UNKNOWN / SOURCE_FACT_INVALID` 并短路 | yes | goal:GW-SAFE-01 |
| mapping cardinality 0 | `UNKNOWN / MAPPING_NOT_FOUND`，Hive calls = 0 | yes | goal:GW-SAFE-01 |
| mapping cardinality N without selection | `UNKNOWN / MAPPING_AMBIGUOUS`，Hive calls = 0 | yes | goal:GW-SAFE-01 |
| runtime stale/unknown/upstream failure | structured UNKNOWN，alarm call = 0 | yes | goal:GW-SAFE-01 |
| alarm partial/unavailable | `UNKNOWN / ALARM_COVERAGE_INCOMPLETE` | yes | goal:GW-SAFE-01 |
| invalid request/schema | HTTP 400，不伪装业务 UNKNOWN | yes | goal:GW-CAP-01 |
| unexpected invariant | HTTP 500，不伪装业务 UNKNOWN | yes | goal:GW-CAP-01 |

## Failure And Stop Conditions

- Stop and ask the user when: SCN-NORMAL served flow 已就绪并需要 `CONTINUE | REVISE | STOP`；需要真实系统、凭据、外部网络、MCP、forbidden path 或新的产品取舍；发现无法隔离的用户 worktree 改动。
- Treat the task as failed when: 浏览器仍直接 import fixture/decision、Gateway 与 Gate A.3 credentialed path 混用、同一业务规则出现多份、非唯一/过期事实得到非 UNKNOWN、或任何外部/客户动作发生。
- Required safe fallback: 仅返回 structured UNKNOWN 或关闭 synthetic route；不得退回浏览器内 mock、真实 Provider、旧 Worker/task/lease 链或猜测结果。

## Provenance

- Based on: `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/clarify.md` digest `96a1b6ec4c62a254d1e6c76e701c71bd3183db57901b7a822563ad3cdbf01d79`。
- Review: `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/team/decision.md`，`APPROVE_PLAN_QUALITY / CONSENSUS`。
- Supersedes for execution: stale `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/synthetic-e2e-mock-admission.json` and its old plan/base bindings；历史文件不修改。
- Historical Discovery L1 remains immutable evidence; only the new action-specific authority package may open this local synthetic route.

## Finding Provenance

规划 Team Review 的 current-goal findings 已在 canonical plan 中解决；本合同没有新增 finding-derived 可执行要求。其他架构与真实系统工作继续保持非目标。

## Final Contract Cleanliness Gate

- [x] 只包含最终同意的 Slice 0–2 范围。
- [x] 旧规划、旧 admission 与 Gate A 不提供执行权。
- [x] 验收、失败语义、Product/UI gate 和 user checkpoint 已明确。
- [x] MCP、真实系统、凭据、外部动作与发布继续关闭。
