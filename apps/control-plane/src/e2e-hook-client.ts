export type E2eHookAction = 'continue' | 'inject_error';

export function parseE2eHookEndpoint(input: Readonly<{
  url: string;
  nodeEnvironment: string | undefined;
  tokenFile: string;
  expectedTokenFile: string;
}>): URL {
  const parsed = new URL(input.url);
  const port = Number(parsed.port);
  if (input.nodeEnvironment !== 'test' || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
    || !Number.isInteger(port) || port < 1 || port > 65_535 || input.tokenFile !== input.expectedTokenFile) {
    throw new Error('E2E hook is restricted to the numeric loopback test supervisor and Worker token');
  }
  return parsed;
}

export async function postE2eHook(
  endpoint: URL,
  token: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<E2eHookAction> {
  const response = await fetch(new URL('/test/hooks/reached', endpoint), {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.status === 204) return 'continue';
  if (!response.ok) throw new Error(`E2E hook supervisor rejected the boundary: ${String(response.status)}`);
  const body = await response.json() as Readonly<{ action?: unknown }>;
  if (body.action === undefined || body.action === 'continue') return 'continue';
  if (body.action === 'inject_error') return 'inject_error';
  throw new Error('E2E hook supervisor returned an unsupported action');
}
