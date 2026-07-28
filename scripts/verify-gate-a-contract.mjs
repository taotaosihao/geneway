import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

const repositoryRoot = realpathSync(new URL('..', import.meta.url));
const atlasRepository = '/home/gewu/.codex/.tmp/marketplaces/atlas-forge';
const historicalCommit = 'ca620c1ad76b607c39011d94b84039b4597231bd';
const historicalTree = '4e5d535758127789108afebfeb7733519deab5bb';
const historicalLintSha256 = '1049ad244c91a57407ebe06e597fbba6a7ceac2e6d3175706ca93f0a157cf54f';
const contractPath = `${repositoryRoot}/doc/plans/atlas-workflow/20260723-008-geneway-gate-a-gearjob/implementation-contract.final.md`;
const authoritySlice = '/home/gewu/.codex/workflow/artifacts/20260723-008-geneway-gate-a-gearjob/team/sdd/slices/gate-a-business-mvp';
const runId = process.env.GENEWAY_RUN_ID ?? `gate-a-contract-${String(Date.now())}-${String(process.pid)}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new Error('GENEWAY_RUN_ID is invalid');
const evidenceDirectory = `/tmp/geneway-runs/${runId}/gate-a`;
const summaryPath = `${evidenceDirectory}/v1-contract.json`;
const safeEnvironment = {
  PATH: '/usr/bin:/bin', HOME: '/home/gewu', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function command(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? safeEnvironment,
    input: options.input,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(' ')} failed (${String(result.status ?? 1)}): ${String(result.stderr).slice(-4_000)}`);
  }
  return result.stdout;
}

const atlasStat = lstatSync(atlasRepository);
if (!atlasStat.isDirectory() || atlasStat.isSymbolicLink() || atlasStat.uid !== process.getuid?.()
  || realpathSync(atlasRepository) !== atlasRepository) {
  throw new Error('historical Atlas marketplace repository is not an owned real directory');
}

mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
chmodSync(`/tmp/geneway-runs/${runId}`, 0o700);
chmodSync(evidenceDirectory, 0o700);
const temporaryTree = mkdtempSync('/tmp/geneway-gate-a-contract-');
chmodSync(temporaryTree, 0o700);
try {
  command('git', ['-C', atlasRepository, 'cat-file', '-e', `${historicalCommit}^{commit}`]);
  const observedTree = command('git', ['-C', atlasRepository, 'rev-parse', `${historicalCommit}^{tree}`]).trim();
  if (observedTree !== historicalTree) throw new Error('historical Atlas commit tree identity drifted');
  const archive = command('git', [
    '-C', atlasRepository, 'archive', '--format=tar', historicalCommit, 'plugins/atlas-workflow',
  ], { encoding: 'buffer' });
  command('tar', ['-xf', '-', '-C', temporaryTree, '--no-same-owner', '--no-same-permissions'], {
    input: archive, encoding: 'buffer',
  });
  const lintPath = `${temporaryTree}/plugins/atlas-workflow/scripts/codex-implementation-contract-lint`;
  const observedLintSha256 = sha256(readFileSync(lintPath));
  if (observedLintSha256 !== historicalLintSha256) throw new Error('historical Atlas contract lint bytes drifted');
  const lintOutput = command(process.execPath, [lintPath, '--strict', '--new-authoring',
    '--file', contractPath, '--authority-slice', authoritySlice], {
    env: { ...safeEnvironment, NODE_PATH: '' },
  });
  const summary = {
    schemaVersion: 'geneway-gate-a-contract-verification/1',
    ok: true,
    runId,
    atlas: {
      repository: atlasRepository,
      commit: historicalCommit,
      tree: observedTree,
      lintSha256: observedLintSha256,
      fullPluginTreeMaterialized: true,
    },
    contract: {
      path: contractPath,
      sha256: sha256(readFileSync(contractPath)),
      authoritySlice,
      briefSha256: sha256(readFileSync(`${authoritySlice}/brief.md`)),
      strict: true,
      newAuthoring: true,
    },
    lintOutput: lintOutput.trim(),
  };
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  if (!temporaryTree.startsWith('/tmp/geneway-gate-a-contract-')) {
    throw new Error('refusing to clean an unexpected historical Atlas directory');
  }
  rmSync(temporaryTree, { recursive: true, force: true });
}
