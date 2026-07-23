import { createHash } from 'node:crypto';
import { GenewayError, type ClaimOutputCandidate, type EvidenceLocatorCandidate, type ResolvedTaskInputRef } from '@geneway/contracts';
import {
  DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
  DEMO_EVIDENCE_START_BYTE,
  FIXTURE_SOURCE_ID,
  POSITIVE_CLAIM_TEXT,
  UNSUPPORTED_CLAIM_TEXT,
} from '@geneway/evidence';

export { parseE2eHookEndpoint, postE2eHook, type E2eHookAction } from './e2e-hook-client.js';
export { ChatRuntimeAdapter, ChatRuntimeError } from './chat-runtime.js';
export type { ChatRuntimeInput, ChatRuntimeResult } from './chat-runtime.js';

export type FakeRuntimeContext = Readonly<{
  inputRef: ResolvedTaskInputRef;
  inputBytes?: Uint8Array;
}>;

export type FakeStepOutput = Readonly<{
  summary: string;
  evidence?: EvidenceLocatorCandidate;
  claims?: readonly ClaimOutputCandidate[];
}>;

const EXCEPTION_UNKNOWN_CLAIM_TEXT = '当前固定来源不足以判断异常根因或实际处置结果。';

function readBusinessExceptionSnapshot(context: FakeRuntimeContext): Readonly<Record<string, unknown>> {
  if (context.inputRef.kind !== 'business_exception_snapshot' || context.inputBytes === undefined) {
    throw new GenewayError('WORKER_INPUT_BYTES_REQUIRED', 'Authorized business exception snapshot bytes are required', 409);
  }
  try {
    const parsed = JSON.parse(Buffer.from(context.inputBytes).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new GenewayError('WORKER_INPUT_CANONICAL_JSON_INVALID', 'Business exception snapshot is not valid JSON', 409);
  }
}

function exceptionEvidence(context: FakeRuntimeContext): Readonly<{
  evidence: EvidenceLocatorCandidate;
  claim: ClaimOutputCandidate;
}> {
  if (context.inputRef.kind !== 'business_exception_snapshot') {
    throw new GenewayError('WORKER_INPUT_KIND_MISMATCH', 'Exception Evidence requires a business exception snapshot', 409);
  }
  const inputRef = context.inputRef;
  const snapshot = readBusinessExceptionSnapshot(context);
  const values = snapshot.values;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new GenewayError('WORKER_INPUT_EVIDENCE_MISSING', 'Business exception snapshot has no accessible fact values', 409);
  }
  const valueRecord = values as Readonly<Record<string, unknown>>;
  const isCapacity = snapshot.exceptionType === 'capacity_progress_lag';
  const jsonPointer = isCapacity ? '/values/progressPct' : '/values/currentValue';
  const value = isCapacity ? valueRecord.progressPct : valueRecord.currentValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GenewayError('WORKER_INPUT_EVIDENCE_MISSING', 'Business exception snapshot is missing its fixed numeric fact', 409);
  }
  const candidateKey = isCapacity ? 'capacity-progress-fact' : 'equipment-alarm-fact';
  const evidence: EvidenceLocatorCandidate = {
    kind: 'business_exception_snapshot',
    candidateKey,
    businessExceptionId: inputRef.businessExceptionId,
    sourceVersionId: inputRef.sourceVersionId,
    sourceSha256: inputRef.sourceSha256,
    canonicalizationVersion: inputRef.canonicalizationVersion,
    jsonPointer,
    valueSha256: createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'),
  };
  return {
    evidence,
    claim: {
      candidateKey: isCapacity ? 'capacity-progress-observation' : 'equipment-alarm-observation',
      text: isCapacity ? `固定模拟来源记录的工单进度为 ${String(value)}%。` : `固定模拟来源记录的设备当前值为 ${String(value)}。`,
      evidenceCandidateKey: candidateKey,
    },
  };
}

export class FakeRuntime {
  readonly mode = 'fake' as const;

