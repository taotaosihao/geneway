# geneway Synthetic E2E MVP Slice 2 Canonical 实施合同

task_id: 20260730-004-geneway-synthetic-e2e-mvp-slice-2
title: 生产计划员工单设备简报六场景与安全降级
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

本合同承接已验收并提交的 Slice 1 `7379fe2a1754e722b8fda5ba6816a3b94744d2ec`，只执行
Team-reviewed canonical plan 中的 Slice 2。用户消息 `continue` 是 Slice 1 checkpoint 的唯一产品
决定，允许在同一 Web → Control Plane → bounded synthetic Connector Gateway → GearJob/Hive
adapter 边界内补齐六场景与安全降级。MCP、真实 API/数据/凭据、authenticated WorkBuddy、
外部网络、push、PR、部署、发布与生产继续关闭。

## Execution Plan

```atlas-execution-plan+json
{
  "schema_version": 1,
  "size_policy": {"policy_id": "atlas-slice-size-v2"},
  "slices": [
    {
      "slice_id": "synthetic-production-brief-six-scenarios",
      "objective": "在已验收的 production.work_order_equipment_brief.v1 纵切中补齐六个 production-shaped synthetic 场景、服务端唯一四态 rubric、原子 degradation matrix、下游调用短路证据和 served browser matrix，并停在用户最终产品 verdict。",
      "depends_on": [],
      "keeper_outputs": ["change:production-work-order-equipment-brief-six-scenarios"],
      "owned_paths": [
        "packages/contracts/src/production-work-order-equipment-brief.ts",
        "packages/contracts/src/production-work-order-equipment-brief.contract.test.ts",
        "services/connector-gateway/src/synthetic-production-provider.ts",
        "services/connector-gateway/src/synthetic-production-provider.test.ts",
        "services/connector-gateway/src/synthetic-production-gateway.ts",
        "services/connector-gateway/src/synthetic-production-gateway.test.ts",
        "apps/control-plane/src/production-work-order-equipment-brief.ts",
        "apps/control-plane/src/production-work-order-equipment-brief.test.ts",
        "apps/control-plane/src/production-work-order-equipment-brief.integration.test.ts",
        "apps/control-plane/src/index.ts",
        "apps/control-plane/src/main.ts",
        "apps/web/src/api.ts",
        "apps/web/src/api.test.ts",
        "apps/web/src/production-brief-routes.tsx",
        "apps/web/src/production-brief-routes.test.tsx",
        "apps/web/src/styles.css",
        "scripts/e2e/synthetic-production-brief.spec.ts"
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
        "scripts/run-synthetic-production-brief.mjs",
        "scripts/playwright.config.ts",
        "package.json",
        "pnpm-lock.yaml"
      ],
      "acceptance_refs": ["GW-MVP-01", "GW-CONN-01", "GW-CAP-01", "GW-SAFE-01", "GW-ACCEPT-01", "AC-01", "AC-02", "AC-03", "AC-04", "AC-05", "AC-06", "AC-08", "AC-09", "AC-10"],
      "risk_class": "high",
      "failure_domain": "本地 synthetic 六场景、服务端四态判断、safe degradation、served Web 与对应测试；不触碰真实系统、MCP 或旧执行链",
      "rollback_boundary": "一个经最终用户 verdict 后允许的本地逻辑提交；无数据库、凭据或外部状态回滚",
      "estimate": {
        "estimated_changed_files": 14,
        "estimated_net_loc": 1400,
        "target_p90_minutes": 150,
        "serial_dependency_depth": 0,
        "independent_vertical_count": 1
      },
      "budget": {
        "max_changed_files": 17,
        "max_loc": 2200,
        "max_wall_clock_minutes": 300,
        "max_required_checks": 5
      },
      "checks": [
        {
          "check_id": "production-brief-six-scenario-tests",
          "gate_class": "integration",
          "command": "./node_modules/.bin/vitest run packages/contracts/src/production-work-order-equipment-brief.contract.test.ts services/connector-gateway/src/synthetic-production-provider.test.ts services/connector-gateway/src/synthetic-production-gateway.test.ts apps/control-plane/src/production-work-order-equipment-brief.test.ts apps/control-plane/src/production-work-order-equipment-brief.integration.test.ts apps/web/src/api.test.ts apps/web/src/production-brief-routes.test.tsx",
          "final_only": false,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-six-scenario-typecheck",
          "gate_class": "typecheck",
          "command": "./node_modules/.bin/tsc -p packages/contracts/tsconfig.json --noEmit --pretty false && ./node_modules/.bin/tsc -p services/connector-gateway/tsconfig.json --noEmit --pretty false && ./node_modules/.bin/tsc -p apps/control-plane/tsconfig.json --noEmit --pretty false && ./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit --pretty false && ./node_modules/.bin/tsc -p scripts/tsconfig.json --noEmit --pretty false",
          "final_only": false,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-six-scenario-lint",
          "gate_class": "lint",
          "command": "./node_modules/.bin/eslint packages/contracts/src/production-work-order-equipment-brief.ts packages/contracts/src/production-work-order-equipment-brief.contract.test.ts services/connector-gateway/src/synthetic-production-provider.ts services/connector-gateway/src/synthetic-production-provider.test.ts services/connector-gateway/src/synthetic-production-gateway.ts services/connector-gateway/src/synthetic-production-gateway.test.ts apps/control-plane/src/production-work-order-equipment-brief.ts apps/control-plane/src/production-work-order-equipment-brief.test.ts apps/control-plane/src/production-work-order-equipment-brief.integration.test.ts apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/production-brief-routes.tsx apps/web/src/production-brief-routes.test.tsx scripts/e2e/synthetic-production-brief.spec.ts --max-warnings=0",
          "final_only": true,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-six-scenario-build",
          "gate_class": "build",
          "command": "./node_modules/.bin/vite build --config apps/web/vite.config.ts",
          "final_only": true,
          "cache_policy": "fresh-executed"
        },
        {
          "check_id": "production-brief-six-scenario-browser",
          "gate_class": "browser-flow",
          "command": "env COREPACK_ENABLE_NETWORK=0 npm_config_offline=true PNPM_CONFIG_OFFLINE=true node scripts/run-synthetic-production-brief.mjs --route-e2e -- --project=synthetic-production-brief synthetic-production-brief.spec.ts",
          "final_only": true,
          "cache_policy": "fresh-executed"
        }
      ]
    }
  ]
}
```

