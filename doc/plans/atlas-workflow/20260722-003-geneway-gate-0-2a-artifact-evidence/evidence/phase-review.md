# Gate 0.2A 阶段复核

## 结论

**ACCEPT**：Gate 0.2A Artifact / Evidence 纵切满足最终实施合同，可以关闭本阶段 Goal。结论只基于最后一次完整 `pnpm verify:gate0.2a`（退出码 0），不复用前序失败运行中的绿色分项。

## 最终聚合结果

| 门禁 | 结果 |
| --- | --- |
| lint / typecheck / build | 全部退出 0 |
| unit | 15 files / 58 tests |
| contracts | 8 files / 29 tests |
| Control Plane integration | 3 files / 21 tests |
| real storage | 3 files / 20 tests |
| security | 2 files / 21 tests |
| recovery | 13/13 required cases |
| backup/restore | success + 2 expected-integrity-failure cases，suite PASS |
| Gate 0.2A success UI | 4/4 |
| Gate 0.2A negative UI | 2/2 |
| Gate 0.1 regression UI | 4/4 |

最终聚合日志：`/tmp/geneway-gate0.2a-final.log`。

## 失败—修复审计

1. 首次聚合在 reliability lane 新增代码上发现两条 lint 错误；修正显式 union narrowing 和 unknown causeCode 类型保护后，lint/typecheck/定向测试通过。
2. 后续聚合在最后的 Gate 0.1 项目发现真实问题：Worker 太快，UI 从 0 跳到 7，测试未观测到中间进度。修复仅在 E2E Worker 设置每步 40ms，定向 Gate 0.1 4/4 通过。
3. 修复后重新从零运行完整聚合；本文件的 PASS 只引用该次完整成功运行。

## 执行器与范围真实性

- 前端优先执行器按合同尝试 Kimi Code CLI 预检；CLI 版本和入口 hash 符合预期，但 user namespace、provider endpoint/region 和 provider-only egress 无法机械证明，因此没有启动 Kimi，也没有给它仓库或客户数据。
- 主 Codex 依合同接管，Kimi 不进入产品 Runtime、依赖、数据流或成功 oracle。
- 产品验收仍是 fake Runtime 和模拟业务结果；GearJob 与真实 ERP/MES 连接不属于本 Gate。

## 运行后状态

- `git diff --check` 通过。
- `geneway-e2e-*`、`geneway-storage-*`、`geneway-br-*` 测试容器、卷和网络残留为 0。
- E2E Worker/Control Plane generations 已退出，短 UDS 与 0600 token 已清理。
- 非阻塞残留：Vite 主 chunk 体积警告；后续性能合同再处理，不影响当前正确性与安全结论。
