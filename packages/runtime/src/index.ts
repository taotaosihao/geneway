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

export class FakeRuntime {
  readonly mode = 'fake' as const;

  executeStep(stepId: string, context: FakeRuntimeContext): FakeStepOutput {
    switch (stepId) {
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
        return { summary: '已提交模拟报告候选，等待 Control Plane 权威发布' };
      default:
        throw new GenewayError('NOT_OPEN', `Runtime step kind or id is not open: ${stepId}`, 422);
    }
  }

  executeExternal(kind: string): never {
    throw new GenewayError('NOT_OPEN', `Runtime kind is not open: ${kind}`, 422);
  }
}
