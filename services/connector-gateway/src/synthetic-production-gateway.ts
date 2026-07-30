import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { productionBriefInternalRequestSchema } from '@geneway/contracts';
import { createSyntheticProductionProvider, type SyntheticProductionProvider } from './synthetic-production-provider.js';

export const SYNTHETIC_PRODUCTION_GATEWAY_PATH = '/internal/synthetic-production/v1/invoke';

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
}

export function createSyntheticProductionGateway(options: Readonly<{
  serviceToken: string;
  provider?: SyntheticProductionProvider;
  logger?: boolean;
}>): FastifyInstance {
  if (options.serviceToken.length < 32 || /\s/u.test(options.serviceToken)) {
    throw new Error('Synthetic production service token must be at least 32 non-whitespace characters');
  }
  const provider = options.provider ?? createSyntheticProductionProvider();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384, trustProxy: false });
  app.get('/health', () => ({ ok: true, service: 'geneway-synthetic-production-gateway' }));
  app.post(SYNTHETIC_PRODUCTION_GATEWAY_PATH, async (request, reply) => {
    if (request.headers.origin !== undefined || !bearerMatches(request.headers.authorization, options.serviceToken)) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Synthetic gateway authority is required' } });
    }
    const input = productionBriefInternalRequestSchema.parse(request.body);
    return provider.invoke(input);
  });
  return app;
}
