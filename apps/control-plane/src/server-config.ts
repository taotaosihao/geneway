const MAX_ALLOWED_WEB_ORIGINS = 8;

function canonicalWebOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('GENEWAY_WEB_ALLOWED_ORIGINS only accepts HTTP(S) origins');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('GENEWAY_WEB_ALLOWED_ORIGINS must not include credentials');
  }
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0 || url.origin !== value) {
    throw new Error('GENEWAY_WEB_ALLOWED_ORIGINS entries must be canonical origins without paths, queries, or fragments');
  }
  return url.origin;
}

export function readAllowedWebOrigins(
  environment: NodeJS.ProcessEnv,
  webPort: number,
): readonly string[] {
  const localOrigins = [`http://localhost:${String(webPort)}`, `http://127.0.0.1:${String(webPort)}`];
  const configured = environment.GENEWAY_WEB_ALLOWED_ORIGINS;
  if (configured === undefined) return localOrigins;

  const values = configured.split(',').map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new Error('GENEWAY_WEB_ALLOWED_ORIGINS must be a comma-separated list of non-empty origins');
  }
  if (values.length > MAX_ALLOWED_WEB_ORIGINS) {
    throw new Error(`GENEWAY_WEB_ALLOWED_ORIGINS accepts at most ${String(MAX_ALLOWED_WEB_ORIGINS)} origins`);
  }
  return [...new Set([...localOrigins, ...values.map(canonicalWebOrigin)])];
}