## Scope

- Goal: 扩展同一个 `production.work_order_equipment_brief.v1`，让 Control Plane 中唯一 rubric 基于 provider-shaped facts 产生 `NO_ACTION | FOLLOW_UP | ESCALATE | UNKNOWN`。
- Scenarios: `SCN-NORMAL`、`SCN-BEHIND-STOP`、`SCN-CRITICAL-ALARM`、`SCN-STALE`、`SCN-UNMAPPED`、`SCN-MULTIPLE`。
- Fixed clock: 所有标准场景使用 `evaluationAsOf=2026-07-29T08:30:00.000Z`。
- Fixture rule: production fixture 只包含 selector、事实、mapping/status/alarm coverage、source revision 和 `observedAt`；不得包含 expected action、reason、freshness、最终文案或 oracle。
- Test oracle: expected action/reason/call ledger 只存在于 test files，不能被 production code 或 Web import。
- User-visible behavior: 同一 `/work-orders/mock` 页面允许用户逐一运行六场景，显示 synthetic 边界、事实、来源/时间、freshness、coverage、unknowns、reason 与下一步。
- Non-goals: MCP、真实 Connector、真实 API/数据/凭据、WorkBuddy、Worker/Runtime/Workflow/task/lease、migration、外部网络、push、PR、部署、发布和生产。

## First Code Slice Guard

- first_code_slice: `SCN-BEHIND-STOP` 必须先沿已存在的真实产品边界贯穿两个 synthetic adapters、Control Plane rubric 和 API-backed Web，产生服务端 `FOLLOW_UP`；随后才补齐其他场景和 degradation matrix。
- first_code_slice_kind: product
- first_code_owner: 单一 `atlas-sdd-implementer`，拥有本合同全部产品路径；主 Codex 负责 authority、集成和验收。
- first_code_verification: focused contract/provider/application/Web tests 必须证明 action 来自事实字段；浏览器仍只请求相对 `/api`。
- allowed_contract_gate_only_until: 只允许作为 `SCN-BEHIND-STOP` 产品纵切的内部准备，不得把 schema 或 fixture 单独宣称为进展完成。
- stop_if_no_code_by_phase: 必要源码读取后立即实施 `SCN-BEHIND-STOP`；若必须触碰 forbidden path 则停止。
- gate_parallelization_or_deferral_plan: 先完成单一 writable owner 的纵向改动，再由独立 reviewer/verifier 并行检查；不拆分相互耦合的 contract/rubric/provider 写入。

## Product/UI Acceptance Gate

