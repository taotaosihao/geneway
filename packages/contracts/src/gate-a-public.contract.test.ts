import { describe, expect, it } from 'vitest';
import {
  gateACapabilityRouteProjectionSchema,
  gateADocumentExecutionEligibilitySchema,
  gateALivePublicWireJsonSchemas,
  gateALivePublishedStatementSchema,
  gateALiveTaskCreateInputSchema,
  gateALiveTaskCreateResponseSchema,
} from './gate-a-public.js';

const digest = (character: string): string => character.repeat(64);

describe('Gate A live public wire contracts', () => {
  it('accepts only the client-owned auto material task fields', () => {
    const input = {
      conversationId: 'conversation-1',
      capabilityId: 'solution.analysis.v1',
      inputRef: { kind: 'document_snapshot', documentSnapshotId: 'snapshot-1' },
      expertTarget: { mode: 'auto' },
    } as const;
    expect(gateALiveTaskCreateInputSchema.parse(input)).toEqual(input);
    expect(gateALiveTaskCreateInputSchema.safeParse({
      ...input,
      provider: 'browser-selected',
    }).success).toBe(false);
    expect(gateALiveTaskCreateInputSchema.safeParse({
      ...input,
      expertTarget: { mode: 'expert', expertId: 'expert.solution.architect.live/1' },
    }).success).toBe(false);
    expect(gateALiveTaskCreateInputSchema.safeParse({
      ...input,
      inputRef: { ...input.inputRef, resourceScope: 'browser-owned' },
    }).success).toBe(false);
  });

  it('publishes an explicit internal live create envelope without provider controls', () => {
    const projection = gateALiveTaskCreateResponseSchema.parse({
      recordVariant: 'business-task.live/1',
      executionRoute: 'live',
      taskId: 'task-1',
      approvalId: 'approval-1',
      approvalSubjectDigest: digest('a'),
      workflowVersion: {
        id: 'workflow-1',
        hash: digest('b'),
        templateId: 'workflow-template.solution-live/1',
        registryDigest: digest('c'),
      },
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    });
    expect(projection.simulation).toBe(false);
    expect(gateALiveTaskCreateResponseSchema.safeParse({ ...projection, provider: 'browser-selected' }).success).toBe(false);
  });

  it('never projects a published fact without verified Evidence', () => {
    const statement = {
      id: 'statement-1',
      kind: 'fact',
      text: '计划数量为100。',
      confidence: 0.99,
      status: 'published',
      evidenceRefIds: [],
      rejectionCode: null,
    };
    expect(gateALivePublishedStatementSchema.safeParse(statement).success).toBe(false);
    expect(gateALivePublishedStatementSchema.parse({ ...statement, evidenceRefIds: ['evidence-1'] }).kind).toBe('fact');
    expect(gateALivePublishedStatementSchema.safeParse({
      ...statement,
      status: 'rejected',
      rejectionCode: null,
    }).success).toBe(false);
  });

  it('keeps live, simulation and NOT_OPEN document routes structurally distinct', () => {
    for (const extractionVersion of [
      'canonical-text/plain-utf8/1',
      'canonical-text/pdf-pages-utf8/1',
      'canonical-text/docx-pages-utf8/1',
    ] as const) {
      const projection = gateADocumentExecutionEligibilitySchema.parse({
        route: 'live',
        eligible: true,
        capabilityVersionId: 'cap_solution_analysis_v1_live_1',
        parserManifestId: 'parser-1',
        parserDigest: digest('d'),
        extractionVersion,
        canonicalTextSha256: digest('e'),
        simulation: false,
        runtimeMode: 'model_gateway',
        businessDecisionAllowed: false,
        internalAcceptance: true,
      });
      if (projection.route !== 'live') throw new Error('expected live eligibility');
      expect(projection.extractionVersion).toBe(extractionVersion);
    }
    expect(gateADocumentExecutionEligibilitySchema.safeParse({
      route: 'live', eligible: true, capabilityVersionId: 'cap_solution_analysis_v1_live_1',
      parserManifestId: 'parser-1', parserDigest: digest('d'), extractionVersion: 'custom-parser/1',
      canonicalTextSha256: digest('e'), simulation: false, runtimeMode: 'model_gateway',
      businessDecisionAllowed: false, internalAcceptance: true,
    }).success).toBe(false);
    expect(gateADocumentExecutionEligibilitySchema.safeParse({
      route: 'live',
      eligible: true,
      simulation: true,
    }).success).toBe(false);
    expect(gateADocumentExecutionEligibilitySchema.parse({
      route: 'not_open',
      eligible: false,
      reason: 'PARSER_AUTHORITY_UNAVAILABLE',
    }).eligible).toBe(false);
  });

  it('opens only the auto ExpertTarget and keeps public JSON schemas secret-free', () => {
    expect(gateACapabilityRouteProjectionSchema.parse({
      capabilityId: 'solution.analysis.v1',
      status: 'internal',
      executionRoute: 'live',
      capabilityVersionId: 'cap_solution_analysis_v1_live_1',
      availableExpertModes: ['auto'],
      simulation: false,
      runtimeMode: 'model_gateway',
      businessDecisionAllowed: false,
      internalAcceptance: true,
    }).availableExpertModes).toEqual(['auto']);
    const wire = JSON.stringify(gateALivePublicWireJsonSchemas);
    expect(wire).not.toContain('authFile');
    expect(wire).not.toContain('serviceToken');
    expect(wire).not.toContain('providerRaw');
    expect(wire).not.toContain('reasoning');
  });
});
