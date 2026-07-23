import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type ExpectedE2eTest = Readonly<{ project: string; file: string; title: string }>;

export const expectedE2eTests: readonly ExpectedE2eTest[] = [
  { project: 'gate0.1', file: 'gate-0.1.spec.ts', title: '小纬完成真实 served UI 方案分析纵切并保持权威实体关联' },
  { project: 'gate0.1', file: 'gate-0.1.spec.ts', title: 'auto 路由通过真实 served UI 创建权威任务' },
  { project: 'gate0.1', file: 'gate-0.1.spec.ts', title: 'expert 路由通过真实 served UI 创建权威任务' },
  { project: 'gate0.1', file: 'gate-0.1.spec.ts', title: '未知 capability 在 UI 与 API 均 fail closed 为 NOT_OPEN' },
  { project: 'gate0.2a-success', file: 'gate-0.2a-storage-thin.spec.ts', title: 'served UI uploads, verifies, recovers and downloads one private source artifact' },
  { project: 'gate0.2a-success', file: 'gate-0.2a-evidence.spec.ts', title: '真实 Worker 完成上传、Workflow、Claim–Evidence–Lineage 与报告纵切' },
  { project: 'gate0.2a-success', file: 'gate-0.2a-recovery.spec.ts', title: '真实 Worker 在已认领步骤的确定性故障点被 kill 后按 checkpoint reclaim 并只发布一次' },
  { project: 'gate0.2a-success', file: 'gate-0.2a-recovery.spec.ts', title: '报告对象校验后取消会拒绝旧 Worker、删除孤儿对象且不发布 Claim 或报告' },
  { project: 'gate0.2a-negative', file: 'gate-0.2a-negative.spec.ts', title: '显式白名单：未注册 Profile 只可存储下载，不贡献成功结论' },
  { project: 'gate0.2a-negative', file: 'gate-0.2a-negative.spec.ts', title: '显式白名单：对象缺失后隐藏元数据并禁用执行' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'after_intent_commit_before_s3_put' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'after_s3_put_before_db_finalize' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'put_response_lost' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'after_outbox_commit_before_worker_claim' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'after_inbox_insert_before_step_execution' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery.spec.ts', title: '真实 Worker 在已认领步骤的确定性故障点被 kill 后按 checkpoint reclaim 并只发布一次' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'complete_step_ack_lost' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'after_report_put_before_db_publish' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'stale_attempt_completion' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery.spec.ts', title: '报告对象校验后取消会拒绝旧 Worker、删除孤儿对象且不发布 Claim 或报告' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'sse_snapshot_subscribe_gap' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'control_plane_restart' },
  { project: 'gate0.2a-recovery-multiprocess', file: 'gate-0.2a-recovery-matrix.spec.ts', title: 'worker_restart' },
  { project: 'gate0.2b-success', file: 'gate-0.2b-task-workflow-routes.spec.ts', title: '真实任务可从六条 served 路由恢复，并与 API、Postgres 和 Worker 保持同一关联' },
  { project: 'gate-a0-live', file: 'gate-a0-fast-chat.spec.ts', title: '真实 served Fast Chat 首问关联 UI、API、Postgres、Worker 与 Gateway audit' },
  { project: 'gate-a0-live', file: 'gate-a0-context-cancel.spec.ts', title: '真实 served Fast Chat 追问上下文并用停止生成完成 cancel fencing' },
  { project: 'gate-a0-lan', file: 'gate-a0-lan-regression.spec.ts', title: '实际 LAN 双浏览器共享 Conversation、上下文、取消并保持材料门' },
];

const resultSchema = z.object({ status: z.string() }).passthrough();
const testSchema = z.object({
  projectName: z.string(),
  status: z.string(),
  results: z.array(resultSchema),
}).passthrough();
const specSchema = z.object({ file: z.string(), title: z.string(), tests: z.array(testSchema) }).passthrough();
type Suite = Readonly<{ specs: readonly z.infer<typeof specSchema>[]; suites: readonly Suite[] }>;
const suiteSchema: z.ZodType<Suite> = z.lazy(() => z.object({
  specs: z.array(specSchema).default([]),
  suites: z.array(suiteSchema).default([]),
}).passthrough());
const reportSchema = z.object({
  errors: z.array(z.unknown()),
  stats: z.object({ expected: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
    unexpected: z.number().int().nonnegative(), flaky: z.number().int().nonnegative() }).passthrough(),
  suites: z.array(suiteSchema),
}).passthrough();

