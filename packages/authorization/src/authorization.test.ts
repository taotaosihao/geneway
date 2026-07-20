import { describe, expect, it } from 'vitest';
import { authorize, deriveTrustedLocalPrincipal, type DelegatedCapability } from './index.js';

const capability: DelegatedCapability = {
  id: 'dc_1', tenantId: 'tenant_local', businessTaskId: 'task_1', principalId: 'user_local',
  allowedActions: ['R0', 'R1'], resourceScopes: ['fixture:solution-analysis:v1'],
  audienceScope: ['conversation:conv_1'], expiresAt: new Date('2099-01-01T00:00:00Z'),
};

describe('authorization', () => {
  it('allows only the delegated intersection', () => {
    expect(() => authorize({ principal: deriveTrustedLocalPrincipal('127.0.0.1'), capability, businessTaskId: 'task_1', action: 'R1', resourceScope: 'fixture:solution-analysis:v1', audience: 'conversation:conv_1' })).not.toThrow();
    expect(() => authorize({ principal: deriveTrustedLocalPrincipal('127.0.0.1'), capability, businessTaskId: 'task_1', action: 'A1', resourceScope: 'fixture:solution-analysis:v1', audience: 'conversation:conv_1' })).toThrow(/outside/);
  });

  it('rejects remote and expired principals', () => {
    expect(() => deriveTrustedLocalPrincipal('10.0.0.7')).toThrow(/loopback/i);
    expect(() => authorize({ principal: deriveTrustedLocalPrincipal('::1'), capability: { ...capability, expiresAt: new Date(0) }, businessTaskId: 'task_1', action: 'R0', resourceScope: 'fixture:solution-analysis:v1', audience: 'conversation:conv_1' })).toThrow(/expired/);
  });
});