- first_operable_user_flow: 页面依次运行六场景并得到 `NO_ACTION/FOLLOW_UP/ESCALATE/UNKNOWN/UNKNOWN/UNKNOWN`。
- browser_entrypoint: http://127.0.0.1:3200/work-orders/mock
- served_ui_validation_action: Playwright must use `page.goto("http://127.0.0.1:3200/work-orders/mock")`，通过真实 Vite document/JS/CSS、相对 `/api`、Control Plane 与 synthetic Gateway 运行六场景；不得使用浏览器 fixture。
- ui_data_mode: `SYNTHETIC_DEMO`。
- required_safety_gates: 浏览器只允许 `127.0.0.1:3200`；0/N mapping 不调用 Hive；stale/unknown/upstream failure 不调用 alarm；无外部请求、真实凭据或业务写。
- allowed_headless_only_until: focused contract/provider/application/Web tests 首次通过；之后必须运行 served browser matrix。
- stop_if_no_ui_by_phase: 六场景 API matrix 通过后必须完成 served browser matrix，不得以 unit-only 结论结束。

## Acceptance Criteria

| ID | Criterion | Required | Verification | Authority |
|---|---|---:|---|---|
| AC-01 | 六场景仍只通过四个 internal operation 调用两个独立 adapters，Web 不引用 provider 私有结构 | yes | import inspection + provider/application tests | goal:GW-CONN-01 |
| AC-02 | Application Capability、operation、mapping/status/alarm/error schema 仍由唯一 Zod 4 合同表达 | yes | contract serialization/negative tests | goal:GW-CAP-01 |
| AC-03 | 六场景均贯穿 served Web、Control Plane、Application Service、loopback Gateway 与被允许的 adapters | yes | API trace + browser network + call ledger | goal:GW-MVP-01 |
| AC-04 | mapping 0/N、stale/unknown/upstream failure、alarm partial/unavailable 均 structured UNKNOWN 并按 rubric 短路 | yes | 独立 degradation oracle + exact call-ledger assertions | goal:GW-SAFE-01 |
| AC-05 | 固定 clock 下六场景依次为 `NO_ACTION/FOLLOW_UP/ESCALATE/UNKNOWN/UNKNOWN/UNKNOWN`，重复运行 deterministic；非标准 fact variant 证明不按 scenario ID 决策 | yes | independent oracle + repeatability + fact-variant tests | goal:GW-ACCEPT-01 |
| AC-06 | 页面显示 synthetic/source/revision/observedAt/freshness/coverage/unknowns/reason/next step，390px 无横向溢出 | yes | served browser + accessibility/overflow assertions | goal:GW-ACCEPT-01 |
| AC-08 | 全程无外部请求、真实凭据、客户值、业务写；credentialed Connector Gateway 不变 | yes | whole-process network trace + secret/diff scan | goal:GW-SAFE-01 |
| AC-09 | 技术门通过后由用户给出 `ACCEPT_SYNTHETIC_WEDGE | REVISE_SYNTHETIC_MVP | STOP_CURRENT_WEDGE` | yes | 当前任务后续用户消息；自动化不得代签 | goal:GW-ACCEPT-01 |
| AC-10 | technical conformance 与用户产品 verdict 独立；只有两者均通过才可进入下一轮规划 | yes | Team decision + user verdict | goal:GW-ACCEPT-01 |

## Decision Rubric And Degradation Matrix

服务端按以下顺序短路，Web、provider 和 tests 不得复制 production decision implementation：

1. required fact/source/revision/`observedAt` 缺失或非法 → `UNKNOWN / SOURCE_FACT_INVALID`。
2. mapping cardinality 0 → `UNKNOWN / MAPPING_NOT_FOUND`，Hive calls = 0。
3. mapping cardinality N 且无显式选择 → `UNKNOWN / MAPPING_AMBIGUOUS`，Hive calls = 0。
4. runtime provider failure → `UNKNOWN / UPSTREAM_FAILURE`，alarm calls = 0。
5. runtime known-state 非 `KNOWN` → `UNKNOWN / STATUS_UNKNOWN`，alarm calls = 0。
6. runtime age > 120s → `UNKNOWN / STATUS_STALE`，alarm calls = 0。
7. alarm coverage `PARTIAL | UNAVAILABLE` → `UNKNOWN / ALARM_COVERAGE_INCOMPLETE`。
8. active `HIGH | CRITICAL` alarm → `ESCALATE / ACTIVE_CRITICAL_ALARM`。
9. status `STOP | OFFLINE` 或进度差 >= 15 个百分点 → `FOLLOW_UP / PRODUCTION_FOLLOW_UP_REQUIRED`。
10. 其余 current/complete facts → `NO_ACTION / NORMAL_OPERATION`。

