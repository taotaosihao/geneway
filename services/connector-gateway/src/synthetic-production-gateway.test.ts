import { afterEach, describe, expect, it } from 'vitest';
import { createSyntheticProductionGateway, SYNTHETIC_PRODUCTION_GATEWAY_PATH } from './synthetic-production-gateway.js';

const token = 'synthetic-service-token-at-least-32-bytes';
const apps: Array<ReturnType<typeof createSyntheticProductionGateway>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('synthetic production gateway', () => {
  it('allows exactly the contract operation with local service authority', async () => {
    const app = createSyntheticProductionGateway({ serviceToken: token });
    apps.push(app);
    const response = await app.inject({
      method: 'POST', url: SYNTHETIC_PRODUCTION_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}` },
      payload: { operationId: 'production.work_order.get.v1', selector: { scenarioRef: 'SCN-NORMAL' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ operationId: 'production.work_order.get.v1' });
  });

  it('rejects missing authority, browser origins, and arbitrary operations', async () => {
    const app = createSyntheticProductionGateway({ serviceToken: token });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: SYNTHETIC_PRODUCTION_GATEWAY_PATH, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: SYNTHETIC_PRODUCTION_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}`, origin: 'http://127.0.0.1:3200' },
      payload: { operationId: 'production.work_order.get.v1', selector: { scenarioRef: 'SCN-NORMAL' } },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: SYNTHETIC_PRODUCTION_GATEWAY_PATH,
      headers: { authorization: `Bearer ${token}` }, payload: { operationId: 'http.get', selector: { scenarioRef: 'SCN-NORMAL' } },
    })).statusCode).toBe(500);
  });
});
