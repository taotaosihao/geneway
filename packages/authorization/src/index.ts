import { z } from 'zod';
import { GenewayError, type Principal } from '@geneway/contracts';

export const actionLevelSchema = z.enum(['R0', 'R1', 'A1']);
export type ActionLevel = z.infer<typeof actionLevelSchema>;

export const delegatedCapabilitySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  businessTaskId: z.string().min(1),
  principalId: z.string().min(1),
  allowedActions: z.array(actionLevelSchema).min(1),
  resourceScopes: z.array(z.string().min(1)).min(1),
  audienceScope: z.array(z.string().min(1)).min(1),
  expiresAt: z.coerce.date(),
}).strict();

export type DelegatedCapability = z.infer<typeof delegatedCapabilitySchema>;

export type AuthorizationRequest = Readonly<{
  principal: Principal;
  capability: DelegatedCapability;
  businessTaskId: string;
  action: ActionLevel;
  resourceScope: string;
  audience: string;
  now?: Date;
}>;

export function authorize(request: AuthorizationRequest): void {
  const now = request.now ?? new Date();
  if (request.principal.trust !== 'trusted-local') throw new GenewayError('UNTRUSTED_PRINCIPAL', 'Only server-derived trusted-local principals are allowed', 403);
  if (request.principal.tenantId !== request.capability.tenantId || request.principal.userId !== request.capability.principalId) {
    throw new GenewayError('CAPABILITY_PRINCIPAL_MISMATCH', 'Delegated capability does not belong to this principal', 403);
  }
  if (request.businessTaskId !== request.capability.businessTaskId) throw new GenewayError('CAPABILITY_TASK_MISMATCH', 'Delegated capability is bound to another task', 403);
  if (request.capability.expiresAt.getTime() <= now.getTime()) throw new GenewayError('CAPABILITY_EXPIRED', 'Delegated capability has expired', 403);
  if (!request.capability.allowedActions.includes(request.action)) throw new GenewayError('ACTION_NOT_ALLOWED', `Action ${request.action} is outside the approved ceiling`, 403);
  if (!request.capability.resourceScopes.includes(request.resourceScope)) throw new GenewayError('RESOURCE_NOT_ALLOWED', 'Resource is outside the delegated scope', 403);
  if (!request.capability.audienceScope.includes(request.audience)) throw new GenewayError('AUDIENCE_NOT_ALLOWED', 'Audience is outside the delegated scope', 403);
}

export function deriveTrustedLocalPrincipal(remoteAddress: string | undefined): Principal {
  const normalized = remoteAddress?.replace(/^::ffff:/, '');
  if (normalized !== '127.0.0.1' && normalized !== '::1') {
    throw new GenewayError('LOOPBACK_REQUIRED', 'Gate 0.1 accepts loopback requests only', 403);
  }
  return { tenantId: 'tenant_local', userId: 'user_local', trust: 'trusted-local' };
}

export function assertTrustedOrigin(origin: string | undefined): void {
  if (origin === undefined) return;
  const allowed = new Set(['http://localhost:3200', 'http://127.0.0.1:3200']);
  if (!allowed.has(origin)) throw new GenewayError('ORIGIN_NOT_ALLOWED', 'Cross-origin writes are not allowed', 403);
}