Degradation tests 必须对 `SOURCE_FACT_INVALID`、mapping 0、mapping N、runtime stale、runtime unknown、runtime upstream failure、alarm partial、alarm unavailable 各有一个不被更早失败掩盖的原子 case，并断言 exact downstream call ledger。非法 request/schema 为 HTTP 400；unexpected invariant 为 HTTP 500，二者不得伪装成业务 UNKNOWN。

## Edge Cases

| Case | Expected behavior | Required | Admission |
|---|---|---:|---|
| required fact/source/revision/`observedAt` invalid | `UNKNOWN / SOURCE_FACT_INVALID`，从首次无效事实后停止 | yes | goal:GW-SAFE-01 |
| mapping cardinality 0 | `UNKNOWN / MAPPING_NOT_FOUND`，runtime/alarm calls = 0 | yes | goal:GW-SAFE-01 |
| mapping cardinality N without selection | `UNKNOWN / MAPPING_AMBIGUOUS`，runtime/alarm calls = 0 | yes | goal:GW-SAFE-01 |
| runtime provider failure | `UNKNOWN / UPSTREAM_FAILURE`，alarm calls = 0，保留 sanitized error class | yes | goal:GW-SAFE-01 |
| runtime unknown | `UNKNOWN / STATUS_UNKNOWN`，alarm calls = 0 | yes | goal:GW-SAFE-01 |
| runtime freshness > 120s | `UNKNOWN / STATUS_STALE`，alarm calls = 0 | yes | goal:GW-SAFE-01 |
| alarm partial or unavailable | `UNKNOWN / ALARM_COVERAGE_INCOMPLETE`，不进入 severity/progress 分支 | yes | goal:GW-SAFE-01 |
| invalid request/schema | HTTP 400，不伪装业务 UNKNOWN | yes | goal:GW-CAP-01 |
| unexpected invariant/bug | HTTP 500，不伪装业务 UNKNOWN | yes | goal:GW-CAP-01 |

## Verification And Evidence

- 使用本合同五个 permanent checks；禁止 root pnpm/Corepack package resolution。
- Final Verifier 额外在 direct guarded browser command 外包 whole-process `strace`，确认非 loopback connect 为 0、kernel browser receipt 为 `ENFORCED`、浏览器只访问 Web 3200、端口清理完成。
- Final Reviewer 检查 fixture/oracle 物理分离、唯一 rubric、adapter call short-circuit、响应 schema、HTTP 400/500 语义、Web forbidden imports 与旧 credentialed Gateway 无 diff。
- 原始 trace、截图、browser report 和 service token 仅保存在 task-owned `/tmp` 或 workflow runtime artifacts，不进入 Git。

## Failure And Stop Conditions

- 若需要 forbidden path、真实 API/数据/凭据、external network、MCP 或新的产品取舍，立即停止。
- 若 provider fixture 包含 expected action/final copy、Web import fixture/rubric、同一规则出现多份、0/N/stale/upstream 继续调用被禁止的下游 operation，视为失败。
- Required safe fallback: 只返回 structured UNKNOWN 或关闭 synthetic route；不得退回浏览器内 mock、真实 Provider 或旧 Worker/task/lease 链。
- Technical conformance 完成后必须停在最终用户 product verdict；Team/自动化不得生成该 verdict。

## Provenance

- Canonical plan: `/home/gewu/.codex/workflow/artifacts/20260729-014-geneway-l2/clarify.md`，SHA-256 `96a1b6ec4c62a254d1e6c76e701c71bd3183db57901b7a822563ad3cdbf01d79`。
- Parent implementation: commit `7379fe2a1754e722b8fda5ba6816a3b94744d2ec`。
- Parent checkpoint readiness: `/home/gewu/.codex/workflow/artifacts/20260730-001-geneway-synthetic-e2e-mvp-slice-0-2/slice1-user-checkpoint-readiness.json`。
- User checkpoint: current-thread user message text `continue`；只开放 Slice 2。
- Canonical root pnpm gate 继续保留为 `NOT_PASS_BASELINE_RESERVED`，本合同使用已验证的 direct local binaries/Node guarded path，不修改 `pnpm-lock.yaml`。

## Finding Provenance

本合同没有把 Slice 1 的已解决 findings 重新变成开放 blocker。它保留其 regression tests，并把 canonical pnpm baseline reservation 作为可见的非产品保留项。其他真实系统、MCP 和平台化改进仍为非目标。

## Final Contract Cleanliness Gate

- [x] 只包含用户 `continue` 后的 Slice 2 六场景与安全降级。
- [x] 唯一服务端 rubric、fixture/oracle 分离、call-ledger 短路和产品/技术双结论已明确。
- [x] Slice 1 历史证据保留，canonical pnpm 未伪装成通过。
- [x] MCP、真实系统、凭据、外部动作、发布和生产继续关闭。