function testKey(test: ExpectedE2eTest): string {
  return `${test.project}\u0000${test.file}\u0000${test.title}`;
}

function expectedSelection(arguments_: readonly string[]): readonly ExpectedE2eTest[] {
  const projects: string[] = [];
  const fileFilters: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument.startsWith('--project=')) {
      projects.push(argument.slice('--project='.length));
      continue;
    }
    if (argument === '--project') {
      const project = arguments_[index + 1];
      if (project === undefined || project.startsWith('-')) throw new Error('Playwright --project requires a project name');
      projects.push(project);
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unsupported selection-changing Playwright argument: ${argument}`);
    fileFilters.push(argument);
  }
  const selectedProjects = projects.length === 0
    ? new Set(expectedE2eTests.map((item) => item.project))
    : new Set(projects);
  for (const project of selectedProjects) {
    if (!expectedE2eTests.some((item) => item.project === project)) throw new Error(`Unknown gated Playwright project: ${project}`);
  }
  const selected = expectedE2eTests.filter((item) => selectedProjects.has(item.project)
    && (fileFilters.length === 0 || fileFilters.some((filter) => item.file.includes(filter))));
  if (selected.length === 0) throw new Error('Playwright selection contains no required gated tests');
  return selected;
}

function flattenSuites(suites: readonly Suite[]): Array<Readonly<{
  project: string; file: string; title: string; status: string; resultStatuses: readonly string[];
}>> {
  const observed: Array<Readonly<{
    project: string; file: string; title: string; status: string; resultStatuses: readonly string[];
  }>> = [];
  for (const suite of suites) {
    for (const spec of suite.specs) {
      for (const test of spec.tests) observed.push({
        project: test.projectName,
        file: spec.file,
        title: spec.title,
        status: test.status,
        resultStatuses: test.results.map((result) => result.status),
      });
    }
    observed.push(...flattenSuites(suite.suites));
  }
  return observed;
}

export function validateE2eReport(input: unknown, arguments_: readonly string[]): Readonly<{
  expectedCount: number; observedCount: number; testKeys: readonly string[];
}> {
  const report = reportSchema.parse(input);
  const expected = expectedSelection(arguments_);
  const observed = flattenSuites(report.suites);
  const expectedKeys = expected.map(testKey).sort();
  const observedKeys = observed.map((test) => testKey(test)).sort();
  if (report.errors.length !== 0 || report.stats.skipped !== 0 || report.stats.unexpected !== 0 || report.stats.flaky !== 0) {
    throw new Error(`Playwright report is not clean: ${JSON.stringify(report.stats)}`);
  }
  if (report.stats.expected !== expected.length || JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Playwright project membership drifted; expected ${JSON.stringify(expectedKeys)}, observed ${JSON.stringify(observedKeys)}`);
  }
  for (const test of observed) {
    if (test.status !== 'expected' || test.resultStatuses.length !== 1 || test.resultStatuses[0] !== 'passed') {
      throw new Error(`Playwright test was skipped, retried or did not pass exactly once: ${testKey(test)}`);
    }
  }
  return { expectedCount: expected.length, observedCount: observed.length, testKeys: observedKeys };
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const reportPath = process.argv[2];
  const rawArguments = process.argv[3];
  if (reportPath === undefined || rawArguments === undefined) throw new Error('usage: e2e-report-gate.ts <report.json> <playwright-arguments-json>');
  const summaryPath = resolve(dirname(reportPath), 'e2e-report-gate.json');
  try {
    const selectionArguments = z.array(z.string()).parse(JSON.parse(rawArguments) as unknown);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
    const result = validateE2eReport(report, selectionArguments);
    await writeFile(summaryPath, `${JSON.stringify({ passed: true, reportPath, selectionArguments, ...result }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`geneway E2E report gate passed: ${summaryPath}\n`);
  } catch (error) {
    await writeFile(summaryPath, `${JSON.stringify({ passed: false, reportPath,
      error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`geneway E2E report gate failed: ${summaryPath}\n`);
    process.exitCode = 1;
  }
}
