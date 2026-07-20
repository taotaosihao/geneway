# Gate 0.1 基础质量

2026-07-21 执行 `pnpm verify:gate0.1`，退出码为 0。聚合结果：

- ESLint：通过，零 warning；
- TypeScript：9 个 workspace project 通过；
- 单元/合同：5 个文件、12 个测试通过；
- Control Plane 集成：真实 PostgreSQL，6 个测试通过；
- 安全：真实 PostgreSQL，10 个测试通过；
- build：所有 workspace 成功，Vite 产出真实 HTML、CSS 和 JS bundle；
- served Playwright：4 个测试通过，覆盖 team 完整纵切、auto/expert 路由和未知 capability fail closed。

Vite 报告主 bundle约 700.38 kB（gzip 约 215.01 kB），属于已知非阻断优化项，不影响 Gate 0.1 功能与真实性。

最新整门原始报告：`/tmp/geneway-runs/gate-0.1-1784576455020-2373368/playwright-report.json`。