  executeStep(stepId: string, context: FakeRuntimeContext): FakeStepOutput {
    switch (stepId) {
      case 'exception_snapshot_load':
        readBusinessExceptionSnapshot(context);
        return { summary: '已读取并校验版本固定的模拟异常来源快照' };
      case 'deterministic_baseline':
        readBusinessExceptionSnapshot(context);
        return { summary: '已从受权 fixture 事实生成确定性基线，未调用外部系统' };
      case 'expert_route_resolve':
        return { summary: '已读取审批主题冻结的专家路由投影；专家不改变固定 Workflow' };
      case 'impact_analysis':
        return { summary: '已生成模拟影响分析；未由 Evidence 支持的业务影响保持未知' };
      case 'action_recommendation':
        return { summary: '已生成 A1 模拟建议，不执行设备、工单、排产或通知写入' };
      case 'evidence_quality_check': {
        const { evidence, claim } = exceptionEvidence(context);
        return {
          summary: '已提交异常来源定位与 Claim 候选，等待 Control Plane 重算 locator 与 hash',
          evidence,
          claims: [
            claim,
            {
              candidateKey: 'exception-cause-unknown',
              text: EXCEPTION_UNKNOWN_CLAIM_TEXT,
              evidenceCandidateKey: null,
            },
          ],
        };
      }
      case 'document_ingest': {
        if (context.inputRef.kind === 'fixture') return { summary: '已读取版本固定的脱敏方案材料' };
        if (context.inputBytes === undefined || context.inputBytes.byteLength === 0) {
          throw new GenewayError('WORKER_INPUT_BYTES_REQUIRED', 'Document snapshot bytes are required by the fake runtime', 409);
        }
        return { summary: '已通过受限 Control Plane 端口读取已验证文档快照' };
      }
      case 'requirement_extract':
        return { summary: '已提取生产工单跟踪与质量追溯要求，并保留一个无来源候选' };
      case 'contradiction_check':
        return { summary: '未发现影响当前模拟分析的材料内冲突' };
      case 'solution_design':
        return { summary: '已形成仅用于演示的方案分析草案' };
      case 'evidence_verify': {
        if (context.inputRef.kind === 'business_exception_snapshot') {
          throw new GenewayError('NOT_OPEN', 'Solution Evidence step does not accept exception input', 422);
        }
        const evidence: EvidenceLocatorCandidate = context.inputRef.kind === 'fixture'
          ? {
              kind: 'legacy_fixture',
              candidateKey: 'primary-source',
              fixtureRef: context.inputRef.fixtureRef,
              fixtureVersion: context.inputRef.fixtureVersion,
              sourceId: FIXTURE_SOURCE_ID,
            }
          : {
              kind: 'document_snapshot',
              candidateKey: 'primary-source',
              documentSnapshotId: context.inputRef.documentSnapshotId,
              startByte: DEMO_EVIDENCE_START_BYTE,
              endByteExclusive: DEMO_EVIDENCE_END_BYTE_EXCLUSIVE,
            };
        return {
          summary: '已提交来源定位候选；权威原文与 hash 由 Control Plane 重取验证',
          evidence,
          claims: [
            { candidateKey: 'supported-requirement', text: POSITIVE_CLAIM_TEXT, evidenceCandidateKey: evidence.candidateKey },
            { candidateKey: 'unsupported-device-control', text: UNSUPPORTED_CLAIM_TEXT, evidenceCandidateKey: null },
          ],
        };
      }
      case 'result_quality_check':
        return { summary: '模拟标识、业务决策禁用和来源要求检查通过' };
      case 'report_publish':
        return { summary: context.inputRef.kind === 'business_exception_snapshot'
          ? '已提交异常模拟报告候选，等待 Control Plane 重新授权后权威发布'
          : '已提交模拟报告候选，等待 Control Plane 权威发布' };
      default:
        throw new GenewayError('NOT_OPEN', `Runtime step kind or id is not open: ${stepId}`, 422);
    }
  }

  executeExternal(kind: string): never {
    throw new GenewayError('NOT_OPEN', `Runtime kind is not open: ${kind}`, 422);
  }
}
