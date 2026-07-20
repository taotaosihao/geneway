import { randomUUID } from 'node:crypto';
import { GenewayError, SIMULATION_ENVELOPE } from '@geneway/contracts';
import { FIXTURE_EXCERPT, POSITIVE_CLAIM_TEXT, UNSUPPORTED_CLAIM_TEXT, sha256Text, type ClaimCandidate, type EvidenceCandidate } from '@geneway/evidence';

export type FakeRuntimeContext = Readonly<{ tenantId: string; businessTaskId: string; fixtureRef: 'fixture:solution-analysis:v1' }>;
export type FakeStepOutput = Readonly<{
  summary: string;
  evidence?: EvidenceCandidate;
  claims?: readonly ClaimCandidate[];
}>;

export class FakeRuntime {
  readonly mode = 'fake' as const;

  executeStep(stepId: string, context: FakeRuntimeContext): FakeStepOutput {
    const base = { tenantId: context.tenantId, businessTaskId: context.businessTaskId, ...SIMULATION_ENVELOPE };
    switch (stepId) {
      case 'document_ingest': {
        if (context.fixtureRef !== 'fixture:solution-analysis:v1') throw new GenewayError('NOT_OPEN', 'Only the fixed redacted fixture is open', 422);
        return { summary: '已读取版本固定的脱敏方案材料' };
      }
      case 'requirement_extract':
        return { summary: '已提取生产工单跟踪与质量追溯要求，并保留一个无来源候选' };
      case 'contradiction_check':
        return { summary: '未发现影响当前模拟分析的材料内冲突' };
      case 'solution_design':
        return { summary: '已形成仅用于演示的方案分析草案' };
      case 'evidence_verify': {
        const evidence: EvidenceCandidate = {
          id: `evidence_${randomUUID()}`,
          ...base,
          sourceId: 'fixture:solution-analysis:v1#requirements',
          sourceExcerpt: FIXTURE_EXCERPT,
          sourceHash: sha256Text(FIXTURE_EXCERPT),
          resourceScope: 'fixture:solution-analysis:v1',
          dataClass: 'C1',
          accessible: true,
        };
        return {
          summary: '已核验材料来源；无来源候选将被拒绝发布',
          evidence,
          claims: [
            { id: `claim_${randomUUID()}`, ...base, text: POSITIVE_CLAIM_TEXT, evidenceRefId: evidence.id },
            { id: `claim_${randomUUID()}`, ...base, text: UNSUPPORTED_CLAIM_TEXT, evidenceRefId: null },
          ],
        };
      }
      case 'result_quality_check':
        return { summary: '模拟标识、业务决策禁用和来源要求检查通过' };
      case 'report_publish':
        return { summary: '已发布带内联来源的模拟分析结果' };
      default:
        throw new GenewayError('NOT_OPEN', `Runtime step kind or id is not open: ${stepId}`, 422);
    }
  }

  executeExternal(kind: string): never {
    throw new GenewayError('NOT_OPEN', `Runtime kind is not open: ${kind}`, 422);
  }
}
