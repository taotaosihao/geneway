# Gate 0.2B 质量汇总

唯一关闭候选为 `gate0.2b-1785038729533-2773014`，aggregate 为 PASS，13 个步骤均 `status=0`、`signal=null`、source stable。

## V2 结果

- `lint`：通过。
- `typecheck`：通过。
- `unit`：25 个测试文件、199 项测试全部通过；其中 `gate-script-contract.test.ts` 55 项、ambient listener proof 13 项、Docker teardown proof 27 项。
- `worker-runtime-allowlist-tests`：2 个测试文件、10 项全部通过。
- `build`：通过。
- `contracts`：通过。

修复期间的聚焦验证为 95/95，通过 `pnpm exec tsc -p scripts/tsconfig.json --noEmit --pretty false`、`pnpm lint`、`git diff --check`。三条 subnet 负向测试又由 fresh reviewer 分别独立运行，均 1/1 通过。

提交前仅暂存 10 个 `scripts/**` 文件，完整审查 staged diff，`git diff --cached --check` 通过；常见凭据/调试扫描无异常，唯一 `console.log` 是 shell 管道输出经校验的接口名。
