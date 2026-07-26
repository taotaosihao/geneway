import { describe, expect, it } from 'vitest';
import {
  gateACapabilityRouteProjectionSchema,
  gateA2ResolvedExpertTargetSchema,
  gateADocumentExecutionEligibilitySchema,
  gateALivePublicWireJsonSchemas,
  gateALivePublishedStatementSchema,
  gateALiveTaskCreateInputSchema,
  gateALiveTaskCreateResponseSchema,
} from './gate-a-public.js';

const digest = (character: string): string => character.repeat(64);

describe('Gate A live public wire contracts', () => {
  const stepBindings = [
    { stepId: 'requirement_extract', agentRegistryReference: 'agent.solution.requirement/live-1',
      agentVersionId: 'agent.solution.requirement/live-2' },
    { stepId: 'contradiction_check', agentRegistryReference: 'agent.solution.contradiction/live-1',
      agentVersionId: 'agent.solution.contradiction/live-2' },
    { stepId: 'solution_design', agentRegistryReference: 'agent.solution.architect/live-1',
      agentVersionId: 'agent.solution.architect/live-2' },
  ] as const;

  it('projects immutable A.2 expert and ordered team provenance without changing the author', () => {
    const expert = gateA2ResolvedExpertTargetSchema.parse({
      mode: 'expert', resolution: 'explicit', expertId: 'expert.solution.architect',
      expertVersionId: 'expert.solution.architect.live/2',
      agentVersionId: 'agent.solution.architect/live-2',
      promptPolicyVersionId: 'xiaowei.solution-analysis.system/2', stepBindings,
    });
    if (expert.mode !== 'expert') throw new Error('expected expert projection');
    expect(expert.expertVersionId).toBe('expert.solution.architect.live/2');
    const team = gateA2ResolvedExpertTargetSchema.parse({
      mode: 'team', resolution: 'explicit', teamId: 'team.solution.core',
      teamVersionId: 'team.solution.core.live/2',
      members: [
        { order: 1, role: 'Requirement Analyst', expertVersionId: 'expert.solution.requirement.live/2', agentVersionId: 'agent.solution.requirement/live-2' },
        { order: 2, role: 'Contradiction Analyst', expertVersionId: 'expert.solution.contradiction.live/2', agentVersionId: 'agent.solution.contradiction/live-2' },
        { order: 3, role: 'Solution Architect', expertVersionId: 'expert.solution.architect.live/2', agentVersionId: 'agent.solution.architect/live-2' },
      ],
      promptPolicyVersionId: 'xiaowei.solution-analysis.system/2', stepBindings,
    });
    if (team.mode !== 'team') throw new Error('expected team projection');
    expect(team.members.map((member: { role: string }) => member.role))
      .toEqual(['Requirement Analyst', 'Contradiction Analyst', 'Solution Architect']);
    expect(gateA2ResolvedExpertTargetSchema.safeParse({ ...expert, author: '方案架构师' }).success).toBe(false);
  });
  it('accepts only the three stable client-owned ExpertTarget selectors', () => {
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
    expect(gateALiveTaskCreateInputSchema.parse({
      ...input, expertTarget: { mode: 'expert', expertId: 'expert.solution.architect' },
    }).expertTarget.mode).toBe('expert');
    expect(gateALiveTaskCreateInputSchema.parse({
      ...input, expertTarget: { mode: 'team', teamId: 'team.solution.core' },
    }).expertTarget.mode).toBe('team');
    for (const expertTarget of [
      { mode: 'expert', expertId: 'expert.solution.architect.live/2' },
      { mode: 'team', teamId: 'team.solution.core', members: [] },
      { mode: 'auto', promptPolicyVersionId: 'browser-owned' },
      { mode: 'auto', provider: 'browser-owned' },
      { mode: 'auto', maxOutputTokens: 1 },
    ]) expect(gateALiveTaskCreateInputSchema.safeParse({ ...input, expertTarget }).success).toBe(false);
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

  it('reads A.1 auto and opens the additive A.2 three-mode tuple without public authority controls', () => {
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
    expect(gateACapabilityRouteProjectionSchema.parse({
      capabilityId: 'solution.analysis.v1', status: 'internal', executionRoute: 'live',
      capabilityVersionId: 'cap_solution_analysis_v1_live_2', availableExpertModes: ['auto', 'expert', 'team'],
      simulation: false, runtimeMode: 'model_gateway', businessDecisionAllowed: false, internalAcceptance: true,
    }).availableExpertModes).toEqual(['auto', 'expert', 'team']);
    const wire = JSON.stringify(gateALivePublicWireJsonSchemas);
    expect(wire).not.toContain('authFile');
    expect(wire).not.toContain('serviceToken');
    expect(wire).not.toContain('providerRaw');
    expect(wire).not.toContain('reasoning');
  });
});
